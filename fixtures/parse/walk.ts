// Shapes the parse walk must keep in order: declarations nested in top-level calls, calls inside
// calls, scopes opened inside arguments, and object pairs inside and outside a scope.
import { describe, it } from './harness.js';
import * as ns from './ns.js';

describe('outer', () => {
  const local = ns.make(ns.deep.read(1), new Map());
  function inner(): number {
    return helper(local.get('a')).value;
  }
  class Nested extends ns.Base<string> implements ns.Shape {
    field = () => this.run(inner());
    private hidden = 1;
    run(x: number): number {
      return super.run(x) + ns.twice(x);
    }
  }
  it('works', async () => {
    await Promise.all([inner(), new Nested().run(2)]);
    register({ onDone: () => finish(), label: 'x' });
  });
});

export const config = {
  load(path: string) {
    return read(path).then((r) => parse(r));
  },
  save: async (v: unknown) => write(JSON.stringify(v)),
  nested: { deep: () => call() },
};

export interface Listener {
  onEvent: (e: string) => void;
  name: string;
}

export type Options = { retry: () => number; limit: number };

export default class extends Base {
  go() {
    return go2();
  }
}

const a = 1,
  b = make(a),
  c = { m() { return b; } };

if (a) {
  const hoisted = setup();
  enum Mode { A, B }
}


export class Calls extends Base {
  #secret() {
    return 1;
  }
  all(a: any, b: any) {
    a?.b();
    a.b?.();
    this.#secret();
    this.x();
    super.y();
    a[b]();
    (a.b)();
    new a.B();
    new X;
    f()();
    a.b.c.d();
    a.b().c();
    (await import('./dyn.js')).run();
    return obj?.a.b() ?? new ns.deep.Thing<string>(1);
  }
}

function broken( {
  call(
}
