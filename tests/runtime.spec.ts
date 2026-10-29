/** Isolated protocol regressions and real Loader composition for the shipped plugin. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const directory = fileURLToPath(new URL('.', import.meta.url))

for (const suite of ['restored-ready-tests.mjs', 'finished-resume-tests.mjs', 'permanent-lifecycle-tests.mjs', 'packaged-loader-tests.mjs', 'reception-capture-tests.mjs']) {
  it(suite, () => {
    const args = suite === 'packaged-loader-tests.mjs' ? [] : ['--import', './offline-network-guard.mjs']
    const output = execFileSync(process.execPath, [...args, suite], { cwd: directory, encoding: 'utf8', timeout: 120000, windowsHide: true })
    expect(output).toMatch(/"failed"\s*:\s*0/)
  }, 125000)
}
