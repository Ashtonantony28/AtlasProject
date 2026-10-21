import { slugify, shout } from './strings.js';

// slugify('top-level comment')
// export * from './widget';

export function decoy(): string {
  // slugify('in a comment')
  /* shout('in a block comment') */
  const s = "slugify('in a string')";
  const t = `shout('in a template')`;
  const u = "require('./widget') import('./widget')";
  return s + t + u;
}

export const banner = 'shout(nothing)';
