// identity: constraint added → breaking (narrower)
export function identity<T extends object>(value: T): T {
  return value;
}

// getLength: constraint removed → safe (wider) — conservative classifier says breaking
export function getLength<T>(value: T): number {
  return (value as { length: number }).length;
}

// Wrapper: second generic param added with default → safe for callers
export type Wrapper<T, U = string> = { value: T; meta: U };

// Repository: unchanged
export interface Repository<T> {
  find(id: string): T;
  save(item: T): void;
}

// AsyncResult: unchanged
export type AsyncResult = Promise<string>;

// Pair: unchanged
export type Pair<A, B> = { first: A; second: B };
