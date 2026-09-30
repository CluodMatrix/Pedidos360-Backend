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
