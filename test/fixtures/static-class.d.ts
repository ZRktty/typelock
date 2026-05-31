export declare class Registry {
  static create(name: string): Registry;
  static readonly DEFAULT_TTL: number;
  register(key: string): void;
  size(): number;
}
