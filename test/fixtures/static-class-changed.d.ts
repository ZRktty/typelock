export declare class Registry {
  static create(name: string): Registry;
  static readonly DEFAULT_TTL: number;
  static destroy(name: string): void;
  register(key: string): void;
  size(): number;
}
