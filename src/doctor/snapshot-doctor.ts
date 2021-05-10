import { strict as assert } from 'assert'
import debug from 'debug'
import fs from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { circularImports } from './circular-imports'
import {
  createBundleAsync,
  CreateSnapshotScriptOpts,
} from '../create-snapshot-script'
import { AsyncScriptProcessor } from './process-script.async'
import { Entries, Metadata } from '../types'
import {
  bundleFileNameFromHash,
  createHash,
  ensureDirSync,
  tryRemoveFile,
} from '../utils'
import {
  stringifyWarning,
  Warning,
  WarningConsequence,
  WarningsProcessor,
} from './warnings-processor'

const logInfo = debug('snapgen:info')
const logDebug = debug('snapgen:debug')
const logTrace = debug('snapgen:trace')
const logError = debug('snapgen:error')

export type SnapshotDoctorOpts = Omit<CreateSnapshotScriptOpts, 'deferred'> & {
  maxWorkers?: number
  previousDeferred: Set<string>
  previousHealthy: Set<string>
  previousNoRewrite: Set<string>
  forceNoRewrite: Set<string>
}

class HealState {
  processedLeaves: boolean
  constructor(
    readonly meta: Readonly<Metadata>,
    readonly healthy: Set<string> = new Set(),
    readonly deferred: Set<string> = new Set(),
    readonly norewrite: Set<string> = new Set(),
    readonly needDefer: Set<string> = new Set(),
    readonly needNorewrite: Set<string> = new Set()
  ) {
    this.processedLeaves = false
  }
}

function sortModulesByLeafness(
  meta: Metadata,
  entries: Entries<Metadata['inputs']>,
  circulars: Map<string, Set<string>>
) {
  const sorted = []
  const handled: Set<string> = new Set()

  while (handled.size < entries.length) {
    const justSorted = []
    // Include modules whose children have been included already
    for (const [key, { imports }] of entries) {
      if (handled.has(key)) continue
      const circular = circulars.get(key)
      const children = imports.map((x) => x.path)

      if (
        children.every(
          (x) => handled.has(x) || (circular != null && circular.has(x))
        )
      ) {
        justSorted.push(key)
      }
    }
    // Sort them further by number of imports
    justSorted.sort((a, b) => {
      const lena = meta.inputs[a].imports.length
      const lenb = meta.inputs[b].imports.length
      return lena > lenb ? -1 : 1
    })

    for (const x of justSorted) {
      sorted.push(x)
      handled.add(x)
    }
  }
  return sorted
}

function sortDeferredByLeafness(
  meta: Metadata,
  entries: Entries<Metadata['inputs']>,
  circulars: Map<string, Set<string>>,
  deferred: Set<string>
) {
  return sortModulesByLeafness(meta, entries, circulars).filter((x) =>
    deferred.has(x)
  )
}

function pathify(keys: Iterable<string>) {
  const xs = []
  for (const x of keys) {
    if (x.startsWith('.') || x.startsWith(path.sep)) {
      xs.push(x)
    } else {
      xs.push(`./${x}`)
    }
  }
  return xs
}
function pathifyAndSort(keys: Set<string>) {
  const xs = pathify(keys)
  xs.sort()
  return xs
}

function unpathify(keys: Set<string>) {
  const unpathified: Set<string> = new Set()
  for (const x of keys) {
    if (!x.startsWith('./')) {
      unpathified.add(x)
    } else {
      unpathified.add(x.slice(2))
    }
  }
  return unpathified
}

function argumentify(set?: Set<string>) {
  return set != null && set.size > 0
    ? Array.from(set).map((x) => `./${x}`)
    : undefined
}

