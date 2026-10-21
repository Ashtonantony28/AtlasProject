export function slugify(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '-');
}

export function shout(text: string): string {
  return text.toUpperCase();
}
