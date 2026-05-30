export interface Position {
  start: number;
  end: number;
  length: number;
}
export type Config = Record<string, string>;
export declare class Processor {
  process(input: string): string | null;
  count(): number;
}