export class SnapshotDoctor {
  private readonly baseDirPath: string
  private readonly entryFilePath: string
  private readonly bundlerPath: string
  private readonly nodeModulesOnly: boolean
  private readonly previousDeferred: Set<string>
  private readonly previousHealthy: Set<string>
  private readonly previousNoRewrite: Set<string>
  private readonly forceNoRewrite: Set<string>
  private readonly nodeEnv: string
  private readonly _scriptProcessor: AsyncScriptProcessor
  private readonly _warningsProcessor: WarningsProcessor

  constructor(opts: SnapshotDoctorOpts) {
    this.baseDirPath = opts.baseDirPath
    this.entryFilePath = opts.entryFilePath
    this.bundlerPath = opts.bundlerPath
    this._scriptProcessor = new AsyncScriptProcessor(opts)
    this._warningsProcessor = new WarningsProcessor(this.baseDirPath)
    this.nodeModulesOnly = opts.nodeModulesOnly
    this.previousDeferred = unpathify(opts.previousDeferred)
    this.previousHealthy = unpathify(opts.previousHealthy)
    this.previousNoRewrite = unpathify(opts.previousNoRewrite)
    this.forceNoRewrite = unpathify(opts.forceNoRewrite)
    this.nodeEnv = opts.nodeEnv
  }

  async heal(): Promise<{
    healthy: string[]
    includingImplicitsDeferred: string[]
    deferred: string[]
    norewrite: string[]
    bundle: Buffer
    meta: Metadata
  }> {
    let { warnings, meta, bundle } = await this._createScript()

    const entries = Object.entries(meta.inputs)
    const circulars = circularImports(meta.inputs, entries)
    logDebug({ circulars })

    const healState = new HealState(
      meta,
      this.previousHealthy,
      this.previousDeferred,
      new Set([...this.previousNoRewrite, ...this.forceNoRewrite])
    )

    await this._processCurrentScript(bundle, warnings, healState, circulars)
    while (healState.needDefer.size > 0 || healState.needNorewrite.size > 0) {
      debugger
      for (const x of healState.needDefer) {
        healState.deferred.add(x)
        healState.healthy.delete(x)
      }
      for (const x of healState.needNorewrite) {
        healState.norewrite.add(x)
        healState.healthy.delete(x)
      }

      const { warnings, bundle } = await this._createScript(
        healState.deferred,
        healState.norewrite
      )
      healState.needDefer.clear()
      healState.needNorewrite.clear()
      await this._processCurrentScript(bundle, warnings, healState, circulars)
    }

    const sortedDeferred = sortDeferredByLeafness(
      meta,
      entries,
      circulars,
      healState.deferred
    )

    const sortedNorewrite = Array.from(healState.norewrite).sort()

    logInfo('Optimizing')

    const {
      optimizedDeferred,
      includingImplicitsDeferred,
    } = await this._optimizeDeferred(meta, sortedDeferred, sortedNorewrite)

    logInfo({ allDeferred: sortedDeferred, len: sortedDeferred.length })
    logInfo({ optimizedDeferred, len: optimizedDeferred.size })
    logInfo({ norewrite: sortedNorewrite, len: sortedNorewrite.length })

    await this._scriptProcessor.dispose()

    return {
      healthy: pathifyAndSort(healState.healthy),
      includingImplicitsDeferred: pathifyAndSort(includingImplicitsDeferred),
      deferred: pathifyAndSort(optimizedDeferred),
      norewrite: pathify(sortedNorewrite),
      bundle,
      meta,
    }
  }

