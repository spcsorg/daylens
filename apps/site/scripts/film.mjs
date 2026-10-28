// Records the launch film from /introducing-v2/film: seeks the stage one frame at a time and pipes each screenshot into ffmpeg,
// so the video is frame-perfect however slow the machine is. Needs `next dev -p 3217` running, ffmpeg, and a Chromium build.
// node scripts/film.mjs --cut duet --ratio 16x9 --out film.mp4 [--fps 60] [--scale 2] [--from 0 --to 12] [--stills dir --at 3,9.5]
import { spawn } from "node:child_process";
import { globSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:3217/introducing-v2/film" },
    cut: { type: "string", default: "duet" },
    ratio: { type: "string", default: "16x9" },
    fps: { type: "string", default: "60" },
    scale: { type: "string", default: "2" },
    from: { type: "string" },
    to: { type: "string" },
    out: { type: "string" },
    stills: { type: "string" },
    at: { type: "string" },
    chrome: { type: "string", default: process.env.CHROME },
  },
});

const SIZE = { "16x9": [1920, 1080], "4x5": [1080, 1350] }[a.ratio];
if (!SIZE || (!a.out && !a.stills)) {
  console.error("usage: film.mjs --ratio 16x9|4x5 (--out file.mp4 | --stills dir --at 1,2)");
  process.exit(64);
}
const [W, H] = SIZE;
const chrome = a.chrome ?? globSync(join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-*/*/headless_shell")).sort().pop();
if (!chrome) throw new Error("no Chromium: pass --chrome or set CHROME");

const browser = spawn(chrome, ["--headless", "--remote-debugging-port=0", "--hide-scrollbars", "--force-color-profile=srgb", "--font-render-hinting=none", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
process.on("exit", () => browser.kill());
const wsUrl = await new Promise((resolve, reject) => {
  let err = "";
  browser.stderr.on("data", (d) => {
    err += d;
    const m = err.match(/ws:\/\/\S+/);
    if (m) resolve(m[0]);
  });
  browser.on("exit", () => reject(new Error(err)));
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
const page = (method, params) => send(method, params, s);
const run = async (expression) => {
  const r = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await page("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: Number(a.scale), mobile: false });
await page("Page.navigate", { url: `${a.url}?cut=${a.cut}&ratio=${a.ratio}&record=1` });
for (let i = 0; !(await run("Boolean(window.__film)").catch(() => false)); i++) {
  if (i > 600) throw new Error("the film stage never became ready");
  await new Promise((r) => setTimeout(r, 100));
}
const duration = await run("window.__film.duration");

async function frame(t) {
  await run(`window.__film.seek(${t}); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  const { data } = await page("Page.captureScreenshot", { format: "png", optimizeForSpeed: true });
  return Buffer.from(data, "base64");
}

if (a.stills) {
  mkdirSync(a.stills, { recursive: true });
  for (const t of (a.at ?? "0").split(",").map(Number)) writeFileSync(join(a.stills, `${a.ratio}-${t.toFixed(2)}.png`), await frame(t));
} else {
  const fps = Number(a.fps);
  const from = Number(a.from ?? 0);
  const to = Math.min(Number(a.to ?? duration), duration);
  const ff = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-i", "-", "-vf", `scale=${W}:${H}:flags=lanczos`, "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-movflags", "+faststart", a.out], { stdio: ["pipe", "inherit", "inherit"] });
  const frames = Math.round((to - from) * fps);
  const started = Date.now();
  for (let i = 0; i < frames; i++) {
    const png = await frame(from + i / fps);
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % (fps * 5) === 0) console.error(`${(from + i / fps).toFixed(1)}s / ${to.toFixed(1)}s, ${((Date.now() - started) / 1000).toFixed(0)}s elapsed`);
  }
  ff.stdin.end();
  const code = await new Promise((r) => ff.on("exit", r));
  if (code !== 0) throw new Error(`ffmpeg exited with ${code}; ${a.out} is incomplete`);
  console.error(`wrote ${a.out}: ${frames} frames, ${(to - from).toFixed(2)}s`);
}

ws.close();

browser.kill();
