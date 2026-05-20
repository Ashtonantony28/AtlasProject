import { createHash } from 'node:crypto';

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function countLoc(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  // If file ends with a newline, the trailing "line" is empty; subtract.
  if (text.length > 0 && text.charCodeAt(text.length - 1) === 10) n--;
  return n;
}
