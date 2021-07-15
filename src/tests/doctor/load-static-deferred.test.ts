import spok from 'spok'
import path from 'path'
import test from 'tape'
import { readResult } from './utils/bundle'
import { SnapshotGenerator } from '../../snapshot-generator'
import { Flag } from '../../snapshot-generator-flags'

const projectBaseDir = path.join(__dirname, 'fixtures', 'load-static-deferred')
const cacheDir = path.join(projectBaseDir, 'cache')
const snapshotEntryFile = path.join(projectBaseDir, 'entry.js')

test('doctor: entry points to dependents of a module that is statically deferred', async (t) => {
  const generator = new SnapshotGenerator(projectBaseDir, snapshotEntryFile, {
    cacheDir,
    nodeModulesOnly: false,
    includeStrictVerifiers: true,
    flags: Flag.Script,
  })
  await generator.createExportBundle()
  const { meta, exported } = readResult(cacheDir)

  spok(t, meta, {
    $topic: 'snapshot meta',
    norewrite: [],
    deferred: [
      './loads-lateuses-static-deferred.js',
      './loads-static-deferred.js',
      './static-deferred.js',
      './uses-loads-static-deferred.js',
    ],
    healthy: [
      './entry.js',
      './lateuses-static-deferred.js',
      './uses-lateuses-static-deferred.js',
    ],
  })
  spok(
    t,
    { keys: Object.keys(exported) },
    {
      $topic: 'exported',
      keys: [
        './static-deferred.js',
        './loads-static-deferred.js',
        './lateuses-static-deferred.js',
        './uses-loads-static-deferred.js',
        './uses-lateuses-static-deferred.js',
        './loads-lateuses-static-deferred.js',
        './entry.js',
      ],
    }
  )
  t.end()
})
