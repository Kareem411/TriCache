/** Plain seed rows — no Drizzle import so root tests can reuse them. */
export type UserRole = 'admin' | 'member';

export interface SeedUser {
  name: string;
  email: string;
  role: UserRole;
}

export const SEED_USERS: readonly SeedUser[] = [
  { name: 'Ada Lovelace', email: 'ada@example.com', role: 'admin' },
  { name: 'Alan Turing', email: 'alan@example.com', role: 'admin' },
  { name: 'Grace Hopper', email: 'grace@example.com', role: 'member' },
];

export const USERS_TAG = 'users';
