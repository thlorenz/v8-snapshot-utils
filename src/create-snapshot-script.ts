import debug from 'debug'
import { strict as assert } from 'assert'
import { promises as fs } from 'fs'
import path from 'path'
import { execSync, ExecSyncOptions, StdioOptions } from 'child_process'
import { BlueprintConfig, scriptFromBlueprint } from './blueprint'
import { Metadata } from './types'
import {
  CreateBundle,
  packherd,
  CreateBundleOpts as PackherdCreateBundleOpts,
  CreateBundleResult,
} from 'packherd'

const logInfo = debug('snapgen:info')
const logDebug = debug('snapgen:debug')
const logTrace = debug('snapgen:trace')
const logError = debug('snapgen:error')

export const BUNDLE_WRAPPER_OPEN = Buffer.from(
  `
  //
  // <esbuild bundle>
  //
`,
  'utf8'
)

export const BUNDLE_WRAPPER_CLOSE = Buffer.from(
  `
  //
  // </esbuild bundle>
  //

  customRequire.definitions = __commonJS 
`,
  'utf8'
)

export type CreateBundleOpts = {
  baseDirPath: string
  entryFilePath: string
  bundlerPath: string
  nodeModulesOnly: boolean
  deferred?: string[]
  norewrite?: string[]
  includeStrictVerifiers?: boolean
  sourcemap?: boolean
  sourcemapExternalPath?: string
}

export type CreateSnapshotScriptOpts = CreateBundleOpts & {
  auxiliaryData?: Record<string, any>
  nodeEnv: string
}

export type CreateSnapshotScript = (
  opts: CreateSnapshotScriptOpts
) => Promise<{ snapshotScript: string }>

const requireDefinitions = (bundle: Buffer, entryPoint: string) => {
  const code = Buffer.concat([
    BUNDLE_WRAPPER_OPEN,
    bundle,
    BUNDLE_WRAPPER_CLOSE,
  ])
  return {
    code,
    mainModuleRequirePath: entryPoint,
  }
}

function getMainModuleRequirePath(basedir: string, entryFullPath: string) {
  logDebug('Obtaining main module require path given', {
    basedir,
    entryFullPath,
  })
  const relPath = path.relative(basedir, entryFullPath)
  return `./${relPath}`
}

/**
 * Assembles a snapshot script for the provided bundle configured for the
 * provided meta data, basedir and opts.
 *
 * @param bundle contents of the bundle created previously
 * @param basedir project root directory
 * @param entryFilepath
 * @param opts
 *
 * @return the contents of the assembled script
 */
export function assembleScript(
  bundle: Buffer,
  basedir: string,
  entryFilePath: string,
  opts: {
    auxiliaryData?: Record<string, any>
    entryPoint?: string
    includeStrictVerifiers?: boolean
    sourceMap?: Buffer
    nodeEnv: string
  }
): { script: Buffer; processedSourceMap?: string } {
  const includeStrictVerifiers = opts.includeStrictVerifiers ?? false
  const auxiliaryDataString = JSON.stringify(opts.auxiliaryData || {})

  const mainModuleRequirePath =
    opts.entryPoint ?? getMainModuleRequirePath(basedir, entryFilePath)

  assert(
    mainModuleRequirePath != null,
    'metadata should have exactly one entry point'
  )

  const defs = requireDefinitions(bundle, mainModuleRequirePath)

  const config: BlueprintConfig = {
    processPlatform: process.platform,
    processNodeVersion: process.version,
    mainModuleRequirePath: JSON.stringify(defs.mainModuleRequirePath),
    auxiliaryData: auxiliaryDataString,
    customRequireDefinitions: defs.code,
    includeStrictVerifiers,
    sourceMap: opts.sourceMap,
    nodeEnv: opts.nodeEnv,
    basedir,
  }
  return scriptFromBlueprint(config)
}

/**
 * Creates bundle and meta file via the provided bundler written in Go
 * and reads and returns its contents asynchronously.
 *
 * @param opts
 * @return promise of the paths and contents of the created bundle and related metadata
 */
export async function createBundleAsync(opts: CreateBundleOpts): Promise<{
  warnings: CreateBundleResult['warnings']
  meta: Exclude<CreateBundleResult['metafile'], undefined>
  bundle: Buffer
  sourceMap?: Buffer
}> {
  return createBundle(opts)
}

