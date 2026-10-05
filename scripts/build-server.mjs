// Bundle the server to dist/server with esbuild; dependencies stay external.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/index.ts', 'src/server/migrate.ts', 'src/server/cli.ts'],
  outdir: 'dist/server',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
