// DynamoDB falso en memoria, SOLO para pruebas locales.
// Soporta únicamente las expresiones que usan las Lambdas de este proyecto.
export function instalarFakeDynamo(db) {
  const tablas = new Map();
  const llamadas = [];
  const tabla = (nombre) => {
    if (!tablas.has(nombre)) tablas.set(nombre, new Map());
    return tablas.get(nombre);
  };
  const error = (name, extra = {}) => Object.assign(new Error(name), { name, ...extra });
  const campo = (token, names) => names?.[token] ?? token;

  function cumple(expr, item, names = {}, values = {}) {
    if (!expr) return true;
    return expr.split(' AND ').every((clausula) => {
      const c = clausula.trim();
      let m;
      if ((m = c.match(/^attribute_exists\((#?\w+)\)$/))) return item?.[campo(m[1], names)] !== undefined;
      if ((m = c.match(/^attribute_not_exists\((#?\w+)\)$/))) return item?.[campo(m[1], names)] === undefined;
      if ((m = c.match(/^(#?\w+) (>=|=) (:\w+)$/))) {
        if (!item) return false;
        const izq = item[campo(m[1], names)];
        return m[2] === '>=' ? izq >= values[m[3]] : izq === values[m[3]];
      }
      throw new Error(`Condición no soportada por el fake: ${c}`);
    });
  }

  function aplicarUpdate(item, expr, names = {}, values = {}) {
    for (const parte of expr.replace(/^SET /, '').split(', ')) {
      const [izq, der] = parte.split(' = ');
      const nombre = campo(izq, names);
      const m = der.match(/^(#?\w+) ([+-]) (:\w+)$/);
      if (m) {
        const base = item[campo(m[1], names)];
        item[nombre] = m[2] === '+' ? base + values[m[3]] : base - values[m[3]];
      } else {
        item[nombre] = values[der];
      }
    }
  }

  const clave = (op) => op.Key?.id ?? op.Item?.id;

  function escribir(op) {
    const t = tabla(op.TableName);
    if (op.Item) {
      t.set(op.Item.id, structuredClone(op.Item));
    } else if (op.UpdateExpression) {
      const item = t.get(op.Key.id) ?? { id: op.Key.id };
      aplicarUpdate(item, op.UpdateExpression, op.ExpressionAttributeNames, op.ExpressionAttributeValues);
      t.set(op.Key.id, item);
      return item;
    } else {
      t.delete(op.Key.id);
    }
    return undefined;
  }

  db.send = async (command) => {
    const tipo = command.constructor.name;
    const p = command.input;
    llamadas.push(tipo + (p.IndexName ? `:${p.IndexName}` : ''));

    switch (tipo) {
      case 'GetCommand':
        return { Item: structuredClone(tabla(p.TableName).get(p.Key.id)) };

      case 'PutCommand':
      case 'DeleteCommand':
      case 'UpdateCommand': {
        const actual = tabla(p.TableName).get(clave(p));
        if (!cumple(p.ConditionExpression, actual, p.ExpressionAttributeNames, p.ExpressionAttributeValues)) {
          throw error('ConditionalCheckFailedException');
        }
        const nuevo = escribir(p);
        return p.ReturnValues === 'ALL_NEW' ? { Attributes: structuredClone(nuevo) } : {};
      }

      case 'ScanCommand':
        return { Items: [...tabla(p.TableName).values()].map((i) => structuredClone(i)) };

      case 'QueryCommand': {
        const attr = campo('#c', p.ExpressionAttributeNames);
        const items = [...tabla(p.TableName).values()]
          .filter((i) => i[attr] === p.ExpressionAttributeValues[':c'])
          .sort((a, b) => String(a.fechaCreacion).localeCompare(String(b.fechaCreacion)));
        if (p.ScanIndexForward === false) items.reverse();
        return { Items: items.map((i) => structuredClone(i)) };
      }

      case 'BatchGetCommand': {
        const [nombre, { Keys }] = Object.entries(p.RequestItems)[0];
        return { Responses: { [nombre]: Keys.map((k) => tabla(nombre).get(k.id)).filter(Boolean).map((i) => structuredClone(i)) } };
      }

      case 'TransactWriteCommand': {
        const ops = p.TransactItems.map((t) => t.Put ?? t.Update ?? t.Delete);
        const vistos = new Set(ops.map((o) => `${o.TableName}#${clave(o)}`));
        if (vistos.size !== ops.length) throw error('ValidationException'); // DynamoDB no admite el mismo ítem dos veces
        const razones = ops.map((o) =>
          cumple(o.ConditionExpression, tabla(o.TableName).get(clave(o)), o.ExpressionAttributeNames, o.ExpressionAttributeValues)
            ? { Code: 'None' }
            : { Code: 'ConditionalCheckFailed' });
        if (razones.some((r) => r.Code !== 'None')) throw error('TransactionCanceledException', { CancellationReasons: razones });
        ops.forEach(escribir);
        return {};
      }

      default:
        throw new Error(`Comando no soportado por el fake: ${tipo}`);
    }
  };

  return {
    tabla,
    llamadas,
    sembrar(nombre, items) {
      items.forEach((i) => tabla(nombre).set(i.id, structuredClone(i)));
    },
  };
}
