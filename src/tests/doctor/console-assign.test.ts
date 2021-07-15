import spok from 'spok'
import path from 'path'
import test from 'tape'
import { readResult } from './utils/bundle'
import { SnapshotGenerator } from '../../snapshot-generator'
import { Flag } from '../../snapshot-generator-flags'

const projectBaseDir = path.join(__dirname, 'fixtures', 'console-assign')
const cacheDir = path.join(projectBaseDir, 'cache')
const snapshotEntryFile = path.join(projectBaseDir, 'entry.js')

test('snapshot: entry points modules using and one reassigning console ', async (t) => {
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
    deferred: [],
    healthy: ['./entry.js', './reassign-console.js', './using-console.js'],
  })
  spok(
    t,
    { keys: Object.keys(exported).sort() },
    {
      $topic: 'exported',
      keys: ['./entry.js', './reassign-console.js', './using-console.js'],
    }
  )
  const reassign = exported['./reassign-console.js'].toString()
  t.ok(
    reassign.includes('typeof get_console()'),
    'reassign-console.js: does rewrite typeof console'
  )
  t.ok(
    reassign.includes('get_console().log'),
    'reassign-console.js: does rewrite typeof console.log'
  )
  t.ok(
    !reassign.includes('get_console() = function') &&
      reassign.includes('console = function'),
    'reassign-console.js: does not rewrite console ='
  )
  t.ok(
    exported['./using-console.js'].toString().includes('get_console'),
    'using-console.js: does rewrite console'
  )
  t.end()
})
