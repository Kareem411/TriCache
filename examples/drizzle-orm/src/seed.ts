import { pathToFileURL } from 'node:url';
import { sqlite, db } from './db.js';
import { users } from './schema.js';
import { SEED_USERS } from './seed-data.js';
import { DB_PATH } from './config.js';

const CREATE_USERS_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/** Drop + recreate + insert the sample roster. Safe to call from demo/verify. */
export function resetAndSeed(): void {
  sqlite.exec('DROP TABLE IF EXISTS users');
  sqlite.exec(CREATE_USERS_SQL);
  const now = new Date();
  db.insert(users)
    .values(SEED_USERS.map((row) => ({ ...row, createdAt: now })))
    .run();
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return entry.endsWith('seed.ts') || entry.endsWith('seed.js');
  }
}

if (isDirectRun()) {
  resetAndSeed();
  const count = sqlite.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  console.log(`Seeded ${count.n} users into ${DB_PATH}`);
}
