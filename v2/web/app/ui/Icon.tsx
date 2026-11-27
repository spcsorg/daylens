/* Paths from V2's ui/Icon.tsx and the admin prototype's new icons, on the same 16-unit grid. */
const d = (p: string) => p.split("|").map((x) => `<path d="${x}"/>`).join("");
const solid = (p: string) => `<path d="${p}" fill="currentColor" stroke="none" fill-rule="evenodd"/>`;
const dot = (cx: number, cy: number, r: number) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;
const rect = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
const disc = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
const TRACKS = "M2.5 5H13.5M2.5 11H13.5";
const RING = "M8 13.75C11.1756 13.75 13.75 11.1756 13.75 8C13.75 4.82436 11.1756 2.25 8 2.25C4.82436 2.25 2.25 4.82436 2.25 8C2.25 11.1756 4.82436 13.75 8 13.75Z";

const outline = {
  alert: d(RING) + solid(rect(7.2, 4.5, 1.6, 4.75, 0.8)) + dot(8, 11, 0.95),
  "arrow-right": d("M3.5 8H12.5M9 11.5L12.5 8L9 4.5"),
  briefcase: d(rect(2.25, 5, 11.5, 8.25, 1.75) + "|M6 5V3.75C6 3.2 6.45 2.75 7 2.75H9C9.55 2.75 10 3.2 10 3.75V5") + solid(rect(6.75, 8, 2.5, 2, 0.6)),
  calendar: d("M2.5 7V11.5C2.5 12.6046 3.39543 13.5 4.5 13.5H11.5C12.6046 13.5 13.5 12.6046 13.5 11.5V7|M5.5 1.5V3M10.5 1.5V3") + solid("M1.75 7.5V5.5A2.75 2.75 0 0 1 4.5 2.75H11.5A2.75 2.75 0 0 1 14.25 5.5V7.5Z"),
  check: d("M3.5 8.5L6.25 11.25L12.5 5"),
  "chevron-down": d("M3.5 6L8 10.5L12.5 6"),
  "chevron-left": d("M10 3.5L5.5 8L10 12.5"),
  "chevron-right": d("M6 3.5L10.5 8L6 12.5"),
  download: d("M8 2.75V10M4.75 7L8 10.25L11.25 7|M3 13.25H13"),
  minus: d("M4 8H12"),
  edit: d("M10.25 3.25L12.75 5.75L5.75 12.75H3.25V10.25Z"),
  globe: d(RING + "|M2.25 8H13.75M8 2.25C9.6 3.85 10.4 5.75 10.4 8C10.4 10.25 9.6 12.15 8 13.75C6.4 12.15 5.6 10.25 5.6 8C5.6 5.75 6.4 3.85 8 2.25Z"),
  overview: d("M2.5 13.5H13.5|M4.5 13.5V9.5|M11.5 13.5V6.5") + solid(rect(6.6, 3, 2.8, 10.5, 1.2)),
  plus: d("M8 3.5V12.5M3.5 8H12.5"),
  settings: d(TRACKS) + dot(10.25, 5, 2.25) + dot(5.75, 11, 2.25),
  people: d("M2.25 13.25C2.25 11.17 3.93 9.75 6 9.75C8.07 9.75 9.75 11.17 9.75 13.25|M10.5 2.9A2.25 2.25 0 1 1 10.5 7.1|M11.75 9.9C12.95 10.25 13.75 11.4 13.75 13.25") + solid(disc(6, 5, 2.5)),
  timesheet: d(rect(3, 2.75, 10, 10.75, 1.75) + "|M5.5 7.5H10.5|M5.5 10.5H8.5") + solid(rect(5.75, 1.75, 4.5, 2.25, 1)),
  x: d("M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5"),
};

const filled: Partial<Record<IconName, string>> = {
  calendar: solid("M1.75 5.5A2.75 2.75 0 0 1 4.5 2.75H11.5A2.75 2.75 0 0 1 14.25 5.5V11.5A2.75 2.75 0 0 1 11.5 14.25H4.5A2.75 2.75 0 0 1 1.75 11.5Z") + d("M5.5 1.5V3M10.5 1.5V3"),
  settings: `<path d="${TRACKS}" stroke-width="2"/>` + dot(10.25, 5, 2.75) + dot(5.75, 11, 2.75),
  briefcase: solid(rect(1.75, 4.75, 12.5, 9, 2) + "M5.5 4.75V3.75A1.5 1.5 0 0 1 7 2.25H9A1.5 1.5 0 0 1 10.5 3.75V4.75H9.25V3.75A.25.25 0 0 0 9 3.5H7A.25.25 0 0 0 6.75 3.75V4.75Z"),
  overview: solid(rect(2, 8.5, 3.6, 5, 1.2) + rect(6.2, 3, 3.6, 10.5, 1.2) + rect(10.4, 6, 3.6, 7.5, 1.2)),
  timesheet: solid(rect(2.5, 2.5, 11, 11.5, 2)) + '<path d="M5.5 7.5H10.5M5.5 10.5H8.5" stroke="var(--bg-sidebar)"/>',
  people: solid(disc(6, 5, 2.6) + "M1.75 13.25C1.75 10.9 3.65 9.25 6 9.25C8.35 9.25 10.25 10.9 10.25 13.25Z" + disc(10.9, 5, 2.1) + "M11 9.4C12.9 9.6 14.25 11.1 14.25 13.25H11.4C11.4 11.8 11.3 10.5 11 9.4Z"),
};

export type IconName = keyof typeof outline;

export function Icon({ name, size = 16, filled: isFilled = false }: { name: IconName; size?: number; filled?: boolean }) {
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
      dangerouslySetInnerHTML={{ __html: (isFilled && filled[name]) || outline[name] }}
    />
  );
}

export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M16 27C22.0751 27 27 22.0751 27 16C27 9.92487 22.0751 5 16 5C9.92487 5 5 9.92487 5 16C5 22.0751 9.92487 27 16 27Z" stroke="var(--text)" strokeWidth="3.5" />
      <circle cx="8.2" cy="8.2" r="6" fill="var(--accent)" stroke="var(--bg-sidebar)" strokeWidth="2.5" />
    </svg>
  );
}
