import path from 'path'
import spok from 'spok'
import test from 'tape'
import { SnapshotGenerator } from '../../snapshot-generator'
import { exec as execOrig } from 'child_process'
import { promisify } from 'util'

if (process.platform == 'darwin') {
  const exec = promisify(execOrig)

  const projectBaseDir = path.join(__dirname, 'fixtures', 'native-modules')
  const cacheDir = path.join(projectBaseDir, 'cache')
  const snapshotEntryFile = path.join(projectBaseDir, 'entry.js')
  const v8snapshotRoot = path.join(__dirname, '..', '..', '..')

  test('native modules: app loading and using fsevents which has native module component', async (t) => {
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
      spok(t, res, { itemIsDir: 131072 })
    } catch (err) {
      t.fail(err.toString())
    }
  })
}
