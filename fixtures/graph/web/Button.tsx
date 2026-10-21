import { slugify } from './strings';

export function Button({ label }: { label: string }) {
  return <button id={slugify(label)}>{label}</button>;
}
