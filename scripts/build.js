// Empaqueta cada Lambda en un único archivo dist/<nombre>/index.mjs.
// El AWS SDK v3 queda como externo: ya viene en el runtime de Lambda.
//
// Los directorios de src/ se mapean 1:1 con las funciones desplegadas; el
// nombre de la función en AWS se define en scripts/deploy.js.
import { build } from 'esbuild';

const MODULOS = [
  'catalogo',      // pedidos360-catalogo
  'pedidos',       // pedidos360-pedidos
  'publicarevento', // pedidos360-publicar-evento
  'email',         // notificar-email
  'cocina',        // ticket-cocina
  'boleta',        // generar-boleta
  'notificaciones', // notificar-frontend
];

for (const nombre of MODULOS) {
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
