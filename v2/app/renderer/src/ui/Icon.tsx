// Daylens icons, drawn on a 16 grid in currentColor. Each object icon has one solid piece (the hand, the lid, the knobs),
// echoing the mark's dot; action icons stay pure line. The sidebar swaps to the filled set for the screen you're on.
import type { SVGProps } from 'react'

const d = (paths: string) => paths.split('|').map((p) => `<path d="${p}"/>`).join('')
const solid = (paths: string) => `<path d="${paths}" fill="currentColor" stroke="none" fill-rule="evenodd"/>`
const bar = (path: string, width = 2.5) => `<path d="${path}" stroke-width="${width}"/>`
const dot = (cx: number, cy: number, r: number) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`

const RING = 'M8 13.75C11.1756 13.75 13.75 11.1756 13.75 8C13.75 4.82436 11.1756 2.25 8 2.25C4.82436 2.25 2.25 4.82436 2.25 8C2.25 11.1756 4.82436 13.75 8 13.75Z'
const BUBBLE = 'M3 4.5C3 3.67157 3.67157 3 4.5 3H11.5C12.3284 3 13 3.67157 13 4.5V9.5C13 10.3284 12.3284 11 11.5 11H7.25L4.5 13.25V11C3.67157 11 3 10.3284 3 9.5V4.5Z'
const BUBBLE_DOTS = 'M5.75 6.1a.9.9 0 1 1 0 1.8a.9.9 0 1 1 0-1.8Z M8 6.1a.9.9 0 1 1 0 1.8a.9.9 0 1 1 0-1.8Z M10.25 6.1a.9.9 0 1 1 0 1.8a.9.9 0 1 1 0-1.8Z'
// Hands at three o'clock as one L, so the filled clock can knock it out in one piece.
const HANDS = 'M7.2 5.2a.8.8 0 0 1 1.6 0V7.2h2.2a.8.8 0 0 1 0 1.6H8A.8.8 0 0 1 7.2 8Z'
const LENS = 'M7.25 11.75C9.73528 11.75 11.75 9.73528 11.75 7.25C11.75 4.76472 9.73528 2.75 7.25 2.75C4.76472 2.75 2.75 4.76472 2.75 7.25C2.75 9.73528 4.76472 11.75 7.25 11.75Z'
const TRACKS = 'M2.5 5H13.5M2.5 11H13.5'
const rect = (x: number, y: number, w: number, h: number, r: number) => `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`
const square = (x: number, y: number, s = 4.5, r = 1.25) => rect(x, y, s, s, r)
const disc = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`

