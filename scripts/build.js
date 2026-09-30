// Empaqueta cada Lambda en un único archivo dist/<nombre>/index.mjs.
// El AWS SDK v3 queda como externo: ya viene en el runtime nodejs22.x.
import { build } from 'esbuild';

for (const nombre of ['catalogo', 'pedidos']) {
  await build({
    entryPoints: [`src/${nombre}/index.js`],
    outfile: `dist/${nombre}/index.mjs`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: ['@aws-sdk/*'],
    sourcemap: false,
    minify: false,
    logLevel: 'info',
  });
}
console.log('Build listo en dist/');
