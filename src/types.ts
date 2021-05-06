import type { CreateBundleResult } from 'packherd'

export type Entries<T> = {
  [K in keyof T]: [K, T[K]]
}[keyof T][]

export type Metadata = CreateBundleResult['metafile'] & {
  inputs: Record<
    string,
    {
      bytes: number
      fileInfo: {
        fullPath: string
      }
      imports: { path: string }[]
    }
  >
}

export type ProcessScriptOpts = {
  bundleHash: string
  bundlePath: string

  baseDirPath: string
  entryFilePath: string
  entryPoint: string

  nodeEnv: string
  unloadableModules: string[]
}

export type ProcessScriptResult = {
  outcome: 'failed:assembleScript' | 'failed:verifyScript' | 'completed'
  error?: Error
}
export type BundleAndProcessScriptResult = {
  outcome: 'failed:bundleScript' | ProcessScriptResult['outcome']
  error?: Error
}

export type ModuleDefinition = (
  exports: NodeModule['exports'],
  module: { exports: NodeModule['exports'] },
  __filename: string,
  __dirname: string,
  require: NodeRequireFunction
) => NodeModule

export type SnapshotResult = {
  customRequire: {
    cache: Record<string, NodeModule>
    definitions: Record<string, ModuleDefinition>
  }
}

export type ModuleResolveResult = {
  resolved: 'module' | 'path'
  fullPath: string
  relPath: string
}

export type ModuleLoadResult = ModuleResolveResult & {
  exports: NodeModule
  origin: 'cache' | 'definitions' | 'Module._load'
}

export type ModuleBuildin = typeof import('module') & {
  _resolveFilename(
    moduleUri: string,
    parent: NodeModule | undefined,
    isMain: boolean
  ): string
  _load(
    request: string,
    parent: NodeModule | undefined,
    isMain: boolean
  ): NodeModule
  _cache: Record<string, NodeModule>
}

export type Snapshot = {
  customRequire: {
    definitions: Record<string, NodeRequireFunction>
    cache: Record<string, NodeModule>
  }
}
