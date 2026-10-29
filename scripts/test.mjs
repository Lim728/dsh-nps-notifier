import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../tests', import.meta.url));
const suites = ['restored-ready-tests.mjs', 'finished-resume-tests.mjs', 'permanent-lifecycle-tests.mjs', 'packaged-loader-tests.mjs', 'reception-capture-tests.mjs'];
for (const suite of suites) {
  const guard = suite === 'packaged-loader-tests.mjs' ? [] : ['--import', './offline-network-guard.mjs'];
  const output = execFileSync(process.execPath, [...guard, suite], { cwd, encoding: 'utf8', timeout: 120000, windowsHide: true });
  if (!/"failed"\s*:\s*0/.test(output)) throw new Error('missing_suite_success');
  console.log(JSON.stringify({ suite, result: output.trim() }));
}
console.log(JSON.stringify({ suites: suites.length, failed: 0, skipped: 0 }));
