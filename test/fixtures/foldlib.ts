export function fold(input: string): string {
  return input.normalize("NFD");
}
export interface FoldOptions {
  preserveCase: boolean;
}
