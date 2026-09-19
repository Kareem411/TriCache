import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { Logger } from 'drizzle-orm/logger';
import { DB_PATH } from './config.js';
import * as schema from './schema.js';

type BetterSqlite3 = typeof import('better-sqlite3');
const Database = createRequire(import.meta.url)('better-sqlite3') as BetterSqlite3;

export interface QueryRecord {
  sql: string;
  params: unknown[];
}

export const queryLog = {
  records: [] as QueryRecord[],
  get count(): number {
    return this.records.length;
  },
  get selects(): number {
    return this.records.filter((r) => /^\s*select/i.test(r.sql)).length;
  },
  reset(): void {
    this.records.length = 0;
  },
};

const logger: Logger = {
  logQuery(query: string, params: unknown[]): void {
    queryLog.records.push({ sql: query, params });
  },
};

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const sqlite = new Database(DB_PATH);

export const db = drizzle(sqlite, {
  schema,
  logger,
});
