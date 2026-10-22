import Shape from './shape';
import { Circle } from './geo';

export function measure(): number {
  return new Shape().area() + Circle.area();
}

export const areas = [1, 2].map(Circle.area);