  async _optimizeDeferred(
    meta: Metadata,
    deferredSortedByLeafness: string[],
    notRewriting: string[]
  ) {
    const optimizedDeferred: Set<string> = new Set(this.previousDeferred)

    // 1. Push down defers where possible, i.e. prefer deferring one import instead of an entire module
    logInfo('--- OPTIMIZE Pushing down defers ---')
    for (const key of deferredSortedByLeafness) {
      if (this.previousDeferred.has(key)) continue
      if (this.previousNoRewrite.has(key)) continue

      const imports = meta.inputs[key].imports.map((x) => x.path)
      if (imports.length === 0) {
        optimizedDeferred.add(key)
        logInfo('Optimize: deferred leaf', key)
        continue
      }
    }

    await Promise.all(
      deferredSortedByLeafness
        .filter(
          (key) =>
            !this.previousDeferred.has(key) && !optimizedDeferred.has(key)
        )
        .map(async (key) => {
          // Check if it was fixed by one of the optimizedDeferred added previously
          if (
            await this._entryWorksWhenDeferring(
              key,
              optimizedDeferred,
              notRewriting
            )
          ) {
            logInfo('Optimize: deferring no longer needed for', key)
            return
          }

          // Treat the deferred as an entry point and find an import that would fix the encountered problem
          const imports = meta.inputs[key].imports.map((x) => x.path)

          // Defer all imports to verify that the module can be fixed at all, if not give up
          if (
            !(await this._entryWorksWhenDeferring(
              key,
              new Set([...optimizedDeferred, ...imports]),
              notRewriting
            ))
          ) {
            logInfo('Optimize: deferred unfixable parent', key)
            optimizedDeferred.add(key)
            return
          }

          await this._tryDeferImport(
            imports,
            key,
            optimizedDeferred,
            notRewriting
          )
        })
    )

    const includingImplicitsDeferred = new Set(optimizedDeferred)

    // 2. Find children that don't need to be explicitly deferred since they are via their deferred parent
    logInfo('--- OPTIMIZE Remove implicit defers ---')
    await this._removeImplicitlyDeferred(optimizedDeferred, notRewriting)

    return { optimizedDeferred, includingImplicitsDeferred }
  }

  private async _removeImplicitlyDeferred(
    optimizedDeferred: Set<string>,
    notRewriting: string[]
  ) {
    const entry = path.relative(this.baseDirPath, this.entryFilePath)
    const implicitDeferredPromises = Array.from(optimizedDeferred.keys())
      .filter((key) => !this.previousDeferred.has(key))
      .map(async (key) => {
        const fine = await this._entryWorksWhenDeferring(
          entry,
          new Set([...optimizedDeferred].filter((x) => x !== key)),
          notRewriting
        )
        return { fine, key }
      })
    const implicitDeferred = await Promise.all(implicitDeferredPromises)
    implicitDeferred
      .filter((x) => x.fine)
      .map((x) => x.key)
      .forEach((key) => {
        optimizedDeferred.delete(key)
        logInfo(
          'Optimize: removing defer of "%s", already deferred implicitly',
          key
        )
      })
  }

  private async _tryDeferImport(
    imports: string[],
    key: string,
    optimizedDeferred: Set<string>,
    notRewriting: string[]
  ) {
    const importPromises = imports
      .filter((imp) => this.previousDeferred.has(imp))
      .map(async (imp) => {
        if (
          await this._entryWorksWhenDeferring(
            key,
            new Set([...optimizedDeferred, imp]),
            notRewriting
          )
        ) {
          return { deferred: imp, fixed: true }
        } else {
          return { deferred: '', fixed: false }
        }
      })

    // Find the one import we need to defer to fix the entry module
    const fixers = new Set(
      (await Promise.all(importPromises))
        .filter((x) => x.fixed)
        .map((x) => x.deferred)
    )

    if (fixers.size === 0) {
      logDebug(
        `${key} does not need to be deferred, but only when more than one of it's imports are deferred.` +
          `This case is not yet handled, therefore we defer the entire module instead.`
      )
      optimizedDeferred.add(key)
      logInfo('Optimize: deferred parent with >1 problematic import', key)
    } else {
      for (const imp of fixers) {
        optimizedDeferred.add(imp)
        logInfo('Optimize: deferred import "%s" of "%s"', imp, key)
      }
    }
  }

