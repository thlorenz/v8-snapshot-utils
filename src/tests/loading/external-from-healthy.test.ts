import path from 'path'
import test from 'tape'
import { SnapshotGenerator } from '../../snapshot-generator'
import { exec as execOrig } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execOrig)

const projectBaseDir = path.join(__dirname, 'fixtures', 'external-from-healthy')
const cacheDir = path.join(projectBaseDir, 'cache')
const snapshotEntryFile = path.join(projectBaseDir, 'entry.js')
const v8snapshotRoot = path.join(__dirname, '..', '..', '..')

test('negotiator: healthy module requires an external one', async (t) => {
  const generator = new SnapshotGenerator(projectBaseDir, snapshotEntryFile, {
    cacheDir,
    nodeModulesOnly: false,
  })
  await generator.createScript()
  await generator.makeAndInstallSnapshot()

  const env: Record<string, any> = {
    ELECTRON_RUN_AS_NODE: 1,
    DEBUG: '(packherd|snapgen):*',
    PROJECT_BASE_DIR: projectBaseDir,
    DEBUG_COLORS: 1,
  }
  const cmd =
    `node ${v8snapshotRoot}/node_modules/.bin/electron` +
    ` -r ${projectBaseDir}/hook-require.js` +
    ` ${projectBaseDir}/app.js`

  try {
    const { stdout } = await exec(cmd, { env })
    const res = JSON.parse(stdout.trim())
    t.equal(res.healthyString, 'FAKE BLUEBIRD')
  } catch (err) {
    t.fail(err.toString())
  }
})
