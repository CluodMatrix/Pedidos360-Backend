// Crea las tablas de DynamoDB (modo on-demand: sin capacidad provisionada, sin costo fijo).
//   node scripts/create-tables.js
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';

const region = process.env.AWS_REGION ?? 'us-east-1';
const client = new DynamoDBClient({ region });

const TABLE_PRODUCTOS = process.env.TABLE_PRODUCTOS ?? 'Pedidos360-Productos';
const TABLE_PEDIDOS = process.env.TABLE_PEDIDOS ?? 'Pedidos360-Pedidos';
const TABLE_EVENTOS = process.env.TABLE_EVENTOS_PROCESADOS ?? 'Pedidos360-EventosProcesados';
const TABLE_NOTIFICACIONES = process.env.TABLA_NOTIFICACIONES ?? 'Pedidos360-Notificaciones';

const tablas = [
  {
    TableName: TABLE_PRODUCTOS,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
  },
  {
    TableName: TABLE_PEDIDOS,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'S' },
      { AttributeName: 'clienteId', AttributeType: 'S' },
      { AttributeName: 'fechaCreacion', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    // Permite que un Cliente liste SUS pedidos con Query (sin Scan de toda la tabla).
    GlobalSecondaryIndexes: [
      {
        IndexName: 'clienteId-fechaCreacion-index',
        KeySchema: [
          { AttributeName: 'clienteId', KeyType: 'HASH' },
          { AttributeName: 'fechaCreacion', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    // Idempotencia de los consumidores de SQS: se reclama el evento antes de
    // procesarlo, asi un mensaje redentregado no se procesa dos veces.
    // Clave COMPUESTA (eventId + consumidor): el mismo evento lo reciben varias
    // colas por el fan-out, y cada consumidor lo procesa una vez por su cuenta.
    TableName: TABLE_EVENTOS,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'eventId', AttributeType: 'S' },
      { AttributeName: 'consumidor', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'eventId', KeyType: 'HASH' },
      { AttributeName: 'consumidor', KeyType: 'RANGE' },
    ],
  },
  {
    // Eventos ya consumidos que la interfaz muestra como notificaciones.
    // El GSI tiene una clave de particion constante ("clave") y la fecha como
    // rango: asi se pueden pedir las MAS RECIENTES con un Query (no un Scan
    // de toda la tabla).
    TableName: TABLE_NOTIFICACIONES,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'S' },
      { AttributeName: 'clave', AttributeType: 'S' },
      { AttributeName: 'fecha', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'notificaciones-fecha-index',
        KeySchema: [
          { AttributeName: 'clave', KeyType: 'HASH' },
          { AttributeName: 'fecha', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
];

async function existe(TableName) {
  try {
    await client.send(new DescribeTableCommand({ TableName }));
    return true;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

for (const tabla of tablas) {
  if (await existe(tabla.TableName)) {
    console.log(`= ${tabla.TableName} ya existe, se omite.`);
    continue;
  }
  await client.send(new CreateTableCommand(tabla));
  await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: tabla.TableName });
  console.log(`+ ${tabla.TableName} creada (${region}).`);
}