  async _entryWorksWhenDeferring(
    key: string,
    deferring: Set<string>,
    notRewriting: string[]
  ) {
    const entryPoint = `./${key}`
    const deferred = Array.from(deferring).map((x) => `./${x}`)
    const norewrite = notRewriting.map((x) => `./${x}`)

    const opts: CreateSnapshotScriptOpts = {
      baseDirPath: this.baseDirPath,
      entryFilePath: this.entryFilePath,
      bundlerPath: this.bundlerPath,
      nodeModulesOnly: this.nodeModulesOnly,
      deferred,
      norewrite,
      includeStrictVerifiers: true,
      nodeEnv: this.nodeEnv,
    }
    const result = await this._scriptProcessor.createAndProcessScript(
      opts,
      entryPoint
    )

    switch (result.outcome) {
      case 'completed':
        logDebug('Verified as healthy "%s"', key)
        return true
      default:
        logDebug('%s script with entry "%s"', result.outcome, key)
        logDebug(result.error!.toString())
        logInfo('"%s" cannot be loaded for current setup (1 deferred)', key)
        return false
    }
  }

  private async _writeBundle(bundle: Buffer) {
    const bundleTmpDir = path.join(tmpdir(), 'v8-snapshot')
    ensureDirSync(bundleTmpDir)
    const bundleHash = createHash(bundle)
    const filename = bundleFileNameFromHash(bundleHash)
    const bundlePath = path.join(bundleTmpDir, filename)
    await fs.promises.writeFile(bundlePath, bundle)
    return { bundleHash, bundlePath }
  }

  private async _processCurrentScript(
    bundle: Buffer,
    warnings: Warning[],
    healState: HealState,
    circulars: Map<string, Set<string>>
  ) {
    const processedWarnings = this._warningsProcessor.process(warnings, {
      deferred: new Set(), // healState.deferred,
      norewrite: healState.norewrite,
    })
    for (const warning of processedWarnings) {
      const s = stringifyWarning(this.baseDirPath, warning)
      switch (warning.consequence) {
        case WarningConsequence.Defer:
          logError('Encountered warning triggering defer: %s', s)
          healState.needDefer.add(warning.location.file)
          break
        case WarningConsequence.NoRewrite:
          logError('Encountered warning triggering no-rewrite: %s', s)
          healState.needNorewrite.add(warning.location.file)
          break
        case WarningConsequence.None:
          logDebug('Encountered warning without consequence: %s', s)
          break
      }
    }

    // If new static issues were encountered we need to rebuild the bundle so we exit early
    if (healState.needNorewrite.size > 0 || healState.needDefer.size > 0) {
      return
    }

    logInfo('Preparing to process current script')
    const { bundleHash, bundlePath } = await this._writeBundle(bundle)
    logDebug('Stored bundle file (%s)', bundleHash)
    logTrace(bundlePath)
    /* START using (bundlePath) */ {
      for (
        let nextStage = this._findNextStage(healState, circulars);
        nextStage.length > 0;
        nextStage = this._findNextStage(healState, circulars)
      ) {
        if (!healState.processedLeaves) {
          healState.processedLeaves = true
          // In case all leaves were determined to be healthy before we can move on to the
          // next step
          if (
            nextStage.length === 0 &&
            healState.needDefer.size === 0 &&
            healState.needNorewrite.size === 0
          ) {
            nextStage = this._findNextStage(healState, circulars)
          }
        }
        const promises = nextStage.map(
          async (key): Promise<void> => {
            logDebug('Testing entry in isolation "%s"', key)

            const unloadableModules = Array.from(healState.deferred).concat(
              Array.from(healState.norewrite)
            )
            const result = await this._scriptProcessor.processScript({
              bundlePath,
              bundleHash,
              baseDirPath: this.baseDirPath,
              entryFilePath: this.entryFilePath,
              entryPoint: `./${key}`,
              nodeEnv: this.nodeEnv,
              unloadableModules,
            })

            assert(result != null, 'expected result from script processor')

            switch (result.outcome) {
              case 'completed': {
                healState.healthy.add(key)
                logDebug('Verified as healthy "%s"', key)
                break
              }
              case 'failed:assembleScript':
              case 'failed:verifyScript': {
                logError('%s script with entry "%s"', result.outcome, key)
                logError(result.error!.toString())

                const warning = this._warningsProcessor.warningFromError(
                  result.error!,
                  key,
                  healState
                )
                if (warning != null) {
                  switch (warning.consequence) {
                    case WarningConsequence.Defer: {
                      logInfo('Deferring "%s"', key)
                      healState.needDefer.add(key)
                      break
                    }
                    case WarningConsequence.NoRewrite: {
                      logInfo(
                        'Not rewriting "%s" as it results in incorrect code',
                        key
                      )
                      healState.needNorewrite.add(key)
                      break
                    }
                    case WarningConsequence.None: {
                      console.error(result.error)
                      assert.fail('I do not know what to do with this error')
                    }
                  }
                }
                break
              }
            }
          }
        )
        await Promise.all(promises)
      }
    } /* END using (bundlePath) */
    logDebug('Removing bundle file (%s)', bundleHash)
    logTrace(bundlePath)
    const err = await tryRemoveFile(bundlePath)
    if (err != null) {
      logError('Failed to remove bundle file', err)
    }
  }

