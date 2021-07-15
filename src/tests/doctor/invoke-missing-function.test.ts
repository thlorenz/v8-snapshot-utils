import spok from 'spok'
import path from 'path'
import test from 'tape'
import { readResult } from './utils/bundle'
import { SnapshotGenerator } from '../../snapshot-generator'
import { Flag } from '../../snapshot-generator-flags'

const projectBaseDir = path.join(
  __dirname,
  'fixtures',
  'invoke-missing-function'
)
const cacheDir = path.join(projectBaseDir, 'cache')
const snapshotEntryFile = path.join(projectBaseDir, 'entry.js')

test('snapshot: entry points to modules, with missing functions', async (t) => {
  const generator = new SnapshotGenerator(projectBaseDir, snapshotEntryFile, {
    cacheDir,
    nodeModulesOnly: false,
    flags: Flag.Script,
  })
  await generator.createExportBundle()
  const { meta, exported } = readResult(cacheDir)

  spok(t, meta, {
    $topic: 'snapshot meta',
    norewrite: ['./invoke-not-function.js', './invoke-undefined.js'],
    deferred: ['./invoke-push-on-undefined.js'],
    healthy: ['./entry.js', './valid-module.js'],
  })
  spok(
    t,
    { keys: Object.keys(exported) },
    {
      $topic: 'exported',
      keys: [
        './valid-module.js',
        './invoke-not-function.js',
        './invoke-undefined.js',
        './invoke-push-on-undefined.js',
        './entry.js',
      ],
    }
  )
  t.end()
})
