export interface Position {
  start: number;
  end: number;
}
export type Config = Record<string, string>;
export declare class Processor {
  constructor(options: string);
  process(input: string): string;
  count(): number;
}
