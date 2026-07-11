import type Database from "better-sqlite3";
import type { Db } from "../db.js";

// Per-connection prepared-statement cache keyed by SQL text. better-sqlite3
// re-prepares automatically on schema change and the runtime is single-threaded,
// so caching statements on the connection is safe. SQL variety is bounded (fixed
// point queries plus a small set of interpolated WHERE clauses), so the map stays
// small. Only kill per-call re-prepares — statements already prepared once at
// module/function/transaction scope must stay as they are.
const statementCache = new WeakMap<Db, Map<string, Database.Statement>>();

export function prepareCached(db: Db, sql: string): Database.Statement {
  let bySql = statementCache.get(db);
  if (!bySql) statementCache.set(db, (bySql = new Map()));
  let stmt = bySql.get(sql);
  if (!stmt) bySql.set(sql, (stmt = db.prepare(sql)));
  return stmt;
}
