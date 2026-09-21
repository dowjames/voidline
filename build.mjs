import * as esbuild from 'esbuild';

const common = {
  bundle: true,
  format: 'iife',
  target: 'es2022',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
};

await esbuild.build({ ...common, entryPoints: ['src/main.js'], outfile: 'dist/game.js' });
await esbuild.build({ ...common, entryPoints: ['src/bench-entry.js'], outfile: 'dist/bench.js' });
console.log('built dist/game.js + dist/bench.js');
