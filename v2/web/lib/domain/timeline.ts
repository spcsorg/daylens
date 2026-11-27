import type { Block } from "./model";

export type Entry =
  | {
      kind: "work";
      start: number;
      end: number;
      label: string;
      summary?: string;
      apps: string[];
      projectId?: string;
      confidence?: number;
      evidence: string[];
    }
  | { kind: "idle" | "away"; start: number; end: number };

/** Joins back-to-back blocks of the same piece of work, and of the same kind of gap, into one entry. */
export function timeline(blocks: Block[]): Entry[] {
  const out: Entry[] = [];
  for (const b of blocks) {
    if (b.deleted) continue;
    const last = out.at(-1);
    if (b.kind !== "work") {
      if (last && last.kind === b.kind && last.end === b.start) last.end = b.end;
      else out.push({ kind: b.kind, start: b.start, end: b.end });
      continue;
    }
    const label = b.label ?? b.title ?? b.app ?? "Untitled";
    if (last && last.kind === "work" && last.end === b.start && last.label === label && last.projectId === b.projectId) {
      last.end = b.end;
      if (b.app && !last.apps.includes(b.app)) last.apps.push(b.app);
      if (b.confidence !== undefined) last.confidence = Math.min(last.confidence ?? 1, b.confidence);
      continue;
    }
    out.push({
      kind: "work",
      start: b.start,
      end: b.end,
      label,
      summary: b.summary,
      apps: b.app ? [b.app] : [],
      projectId: b.projectId,
      confidence: b.confidence,
      evidence: b.evidence ?? [],
    });
  }
  return out;
}

/** Seconds per key across work blocks, largest first. */
export function totalsBy(blocks: Block[], key: (b: Block) => string | undefined, limit: number) {
  const sums = new Map<string, number>();
  for (const b of blocks) {
    const k = key(b);
    if (b.deleted || b.kind !== "work" || !k) continue;
    sums.set(k, (sums.get(k) ?? 0) + (b.end - b.start) / 1000);
  }
  return [...sums]
    .map(([name, seconds]) => ({ name, seconds }))
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, limit);
}
