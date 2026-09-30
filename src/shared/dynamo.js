// Cliente DynamoDB compartido por las dos Lambdas.
// El SDK v3 ya viene incluido en el runtime nodejs22.x de Lambda, por eso
// el build lo deja como dependencia externa (no se empaqueta).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

export const TABLE_PRODUCTOS = process.env.TABLE_PRODUCTOS ?? 'Pedidos360-Productos';
export const TABLE_PEDIDOS = process.env.TABLE_PEDIDOS ?? 'Pedidos360-Pedidos';
export const INDEX_PEDIDOS_CLIENTE = 'clienteId-fechaCreacion-index';

export const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

// Scan/Query devuelven máximo 1 MB por llamada: se sigue paginando hasta el final.
async function paginate(Command, params) {
  const items = [];
  let startKey;
  do {
    const result = await db.send(new Command({ ...params, ExclusiveStartKey: startKey }));
    items.push(...(result.Items ?? []));
    startKey = result.LastEvaluatedKey;
  } while (startKey);
  return items;
}

export const scanAll = (params) => paginate(ScanCommand, params);
export const queryAll = (params) => paginate(QueryCommand, params);
