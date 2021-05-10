export function createVerifyModuleCanBeLoaded(
  unloadableModules: string[]
): string {
  const unloadableModulesStr = JSON.stringify(unloadableModules)
  const unloadables = `const unloadables = new Set(${unloadableModulesStr})`

  return `
  ${unloadables}
  function verifyModuleCanBeLoaded(moduleName) {
     if (unloadables.has(moduleName)) {
        throw new Error(
          '[SNAPSHOT_CACHE_FAILURE] Cannot load deferred or norewrite module "' +
          moduleName + '"' +
          ' during snapshot creation'
        )
     }
  }
  `
}