const svgs = {
  'alert': d(RING) + solid(rect(7.2, 4.5, 1.6, 4.75, 0.8)) + dot(8, 11, 0.95),
  'apps': d([square(2.5, 2.5), square(9, 2.5), square(2.5, 9)].join('|')) + solid(square(8.25, 8.25, 6, 2)),
  'arrow-right': d('M3.5 8H12.5M9 11.5L12.5 8L9 4.5'),
  'ask': d(BUBBLE) + solid(BUBBLE_DOTS),
  'calendar': d('M2.5 7V11.5C2.5 12.6046 3.39543 13.5 4.5 13.5H11.5C12.6046 13.5 13.5 12.6046 13.5 11.5V7|M5.5 1.5V3M10.5 1.5V3') + solid('M1.75 7.5V5.5A2.75 2.75 0 0 1 4.5 2.75H11.5A2.75 2.75 0 0 1 14.25 5.5V7.5Z'),
  'check': d('M3.5 8.5L6.25 11.25L12.5 5'),
  'copy': d(rect(5.5, 5.5, 8, 8, 1.75) + '|M10.5 5.5V4.25C10.5 3.2835 9.7165 2.5 8.75 2.5H4.25C3.2835 2.5 2.5 3.2835 2.5 4.25V8.75C2.5 9.7165 3.2835 10.5 4.25 10.5H5.5'),
  'chevron-down': d('M3.5 6L8 10.5L12.5 6'),
  'chevron-left': d('M10 3.5L5.5 8L10 12.5'),
  'chevron-right': d('M6 3.5L10.5 8L6 12.5'),
  'enter': d('M12.5 3.5V8A1.5 1.5 0 0 1 11 9.5H3.5M6.25 6.75L3.5 9.5L6.25 12.25'),
  'eye-off': d('M2.5 2.5L13.5 13.5M6.6 6.6C6.31114 6.98514 6.1709 7.46156 6.20503 7.94178C6.23916 8.422 6.44536 8.87379 6.78579 9.21421C7.12621 9.55464 7.578 9.76084 8.05822 9.79497C8.53844 9.8291 9.01486 9.68886 9.4 9.4M4.3 4.9C3.2 5.7 2.4 6.8 2 8C2.9 10.6 5.2 12.5 8 12.5C9.1 12.5 10.1 12.2 11 11.7M7 3.6C7.3 3.6 7.7 3.5 8 3.5C10.8 3.5 13.1 5.4 14 8C13.7 8.8 13.3 9.6 12.7 10.2'),
  'globe': d(RING + '|M2.25 8H13.75M8 2.25C9.6 3.85 10.4 5.75 10.4 8C10.4 10.25 9.6 12.15 8 13.75C6.4 12.15 5.6 10.25 5.6 8C5.6 5.75 6.4 3.85 8 2.25Z'),
  'lock': d('M5.5 6.5V5.25C5.5 3.86929 6.61929 2.75 8 2.75C9.38071 2.75 10.5 3.86929 10.5 5.25V6.5') + solid('M2.75 8.5A2.25 2.25 0 0 1 5 6.25H11A2.25 2.25 0 0 1 13.25 8.5V12A2.25 2.25 0 0 1 11 14.25H5A2.25 2.25 0 0 1 2.75 12Z'),
  'more': dot(3.75, 8, 1.1) + dot(8, 8, 1.1) + dot(12.25, 8, 1.1),
  'open': d('M12.5 9.5V3.5H6.5M12.5 3.5L4 12'),
  'pause': solid(rect(4.25, 3, 2.75, 10, 1.375) + rect(9, 3, 2.75, 10, 1.375)),
  'plus': d('M8 3.5V12.5M3.5 8H12.5'),
  'search': d(LENS) + bar('M11 11L13.25 13.25', 2.75),
  'settings': d(TRACKS) + dot(10.25, 5, 2.25) + dot(5.75, 11, 2.25),
  'spinner': d('M8 2C9.18669 2 10.3467 2.35189 11.3334 3.01118C12.3201 3.67047 13.0892 4.60754 13.5433 5.7039C13.9974 6.80026 14.1162 8.00666 13.8847 9.17054C13.6532 10.3344 13.0818 11.4035 12.2426 12.2426C11.4035 13.0818 10.3344 13.6532 9.17054 13.8847C8.00666 14.1162 6.80026 13.9974 5.7039 13.5433C4.60754 13.0892 3.67047 12.3201 3.01118 11.3334C2.35189 10.3467 2 9.18669 2 8'),
  'today': d(RING) + solid(HANDS),
  'trash': d('M6.25 3.5V2.75H9.75V3.5|M4.25 6.5L4.85 13.25H11.15L11.75 6.5') + solid(rect(2.25, 3.5, 11.5, 2, 1)),
  'x': d('M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5'),
} as const

// The sidebar's current screen: the whole glyph solid, the details knocked out.
const filled: Partial<Record<keyof typeof svgs, string>> = {
  'today': solid(disc(8, 8, 6.5) + HANDS),
  'apps': solid([square(1.75, 1.75, 6, 2), square(8.25, 1.75, 6, 2), square(1.75, 8.25, 6, 2), square(8.25, 8.25, 6, 2)].join(' ')),
  'ask': d(BUBBLE) + solid(BUBBLE + BUBBLE_DOTS),
  'search': bar(LENS) + bar('M11 11L13.25 13.25', 2.75),
  'settings': bar(TRACKS, 2) + dot(10.25, 5, 2.75) + dot(5.75, 11, 2.75),
}

export type IconName = keyof typeof svgs

export function Icon({ name, size = 16, filled: fill = false, ...rest }: { name: IconName; size?: number; filled?: boolean } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
      dangerouslySetInnerHTML={{ __html: (fill && filled[name]) || svgs[name] }}
    />
  )
}

/** The Daylens mark: the ring is the day, the amber dot is now. */
export function Mark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M16 27C22.0751 27 27 22.0751 27 16C27 9.92487 22.0751 5 16 5C9.92487 5 5 9.92487 5 16C5 22.0751 9.92487 27 16 27Z" stroke="var(--text)" strokeWidth="3.5" />
      <circle cx="8.2" cy="8.2" r="6" fill="var(--accent)" stroke="var(--bg-window)" strokeWidth="2.5" />
    </svg>
  )
}
