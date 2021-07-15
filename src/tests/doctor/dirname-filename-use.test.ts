import spok from 'spok'
import path from 'path'
import test from 'tape'
import { readResult } from './utils/bundle'
import { SnapshotGenerator } from '../../snapshot-generator'
import { Flag } from '../../snapshot-generator-flags'

const projectBaseDir = path.join(__dirname, 'fixtures', 'dirname-filename-use')
const cacheDir = path.join(projectBaseDir, 'cache')
const snapshotEntryFile = path.join(projectBaseDir, 'entry.js')

test('snapshot: using dir/file name delayed and during init ', async (t) => {
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
    deferred: ['./using-filename-init.js'],
    healthy: ['./entry.js', './using-dirname-delayed.js', './valid-module.js'],
  })
  spok(
    t,
    { keys: Object.keys(exported) },
    {
      $topic: 'exported',
      keys: [
        './valid-module.js',
        './using-dirname-delayed.js',
        './using-filename-init.js',
        './entry.js',
      ],
    }
  )
  t.end()
})
