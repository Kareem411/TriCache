export interface Item {
  id: string;
  name: string;
  price: number;
}

/** Seed catalog used by the in-process repository (no database required). */
export const INITIAL_ITEMS: readonly Item[] = [
  { id: '1', name: 'Mechanical Keyboard', price: 129 },
  { id: '2', name: 'Wireless Mouse', price: 79 },
  { id: '3', name: 'Studio Headphones', price: 249 },
];
