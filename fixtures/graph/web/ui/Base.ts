export class BaseView<T> {
  value?: T;
  mount(): void {}
}

export function helperA(): number {
  return 1;
}
