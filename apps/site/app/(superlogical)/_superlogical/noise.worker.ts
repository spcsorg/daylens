/// <reference lib="webworker" />
// Port of Superlogical's noise-gradient worker: a warped vertical ramp, rendered at quarter scale and upscaled.
import type { Stop } from "./ramp";

type State = {
  width: number;
  height: number;
  dpr: number;
  renderScale: number;
  stops: Stop[];
  frequency: number;
  warp: number;
  wave: number;
  travel: number;
  angle: number;
  progress: number;
  visible: boolean;
  reducedMotion: boolean;
};

const FRAME = 1000 / 30;
const ctxScope = self as unknown as DedicatedWorkerGlobalScope;

let out: OffscreenCanvas | null = null;
let outCtx: OffscreenCanvasRenderingContext2D | null = null;
const small = new OffscreenCanvas(2, 2);
const smallCtx = small.getContext("2d");
let state: State | null = null;
let dirty = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastFrame = -1;
let lastWave = -1;
let drift = 0;
let image: ImageData | null = null;
let colX = new Float64Array(0);
let rowY = new Float64Array(0);
let jitter = new Float64Array(0);
let capW = 0;
let capH = 0;
let curW = 0;
let curH = 0;

const smooth = (t: number) => t * t * (3 - 2 * t);
function hash(x: number, y: number) {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
function noise(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x: number, y: number) {
  let v = 0.5 * noise(x, y);
  v += 0.25 * noise(x * 2.03 + 17.13, y * 2.03 + 9.71);
  return v * 1.25;
}
function paint(data: Uint8ClampedArray, i: number, stops: Stop[], t: number) {
  let c = stops[stops.length - 1][1];
  if (t <= stops[0][0]) c = stops[0][1];
  else
    for (let k = 1; k < stops.length; k++) {
      const [p1, c1] = stops[k];
      if (t <= p1) {
        const [p0, c0] = stops[k - 1];
        const s = (t - p0) / (p1 - p0);
        data[i] = c0[0] + (c1[0] - c0[0]) * s;
        data[i + 1] = c0[1] + (c1[1] - c0[1]) * s;
        data[i + 2] = c0[2] + (c1[2] - c0[2]) * s;
        data[i + 3] = 255;
        return;
      }
    }
  data[i] = c[0];
  data[i + 1] = c[1];
  data[i + 2] = c[2];
  data[i + 3] = 255;
}

function ensure(w: number, h: number) {
  if (!smallCtx) return;
  if (w > capW || h > capH) {
    capW = Math.max(w, capW ? Math.ceil(capW * 1.5) : w);
    capH = Math.max(h, capH ? Math.ceil(capH * 1.5) : h);
    image = smallCtx.createImageData(capW, capH);
    colX = new Float64Array(capW);
    rowY = new Float64Array(capH);
    jitter = new Float64Array(capW * capH);
    curW = 0;
  }
  if (w !== curW || h !== curH) {
    curW = w;
    curH = h;
    for (let x = 0; x < w; x++) colX[x] = x / w;
    for (let y = 0; y < h; y++) {
      rowY[y] = y / h;
      for (let x = 0; x < w; x++) jitter[y * capW + x] = hash(x, y + 7919) - 0.5;
    }
  }
}

function render(s: State) {
  if (!smallCtx || !out || !outCtx || !s.width || !s.height) return;
  const scale = Math.min(1, Math.max(0.1, s.renderScale));
  const w = Math.max(2, Math.round(s.width * scale));
  const h = Math.max(2, Math.round(s.height * scale));
  if (small.width !== w) small.width = w;
  if (small.height !== h) small.height = h;
  ensure(w, h);
  if (!image) return;
  const k = 1 / (1 + s.travel);
  const shift = s.travel * k * s.progress;
  const warp = s.warp * k;
  const data = image.data;
  const aspect = s.width / s.height;
  const rad = (s.angle * Math.PI) / 180;
  const ax = Math.cos(rad) * aspect;
  const ay = Math.sin(rad);
  const lo = Math.min(0, ax) + Math.min(0, ay);
  const span = Math.abs(ax) + Math.abs(ay) || 1;
  for (let y = 0; y < h; y++) {
    const ny = rowY[y];
    const fy = ny * s.frequency;
    for (let x = 0; x < w; x++) {
      const idx = y * capW + x;
      let u = ((colX[x] * ax + ny * ay - lo) / span) * k + shift + (fbm(colX[x] * s.frequency * aspect + drift, fy) - 0.47) * warp + jitter[idx] * 0.006;
      u = Math.min(1, Math.max(0, u));
      paint(data, idx * 4, s.stops, smooth(u));
    }
  }
  smallCtx.putImageData(image, 0, 0, 0, 0, w, h);
  const W = Math.round(s.width * s.dpr);
  const H = Math.round(s.height * s.dpr);
  if (out.width !== W) out.width = W;
  if (out.height !== H) out.height = H;
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = "low";
  outCtx.drawImage(small, 0, 0, w, h, 0, 0, W, H);
}

const animating = (s: State | null) => !!(s?.visible && s.wave && !s.reducedMotion);

function schedule() {
  if (!state?.visible || timer !== null) return;
  const now = performance.now();
  const wait = lastFrame < 0 ? 0 : Math.max(0, FRAME - (now - lastFrame));
  timer = setTimeout(tick, wait);
}

function tick() {
  timer = null;
  const s = state;
  if (!s?.visible) {
    lastFrame = -1;
    lastWave = -1;
    return;
  }
  const now = performance.now();
  lastFrame = now - ((lastFrame < 0 ? FRAME : now - lastFrame) % FRAME);
  if (animating(s)) {
    if (lastWave >= 0) drift += (Math.min(now - lastWave, 250) / 1000) * s.wave;
    lastWave = now;
  } else lastWave = -1;
  if (dirty || animating(s)) {
    dirty = false;
    render(s);
  }
  if (dirty || animating(state)) schedule();
}

ctxScope.onmessage = ({ data }: MessageEvent) => {
  if (data.type === "init") {
    out = data.canvas as OffscreenCanvas;
    outCtx = out.getContext("2d");
    return;
  }
  state = data.state as State;
  dirty = true;
  if (!state.visible) {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastFrame = -1;
    lastWave = -1;
    return;
  }
  schedule();
};
