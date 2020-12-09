import { strict as assert } from 'assert'
import path from 'path'
import debug from 'debug'
import vm from 'vm'
import {
  assembleScript,
  createBundle,
  CreateSnapshotScriptOpts,
  Metadata,
} from './create-snapshot-script'

const logInfo = debug('snapgen:info')
const logDebug = debug('snapgen:debug')
const logError = debug('snapgen:error')

export type SnapshotDoctorOpts = Omit<CreateSnapshotScriptOpts, 'deferred'>

class HealState {
  constructor(
    readonly meta: Readonly<Metadata>,
    readonly deferred: Set<string> = new Set(),
    readonly verified: Set<string> = new Set(),
    readonly needDefer: Set<string> = new Set()
  ) {}
}

type Entries<T> = {
  [K in keyof T]: [K, T[K]]
}[keyof T][]

function circularImports(
  inputs: Metadata['inputs'],
  entries: Entries<Metadata['inputs']>
) {
  const map: Map<string, Set<string>> = new Map()
  for (const [key, { imports }] of entries) {
    const circs = []
    for (const p of imports.map((x) => x.path)) {
      const isCircular = inputs[p].imports.some((x) => x.path === key)
      if (isCircular) circs.push(p)
    }
    if (circs.length > 0) map.set(key, new Set(circs))
  }
  return map
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

function pathify(deferred: Set<string>) {
  const xs = []
  for (const x of deferred) {
    xs.push(`./${x}`)
  }
  return xs
}

export class SnapshotDoctor {
  readonly baseDirPath: string
  readonly entryFilePath: string
  readonly bundlerPath: string

  constructor(opts: SnapshotDoctorOpts) {
    this.baseDirPath = opts.baseDirPath
    this.entryFilePath = opts.entryFilePath
    this.bundlerPath = opts.bundlerPath
  }

  async heal(forceDeferred: string[] = []) {
    const { meta, bundle } = await this._createScript()

    const entries = Object.entries(meta.inputs)
    const circulars = circularImports(meta.inputs, entries)
    logDebug({ circulars })

    const healState = new HealState(meta, new Set(forceDeferred))

    let snapshotScript = this._processCurrentScript(
      bundle,
      healState,
      circulars
    )
    while (healState.needDefer.size > 0) {
      for (const x of healState.needDefer) {
        healState.deferred.add(x)
      }
      const { bundle } = await this._createScript(healState.deferred)
      healState.needDefer.clear()
      snapshotScript = this._processCurrentScript(bundle, healState, circulars)
    }

    const sortedDeferred = sortDeferredByLeafness(
      meta,
      entries,
      circulars,
      healState.deferred
    )

    logInfo('Optimizing')

    const {
      optimizedDeferred,
      includingImplicitsDeferred,
    } = await this._optimizeDeferred(meta, sortedDeferred, forceDeferred)

    logInfo('Optimized')
    logDebug({ allDeferred: sortedDeferred, len: sortedDeferred.length })
    logInfo({ optimizedDeferred, len: optimizedDeferred.size })

    return {
      verified: healState.verified,
      includingImplicitsDeferred: pathify(includingImplicitsDeferred),
      deferred: pathify(optimizedDeferred),
      bundle,
      snapshotScript,
      meta,
    }
  }

  async _optimizeDeferred(
    meta: Metadata,
    deferredSortedByLeafness: string[],
    forceDeferred: string[]
  ) {
    const optimizedDeferred: Set<string> = new Set(forceDeferred)

    // 1. Push down defers where possible, i.e. prefer deferring one import instead of an entire module

    // Treat the deferred as an entry point and find an import that would fix the encountered problem
    for (const key of deferredSortedByLeafness) {
      if (forceDeferred.includes(key)) continue
      const imports = meta.inputs[key].imports.map((x) => x.path)
      if (imports.length === 0) {
        optimizedDeferred.add(key)
        logInfo('Optimize: deferred leaf', key)
        continue
      }

      // Check if it was fixed by one of the optimizedDeferred added previously
      if (await this._entryWorksWhenDeferring(key, meta, optimizedDeferred)) {
        logInfo('Optimize: deferring no longer needed for', key)
        continue
      }

      // Defer all imports to verify that the module can be fixed at all, if not give up
      if (
        !(await this._entryWorksWhenDeferring(
          key,
          meta,
          new Set([...optimizedDeferred, ...imports])
        ))
      ) {
        optimizedDeferred.add(key)
        logInfo('Optimize: deferred unfixable parent', key)
        continue
      }

      // Find the one import we need to defer to fix the entry module
      let success = false
      for (const imp of imports) {
        if (
          await this._entryWorksWhenDeferring(
            key,
            meta,
            new Set([...optimizedDeferred, imp])
          )
        ) {
          optimizedDeferred.add(imp)
          logInfo('Optimize: deferred import "%s" of "%s"', imp, key)
          success = true
          break
        }
      }
      if (!success) {
        logDebug(
          `${key} does not need to be deferred, but only when more than one of it's imports are deferred.` +
            `This case is not yet handled, therefore we defer the entire module instead.`
        )
        optimizedDeferred.add(key)
        logInfo('Optimize: deferred parent with >1 problematic import', key)
      }
    }

    const includingImplicitsDeferred = new Set(optimizedDeferred)

    // 2. Find children that don't need to be explicitly deferred since they are via their deferred parent
    const entry = path.relative(this.baseDirPath, this.entryFilePath)
    for (const key of optimizedDeferred) {
      if (forceDeferred.includes(key)) continue
      if (
        await this._entryWorksWhenDeferring(
          entry,
          meta,
          new Set([...optimizedDeferred].filter((x) => x !== key))
        )
      ) {
        optimizedDeferred.delete(key)
        logInfo(
          'Optimize: removing defer of "%s", already deferred implicitly',
          key
        )
      }
    }

    return { optimizedDeferred, includingImplicitsDeferred }
  }

  async _entryWorksWhenDeferring(
    key: string,
    meta: Metadata,
    deferring: Set<string>
  ) {
    const { bundle } = await this._createScript(deferring)
    const snapshotScript = assembleScript(bundle, meta, this.baseDirPath, {
      entryPoint: `./${key}`,
      includeStrictVerifiers: true,
    })
    const healState = new HealState(meta, deferring)
    this._testScript(key, snapshotScript, healState)
    return !healState.needDefer.has(key)
  }

  _getChildren(meta: Metadata, mdl: string) {
    const info = meta.inputs[mdl]
    assert(info != null, `unable to find ${mdl} in the metadata`)
    return info.imports.map((x) => x.path)
  }

  _processCurrentScript(
    bundle: string,
    healState: HealState,
    circulars: Map<string, Set<string>>
  ): string | undefined {
    logInfo('Processing current script')
    let snapshotScript
    for (
      let nextStage = this._findNextStage(healState, circulars);
      nextStage.length > 0;
      nextStage = this._findNextStage(healState, circulars)
    ) {
      for (const key of nextStage) {
        logDebug('Testing entry in isolation "%s"', key)
        snapshotScript = assembleScript(
          bundle,
          healState.meta,
          this.baseDirPath,
          {
            entryPoint: `./${key}`,
            includeStrictVerifiers: true,
          }
        )
        this._testScript(key, snapshotScript, healState)
      }
    }
    return snapshotScript
  }

  _testScript(key: string, snapshotScript: string, healState: HealState) {
    try {
      vm.runInNewContext(snapshotScript, undefined, {
        filename: `./${key}`,
        displayErrors: true,
      })
      healState.verified.add(key)
      logDebug('Successfully verified ...')
    } catch (err) {
      // Cannot log err as is as it may come from inside the VM which in some cases is the Error we modified
      // and thus throws when we try to access err.name
      logDebug(err.toString())
      logInfo(
        '"%s" cannot be loaded for current setup (%d deferred)',
        key,
        healState.deferred.size
      )
      healState.needDefer.add(key)
    }
  }

  async _createScript(
    deferred?: Set<string>
  ): Promise<{ meta: Metadata; bundle: string }> {
    try {
      const deferredArg =
        deferred != null && deferred.size > 0
          ? Array.from(deferred).map((x) => `./${x}`)
          : undefined

      const { meta, bundle } = await createBundle({
        baseDirPath: this.baseDirPath,
        entryFilePath: this.entryFilePath,
        bundlerPath: this.bundlerPath,
        deferred: deferredArg,
      })
      return { meta, bundle }
    } catch (err) {
      logError('Failed creating initial bundle')
      throw err
    }
  }

  _findNextStage(healState: HealState, circulars: Map<string, Set<string>>) {
    const { verified, deferred, needDefer } = healState
    const visited = verified.size + deferred.size + needDefer.size
    return visited === 0
      ? this._findLeaves(healState.meta)
      : this._findVerifiables(healState, circulars)
  }

  _findLeaves(meta: Metadata) {
    const leaves = []
    for (const [key, { imports }] of Object.entries(meta.inputs)) {
      if (imports.length === 0) leaves.push(key)
    }
    return leaves
  }

  _findVerifiables(healState: HealState, circulars: Map<string, Set<string>>) {
    // Finds modules that only depend on previously handled modules
    const verifiables = []
    for (const [key, { imports }] of Object.entries(healState.meta.inputs)) {
      if (healState.needDefer.has(key)) continue
      if (this._wasHandled(key, healState.verified, healState.deferred))
        continue

      const circular = circulars.get(key) ?? new Set()
      const allImportsHandledOrCircular = imports.every(
        (x) =>
          this._wasHandled(x.path, healState.verified, healState.deferred) ||
          circular.has(x.path)
      )
      if (allImportsHandledOrCircular) verifiables.push(key)
    }
    return verifiables
  }

  _wasHandled(key: string, verified: Set<string>, deferred: Set<string>) {
    return verified.has(key) || deferred.has(key)
  }
}
