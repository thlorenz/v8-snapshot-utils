const { execSync } = require('child_process')
const { binary } = require('snapbuild')

execSync(`${binary} --help`)
