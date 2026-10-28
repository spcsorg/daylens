// Every frame is a pure function of time, so the page can play it live and the recorder can seek it frame by frame.

export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const mix = (a: number, b: number, k: number) => a + (b - a) * k;

// Close to the app's --ease, cubic-bezier(0.22, 1, 0.36, 1).
export const out = (x: number) => 1 - Math.pow(1 - x, 4);
export const inOut = (x: number) => (x < 0.5 ? 8 * x ** 4 : 1 - Math.pow(-2 * x + 2, 4) / 2);
// A small overshoot for things that land: blocks dropping in, the mark settling.
export const back = (x: number) => {
  const c = 1.4;
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
};

export const prog = (t: number, a: number, b: number, e: (x: number) => number = out) => e(clamp((t - a) / (b - a)));

export function typed(text: string, t: number, start: number, cps = 18) {
  return text.slice(0, Math.max(0, Math.floor((t - start) * cps)));
}

export type Key = { t: number; [k: string]: number };

// Interpolates every numeric field between the keyframes around t.
export function keys<K extends Key>(frames: K[], t: number, e = inOut): K {
  if (t <= frames[0].t) return frames[0];
  for (let i = 1; i < frames.length; i++) {
    const b = frames[i];
    if (t < b.t) {
      const a = frames[i - 1];
      const k = e((t - a.t) / (b.t - a.t));
      const r = { ...a } as K;
      for (const f of Object.keys(b)) (r as Record<string, number>)[f] = mix(a[f] ?? b[f], b[f], k);
      return r;
    }
  }
  return frames[frames.length - 1];
}

// Fades in over [a, a+d] and out over [b-d, b].
export function span(t: number, a: number, b: number, d = 0.35) {
  return Math.min(prog(t, a, a + d), 1 - prog(t, b - d, b, (x) => x));
}
