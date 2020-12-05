import { strict as assert } from 'assert'
import debug from 'debug'
import fs from 'fs'
import path from 'path'
import { SnapshotDoctor } from './snapshot-doctor'
import { canAccess, createHashForFile, matchFileHash } from './utils'

const logInfo = debug('snapgen:info')

export async function determineDeferred(
  bundlerPath: string,
  projectBaseDir: string,
  snapshotEntryFile: string,
  cacheDir: string
) {
  const hashFilePath = await findHashFile(projectBaseDir)
  assert(
    hashFilePath != null,
    `Unable to find hash file inside ${projectBaseDir}`
  )

  const jsonPath = path.join(cacheDir, 'snapshot-meta.json')

  const { match, hash, deferred } = await validateExistingDeferred(
    jsonPath,
    hashFilePath
  )
  if (match) return deferred

  logInfo(
    'Did not find valid excludes for current project state, will determine them ...'
  )

  const doctor = new SnapshotDoctor({
    bundlerPath,
    entryFilePath: snapshotEntryFile,
    baseDirPath: projectBaseDir,
  })

  const { deferred: updatedDeferred } = await doctor.heal()
  const deferredHashFile = path.relative(projectBaseDir, hashFilePath)
  const cachedDeferred = {
    deferred: updatedDeferred,
    deferredHashFile,
    deferredHash: hash,
  }

  await fs.promises.writeFile(
    jsonPath,
    JSON.stringify(cachedDeferred, null, 2),
    'utf8'
  )
  return updatedDeferred
}

async function validateExistingDeferred(
  jsonPath: string,
  hashFilePath: string
) {
  if (!(await canAccess(jsonPath))) {
    const hash = await createHashForFile(hashFilePath)
    return { deferred: [], match: false, hash }
  }
  const { deferredHash, deferred } = require(jsonPath)
  const res = await matchFileHash(hashFilePath, deferredHash)
  return { deferred, match: res.match, hash: res.hash }
}

async function findHashFile(projectBaseDir: string) {
  const yarnLock = path.join(projectBaseDir, 'yarn.lock')
  const packageLock = path.join(projectBaseDir, 'package.json.lock')
  const packageJson = path.join(projectBaseDir, 'package.json')

  for (const x of [yarnLock, packageLock, packageJson]) {
    if (await canAccess(x)) return x
  }
}