export interface Widget {
  id: string;
  label: string;
}
export function makeWidget(id: string): Widget {
  return { id, label: '' };
}
