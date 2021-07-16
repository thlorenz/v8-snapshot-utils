const { execSync } = require('child_process')
const { binary } = require('snapbuild')
const path = require('path')

const baseDir = path.join(
  __dirname,
  '..',
  'dist',
  'tests',
  'doctor',
  'fixtures',
  'access-buffer'
)
const metaFile = path.join(baseDir, 'entry.js')

const args = `--basedir=${baseDir} --metafile ${metaFile} --doctor`
const stdout = execSync(`${binary} ${args}`, {
  cwd: baseDir,
  stdio: ['pipe', 'pipe', 'ignore'],
})
console.log(stdout.toString())
