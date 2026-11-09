// DAYLENS_TEST_NOW: main turns the test time into one offset and hands it to every process, which moves its own Date
// by it, so every reader of the time, ours or a library's, sees the test clock. Time still passes from there.

// How the Node processes main starts get the offset; the renderer gets it as an argument (OFFSET_ARG).
export const OFFSET_ENV = 'DAYLENS_TEST_OFFSET_MS'
export const OFFSET_ARG = '--daylens-test-offset-ms='

export function shiftClock(offsetMs: number): void {
  if (!Number.isFinite(offsetMs) || offsetMs === 0) return
  const Real = Date
  const now = () => Real.now() + offsetMs
  function Shifted(this: unknown, ...args: unknown[]): unknown {
    if (!new.target) return new Real(now()).toString()
    return Reflect.construct(Real, args.length ? args : [now()], new.target)
  }
  Shifted.prototype = Real.prototype
  Shifted.now = now
  Object.setPrototypeOf(Shifted, Real)
  globalThis.Date = Shifted as unknown as DateConstructor
}
