// The normalizer as the service runs it: browser pages follow the helper's focus.

import type { BrowserPages } from './browser.ts'
import type { ClockPoint } from './browserLocal.ts'
import { Normalizer, type GapPoint, type Privacy, type Sink } from './normalize.ts'
import type { Line } from './protocol.ts'

export class ServiceNormalizer extends Normalizer {
  private readonly pages: BrowserPages
  private last: ClockPoint | null = null

  constructor(sink: Sink, privacy: Privacy, pages: BrowserPages) {
    super(sink, privacy)
    this.pages = pages
  }

  override handle(line: Line): void {
    this.last = { boot: line.boot, wall_ms: line.t.wall_ms, mono_us: line.t.mono_us }
    super.handle(line)
    if (line.kind === 'focus') this.pages.onFront(line)
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
