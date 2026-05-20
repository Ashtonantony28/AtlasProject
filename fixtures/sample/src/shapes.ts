import { PI, multiply } from './math.js';

export interface Drawable {
  area(): number;
}

/** Base shape with a name. */
export class Shape {
  constructor(public name: string) {}

  describe(): string {
    return `Shape(${this.name})`;
  }
}

/** Circle of given radius. */
export class Circle extends Shape implements Drawable {
  constructor(public radius: number) {
    super('circle');
  }

  area(): number {
    return multiply(PI, multiply(this.radius, this.radius));
  }
}

export class Square extends Shape implements Drawable {
  constructor(public side: number) {
    super('square');
  }

  area(): number {
    return multiply(this.side, this.side);
  }
}
