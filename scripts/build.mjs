import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'],
  { cwd: root, stdio: 'inherit', windowsHide: true });
const { build } = await import('tsdown');
await build({ config: fileURLToPath(new URL('../tsdown.config.ts', import.meta.url)) });
