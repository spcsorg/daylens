import type { CSSProperties, ReactNode } from "react";
import "./dots.css";
import { asset } from "../../../../_v2/base";
import type { Beat, Ratio } from "../Film";
import { SHOTS } from "../shots";
import { back, clamp, inOut, keys, mix, out, prog, typed, type Key } from "../time";
import { AppIcons, Cursor, Glyph } from "../ui";
import { APPS, ASK, HOURS, PRIVACY } from "../world";

// Option B, after OpenAI's dots: each use case is a scenario told in one line, then played out in Ask beside the app it points to, on a soft colour field.

type Tone = { field: string; ink: string; soft: string };
const TONES = {
  cream: { field: "#f3ead9", ink: "#141619", soft: "#efe3cc" },
  peach: { field: "#f6d8cc", ink: "#dc6f52", soft: "#fbe4da" },
  sky: { field: "#cfe1f0", ink: "#3b7cc0", soft: "#e2edf7" },
  lilac: { field: "#dcd2ea", ink: "#7a5fb6", soft: "#ece6f5" },
  apricot: { field: "#f2cda6", ink: "#d9731a", soft: "#fcebd8" },
  butter: { field: "#f5dfae", ink: "#141619", soft: "#fcebd8" },
} satisfies Record<string, Tone>;

const toneVars = (t: Tone) => ({ "--d-ink": t.ink, "--d-soft": t.soft }) as CSSProperties;

/* Placement: a window drawn at its own design size, centred at (x, y) on the stage and scaled by s. */

type Place = Key & { x: number; y: number; s: number; o: number };
const at = (t: number, x: number, y: number, s: number, o = 1): Place => ({ t, x, y, s, o });

function Placed({ p, w, h, z, children, tone }: { p: Place; w: number; h: number; z?: number; children: ReactNode; tone: Tone }) {
  return (
    <div
      className="d-placed"
      style={{ ...toneVars(tone), width: w, height: h, zIndex: z, opacity: p.o, transform: `translate(${p.x - w / 2}px, ${p.y - h / 2}px) scale(${p.s})` }}
    >
      {children}
    </div>
  );
}

// A point inside a placed window, in stage pixels.
const point = (p: Place, w: number, h: number, dx: number, dy: number) => ({ x: p.x + (dx - w / 2) * p.s, y: p.y + (dy - h / 2) * p.s });

function Pointer({ x, y, press, o, k }: { x: number; y: number; press: number; o: number; k: number }) {
  return (
    <div className="d-pointer" style={{ opacity: o, transform: `translate(${x}px, ${y}px) scale(${k})` }}>
      <Cursor x={0} y={0} press={press} />
    </div>
  );
}

