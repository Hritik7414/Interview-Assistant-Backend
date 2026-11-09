// Production build: bundles the server and its vendored protocol contract (src/shared)
// into dist/server.js. Third-party dependencies stay external (installed at runtime).
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {});

await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // Resolves the `@shared` alias from tsconfig.json.
  tsconfig: 'tsconfig.json',
  external: [...external, 'pino-pretty'],
  logLevel: 'info',
});
