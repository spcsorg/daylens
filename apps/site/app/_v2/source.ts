// The tracked links in posts (christian-tonny.dev/daylens/ig); a signup with none is "direct".
export const CHANNELS = ["ig", "yt", "x", "tt", "li"] as const;
export const SOURCES = new Set<string>([...CHANNELS, "direct"]);

const KEY = "daylens-source";

// Kept for the tab, so a visit to the privacy page and back still counts the link.
export function rememberSource(source: string) {
  try {
    sessionStorage.setItem(KEY, source);
  } catch {}
}

export function currentSource() {
  try {
    const s = sessionStorage.getItem(KEY);
    return s && SOURCES.has(s) ? s : "direct";
  } catch {
    return "direct";
  }
}