  private async _createScript(
    deferred?: Set<string>,
    norewrite?: Set<string>
  ): Promise<{
    meta: Metadata
    bundle: Buffer
    warnings: Warning[]
  }> {
    try {
      const deferredArg = argumentify(deferred)
      const norewriteArg = argumentify(norewrite)

      const { warnings, meta, bundle } = await createBundleAsync({
        baseDirPath: this.baseDirPath,
        entryFilePath: this.entryFilePath,
        bundlerPath: this.bundlerPath,
        nodeModulesOnly: this.nodeModulesOnly,
        deferred: deferredArg,
        norewrite: norewriteArg,
      })

      return { warnings, meta: meta as Metadata, bundle }
    } catch (err) {
      logError('Failed creating initial bundle')
      throw err
    }
  }

  private _findNextStage(
    healState: HealState,
    circulars: Map<string, Set<string>>
  ) {
    if (healState.processedLeaves) {
      return this._findVerifiables(healState, circulars)
    } else {
      return this._findLeaves(healState)
    }
  }

  private _findLeaves(healState: HealState) {
    const leaves = []
    for (const [key, { imports }] of Object.entries(healState.meta.inputs)) {
      if (
        healState.healthy.has(key) ||
        healState.deferred.has(key) ||
        healState.needDefer.has(key) ||
        healState.needNorewrite.has(key)
      ) {
        continue
      }
      if (imports.length === 0) leaves.push(key)
    }
    return leaves
  }

  private _findVerifiables(
    healState: HealState,
    circulars: Map<string, Set<string>>
  ) {
    // Finds modules that only depend on previously handled modules
    const verifiables = []
    for (const [key, { imports }] of Object.entries(healState.meta.inputs)) {
      if (healState.needNorewrite.has(key)) continue
      if (healState.needDefer.has(key)) continue
      if (
        this._wasHandled(
          key,
          healState.healthy,
          healState.deferred,
          healState.norewrite
        )
      )
        continue

      const circular = circulars.get(key) ?? new Set()
      const allImportsHandledOrCircular = imports.every(
        (x) =>
          this._wasHandled(
            x.path,
            healState.healthy,
            healState.deferred,
            healState.norewrite
          ) || circular.has(x.path)
      )
      if (allImportsHandledOrCircular) verifiables.push(key)
    }
    return verifiables
  }

  private _wasHandled(
    key: string,
    healthy: Set<string>,
    deferred: Set<string>,
    norewrite: Set<string>
  ) {
    return healthy.has(key) || deferred.has(key) || norewrite.has(key)
  }
}
