import { blueBright, gray, green, yellow } from 'ansi-colors'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import path from 'path'
import resolveFrom from 'resolve-from'

import debug from 'debug'
const logDebug = debug('snapgen:debug')

const BUNDLERS = new Map([
  ['darwin-x64', require.resolve('snapbuild-darwin-x64/bin/snapshot')],
])

export function getBundlerPath() {
  if (process.env.SNAPSHOT_BUNDLER != null) {
    const bundler = path.resolve(process.env.SNAPSHOT_BUNDLER)
    logDebug('Using provided SNAPSHOT_BUNDLER (%s)', bundler)
    return bundler
  }

  const platformKey = `${os.platform()}-${os.arch()}`
  const bundler = BUNDLERS.get(platformKey)
  if (bundler == null) {
    throw new Error(
      `No snapshot bundler known for your platform ${platformKey}\n` +
        `Please provide the path to the executable via 'SNAPSHOT_BUNDLER=/path/to/snapshot'`
    )
  }
  logDebug('Using installed snapshot bundler (%s)', bundler)
  return bundler
}

function canAccessSync(p: string) {
  try {
    fs.accessSync(p)
    return true
  } catch (_) {
    return false
  }
}

export function createHash(s: Buffer) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export async function createHashForFile(p: string) {
  const contents = await tryReadFile(p)
  if (contents == null) throw new Error(`Cannot obtain hash for '${p}`)
  return createHash(contents)
}

export function bundleFileNameFromHash(hash: string) {
  return `bundle.${hash}.js`
}

export async function canAccess(p: string) {
  try {
    await fs.promises.access(p)
    return true
  } catch (_) {
    return false
  }
}

export async function tryReadFile(p: string): Promise<Buffer | undefined> {
  if (!(await canAccess(p))) return
  return fs.promises.readFile(p)
}

export async function tryRemoveFile(p: string) {
  if (!(await canAccess(p))) {
    return new Error(`Cannot access ${p} in order to delete it`)
  }
  try {
    await fs.promises.unlink(p)
  } catch (err) {
    return err
  }
}

export async function matchFileHash(p: string, hash: string) {
  const contents = await tryReadFile(p)
  if (contents == null) throw new Error(`Cannot obtain hash for '${p}`)
  const currentHash = createHash(contents)
  return { hash: currentHash, match: hash === currentHash }
}

export function ensureDirSync(dir: string) {
  if (!canAccessSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    return
  }
  // dir already exists, make sure it isn't a file
  const stat = fs.statSync(dir)
  if (!stat.isDirectory()) {
    throw new Error(`'${dir}' is not a directory`)
  }
}

export function checkFileSync(p: string) {
  if (!canAccessSync(p)) throw new Error(`Unable to find '${p}'`)
  const stat = fs.statSync(p)
  if (!stat.isFile()) throw new Error(`${p} is not a file`)
}

export function checkDirSync(p: string) {
  if (!canAccessSync(p)) throw new Error(`Unable to find '${p}'`)
  const stat = fs.statSync(p)
  if (!stat.isDirectory()) throw new Error(`${p} is not a directory`)
}

export function fileExistsSync(p: string) {
  try {
    checkFileSync(p)
    return true
  } catch (_) {
    return false
  }
}

export function resolveElectronVersion(root: string): string {
  const electron = resolveFrom(root, 'electron')
  return require(path.join(path.dirname(electron), 'package.json')).version
}

export function backupName(orig: string) {
  const file = path.basename(orig)
  const ext = path.extname(orig)
  return `${file}.orig.${ext}`
}

export function electronSnapshotPath(root: string, v8ContextFile: string) {
  const electron = path.dirname(resolveFrom(root, 'electron'))
  let location
  switch (process.platform) {
    case 'darwin': {
      location =
        'dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources'
      break
    }
    case 'linux':
    case 'openbsd':
    case 'sunos':
    case 'win32':
    case 'cygwin':
    case 'netbsd': {
      location = 'dist'
      break
    }

    default: {
      throw new Error(`Platform not supported ${process.platform}`)
    }
  }

  const snapshotLocation = path.join(electron, location)
  return path.join(snapshotLocation, v8ContextFile)
}
// at Object.__commonJS../node_modules/mute-stream/mute.js (/Volumes/d/dev/cy/perf-tr1/v8-snapshot/example-multi/cache/snapshot.js:10555:43)
const commonJsModuleRx = /(at Object.__commonJS\.)([^(]+)([^ :]+) *:(\d+)(.+)/
export function prettyPrintError(err: Error, baseDirPath: string) {
  if (
    !(
      err.stack != null &&
      (err.message.includes('Cannot require module') ||
        commonJsModuleRx.test(err.stack))
    )
  ) {
    console.error(err)
    return
  }

  console.error(err.message)
  const frames = err.stack.split('\n')

  const locations = []
  const prettyFrames = []
  for (const frame of frames) {
    const match = frame.match(commonJsModuleRx)
    if (match == null) {
      prettyFrames.push(frame)
      continue
    }
    const parts = {
      atObject: match[1],
      requireString: match[2].trimEnd(),
      snapshotPath: match[3],
      lineno: match[4],
      rest: match[5],
    }
    prettyFrames.push(
      `${gray(parts.atObject)} ${green(parts.requireString)}` +
        `${gray(parts.snapshotPath)}` +
        `:${blueBright(parts.lineno)}${gray(')')}`
    )
    const fullPath = path.resolve(baseDirPath, parts.requireString)
    locations.push(
      `${parts.requireString} ${gray('at snapshot:' + parts.lineno)} (${gray(
        fullPath
      )})`
    )
  }
  console.error(prettyFrames.join('\n'))

  console.error(yellow('\nRequire Definitions Stack:'))
  console.error('  %s', green(locations.join('\n  ')))
}
