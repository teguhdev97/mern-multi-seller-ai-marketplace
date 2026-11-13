import { readFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { auth } from "../lib/auth.js";
import { pool } from "./pool.js";

try {
  if (process.env.DB_CONNECTION && process.env.DB_CONNECTION !== "mysql") {
    throw new Error("DB_CONNECTION must be mysql");
  }
  if (!process.env.DB_DATABASE) {
    throw new Error(
      "Set DB_DATABASE to the dedicated marketplace schema before migrating",
    );
  }

  const connection = await pool.getConnection();
  try {
    const lock = `marketplace:migrate:${process.env.DB_DATABASE}`.slice(0, 64);
    const [result] = await connection.execute<import("mysql2").RowDataPacket[]>(
      "SELECT GET_LOCK(?, 30) AS acquired",
      [lock],
    );
    if (result[0]?.acquired !== 1)
      throw new Error("Could not acquire the database migration lock");
    try {
      const authMigration = await getMigrations(auth.options);
      await authMigration.runMigrations();
      const ddl = await readFile(
        new URL("../../sql/001-marketplace.sql", import.meta.url),
        "utf8",
      );
      for (const statement of ddl
        .split(/;\s*(?:\r?\n|$)/)
        .map((item) => item.trim())
        .filter(Boolean)) {
        await connection.query(statement);
      }
      console.log("Marketplace database schema is ready");
    } finally {
      await connection.execute("SELECT RELEASE_LOCK(?)", [lock]);
    }
  } finally {
    connection.release();
  }
} finally {
  await pool.end();
}
