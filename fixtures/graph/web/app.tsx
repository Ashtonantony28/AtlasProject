import { BaseView, aliasA, extra, Panel, cyc } from './ui';
import Store from './store';
import makeId from './ids.js';

export class Screen extends BaseView<string> {
  draw(): number {
    this.mount();
    return aliasA() + extra() + cyc() + makeId();
  }
}

export function App() {
  return <Panel />;
}

export function useStore(): Store {
  return new Store();
}
