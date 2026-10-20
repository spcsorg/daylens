// Hero backdrop fields: grains settle where a field crosses zero; coords are centred, scaled by half the longer side.

const PI = Math.PI;

function plate(u: number, v: number, a: number, b: number) {
  return 0.5 * (Math.cos(PI * a * u) * Math.cos(PI * b * v) - Math.cos(PI * b * u) * Math.cos(PI * a * v));
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// Twelve lobes, one per hour on a clock face.
function clock(u: number, v: number) {
  const r = Math.hypot(u, v);
  const th = Math.atan2(v, u);
  return 0.55 * Math.cos(10 * r) + 0.45 * smooth(0.08, 0.3, r) * Math.cos(12 * th + 1.6 * r);
}

function lattice(u: number, v: number) {
  const r = Math.hypot(u, v);
  return 0.8 * plate(u * 0.9, v * 0.9, 3, 7) + 0.2 * Math.cos(6 * r) - 0.02;
}

// Horizontal bands, like rows of a timeline.
function strata(u: number, v: number) {
  const r = Math.hypot(u, v);
  return 0.75 * Math.cos(9 * v + 1.2 * Math.sin(3.1 * u)) + 0.25 * Math.cos(6 * r);
}

function rings(u: number, v: number) {
  const s = Math.cbrt(Math.abs(u) ** 3 + Math.abs(v) ** 3);
  return 0.6 * Math.cos(11 * s) + 0.4 * plate(u, v, 2, 5);
}

export const FIELDS = [clock, lattice, strata, rings];
export const DEFAULT_FIELD = 1;

export type Grains = {
  n: number;
  x: Float32Array;
  y: Float32Array;
  sx: Float32Array;
  sy: Float32Array;
  tx: Float32Array;
  ty: Float32Array;
  ready: Uint8Array;
  delay: Float32Array;
  tone: Uint8Array;
  dust: Uint8Array;
};

const BAND = 0.06;
const ZOOM = 1.3;
const DUST = 0.22;

function gauss() {
  return (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
}

export function makeGrains(w: number, h: number, field: number): Grains {
  const n = Math.round(w * h * 0.042);
  const s = Math.max(w, h) / 2 / ZOOM;
  const f = FIELDS[field];
  const g: Grains = {
    n,
    x: new Float32Array(n),
    y: new Float32Array(n),
    sx: new Float32Array(n),
    sy: new Float32Array(n),
    tx: new Float32Array(n),
    ty: new Float32Array(n),
    ready: new Uint8Array(n),
    delay: new Float32Array(n),
    tone: new Uint8Array(n),
    dust: new Uint8Array(n),
  };
  let i = 0;
  let guard = 0;
  while (i < n && guard < n * 60) {
    guard++;
    const px = Math.random() * w;
    const py = Math.random() * h;
    const dust = Math.random() < DUST ? 1 : 0;
    const val = f((px - w / 2) / s, (py - h / 2) / s) / (dust ? BAND * 2.6 : BAND);
    if (Math.random() < Math.exp(-val * val)) {
      g.dust[i] = dust;
      g.x[i] = px;
      g.y[i] = py;
      g.delay[i] = Math.random() * 0.35;
      g.tone[i] = (Math.random() * 255) | 0;
      i++;
    }
  }
  g.n = i;
  return g;
}

// Newton steps toward the nearest zero of the new field, then a spread across the band.
export function retarget(g: Grains, w: number, h: number, field: number, from: number, to: number) {
  const s = Math.max(w, h) / 2 / ZOOM;
  const f = FIELDS[field];
  const e = 0.002;
  for (let i = from; i < to; i++) {
    let u = (g.x[i] - w / 2) / s;
    let v = (g.y[i] - h / 2) / s;
    let gx = 0;
    let gy = 0;
    for (let k = 0; k < 6; k++) {
      const val = f(u, v);
      gx = (f(u + e, v) - f(u - e, v)) / (2 * e);
      gy = (f(u, v + e) - f(u, v - e)) / (2 * e);
      const g2 = gx * gx + gy * gy + 1e-6;
      let du = (-val * gx) / g2;
      let dv = (-val * gy) / g2;
      const len = Math.hypot(du, dv);
      if (len > 0.08) {
        du *= 0.08 / len;
        dv *= 0.08 / len;
      }
      u += du;
      v += dv;
    }
    const gl = Math.hypot(gx, gy) + 1e-6;
    const spread = (gauss() * BAND * (g.dust[i] ? 1.8 : 0.7)) / gl;
    u += (gx / gl) * spread;
    v += (gy / gl) * spread;
    g.sx[i] = g.x[i];
    g.sy[i] = g.y[i];
    g.tx[i] = u * s + w / 2;
    g.ty[i] = v * s + h / 2;
    g.ready[i] = 1;
  }
}

function rgba(r: number, gr: number, b: number, a: number) {
  return ((a << 24) | (b << 16) | (gr << 8) | r) >>> 0;
}

// Core grains are 2x2 with a lit corner and a shaded corner; dust grains are single pixels.
const TONES = (() => {
  const out = new Uint32Array(256 * 4);
  for (let t = 0; t < 256; t++) {
    const k = t / 255;
    const g = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    const base = 0xd8 - 30 * k;
    out[t * 4] = rgba(g(base + 30), g(base + 31), g(base + 32), 255);
    out[t * 4 + 1] = rgba(g(base), g(base + 1), g(base + 2), 255);
    out[t * 4 + 2] = rgba(g(base - 26), g(base - 25), g(base - 24), 255);
    out[t * 4 + 3] = rgba(g(0xc4 + 20 * k), g(0xc5 + 20 * k), g(0xc6 + 20 * k), 90 + ((t * 5) % 80));
  }
  return out;
})();

export function paint(g: Grains, buf: Uint32Array, w: number, h: number) {
  buf.fill(0);
  for (let i = 0; i < g.n; i++) {
    const x = g.x[i] | 0;
    const y = g.y[i] | 0;
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) continue;
    const o = y * w + x;
    const t = g.tone[i] * 4;
    if (g.dust[i]) {
      buf[o] = TONES[t + 3];
      continue;
    }
    buf[o] = TONES[t];
    buf[o + 1] = TONES[t + 1];
    buf[o + w] = TONES[t + 1];
    buf[o + w + 1] = TONES[t + 2];
  }
}
