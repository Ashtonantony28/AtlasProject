import { Circle, Square } from './shapes.js';
import { add } from './math.js';

/** Compute the combined area of one circle and one square. */
export function totalArea(radius: number, side: number): number {
  const c = new Circle(radius);
  const s = new Square(side);
  return add(c.area(), s.area());
}

export function main(): void {
  const t = totalArea(2, 3);
  console.log(`total area = ${t}`);
}
