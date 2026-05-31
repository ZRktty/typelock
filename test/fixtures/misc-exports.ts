// intersection type
export type Tagged = { id: string } & { tag: number };

// enum
export enum Direction {
  Up = "UP",
  Down = "DOWN",
}

// namespace
export namespace Utils {
  export const version = "1.0";
}

// const variable export
export const MAX_SIZE: number = 100;
