import { readFileSync } from "node:fs";
import {
  createPool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2";

export const authPool = createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  connectionLimit: Math.max(2, Number(process.env.DB_POOL_SIZE || 10)),
  timezone: "Z",
  charset: "utf8mb4",
  decimalNumbers: true,
  ...(process.env.DB_TLS_CA_FILE && {
    ssl: {
      ca: readFileSync(process.env.DB_TLS_CA_FILE),
      rejectUnauthorized: true,
      verifyIdentity: true,
    },
  }),
});

export const pool = authPool.promise();

type Value = string | number | boolean | Date | null;

export class Sql {
  constructor(
    readonly text: string,
    readonly values: Value[] = [],
  ) {}
}

// Template substitutions are bound parameters unless they are explicitly built SQL fragments.
export function sql(
  parts: TemplateStringsArray,
  ...args: (Value | Sql)[]
): Sql {
  let text = parts[0]!;
  const values: Value[] = [];
  for (const [index, arg] of args.entries()) {
    if (arg instanceof Sql) {
      text += arg.text;
      values.push(...arg.values);
    } else {
      text += "?";
      values.push(arg);
    }
    text += parts[index + 1]!;
  }
  return new Sql(text, values);
}

export function joinSql(parts: Sql[], separator = ", "): Sql {
  return new Sql(
    parts.map((part) => part.text).join(separator),
    parts.flatMap((part) => part.values),
  );
}

export function inList(values: string[]): Sql {
  return values.length
    ? joinSql(values.map((value) => sql`${value}`))
    : sql`NULL`;
}

export function assignments(fields: [Sql, Value | undefined][]): Sql {
  return joinSql(
    fields.flatMap(([column, value]) =>
      value === undefined ? [] : [sql`${column} = ${value}`],
    ),
  );
}

const booleanFields = new Set([
  "approved",
  "active",
  "banned",
  "isDefault",
  "emailVerified",
]);
const jsonFields = new Set([
  "images",
  "chunks",
  "sizes",
  "colors",
  "addressSnapshot",
  "seller",
  "product",
  "user",
  "order",
  "items",
  "comments",
  "addresses",
  "phones",
  "_count",
]);
const dateFields = new Set([
  "createdAt",
  "updatedAt",
  "revokedAt",
  "expiresAt",
  "banExpires",
]);

function decode(value: unknown, field = ""): unknown {
  if (value === null) return null;
  if (booleanFields.has(field)) return Boolean(Number(value));
  if (jsonFields.has(field) && typeof value === "string")
    return decode(JSON.parse(value), field);
  if (dateFields.has(field) && typeof value === "string")
    return new Date(value.replace(" ", "T") + "Z");
  if (Array.isArray(value)) {
    const list = value.map((item) => decode(item));
    if (field === "comments")
      list.sort((a: any, b: any) => Number(a.createdAt) - Number(b.createdAt));
    if (field === "addresses" || field === "phones")
      list.sort((a: any, b: any) => Number(b.isDefault) - Number(a.isDefault));
    return list;
  }
  if (typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, decode(entry, key)]),
    );
  }
  return value;
}

export async function rows<T>(
  query: Sql,
  connection: Pick<typeof pool, "execute"> = pool,
): Promise<T[]> {
  const [result] = await connection.execute<RowDataPacket[]>(
    query.text,
    query.values,
  );
  return result.map((row) => decode(row) as T);
}

export async function one<T>(
  query: Sql,
  connection: Pick<typeof pool, "execute"> = pool,
): Promise<T | null> {
  return (await rows<T>(query, connection))[0] ?? null;
}

export async function scalar(
  query: Sql,
  connection: Pick<typeof pool, "execute"> = pool,
): Promise<number> {
  const row = await one<{ value: number }>(query, connection);
  return Number(row?.value ?? 0);
}

export async function write(
  query: Sql,
  connection: Pick<typeof pool, "execute"> = pool,
): Promise<ResultSetHeader> {
  const [result] = await connection.execute<ResultSetHeader>(
    query.text,
    query.values,
  );
  return result;
}

export async function transaction<T>(
  work: (connection: ReturnType<PoolConnection["promise"]>) => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function insertRow<T>(
  insert: (id: string) => Sql,
  select: (id: string) => Sql,
  connection: Pick<typeof pool, "execute"> = pool,
): Promise<T> {
  const id = crypto.randomUUID();
  await write(insert(id), connection);
  const result = await one<T>(select(id), connection);
  if (!result) throw new Error("Inserted record could not be read");
  return result;
}

export async function updateRow<T>(
  fields: Sql,
  update: (fields: Sql) => Sql,
  select: Sql,
  connection: Pick<typeof pool, "execute"> = pool,
): Promise<T> {
  if (fields.text) await write(update(fields), connection);
  const result = await one<T>(select, connection);
  if (!result) throw new Error("Record no longer exists");
  return result;
}
