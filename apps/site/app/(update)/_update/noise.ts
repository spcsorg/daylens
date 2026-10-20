// Port of the reference's noise-gradient worker. Must stay self-contained: it is serialized with toString() into a Blob worker.
/* eslint-disable */
export function noiseProgram(scope: any, makeCanvas: (w: number, h: number) => any) {
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const hash = (x: number, y: number) => {
    let n = (x * 374761393 + y * 668265263) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967296;
  };
  const value = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const u = smooth(x - xi), v = smooth(y - yi);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const fbm = (x: number, y: number) => {
    let r = 0.5 * value(x, y);
    x = x * 2.03 + 17.13;
    y = y * 2.03 + 9.71;
    r += 0.25 * value(x, y);
    return r * 1.25;
  };
  const put = (data: Uint8ClampedArray, i: number, stops: any[], t: number) => {
    if (t <= stops[0][0]) {
      const c = stops[0][1];
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
      return;
    }
    for (let k = 1; k < stops.length; k++) {
      const p = stops[k][0], c = stops[k][1];
      if (t <= p) {
        const p0 = stops[k - 1][0], c0 = stops[k - 1][1];
        const f = (t - p0) / (p - p0);
        data[i] = c0[0] + (c[0] - c0[0]) * f;
        data[i + 1] = c0[1] + (c[1] - c0[1]) * f;
        data[i + 2] = c0[2] + (c[2] - c0[2]) * f;
        data[i + 3] = 255;
        return;
      }
    }
    const c = stops[stops.length - 1][1];
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  };

  const FRAME = 1000 / 30;
  let st: any = null, dirty = false, timer: any = null, lastTick = -1, lastWave = -1, drift = 0;
  const canvas = makeCanvas(2, 2);
  let ctx: any = null, space: string | null = null;
  let img: any, xs: Float64Array, ys: Float64Array, jitter: Float64Array;
  let capW = 0, capH = 0, curW = 0, curH = 0;

  const alloc = (w: number, h: number) => {
    if (w > capW || h > capH) {
      capW = Math.max(w, capW ? Math.ceil(capW * 1.5) : w);
      capH = Math.max(h, capH ? Math.ceil(capH * 1.5) : h);
      img = ctx.createImageData(capW, capH);
      xs = new Float64Array(capW);
      ys = new Float64Array(capH);
      jitter = new Float64Array(capW * capH);
    }
    if (w !== curW || h !== curH) {
      curW = w; curH = h;
      for (let x = 0; x < w; x++) xs[x] = x / w;
      for (let y = 0; y < h; y++) {
        ys[y] = y / h;
        for (let x = 0; x < w; x++) jitter[y * capW + x] = hash(x, y + 7919) - 0.5;
      }
    }
  };

  const render = (s: any) => {
    if (!ctx) {
      ctx = canvas.getContext("2d", { colorSpace: s.colorSpace }) || canvas.getContext("2d");
      space = s.colorSpace;
    }
    if (!ctx || space !== s.colorSpace) return;
    const { width, height, renderScale, stops, frequency, warp, travel, loop, angle, progress } = s;
    if (!width || !height) return;
    const scale = Math.min(1, Math.max(0.1, renderScale));
    const w = Math.max(2, Math.round(width * scale)), h = Math.max(2, Math.round(height * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    alloc(w, h);
    const k = 1 / (1 + travel), shift = travel * k * progress, wk = warp * k, data = img.data;
    const aspect = width / height, rad = (angle * Math.PI) / 180;
    const dx = Math.cos(rad) * aspect, dy = Math.sin(rad);
    const off = Math.min(0, dx) + Math.min(0, dy), span = Math.abs(dx) + Math.abs(dy) || 1;
    for (let y = 0; y < h; y++) {
      const ny = ys[y], fy = ny * frequency;
      for (let x = 0; x < w; x++) {
        const i = y * capW + x;
        let t = ((xs[x] * dx + ny * dy - off) / span) * k + shift + (fbm(xs[x] * frequency * aspect + drift, fy) - 0.47) * wk + jitter[i] * 0.006;
        if (loop && travel > 0) {
          const l = travel * k;
          t = (((t % l) + l) % l) / l;
        } else t = Math.min(1, Math.max(0, t));
        put(data, i * 4, stops, smooth(t));
      }
    }
    ctx.putImageData(img, 0, 0, 0, 0, w, h);
    const bitmap = canvas.transferToImageBitmap ? canvas.transferToImageBitmap() : canvas;
    scope.postMessage({ type: "frame", bitmap, width, height, dpr: s.dpr }, bitmap === canvas ? [] : [bitmap]);
  };

  const moving = (s: any) => !!(s && s.visible && s.wave && !s.reducedMotion);
  const schedule = () => {
    if (!st || !st.visible || timer !== null) return;
    const now = performance.now();
    const wait = lastTick < 0 ? 0 : Math.max(0, FRAME - (now - lastTick));
    timer = setTimeout(tick, wait);
  };
  const tick = () => {
    timer = null;
    const s = st;
    if (!s || !s.visible) {
      lastTick = -1; lastWave = -1;
      return;
    }
    const now = performance.now();
    lastTick = now - (lastTick < 0 ? FRAME : now - lastTick) % FRAME;
    if (moving(s)) {
      if (lastWave >= 0) drift += (Math.min(now - lastWave, 250) / 1000) * s.wave;
      lastWave = now;
    } else lastWave = -1;
    if (dirty || moving(s)) {
      dirty = false;
      render(s);
    }
    if (dirty || moving(st)) schedule();
  };
  scope.onmessage = (e: any) => {
    st = e.data.state;
    dirty = true;
    if (!st.visible) {
      if (timer !== null) clearTimeout(timer);
      timer = null; lastTick = -1; lastWave = -1;
      return;
    }
    schedule();
  };
}
