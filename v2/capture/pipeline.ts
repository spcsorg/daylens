// The normalizer as the service runs it: pause drops lines before anything is decided, and browser pages follow
// the helper's focus.

import type { BrowserPages } from './browser.ts'
import { Normalizer, type GapPoint, type NormalizerOptions, type Privacy, type Sink } from './normalize.ts'
import type { Pause } from './pause.ts'
import type { Line } from './protocol.ts'

export class ServiceNormalizer extends Normalizer {
  private readonly pause: Pause
  private readonly pages: BrowserPages

  constructor(sink: Sink, privacy: Privacy, pause: Pause, pages: BrowserPages, opts: NormalizerOptions = {}) {
    super(sink, privacy, opts)
    this.pause = pause
    this.pages = pages
  }

  override handle(line: Line): void {
    if (this.pause.blocks(line.t.wall_ms)) return
    super.handle(line)
    if (line.kind === 'focus') this.pages.onFront(line)
  }

  override interrupt(at: GapPoint): void {
    super.interrupt(at)
    this.pages.interrupt(at)
  }
}
