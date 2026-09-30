// Carga los 6 productos de demostración (mismos IDs, precios y stock que Comprar.tsx del frontend).
//   node scripts/seed.js            -> inserta solo los que no existen (no toca el stock actual)
//   node scripts/seed.js --reset    -> sobrescribe todos (restablece el stock inicial)
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const region = process.env.AWS_REGION ?? 'us-east-1';
const TABLE_PRODUCTOS = process.env.TABLE_PRODUCTOS ?? 'Pedidos360-Productos';
const reset = process.argv.includes('--reset');
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

const PRODUCTOS = [
  { id: 'prod-teclado-001', nombre: 'Teclado Mecánico Compacto', descripcion: 'Teclado compacto para trabajo y estudio.', precio: 39990, stock: 20 },
  { id: 'prod-mouse-002', nombre: 'Mouse Inalámbrico', descripcion: 'Mouse ergonómico para uso diario.', precio: 18990, stock: 30 },
  { id: 'prod-audifonos-003', nombre: 'Audífonos USB', descripcion: 'Audífonos con micrófono integrado.', precio: 24990, stock: 15 },
  { id: 'prod-webcam-004', nombre: 'Webcam Full HD', descripcion: 'Cámara para reuniones y videollamadas.', precio: 32990, stock: 12 },
  { id: 'prod-hub-005', nombre: 'Hub USB-C', descripcion: 'Adaptador multipuerto para notebook.', precio: 28990, stock: 18 },
  { id: 'prod-soporte-006', nombre: 'Soporte para Notebook', descripcion: 'Soporte ajustable para escritorio.', precio: 21990, stock: 25 },
];

const ahora = new Date().toISOString();
for (const producto of PRODUCTOS) {
  try {
    await db.send(new PutCommand({
      TableName: TABLE_PRODUCTOS,
      Item: { ...producto, fechaCreacion: ahora, fechaActualizacion: ahora },
      ...(reset ? {} : { ConditionExpression: 'attribute_not_exists(id)' }),
    }));
    console.log(`+ ${producto.id}`);
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') console.log(`= ${producto.id} ya existe, se omite.`);
    else throw err;
  }
}
