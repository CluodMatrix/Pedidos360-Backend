// Crea o actualiza las dos Lambdas (pedidos360-catalogo y pedidos360-pedidos).
//   npm run deploy
//
// AWS Academy no permite crear roles IAM: se reutiliza el rol existente "LabRole".
// Puedes forzar otro con LAMBDA_ROLE_ARN=arn:aws:iam::<cuenta>:role/<rol>.
import AdmZip from 'adm-zip';
import {
  CreateFunctionCommand,
  GetFunctionCommand,
  LambdaClient,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionActiveV2,
  waitUntilFunctionUpdatedV2,
} from '@aws-sdk/client-lambda';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

const region = process.env.AWS_REGION ?? 'us-east-1';
const lambda = new LambdaClient({ region });
const TABLE_PRODUCTOS = process.env.TABLE_PRODUCTOS ?? 'Pedidos360-Productos';
const TABLE_PEDIDOS = process.env.TABLE_PEDIDOS ?? 'Pedidos360-Pedidos';

const funciones = [
  { nombre: 'pedidos360-catalogo', dir: 'catalogo', env: { TABLE_PRODUCTOS } },
  { nombre: 'pedidos360-pedidos', dir: 'pedidos', env: { TABLE_PRODUCTOS, TABLE_PEDIDOS } },
];

async function resolverRol() {
  if (process.env.LAMBDA_ROLE_ARN) return process.env.LAMBDA_ROLE_ARN;
  const { Account } = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
  return `arn:aws:iam::${Account}:role/LabRole`;
}

function empaquetar(dir) {
  const zip = new AdmZip();
  zip.addLocalFile(`dist/${dir}/index.mjs`);
  return zip.toBuffer();
}

async function existe(FunctionName) {
  try {
    await lambda.send(new GetFunctionCommand({ FunctionName }));
    return true;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

const config = {
  Runtime: 'nodejs22.x',
  Handler: 'index.handler',
  Timeout: 10,
  MemorySize: 256,
  Architectures: ['arm64'], // más barata que x86_64
};

const Role = await resolverRol();
console.log(`Región: ${region} | Rol: ${Role}`);

for (const fn of funciones) {
  const ZipFile = empaquetar(fn.dir);
  const wait = { client: lambda, maxWaitTime: 120 };
  let arn;

  if (await existe(fn.nombre)) {
    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: fn.nombre, ZipFile, Architectures: config.Architectures }));
    await waitUntilFunctionUpdatedV2(wait, { FunctionName: fn.nombre });
    const { FunctionArn } = await lambda.send(new UpdateFunctionConfigurationCommand({
      FunctionName: fn.nombre,
      Runtime: config.Runtime,
      Handler: config.Handler,
      Timeout: config.Timeout,
      MemorySize: config.MemorySize,
      Environment: { Variables: fn.env },
    }));
    await waitUntilFunctionUpdatedV2(wait, { FunctionName: fn.nombre });
    arn = FunctionArn;
    console.log(`~ ${fn.nombre} actualizada`);
  } else {
    const { FunctionArn } = await lambda.send(new CreateFunctionCommand({
      FunctionName: fn.nombre,
      Role,
      Code: { ZipFile },
      Runtime: config.Runtime,
      Handler: config.Handler,
      Timeout: config.Timeout,
      MemorySize: config.MemorySize,
      Architectures: config.Architectures,
      Environment: { Variables: fn.env },
    }));
    await waitUntilFunctionActiveV2(wait, { FunctionName: fn.nombre });
    arn = FunctionArn;
    console.log(`+ ${fn.nombre} creada`);
  }
  console.log(`  ${arn}`);
}