function Pane({ title, icon, children, className }: { title: string; icon?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`d-pane ${className ?? ""}`}>
      <div className="d-bar">
        <span className="d-lights">
          <i />
          <i />
          <i />
        </span>
        <span className="d-bar-title">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {icon ? <img src={icon} width={16} height={16} alt="" /> : null}
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function Caret({ t }: { t: number }) {
  return <i className="f-caret" style={{ opacity: Math.floor(t * 2) % 2 ? 0 : 1 }} />;
}

function Words({ text, t, start, rate = 11 }: { text: string; t: number; start: number; rate?: number }) {
  const n = clamp((t - start) * rate, 0, 999);
  return (
    <>
      {text.split(" ").slice(0, Math.ceil(n)).map((w, i) => {
        const k = clamp(n - i);
        return (
          <span key={i} style={{ opacity: k, filter: k < 1 ? `blur(${(1 - k) * 3}px)` : undefined }}>
            {w}{" "}
          </span>
        );
      })}
    </>
  );
}

function Bubble({ text, t, sent }: { text: string; t: number; sent: number }) {
  const k = prog(t, sent, sent + 0.4, back);
  return (
    <div className="d-me" style={{ opacity: clamp(k * 2), transform: `translateY(${(1 - k) * 14}px) scale(${mix(0.92, 1, clamp(k))})` }}>
      {text}
    </div>
  );
}

function Thinking({ t, a, b, text }: { t: number; a: number; b: number; text: string }) {
  const o = prog(t, a, a + 0.25) * (1 - prog(t, b - 0.15, b + 0.1));
  if (o <= 0) return null;
  return (
    <div className="d-thinking" style={{ opacity: o, height: 30 * (1 - prog(t, b - 0.1, b + 0.2)) }}>
      <span className="f-shimmer" style={{ backgroundPosition: `${-200 + ((t * 170) % 400)}px 0` }}>
        {text}
      </span>
    </div>
  );
}

function Composer({ q, t, typeAt, sendAt }: { q: string; t: number; typeAt: number; sendAt: number }) {
  const sent = t >= sendAt;
  const draft = typed(q, t, typeAt, 20);
  const press = prog(t, sendAt - 0.1, sendAt) * (1 - prog(t, sendAt + 0.02, sendAt + 0.15));
  return (
    <div className="d-composer">
      <span>
        {!sent && draft ? draft : <span className="f-placeholder">Ask about any day</span>}
        {!sent && t > typeAt ? <Caret t={t} /> : null}
      </span>
      <i className={!sent && draft ? "is-ready" : undefined} style={{ transform: `scale(${1 - press * 0.12})` }}>
        <Glyph name="arrow" size={15} style={{ transform: "rotate(-90deg)" }} />
      </i>
    </div>
  );
}

function AskHead() {
  return (
    <div className="d-head">
      <span className="d-head-title">Ask</span>
      <span className="d-beta">In the beta</span>
    </div>
  );
}

const enter = (t: number, d: number) => prog(t, -0.35, 0.45) * (1 - prog(t, d - 0.15, d + 0.4, inOut));
const rise = (t: number, d: number) => (1 - prog(t, -0.35, 0.6)) * 80 - prog(t, d - 0.15, d + 0.4, inOut) * 40;

/* Scenario card: a small label, then one sentence that inks in word by word. */

function card(label: string, text: string, dur: number, tone: Tone, sub?: string): Beat {
  return {
    kind: "scene",
    dur,
    sky: tone.field,
    render: (t, ratio) => {
      if (t < 0 || t > dur) return null;
      const size = ratio === "4x5" ? 78 : 92;
      const words = text.split(" ");
      const drift = 50 * (1 - out(clamp(t / dur)));
      const gone = prog(t, dur - 0.45, dur - 0.05);
      return (
        <div className={`d-card is-${ratio}`} style={{ ...toneVars(tone), transform: `translateX(${drift}px)` }}>
          <span className="d-label" style={{ opacity: prog(t, 0, 0.35) * (1 - gone) }}>
            <i />
            {label}
          </span>
          <p style={{ fontSize: size }}>
            {words.map((w, i) => {
              const k = prog(t, 0.12 + i * 0.075, 0.42 + i * 0.075);
              return (
                <span key={i} style={{ opacity: (0.2 + 0.8 * k) * (1 - prog(t, dur - 0.5 + i * 0.02, dur - 0.2 + i * 0.02)) * prog(t, 0.1, 0.4) }}>
                  {w}{" "}
                </span>
              );
            })}
          </p>
          {sub ? (
            <small style={{ opacity: prog(t, 0.9, 1.4) * (1 - gone) }}>{sub}</small>
          ) : null}
        </div>
      );
    },
  };
}

/* Opening title: the mark, then the name. */

const opener: Beat = {
  kind: "scene",
  dur: 3.0,
  sky: TONES.butter.field,
  render: (t, ratio) => {
    if (t < 0 || t > 3.0) return null;
    const k = prog(t, 0.05, 0.7, back);
    const gone = prog(t, 2.5, 2.95, inOut);
    const size = ratio === "4x5" ? 96 : 120;
    return (
      <div className="d-open" style={{ opacity: 1 - gone, transform: `translateY(${-gone * 30}px)` }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={asset("/icons/daylens.svg")} alt="" width={size * 0.9} height={size * 0.9} style={{ opacity: clamp(k * 1.5), transform: `scale(${mix(0.85, 1, k)})` }} />
        <h1 style={{ fontSize: size }}>
          {"Introducing Daylens V2".split(" ").map((w, i) => {
            const m = prog(t, 0.35 + i * 0.1, 0.75 + i * 0.1);
            return (
              <span key={i} style={{ opacity: 0.15 + 0.85 * m, filter: m < 1 ? `blur(${(1 - m) * 8}px)` : undefined }}>
                {w}{" "}
              </span>
            );
          })}
        </h1>
        <p style={{ fontSize: size * (ratio === "4x5" ? 0.38 : 0.3), opacity: prog(t, 1.0, 1.5) }}>It writes down your day, so you can ask about it.</p>
      </div>
    );
  },
};

/* A · Find it again: Ask for the post, then open it in Chrome. */

const A = {
  q: "what was that pricing post I read last Tuesday?",
  type: 0.5,
  send: 3.05,
  read: [3.3, 4.4] as [number, number],
  answer: 4.4,
  sources: 7.0,
  click: 8.05,
  dur: 10.6,
};
const A_ANSWER = ASK.answer;

const ASK_W = { "16x9": 600, "4x5": 500 };
const ASK_H = { "16x9": 520, "4x5": 560 };
const PAGE_W = { "16x9": 720, "4x5": 520 };
const PAGE_H = { "16x9": 520, "4x5": 600 };

const sceneFind: Beat = {
  kind: "scene",
  dur: A.dur,
  sky: TONES.peach.field,
  render: (t, ratio) => {
    const d = A.dur;
    if (t < -0.5 || t > d + 0.5) return null;
    const tone = TONES.peach;
    const wide = ratio === "16x9";
    const [aw, ah, pw, ph] = [ASK_W[ratio], ASK_H[ratio], PAGE_W[ratio], PAGE_H[ratio]];
    const o = enter(t, d);
    const r = rise(t, d);
    const ask = keys(
      wide
        ? [at(0, 960, 540, 1.42), at(A.click + 0.1, 960, 540, 1.42), at(A.click + 0.9, 480, 540, 1.28)]
        : [at(0, 540, 675, 2.0), at(A.click + 0.1, 540, 675, 2.0), at(A.click + 0.9, 540, 400, 1.9)],
      t,
    );
    const page = keys(
      wide
        ? [at(0, 1560, 540, 1.28, 0), at(A.click + 0.15, 1560, 540, 1.28, 0), at(A.click + 0.95, 1365, 540, 1.28, 1)]
        : [at(0, 540, 2100, 1.85), at(A.click + 0.15, 540, 2100, 1.85), at(A.click + 0.95, 540, 1030, 1.85)],
      t,
    );
    const cards = prog(t, A.sources, A.sources + 0.5);
    const hot = t > A.click - 0.5 && t < A.click + 0.8;
    const src = point(ask, aw, ah, wide ? 400 : 300, wide ? 344 : 369);
    const ptr = keys(
      [
        { t: A.sources + 0.3, x: src.x + 260, y: src.y + 160, press: 0 },
        { t: A.click - 0.12, x: src.x, y: src.y, press: 0 },
        { t: A.click, x: src.x, y: src.y, press: 1 },
        { t: A.click + 0.14, x: src.x, y: src.y, press: 0 },
        { t: A.click + 0.9, x: src.x - (wide ? 60 : 0), y: src.y + (wide ? 40 : -80), press: 0 },
      ],
      t,
    );
    const ptrO = prog(t, A.sources + 0.1, A.sources + 0.4) * (1 - prog(t, A.click + 0.6, A.click + 1.0));
    return (
      <div className="d-scene" style={{ opacity: o, transform: `translateY(${r}px)` }}>
        <Placed p={ask} w={aw} h={ah} tone={tone} z={1}>
          <Pane title="Daylens" className="d-ask">
            <AskHead />
            <div className="d-thread">
              {t >= A.send ? <Bubble text={A.q} t={t} sent={A.send} /> : null}
              {t >= A.send ? <Thinking t={t} a={A.read[0]} b={A.read[1]} text="Reading last Tuesday" /> : null}
              {t >= A.answer ? (
                <div className="d-them">
                  <Words text={A_ANSWER} t={t} start={A.answer} />
                </div>
              ) : null}
              <div className="d-from" style={{ opacity: cards, transform: `translateY(${(1 - cards) * 14}px)` }}>
                <div className={hot ? "d-page is-hot" : "d-page"}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={ASK.page.icon} width={18} height={18} alt="" />
                  <div>
                    <b>{ASK.page.title}</b>
                    <small>{ASK.page.host}</small>
                  </div>
                  <Glyph name="arrow" />
                </div>
                <div className="d-hours">
                  {ASK.hours.map((h, i) => (
                    <span key={h.at} style={{ opacity: prog(t, A.sources + 0.3 + i * 0.12, A.sources + 0.6 + i * 0.12) }}>
                      <AppIcons apps={h.apps} size={14} />
                      {h.at}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <Composer q={A.q} t={t} typeAt={A.type} sendAt={A.send} />
          </Pane>
        </Placed>
        <Placed p={page} w={pw} h={ph} tone={tone} z={2}>
          <BrowserPage t={t - A.click - 0.4} />
        </Placed>
        <Pointer x={ptr.x} y={ptr.y} press={ptr.press} o={ptrO} k={wide ? 1.5 : 2} />
      </div>
    );
  },
};

function BrowserPage({ t }: { t: number }) {
  const load = prog(t, 0, 0.5);
  return (
    <div className="d-pane d-browser">
      <div className="d-tabs">
        <span className="d-lights">
          <i />
          <i />
          <i />
        </span>
        <span className="d-tab">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={APPS.chrome} width={14} height={14} alt="" />
          Per-seat or usage pricing? – Kestrel
        </span>
      </div>
      <div className="d-url">
        <Glyph name="left" size={14} />
        <Glyph name="right" size={14} style={{ opacity: 0.4 }} />
        <span>kestrel.dev/blog/per-seat-or-usage</span>
      </div>
      <div className="d-progress" style={{ transform: `scaleX(${load})`, opacity: 1 - prog(t, 0.5, 0.8) }} />
      <article className="d-article" style={{ opacity: prog(t, 0.15, 0.6), transform: `translateY(${(1 - prog(t, 0.15, 0.8)) * 12}px)` }}>
        <small>Kestrel · Field notes</small>
        <h2>Per-seat or usage pricing?</h2>
        <p className="d-byline">What we learned moving a small product from seats to usage · 7 min read</p>
        <p>Seats are easy to explain and easy to forecast. Usage follows value, but it makes every invoice a small surprise.</p>
        <p>We tried both for a year. Here is what changed for the customers who stayed, and for the ones who left.</p>
      </article>
    </div>
  );
}

/* B · Count the hours: the invoice is open, Ask has the number, drag it across. */

const B = {
  q: "how many hours did I spend on Harbor Studio this month?",
  type: 0.45,
  send: 3.4,
  read: [3.65, 4.6] as [number, number],
  answer: 4.6,
  grab: 7.55,
  drop: 8.55,
  dur: 10.4,
};
const B_ANSWER = "Five days on Harbor this month, mostly building their site in Cursor, plus two calls with their team about the launch.";
const B_HOURS = ["Mon 6 · 2 PM", "Wed 8 · 10 AM", "Thu 9 · 3 PM", "Mon 13 · 4 PM"];

const MAIL_W = { "16x9": 640, "4x5": 500 };
const MAIL_H = { "16x9": 420, "4x5": 300 };
const ASK_B_H = { "16x9": 520, "4x5": 450 };

const sceneHours: Beat = {
  kind: "scene",
  dur: B.dur,
  sky: TONES.sky.field,
  render: (t, ratio) => {
    const d = B.dur;
    if (t < -0.5 || t > d + 0.5) return null;
    const tone = TONES.sky;
    const wide = ratio === "16x9";
    const [aw, ah, mw, mh] = [ASK_W[ratio], ASK_B_H[ratio], MAIL_W[ratio], MAIL_H[ratio]];
    const o = enter(t, d);
    const r = rise(t, d);
    const ask = wide ? at(0, 524, 540, 1.3) : at(0, 540, 955, 1.9);
    const mail = keys(wide ? [at(0, 1370, 540, 1.3), at(d, 1366, 540, 1.31)] : [at(0, 540, 300, 1.75), at(d, 540, 302, 1.76)], t);
    const from = point(ask, aw, ah, wide ? 521 : 422, wide ? 312 : 337);
    const to = point(mail, mw, mh, wide ? 554 : 412, wide ? 224 : 223);
    const ptr = keys(
      [
        { t: B.grab - 0.9, x: from.x + 140, y: from.y + 150, press: 0 },
        { t: B.grab - 0.08, x: from.x, y: from.y, press: 0 },
        { t: B.grab + 0.05, x: from.x, y: from.y, press: 1 },
        { t: B.drop, x: to.x, y: to.y, press: 1 },
        { t: B.drop + 0.12, x: to.x, y: to.y, press: 0 },
        { t: B.drop + 0.9, x: to.x + 40, y: to.y + 60, press: 0 },
      ],
      t,
      inOut,
    );
    const ptrO = prog(t, B.grab - 1.0, B.grab - 0.7) * (1 - prog(t, B.drop + 0.6, B.drop + 1.0));
    const lift = prog(t, B.grab, B.grab + 0.15) * (1 - prog(t, B.drop, B.drop + 0.2));
    const dragging = t > B.grab && t < B.drop + 0.05;
    const dropped = prog(t, B.drop, B.drop + 0.35, back);
    const cards = prog(t, B.answer + 1.9, B.answer + 2.4);
    return (
      <div className="d-scene" style={{ opacity: o, transform: `translateY(${r}px)` }}>
        <Placed p={mail} w={mw} h={mh} tone={tone} z={1}>
          <Pane title="Invoice 1042" icon={APPS.mail} className="d-mail">
            <div className="d-field">
              <span>To</span>Maya Lind, Harbor Studio
            </div>
            <div className="d-field">
              <span>Subject</span>Invoice 1042, April so far
            </div>
            <div className="d-letter">
              <p>Hi Maya, here are this month’s hours.</p>
              <div className="d-table">
                <span>Harbor site, design and build</span>
                <span className={dropped > 0 ? "d-cell is-full" : t > 1 ? "d-cell is-wait" : "d-cell"} style={{ transform: `scale(${mix(1, 1.06, Math.sin(clamp(dropped) * Math.PI))})` }}>
                  {dropped > 0 ? "11h 20m" : <Caret t={t} />}
                </span>
              </div>
              {wide ? <p className="d-muted">Thanks, and see you Thursday.</p> : null}
            </div>
          </Pane>
        </Placed>
        <Placed p={ask} w={aw} h={ah} tone={tone} z={2}>
          <Pane title="Daylens" className="d-ask">
            <AskHead />
            <div className="d-thread">
              {t >= B.send ? <Bubble text={B.q} t={t} sent={B.send} /> : null}
              {t >= B.send ? <Thinking t={t} a={B.read[0]} b={B.read[1]} text="Reading April so far" /> : null}
              {t >= B.answer ? (
                <div className="d-them">
                  <Words text={B_ANSWER} t={t} start={B.answer} />
                </div>
              ) : null}
              <div className="d-from" style={{ opacity: cards, transform: `translateY(${(1 - cards) * 14}px)` }}>
                <div className="d-total">
                  <span>Harbor Studio, April so far</span>
                  <b className="d-grab" style={{ opacity: 1 - 0.55 * lift }}>11h 20m</b>
                </div>
                {wide ? (
                  <div className="d-hours">
                    {B_HOURS.map((h, i) => (
                      <span key={h} style={{ opacity: prog(t, B.answer + 2.1 + i * 0.1, B.answer + 2.4 + i * 0.1) }}>
                        {h}
                      </span>
                    ))}
                    <span className="d-more" style={{ opacity: prog(t, B.answer + 2.5, B.answer + 2.8) }}>
                      10 more hours
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
            <Composer q={B.q} t={t} typeAt={B.type} sendAt={B.send} />
          </Pane>
        </Placed>
        {dragging ? (
          <div className="d-ghost" style={{ ...toneVars(tone), transform: `translate(${ptr.x + 14}px, ${ptr.y + 18}px) scale(${wide ? 1.35 : 1.8})` }}>
            11h 20m
          </div>
        ) : null}
        <Pointer x={ptr.x} y={ptr.y} press={ptr.press} o={ptrO} k={wide ? 1.5 : 2} />
      </div>
    );
  },
};

/* C · Brief your assistant: Claude Code asks Daylens about the morning, and the hours it reads light up. */

const C = {
  q: "write my standup from this morning",
  type: 0.45,
  send: 2.4,
  tool: 2.8,
  read: 3.0,
  answer: 4.5,
  dur: 9.6,
};
const C_LINES = ["Answered the Thursday review notes", "Drafted most of the spring pricing memo", "The design sync ran long, then I fixed the pricing page"];

const CC_W = { "16x9": 600, "4x5": 500 };
const CC_H = { "16x9": 500, "4x5": 430 };
const DAY_W = { "16x9": 600, "4x5": 500 };
const DAY_H = { "16x9": 500, "4x5": 340 };

const sceneAssistant: Beat = {
  kind: "scene",
  dur: C.dur,
  sky: TONES.lilac.field,
  render: (t, ratio) => {
    const d = C.dur;
    if (t < -0.5 || t > d + 0.5) return null;
    const tone = TONES.lilac;
    const wide = ratio === "16x9";
    const [cw, ch, dw, dh] = [CC_W[ratio], CC_H[ratio], DAY_W[ratio], DAY_H[ratio]];
    const o = enter(t, d);
    const r = rise(t, d);
    const cc = wide ? at(0, 550, 540, 1.3) : at(0, 540, 945, 1.9);
    const day = keys(wide ? [at(0, 1370, 540, 1.3), at(d, 1366, 540, 1.31)] : [at(0, 540, 300, 1.7), at(d, 540, 302, 1.71)], t);
    const sent = t >= C.send;
    const draft = typed(C.q, t, C.type, 20);
    const reading = t > C.tool && t < C.answer - 0.2;
    const tool = prog(t, C.tool, C.tool + 0.3);
    return (
      <div className="d-scene" style={{ opacity: o, transform: `translateY(${r}px)` }}>
        <Placed p={day} w={dw} h={dh} tone={tone} z={1}>
          <Pane title="Daylens" className="d-today">
            <div className="d-day-head">
              <span>Tuesday, 14 April</span>
              <small>Today</small>
            </div>
            {HOURS.slice(0, wide ? 5 : 3).map((h, i) => {
              const lit = i < 3 ? prog(t, C.read + i * 0.35, C.read + 0.3 + i * 0.35) * (1 - 0.55 * prog(t, C.answer + 1.2, C.answer + 1.8)) : 0;
              return (
                <div key={h.at} className={h.away ? "d-row is-away" : "d-row"}>
                  <i className="d-lit" style={{ opacity: lit, transform: `scaleX(${mix(0.96, 1, lit)})` }} />
                  <span className="d-row-at">{h.at}</span>
                  <div>
                    <b>{h.title}</b>
                    {h.apps.length ? <AppIcons apps={h.apps} size={14} /> : null}
                  </div>
                </div>
              );
            })}
          </Pane>
        </Placed>
        <Placed p={cc} w={cw} h={ch} tone={tone} z={2}>
          <Pane title="Claude Code" icon={APPS.claude} className="d-ask d-cc">
            <div className="d-thread">
              {sent ? <Bubble text={C.q} t={t} sent={C.send} /> : null}
              {t >= C.tool ? (
                <div className="d-tool" style={{ opacity: tool, transform: `scale(${mix(0.94, 1, tool)})` }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={asset("/icons/daylens.svg")} width={16} height={16} alt="" />
                  <span className={reading ? "f-shimmer" : undefined} style={reading ? { backgroundPosition: `${-200 + ((t * 170) % 400)}px 0` } : undefined}>
                    Daylens · read Tuesday, 9 AM to 12 PM
                  </span>
                </div>
              ) : null}
              {t >= C.answer ? (
                <div className="d-them d-standup">
                  <b style={{ opacity: prog(t, C.answer, C.answer + 0.3) }}>Standup, Tuesday morning</b>
                  {C_LINES.map((l, i) => (
                    <div key={l} className="d-li">
                      <Words text={l} t={t} start={C.answer + 0.35 + i * 0.75} rate={13} />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="d-composer">
              <span>
                {!sent && draft ? draft : <span className="f-placeholder">Reply to Claude</span>}
                {!sent && t > C.type ? <Caret t={t} /> : null}
              </span>
              <i className={!sent && draft ? "is-ready" : undefined}>
                <Glyph name="arrow" size={15} style={{ transform: "rotate(-90deg)" }} />
              </i>
            </div>
          </Pane>
        </Placed>
        {wide ? <p className="d-note" style={{ opacity: prog(t, C.answer + 2.6, C.answer + 3.1) * (1 - prog(t, d - 0.3, d)) }}>
          Assistants connect over MCP. Every read shows up in Settings, with the assistant’s name.
        </p> : null}
      </div>
    );
  },
};

/* Privacy, in the exact words. */

const privacy = card("Yours", "It stays on your Mac.", 4.6, TONES.apricot, PRIVACY);

const morning = { ...SHOTS.morning, dur: 6.9 };

export const dots: Beat[] = [
  opener,
  { kind: "shot", shot: morning, sky: TONES.butter.field },
  card("Find it again", "You’re finishing a pricing memo and can’t find the post you read last Tuesday.", 3.4, TONES.peach),
  sceneFind,
  card("Count the hours", "You’re sending Harbor Studio an invoice and need this month’s hours.", 3.1, TONES.sky),
  sceneHours,
  card("Brief your assistant", "You want Claude Code to write your standup from this morning.", 3.1, TONES.lilac),
  sceneAssistant,
  privacy,
  { kind: "end", dur: 3.6, sky: TONES.butter.field },
];
