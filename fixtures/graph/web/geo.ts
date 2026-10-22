export namespace Circle {
  export function area(): number {
    return 1;
  }
  function hidden(): number {
    return 0;
  }
  export const unit = hidden();
}

export namespace Square {
  export function area(): number {
    return 2;
  }
}
