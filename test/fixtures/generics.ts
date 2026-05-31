// Generic function — unconstrained
export function identity<T>(value: T): T {
  return value;
}

// Generic function — constrained
export function getLength<T extends { length: number }>(value: T): number {
  return value.length;
}

// Generic type alias — single param
export type Wrapper<T> = { value: T };

// Generic interface
export interface Repository<T> {
  find(id: string): T;
  save(item: T): void;
}

// Instantiated generic (should stay as named leaf, not expand Promise internals)
export type AsyncResult = Promise<string>;

// Nested generics
export type Pair<A, B> = { first: A; second: B };
