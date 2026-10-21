import { slugify, shout } from './strings.js';

// slugify('top-level comment')

export function decoy(): string {
  // slugify('in a comment')
  /* shout('in a block comment') */
  const s = "slugify('in a string')";
  const t = `shout('in a template')`;
  return s + t;
}

export const banner = 'shout(nothing)';
