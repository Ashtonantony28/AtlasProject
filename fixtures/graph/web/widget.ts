import { clamp } from './lib/index.mjs';
import * as strings from './strings.js';

export interface Paintable {
  paint(): string;
}

export class Widget {
  render(): string {
    return this.paint();
  }

  paint(): string {
    return strings.shout('widget');
  }
}

export class FancyWidget<
  TProps extends object = object,
  TState extends object = object,
  TContext = unknown,
>
  extends Widget
  implements Paintable
{
  paint(): string {
    return super.paint() + this.render();
  }
}

export const compute = (n: number): number => {
  const inner = n * 2;
  return clamp(inner, 0, 10);
};

export function afterLongHeader(): Widget {
  return new FancyWidget();
}