/**
 * Creates a bundle for the provided entry file and then assembles a
 * snapshot script from them.
 *
 * @param opts
 * @return the paths and contents of the created bundle and related metadata
 * as well as the created snapshot script
 */
export async function createSnapshotScript(
  opts: CreateSnapshotScriptOpts
): Promise<{ snapshotScript: Buffer; meta: Metadata; bundle: Buffer }> {
  const { bundle, sourceMap, meta } = await createBundleAsync(opts)

  logDebug('Assembling snapshot script')
  const { processedSourceMap, script } = assembleScript(
    bundle,
    opts.baseDirPath,
    opts.entryFilePath,
    {
      auxiliaryData: opts.auxiliaryData,
      includeStrictVerifiers: opts.includeStrictVerifiers,
      sourceMap,
      nodeEnv: opts.nodeEnv,
    }
  )

  if (opts.sourcemapExternalPath != null && processedSourceMap != null) {
    logInfo('Writing external sourcemaps to "%s"', opts.sourcemapExternalPath)
    await fs.writeFile(opts.sourcemapExternalPath, processedSourceMap, 'utf8')
  }

  return { snapshotScript: script, meta: meta as Metadata, bundle }
}

function stringToBuffer(contents: string) {
  return Buffer.from(contents, 'hex')
}

const makePackherdCreateBundle: (opts: CreateBundleOpts) => CreateBundle =
  (opts: CreateBundleOpts) => (popts: PackherdCreateBundleOpts) => {
    const basedir = path.resolve(process.cwd(), opts.baseDirPath)
    const cmd =
      opts.bundlerPath +
      ` --basedir=${basedir}` +
      (opts.deferred != null && opts.deferred.length > 0
        ? ` --deferred='${opts.deferred.join(',')}'`
        : '') +
      (opts.norewrite != null && opts.norewrite.length > 0
        ? ` --norewrite='${opts.norewrite.join(',')}'`
        : '') +
      ' --metafile' +
      ` ${popts.entryFilePath}` +
      (!!opts.includeStrictVerifiers ? ' --doctor' : '') +
      (!!opts.sourcemap ? ' --sourcemap' : '')

    logTrace('Running "%s"', cmd)

    const _MB = 1024 * 1024
    const execOpts: ExecSyncOptions = Object.assign(
      {
        maxBuffer: 200 * _MB,
        cwd: basedir,
      },
      // Windows doesn't properly support piping stdio
      process.platform === 'win32'
        ? {}
        : { stdio: ['pipe', 'pipe', 'ignore'] as StdioOptions }
    )

    try {
      const stdout = execSync(cmd, execOpts)
      const { warnings, outfiles, metafile } = JSON.parse(stdout.toString())

      assert(outfiles.length >= 1, 'need at least one outfile')
      assert(metafile != null, 'expected metafile to be included in result')
      assert(
        metafile.contents != null,
        'expected metafile to include contents buffer'
      )

      const bundleContents = outfiles[0].contents
      const bundle = { contents: stringToBuffer(bundleContents) }

      const includedSourcemaps = outfiles.length === 2
      if (!!opts.sourcemap) {
        assert(
          includedSourcemaps,
          'should include sourcemap when --sourcemap is provided'
        )
      } else {
        assert(
          !includedSourcemaps,
          'should only include sourcemap when --sourcemap is provided'
        )
      }
      const sourceMap = includedSourcemaps
        ? { contents: stringToBuffer(outfiles[1].contents) }
        : undefined

      const metadata: Metadata = JSON.parse(
        stringToBuffer(metafile.contents).toString()
      )
      const result: CreateBundleResult = {
        warnings,
        outputFiles: [bundle],
        sourceMap,
        metafile: metadata,
      }
      return Promise.resolve(result)
    } catch (err) {
      if (err.stderr != null) {
        logError(err.stderr.toString())
      }
      if (err.stdout != null) {
        logDebug(err.stdout.toString())
      }
      logError(err)
      return Promise.reject(new Error(`Failed command: "${cmd}"`))
    }
  }

async function createBundle(opts: CreateBundleOpts) {
  const { warnings, bundle, sourceMap, meta } = await packherd({
    entryFile: opts.entryFilePath,
    nodeModulesOnly: opts.nodeModulesOnly,
    createBundle: makePackherdCreateBundle(opts),
  })
  return { warnings, bundle, sourceMap, meta }
}
