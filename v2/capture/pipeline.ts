// The normalizer as the service runs it: browser pages follow the helper's focus.

import type { BrowserPages } from './browser.ts'
import type { ClockPoint } from './browserLocal.ts'
import { Normalizer, type GapPoint, type Privacy, type Sink } from './normalize.ts'
import type { Line, LineOf } from './protocol.ts'

export class ServiceNormalizer extends Normalizer {
  private readonly pages: BrowserPages
  private last: ClockPoint | null = null

  constructor(sink: Sink, privacy: Privacy, pages: BrowserPages) {
    super(sink, privacy)
    this.pages = pages
  }

  override handle(line: Line): boolean {
    this.last = { boot: line.boot, wall_ms: line.t.wall_ms, mono_us: line.t.mono_us }
    return super.handle(line)
  }

  protected override onFront(line: LineOf<'focus'>): void {
    this.pages.onFront(line)
  }

  // The page in front ends with the row it divides; the next focus line asks the extension again.
  protected override onStopChanged(at: GapPoint): void {
    this.pages.interrupt(at)
  }

  // The helper's clock as of its latest line, for lines the service stamps itself.
  clock(): ClockPoint | null {
    return this.last
  }

  override interrupt(at: GapPoint): void {
    super.interrupt(at)
    this.pages.interrupt(at)
  }
}
