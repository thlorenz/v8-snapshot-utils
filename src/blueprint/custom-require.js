//
// <custom-require>
//
let require = (moduleName) => {
  throw new Error(
    `[SNAPSHOT_CACHE_FAILURE] Cannot require module "${moduleName}"`
  )
}

// Some modules check for `module.parent` in order to to determine if they are
// run from CLI or are being required.
// Providing an empty one fixes those cases. Once that isn't sufficient we'll
// need to pass the `module` from `require` calls generated by esbuild.
function customRequire(modulePath, parent = {}) {
  let module = customRequire.cache[modulePath]

  if (!module) {
    // NOTE: the modulePath may be relative to the projectBaseDir, however since
    // access to __dirname/__filename is redirected to a path resolver via the esbuild
    // snapshot rewriter we don't have to "fix" it here.
    // @see ../loading/snapshot-require.ts
    const filename = modulePath
    const dirname = filename.split('/').slice(0, -1).join('/')

    module = {
      exports: {},
      children: [],
      loaded: true,
      parent,
      paths: (parent != null && parent.paths) || [],
      require: customRequire,
      filename,
      id: filename,
      path: filename,
    }

    function define(callback) {
      callback(customRequire, module.exports, module)
    }

    if (customRequire.definitions.hasOwnProperty(modulePath)) {
      module.parent = parent
      customRequire.cache[modulePath] = module
      customRequire.definitions[modulePath].apply(module.exports, [
        module.exports,
        module,
        filename,
        dirname,
        customRequire,
        define,
      ])
    } else if (coreStubs.hasOwnProperty(modulePath)) {
      module.exports = coreStubs[modulePath]
      // we don't cache core modules but only serve stubs to not break snapsshotting
    } else {
      try {
        module.exports = require(modulePath)
        customRequire.cache[modulePath] = module
      } catch (err) {
        // If we're running in doctor (strict) mode avoid trying to resolve core modules by path
        if (require.isStrict) {
          throw err
        } else {
          debugger
          throw new Error(`Failed to require ${modulePath}.\n${err.toString()}`)
        }
      }
    }
  }

  return module.exports
}

customRequire.extensions = {}
customRequire.cache = {}

customRequire.resolve = function (mod) {
  try {
    return require.resolve(mod)
  } catch (err) {
    // console.error(err.toString())
    // console.error('Failed to resolve', mod)
    // debugger
    throw err
  }
}
//
// </custom-require>
//
