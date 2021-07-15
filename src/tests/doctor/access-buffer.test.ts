import spok from 'spok'
import path from 'path'
import test from 'tape'
import { readResult } from './utils/bundle'
import { SnapshotGenerator } from '../../snapshot-generator'
import { Flag } from '../../snapshot-generator-flags'

const projectBaseDir = path.join(__dirname, 'fixtures', 'access-buffer')
const cacheDir = path.join(projectBaseDir, 'cache')
const snapshotEntryFile = path.join(projectBaseDir, 'entry.js')

test('snapshot: entry points two modules, one accessing Buffer', async (t) => {
  const generator = new SnapshotGenerator(projectBaseDir, snapshotEntryFile, {
    cacheDir,
    nodeModulesOnly: false,
    flags: Flag.Script,
  })
  await generator.createExportBundle()
  const { meta, exported } = readResult(cacheDir)

  spok(t, meta, {
    $topic: 'snapshot meta',
    norewrite: [],
    deferred: ['./accessing-buffer.js'],
    healthy: ['./entry.js', './valid-module.js'],
  })
  spok(
    t,
    { keys: Object.keys(exported) },
    {
      $topic: 'exported',
      keys: ['./valid-module.js', './accessing-buffer.js', './entry.js'],
    }
  )
  t.end()
})
