import fs from 'fs'
import { createVerifyModuleCanBeLoaded } from './verify-loadable-modules'

import debug from 'debug'
const logInfo = debug('snapgen:info')

function read(part: string, indent = '  ') {
  const p = require.resolve(`./blueprint/${part}`)
  const s = fs.readFileSync(p, 'utf8')
  return s.split('\n').join(`\n${indent}`)
}

const globals = read('globals')
const strictGlobals = read('globals-strict')
const customRequire = read('custom-require')
const setGlobals = read('set-globals')

export type BlueprintConfig = {
  processPlatform: string
  processNodeVersion: string
  mainModuleRequirePath: string
  auxiliaryData: string
  customRequireDefinitions: Buffer
  includeStrictVerifiers: boolean
  nodeEnv: string
  unloadableModules: string[]
}
export function scriptFromBlueprint(config: BlueprintConfig) {
  const {
    processPlatform,
    processNodeVersion,
    mainModuleRequirePath,
    auxiliaryData,
    customRequireDefinitions,
    includeStrictVerifiers,
    nodeEnv,
  } = config

  const verifyModuleCanBeLoaded = config.includeStrictVerifiers
    ? createVerifyModuleCanBeLoaded(config.unloadableModules)
    : 'function verifyModuleCanBeLoaded(moduleName) {}'

  logInfo({
    unloadables: config.unloadableModules.length,
    verify: config.includeStrictVerifiers,
  })

  const wrapperOpen = Buffer.from(
    `
var snapshotAuxiliaryData = ${auxiliaryData}

function generateSnapshot() {
  //
  // <process>
  //
  function cannotAccess(proto, prop) {
    return function () {
      throw 'Cannot access ' + proto + '.' + prop + ' during snapshot creation'
    }
  }
  function getPrevent(proto, prop) {
    return {
      get: cannotAccess(proto, prop)
    }
  }

  let process = {}
  Object.defineProperties(process, {
    platform: {
      value: '${processPlatform}',
      enumerable: false,
    },
    argv: {
      value: [],
      enumerable: false,
    },
    env: {
      value: {
        NODE_ENV: '${nodeEnv}',
      },
      enumerable: false,
    },
    version: {
      value: '${processNodeVersion}',
      enumerable: false,
    },
    versions: {
      value: { node: '${processNodeVersion}' },
      enumerable: false,
    },
    nextTick: getPrevent('process', 'nextTick')
  })

  function get_process() {
    return process
  }
  //
  // </process>
  //

  ${globals}
  ${includeStrictVerifiers ? strictGlobals : ''}

  const coreStubs = {
  }
`,
    'utf8'
  )
  const wrapperClose = Buffer.from(
    `
  ${verifyModuleCanBeLoaded}
  ${customRequire}
  ${includeStrictVerifiers ? 'require.isStrict = true' : ''}

  customRequire(${mainModuleRequirePath})
  return {
    customRequire,
    setGlobals: ${setGlobals},
  }
}

snapshotAuxiliaryData.snapshotSections = []
var snapshotResult = generateSnapshot.call({})

generateSnapshot = null
`,
    'utf8'
  )

  return Buffer.concat([wrapperOpen, customRequireDefinitions, wrapperClose])
}
