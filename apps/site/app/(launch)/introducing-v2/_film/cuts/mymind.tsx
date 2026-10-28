import type { CSSProperties, ReactNode } from "react";
import { asset } from "../../../../_v2/base";
import type { Ratio } from "../Film";
import { Cursor, Glyph } from "../ui";
import { clamp, inOut, keys, mix, out, prog, typed } from "../time";
import { APPS, ASK, HOURS, LAST_WEEK, MONTH, MORNING_SUMMARY, OPEN_HOUR, PRIVACY, SEARCH, WAITLIST_URL } from "../world";
import "../mymind.css";

// Option D, after mymind's onboarding: one bezel-less Mac window on a flat blue field, a living daylight gradient inside it,
// type that goes from blurred to sharp, and a small sun that you tap and that blooms into the next screen.

const FRAME = {
  "4x5": { w: 1080, h: 1350, pw: 640, ph: 860, k: 1.33, top: 64, col: 580, pad: 80, sun: 64, wide: false },
  "16x9": { w: 1920, h: 1080, pw: 1100, ph: 740, k: 1.24, top: 52, col: 720, pad: 50, sun: 40, wide: true },
} as const;
type Frame = (typeof FRAME)[Ratio];

const FIELD = "#5b95ec";
const MARK = asset("/icons/daylens.svg");

// Each screen runs from its start to the tap that blooms it away; the next one starts as the bloom clears.
const HOLDS = [4.6, 4.2, 8.3, 6.0, 6.4, 11.8, 7.0];
const END = 5.6;
const GAP = 0.34;
const TAPS = HOLDS.reduce<number[]>((a, d, i) => [...a, (i ? a[i - 1] + GAP : 0) + d], []);
const STARTS = [0, ...TAPS.map((x) => x + GAP)];
const LENGTH = STARTS[STARTS.length - 1] + END;

// The day passes inside the window: dawn on the welcome, noon in the calendar, dusk at the end.
const DAYLIGHT: [number, string][] = [
  [0, "#f4cdbf"],
  [STARTS[2], "#f6dca0"],
  [STARTS[3], "#c9def2"],
  [STARTS[5], "#f3c193"],
  [STARTS[6], "#efb7a8"],
  [STARTS[7], "#d5c8ec"],
];

const easeIn = (x: number) => x * x * x;
// A landing that squashes, overshoots and settles, like Park's logo.
const jelly = (x: number) => (x <= 0 ? 0 : 1 - Math.exp(-7 * x) * Math.cos(13 * x));

function hex(a: string, b: string, k: number) {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v, i) => Math.round(mix(v, y[i], k))).join(" ")})`;
}

function daylight(t: number) {
  const i = Math.max(0, DAYLIGHT.findLastIndex(([at]) => at <= t));
  const [at, c] = DAYLIGHT[i];
  const next = DAYLIGHT[Math.min(i + 1, DAYLIGHT.length - 1)];
  return hex(c, next[1], next[0] > at ? prog(t, next[0] - 1.6, next[0] + 0.4, inOut) : 0);
}

function Sky({ t }: { t: number }) {
  const s = (f: number, p: number) => Math.sin(t * f + p);
  const sun = daylight(t);
  return (
    <div
      className="mm-sky"
      style={{
        background: [
          `radial-gradient(62% 46% at ${22 + 12 * s(0.23, 0)}% ${16 + 9 * s(0.19, 1)}%, ${sun} 0%, transparent 72%)`,
          `radial-gradient(58% 50% at ${82 + 10 * s(0.17, 2)}% ${64 + 12 * s(0.21, 3)}%, #c3cae6 0%, transparent 70%)`,
          `radial-gradient(48% 36% at ${54 + 14 * s(0.15, 4)}% ${42 + 10 * s(0.25, 5)}%, #ffffff 0%, transparent 72%)`,
          `radial-gradient(40% 34% at ${18 + 8 * s(0.2, 6)}% ${86 + 6 * s(0.16, 7)}%, ${sun} 0%, transparent 70%)`,
          "linear-gradient(180deg, #f1f2f7 0%, #dfe3ef 100%)",
        ].join(","),
      }}
    />
  );
}

// Words go from a heavy blur to sharp, one after another. "|" breaks the line.
function Blur({ text, t, at, step = 0.07, d = 0.7, px = 14 }: { text: string; t: number; at: number; step?: number; d?: number; px?: number }) {
  let n = 0;
  return (
    <>
      {text.split("|").map((line, l) => (
        <span key={l} className="mm-line">
          {line.split(" ").map((w, i) => {
            const k = prog(t, at + n * step, at + n * step + d);
            n++;
            return (
              <span key={i} className="mm-w" style={{ opacity: k, filter: k < 1 ? `blur(${(1 - k) * px}px)` : undefined }}>
                {w}{" "}
              </span>
            );
          })}
        </span>
      ))}
    </>
  );
}

function Head({ text, t, f, at = 0.1 }: { text: string; t: number; f: Frame; at?: number }) {
  return (
    <div className="mm-head" style={f.wide ? { marginBottom: 26 } : undefined}>
      {f.wide ? null : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={MARK} alt="" width={30} height={30} style={{ opacity: prog(t, at - 0.1, at + 0.3), filter: `blur(${(1 - prog(t, at - 0.1, at + 0.4)) * 6}px)` }} />
      )}
      <h1>
        <Blur text={f.wide ? text.replace("|", " ") : text} t={t} at={at} />
      </h1>
    </div>
  );
}

function Icons({ apps, t, at }: { apps: string[]; t: number; at: number }) {
  return (
    <span className="mm-icons">
      {apps.map((src, i) => {
        const k = jelly(t - at - i * 0.06);
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={src} src={src} alt="" width={20} height={20} style={{ opacity: clamp(k * 3), transform: `scale(${mix(0.4, 1, k)})` }} />
        );
      })}
    </span>
  );
}

/* 1 · Welcome */

function Welcome({ t, f }: { t: number; f: Frame }) {
  const bloom = prog(t, 0.35, 1.4);
  const d = f.wide ? 440 : 500;
  return (
    <div className="mm-scene" style={{ paddingTop: f.wide ? 54 : 96 }}>
      <div className="mm-circle" style={{ width: d, height: d, opacity: bloom, transform: `scale(${mix(0.72, 1, bloom)})`, filter: bloom < 1 ? `blur(${(1 - bloom) * 30}px)` : undefined }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={MARK} alt="" width={46} height={46} style={{ opacity: prog(t, 0.9, 1.3), filter: `blur(${(1 - prog(t, 0.9, 1.4)) * 8}px)` }} />
        <h1>
          <Blur text="Your day,|written down" t={t} at={1.05} step={0.1} d={0.8} />
        </h1>
      </div>
      <p className="mm-sub" style={{ marginTop: 34 }}>
        <Blur text="Daylens notes the apps, windows and pages you use, and turns them into a calendar of your day." t={t} at={2.0} step={0.025} d={0.6} px={8} />
      </p>
    </div>
  );
}

/* 2 · Nothing to do */

const NOS = ["timers", "tagging", "writing it up"];

function Nothing({ t, f }: { t: number; f: Frame }) {
  return (
    <div className="mm-scene" style={{ paddingTop: f.ph * 0.24 }}>
      <Head text="Just use your Mac." t={t} f={f} />
      <div className="mm-nos">
        {NOS.map((w, i) => {
          const a = 0.75 + i * 0.45;
          const no = prog(t, a, a + 0.25);
          const k = prog(t, a + 0.12, a + 0.85);
          return (
            <p key={w}>
              <span className="mm-no" style={{ opacity: no }}>
                No
              </span>{" "}
              <span style={{ opacity: k, filter: k < 1 ? `blur(${(1 - k) * 16}px)` : undefined }}>{w}</span>
            </p>
          );
        })}
      </div>
    </div>
  );
}

/* 3 · The day fills in, hour by hour */

const ROW = 54;
const CARD_HEAD = 78;
const D_FIRST = 1.15;
const D_EACH = 0.78;
const SWALLOW = 0.38;
const D_SWEEP = D_FIRST + 5 * D_EACH + SWALLOW + 0.35;

const appOf = (title: string) =>
  title.endsWith("Mail") ? APPS.mail : title.endsWith("Notion") ? APPS.notion : title.endsWith("Zoom") ? APPS.zoom : title.endsWith("Claude") ? APPS.claude : APPS.chrome;

function Chip({ text, t, hour, j, half }: { text: string; t: number; hour: number; j: number; half: number }) {
  const a = D_FIRST + hour * D_EACH;
  const side = (hour + j) % 2 ? 1 : -1;
  const rest = { x: side * (half * 0.34 + j * 22), y: CARD_HEAD + (hour + 1.25 + j * 0.82) * ROW, r: side * (4 + 3 * j) * (j % 2 ? -1 : 1) };
  const enter = prog(t, a - 1.0 + j * 0.1, a - 0.45 + j * 0.1);
  const fly = prog(t, a + j * 0.05, a + SWALLOW - 0.02, easeIn);
  if (fly >= 1) return null;
  const bob = Math.sin(t * 2.1 + hour + j) * 4;
  const x = mix(rest.x + side * 120 * (1 - enter), -half * 0.18, fly);
  const y = mix(rest.y + bob, CARD_HEAD + hour * ROW + ROW / 2, fly);
  return (
    <div
      className="mm-chip"
      style={{
        opacity: enter * (1 - clamp((fly - 0.55) / 0.45)),
        filter: enter < 1 ? `blur(${(1 - enter) * 10}px)` : undefined,
        transform: `translate(calc(${x}px - 50%), calc(${y}px - 50%)) rotate(${mix(rest.r, 0, fly)}deg) scale(${mix(1, 0.32, fly)})`,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={appOf(text)} alt="" width={18} height={18} />
      {text}
    </div>
  );
}

function DayRow({ i, t }: { i: number; t: number }) {
  const h = HOURS[i];
  const a = D_FIRST + i * D_EACH;
  const s = a + SWALLOW;
  const lean = prog(t, a, s, easeIn) * (1 - prog(t, s, s + 0.06));
  const landed = prog(t, s, s + 0.12);
  const j = jelly(t - s);
  const flash = h.away ? 0 : prog(t, s, s + 0.05) * (1 - prog(t, s + 0.1, s + 0.9));
  return (
    <div className="mm-row" style={{ height: ROW, background: `rgb(252 235 216 / ${flash})` }}>
      <span className={h.now ? "mm-at is-now" : "mm-at"} style={{ opacity: 0.35 + 0.65 * prog(t, 0.3 + i * 0.06, 0.7 + i * 0.06) }}>
        {h.at}
      </span>
      <i className="mm-skel" style={{ opacity: (1 - landed) * prog(t, 0.4 + i * 0.06, 0.8 + i * 0.06), transform: `scaleX(${mix(1, 1.1, lean)}) scaleY(${mix(1, 1.5, lean)})` }} />
      <div
        className={h.away ? "mm-row-body is-away" : "mm-row-body"}
        style={{
          opacity: landed,
          filter: landed < 1 ? `blur(${(1 - landed) * 6}px)` : undefined,
          transform: h.away ? undefined : `scale(${mix(0.86, 1, j)}, ${mix(0.7, 1, j)})`,
        }}
      >
        <b>{h.title}</b>
        {h.now ? (
          <span className="mm-live">
            <i style={{ transform: `scale(${1 + 0.35 * Math.max(0, Math.sin(t * 5))})` }} />
            Recording now
          </span>
        ) : (
          <Icons apps={h.apps} t={t} at={s + 0.08} />
        )}
      </div>
    </div>
  );
}

function Day({ t, f }: { t: number; f: Frame }) {
  const w = Math.min(f.col, 600);
  const sweep = prog(t, D_SWEEP, D_SWEEP + 0.42, easeIn);
  const pop = jelly(t - D_SWEEP - 0.42);
  return (
    <div className="mm-scene" style={{ paddingTop: f.wide ? f.pad : f.pad - 20 }}>
      <Head text="It writes your day,|hour by hour." t={t} f={f} />
      <div className="mm-stack" style={{ width: w }}>
        <div className="mm-card mm-day" style={{ opacity: prog(t, 0.2, 0.7), transform: `translateY(${(1 - prog(t, 0.2, 0.9)) * 24}px) scale(${t > D_SWEEP + 0.42 ? mix(1.012, 1, pop) : 1})` }}>
          <div className="mm-card-head" style={{ height: CARD_HEAD }}>
            <span className="mm-serif">Tuesday</span>
            <span className="mm-meta">2:10 PM</span>
          </div>
          {HOURS.map((h, i) => (
            <DayRow key={h.at} i={i} t={t} />
          ))}
          <p className="mm-summary">
            <Blur text={MORNING_SUMMARY} t={t} at={D_SWEEP + 0.4} step={0.04} d={0.5} px={8} />
          </p>
          <i className="mm-sweep" style={{ opacity: sweep > 0 && sweep < 1 ? 1 : 0, transform: `translateY(${mix(-40, 110, sweep)}%)` }} />
        </div>
        {HOURS.map((h, i) => (h.raw ?? []).map((r, j) => <Chip key={r} text={r} t={t} hour={i} j={j} half={w / 2} />))}
      </div>
    </div>
  );
}

/* 4 · Every day becomes a calendar */

const C_WEEK = 0.7;
const C_MONTH = 3.3;

function Seg({ t }: { t: number }) {
  const x = keys([{ t: 0, x: 0 }, { t: C_WEEK, x: 0 }, { t: C_WEEK + 0.35, x: 1 }, { t: C_MONTH, x: 1 }, { t: C_MONTH + 0.35, x: 2 }], t).x;
  return (
    <div className="mm-seg">
      <i style={{ transform: `translateX(${x * 100}%)` }} />
      {["Day", "Week", "Month"].map((v, i) => (
        <span key={v} style={{ color: Math.abs(x - i) < 0.5 ? "var(--w-text)" : undefined }}>
          {v}
        </span>
      ))}
    </div>
  );
}

function Week({ t, gone }: { t: number; gone: number }) {
  const rows = ["8", "9", "10", "11", "12", "1", "2", "3", "4"];
  return (
    <div className="mm-week" style={{ opacity: 1 - gone, filter: gone ? `blur(${gone * 12}px)` : undefined }}>
      <div className="mm-week-days">
        {LAST_WEEK.days.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="mm-week-grid">
        {rows.map((h, i) => (
          <span key={h} className="mm-week-line" style={{ top: i * 32 }}>
            {h}
          </span>
        ))}
        {LAST_WEEK.blocks.map((b, i) => {
          const a = C_WEEK + 0.2 + b.col * 0.09 + b.start * 0.035;
          const k = jelly(t - a);
          return (
            <div
              key={i}
              className="mm-block"
              style={{ left: `calc(${b.col} * (100% / 7) + 2px)`, top: b.start * 32 + 2, height: b.len * 32 - 4, opacity: prog(t, a, a + 0.12), transform: `translateY(${(1 - k) * -16}px) scaleY(${mix(0.8, 1, k)})` }}
            >
              {b.label}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Month({ t }: { t: number }) {
  const cells: (number | null)[] = [...MONTH.lead.map(() => null), ...MONTH.days, 1, 2, 3];
  return (
    <div className="mm-month">
      <div className="mm-week-days">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="mm-month-grid">
        {cells.map((d, i) => {
          const total = d !== null && i < 32 ? MONTH.totals[d] : undefined;
          const k = prog(t, C_MONTH + 0.15 + i * 0.018, C_MONTH + 0.6 + i * 0.018);
          return (
            <div key={i} className={d === null || i >= 32 ? "mm-cell is-out" : "mm-cell"} style={{ opacity: k, filter: k < 1 ? `blur(${(1 - k) * 8}px)` : undefined }}>
              <span className={d === 14 ? "is-today" : undefined}>{d ?? MONTH.lead[i]}</span>
              {total ? (
                <>
                  <b>{total[0]}</b>
                  <small>{total[1]}</small>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Calendar({ t, f }: { t: number; f: Frame }) {
  const month = t >= C_MONTH;
  const gone = prog(t, C_MONTH, C_MONTH + 0.3);
  const title = t < C_WEEK + 0.2 ? "Tuesday, 14 April" : t < C_MONTH + 0.2 ? LAST_WEEK.title : MONTH.title;
  const swap = [C_WEEK + 0.2, C_MONTH + 0.2].filter((x) => x <= t).pop() ?? -1;
  return (
    <div className="mm-scene" style={{ paddingTop: f.pad }}>
      <Head text="Every day becomes|a calendar." t={t} f={f} />
      <div className="mm-card mm-cal" style={{ width: f.col, opacity: prog(t, 0.2, 0.7), transform: `translateY(${(1 - prog(t, 0.2, 0.9)) * 24}px)` }}>
        <div className="mm-card-head">
          <span className="mm-serif" key={title} style={{ opacity: swap < 0 ? 1 : prog(t, swap, swap + 0.3), filter: swap >= 0 && t < swap + 0.3 ? `blur(${(1 - prog(t, swap, swap + 0.3)) * 8}px)` : undefined }}>
            {title}
          </span>
          <Seg t={t} />
        </div>
        <div className="mm-cal-body">
          {gone < 1 ? <Week t={t} gone={gone} /> : null}
          {month ? <Month t={t} /> : null}
        </div>
      </div>
    </div>
  );
}

/* 5 · Search, typed large, the results sliding in under it */

const S_TYPE = 0.75;
const S_DONE = S_TYPE + SEARCH.query.length / 17;
const S_NEXT = S_DONE + 1.7;

function Search({ t, f }: { t: number; f: Frame }) {
  const q = typed(SEARCH.query, t, S_TYPE, 17);
  const lift = prog(t, S_DONE + 0.1, S_DONE + 0.6, inOut);
  const c = keys([{ t: S_DONE, c: -1.4 }, { t: S_DONE + 0.8, c: 0 }, { t: S_NEXT, c: 0 }, { t: S_NEXT + 0.55, c: 1 }], t, out).c;
  const shown = prog(t, S_DONE + 0.05, S_DONE + 0.4);
  const cards = [
    ...SEARCH.pages.map((p) => ({ key: p.title, icon: <img src={p.icon} alt="" width={22} height={22} />, title: p.title.split(" – ")[0], meta: p.meta, foot: p.hour })),
    { key: "hour", icon: <Glyph name="today" size={20} />, title: SEARCH.hours[0].title, meta: SEARCH.hours[0].meta, foot: "Five pages, 52 minutes" },
  ];
  return (
    <div className="mm-scene" style={{ paddingTop: f.pad }}>
      <Head text="Find it the way|you remember it." t={t} f={f} />
      <div className="mm-query" style={{ transform: `translateY(${mix(f.ph * 0.1, 0, lift)}px)` }}>
        {q ? q : <span className="mm-placeholder" style={{ opacity: prog(t, 0.3, 0.6) }}>Search your days</span>}
        {t > S_TYPE - 0.3 && t < S_DONE + 0.4 ? <i className="mm-caret" style={{ opacity: Math.floor(t * 2.4) % 2 ? 0 : 1 }} /> : null}
      </div>
      <div className="mm-carousel" style={{ opacity: shown }}>
        {cards.map((card, i) => {
          const o = i - c;
          const a = Math.abs(o);
          return (
            <div
              key={card.key}
              className="mm-result"
              style={{ transform: `translateX(calc(-50% + ${o * 324}px)) scale(${1 - Math.min(a, 1.5) * 0.12})`, opacity: 1 - Math.min(a, 2) * 0.32, filter: a > 0.05 ? `blur(${Math.min(a, 2) * 2.4}px)` : undefined }}
            >
              <div className="mm-result-top">
                {card.icon}
                <small>{card.meta}</small>
              </div>
              <b>{card.title}</b>
              <small className="mm-result-foot">{card.foot}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* 6 · Ask, the hero: a calm answer with the page and hours it came from */

const A_TYPE = 1.0;
const A_SEND = A_TYPE + ASK.question.length / 20 + 0.35;
const A_ANSWER = A_SEND + 1.45;
const A_WORDS = ASK.answer.split(" ");
const A_SOURCES = A_ANSWER + A_WORDS.length / 11 + 0.2;

function Ask({ t, f }: { t: number; f: Frame }) {
  const sent = prog(t, A_SEND, A_SEND + 0.8, inOut);
  const draft = typed(ASK.question, t, A_TYPE, 20);
  const thinking = prog(t, A_SEND + 0.45, A_SEND + 0.75) * (1 - prog(t, A_ANSWER - 0.15, A_ANSWER + 0.1));
  const words = clamp((t - A_ANSWER) * 11, 0, A_WORDS.length);
  const src = (d: number) => {
    const k = prog(t, A_SOURCES + d, A_SOURCES + d + 0.55);
    return { opacity: k, transform: `translateY(${(1 - k) * 22}px)`, filter: k < 1 ? `blur(${(1 - k) * 8}px)` : undefined } as CSSProperties;
  };
  return (
    <div className="mm-scene" style={{ paddingTop: mix(f.ph * 0.33, f.pad - 18, sent) }}>
      <div className="mm-ask-head" style={{ opacity: 1 - prog(t, A_SEND, A_SEND + 0.3), top: f.pad }}>
        <Head text="Or just ask." t={t} f={f} />
        <span className="mm-pill" style={{ opacity: prog(t, 0.5, 0.9) }}>
          Ask, in the beta
        </span>
      </div>
      <div className="mm-question" style={{ fontSize: mix(40, 27, sent), maxWidth: mix(Math.min(f.col, 620), f.col, sent) }}>
        {draft ? draft : <span className="mm-placeholder" style={{ opacity: prog(t, 0.6, 0.9) }}>Ask about any day</span>}
        {t > A_TYPE - 0.3 && t < A_SEND ? <i className="mm-caret" style={{ opacity: Math.floor(t * 2.4) % 2 ? 0 : 1 }} /> : null}
      </div>
      <div className="mm-answer-area" style={{ width: f.col }}>
        <p className="mm-thinking" style={{ opacity: thinking, height: 24 * (1 - prog(t, A_ANSWER - 0.1, A_ANSWER + 0.3)) }}>
          <span style={{ backgroundPosition: `${-220 + ((t * 170) % 440)}px 0` }}>Reading Tuesday</span>
        </p>
        <p className="mm-answer">
          {A_WORDS.map((w, i) => {
            const k = clamp(words - i, 0, 1);
            return (
              <span key={i} style={{ opacity: k, filter: k < 1 ? `blur(${(1 - k) * 6}px)` : undefined }}>
                {w}{" "}
              </span>
            );
          })}
        </p>
        <div className="mm-sources">
          <small style={src(0)}>From this page and these hours</small>
          <div className="mm-card mm-page" style={src(0.1)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={ASK.page.icon} alt="" width={22} height={22} />
            <div>
              <b>{ASK.page.title}</b>
              <small>{ASK.page.host}</small>
            </div>
            <Glyph name="arrow" size={16} />
          </div>
          {ASK.hours.map((h, i) => (
            <div key={h.at} className="mm-card mm-src-hour" style={src(0.28 + i * 0.16)}>
              <span className="mm-at">{h.at}</span>
              <div>
                <b>{h.title}</b>
                <small>{h.line}</small>
              </div>
              <span className="mm-icons">
                {h.apps.map((a) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={a} src={a} alt="" width={18} height={18} />
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* 7 · Remove a page, then pause */

const P_X = 1.55;
const P_REMOVE = 2.35;
const P_PAUSE = 3.5;
const P_ROW = 54;

function Forget({ t, f }: { t: number; f: Frame }) {
  const w = Math.min(f.col, 600);
  const confirm = prog(t, P_X + 0.05, P_X + 0.3);
  const gone = prog(t, P_REMOVE + 0.05, P_REMOVE + 0.5, inOut);
  const paused = prog(t, P_PAUSE + 0.05, P_PAUSE + 0.5, inOut);
  const rows = [...OPEN_HOUR.pages, ...OPEN_HOUR.windows];
  const rowY = (i: number) => 132 + i * P_ROW + P_ROW / 2 + 52 * paused;
  const cur = keys(
    [
      { t: 0.7, x: w * 0.5, y: 420, p: 0 },
      { t: P_X - 0.14, x: w - 30, y: rowY(3), p: 0 },
      { t: P_X, x: w - 30, y: rowY(3), p: 1 },
      { t: P_X + 0.14, x: w - 30, y: rowY(3), p: 0 },
      { t: P_REMOVE - 0.14, x: w - 54, y: rowY(3), p: 0 },
      { t: P_REMOVE, x: w - 54, y: rowY(3), p: 1 },
      { t: P_REMOVE + 0.14, x: w - 54, y: rowY(3), p: 0 },
      { t: P_PAUSE - 0.14, x: w - 62, y: 40, p: 0 },
      { t: P_PAUSE, x: w - 62, y: 40, p: 1 },
      { t: P_PAUSE + 0.14, x: w - 62, y: 40, p: 0 },
      { t: 5.0, x: w - 20, y: 150, p: 0 },
    ],
    t,
  );
  return (
    <div className="mm-scene" style={{ paddingTop: f.pad }}>
      <Head text="You decide what stays." t={t} f={f} />
      <div className="mm-stack" style={{ width: w }}>
        <div className="mm-card mm-forget" style={{ opacity: prog(t, 0.2, 0.7), transform: `translateY(${(1 - prog(t, 0.2, 0.9)) * 24}px)` }}>
          <div className="mm-card-head">
            <div>
              <small className="mm-meta">Tuesday, {OPEN_HOUR.range}</small>
              <span className="mm-serif">{OPEN_HOUR.title}</span>
            </div>
            <span className={paused > 0.5 ? "mm-btn is-on" : "mm-btn"}>
              <Glyph name={paused > 0.5 ? "right" : "pause"} size={14} />
              {paused > 0.5 ? "Resume" : "Pause"}
            </span>
          </div>
          <div className="mm-paused" style={{ height: 52 * paused, opacity: paused }}>
            <span>
              <Glyph name="pause" size={14} />
              Paused until 3:00 PM. Nothing is recorded.
            </span>
          </div>
          {rows.map((p, i) => {
            const target = i === 3;
            return (
              <div
                key={p.title}
                className="mm-page-row"
                style={target ? { height: P_ROW * (1 - gone), opacity: 1 - gone, filter: gone ? `blur(${gone * 10}px)` : undefined } : { height: P_ROW }}
              >
                {target && confirm > 0 ? (
                  <div className="mm-confirm" style={{ opacity: confirm }}>
                    <span>Remove this page from Tuesday?</span>
                    <span className="mm-danger">Remove</span>
                  </div>
                ) : (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.icon} alt="" width={20} height={20} />
                    <div>
                      <b>{p.title}</b>
                      <small>{p.host}</small>
                    </div>
                    <span className="mm-min">{p.min}</span>
                    <Glyph name="x" size={14} />
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ position: "absolute", inset: 0, opacity: prog(t, 0.6, 0.9) * (1 - prog(t, 4.6, 5.0)) }}>
          <Cursor x={cur.x} y={cur.y} press={cur.p} />
        </div>
      </div>
      <p className="mm-privacy">
        <Glyph name="lock" size={14} />
        <span>
          <Blur text={PRIVACY} t={t} at={4.3} step={0.02} d={0.5} px={8} />
        </span>
      </p>
    </div>
  );
}

/* 8 · End */

function End({ t, f }: { t: number; f: Frame }) {
  const bloom = prog(t, 0, 1.0);
  const d = f.wide ? 500 : 560;
  return (
    <div className="mm-scene" style={{ paddingTop: (f.ph - d) / 2 - 30 }}>
      <div className="mm-circle is-end" style={{ width: d, height: d, opacity: bloom, transform: `scale(${mix(0.72, 1, bloom)})`, filter: bloom < 1 ? `blur(${(1 - bloom) * 30}px)` : undefined }}>
        <div className="mm-lockup" style={{ opacity: prog(t, 0.4, 0.8), filter: `blur(${(1 - prog(t, 0.4, 0.9)) * 12}px)`, transform: `scale(${mix(0.94, 1, jelly(t - 0.4))})` }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={MARK} alt="" width={64} height={64} />
          <span>Daylens</span>
        </div>
        <p className="mm-end-sub">
          <Blur text="Mac beta, early November" t={t} at={1.0} step={0.06} d={0.5} px={8} />
        </p>
        <p className="mm-url" style={{ opacity: prog(t, 1.4, 1.8), filter: `blur(${(1 - prog(t, 1.4, 1.9)) * 8}px)` }}>
          {WAITLIST_URL}
        </p>
      </div>
    </div>
  );
}

const SCENES = [Welcome, Nothing, Day, Calendar, Search, Ask, Forget, End];

/* The sun you tap, and the bloom it opens into */

function Sun({ t, tap, f }: { t: number; tap: number; f: Frame }) {
  const b = t - (tap - 1.35);
  const up = prog(b, 0, 0.55);
  const wob = t * Math.PI * 2 * 0.95;
  const r = (p: number, a: number) => `${50 + a * Math.sin(wob + p)}%`;
  const press = prog(t, tap - 0.16, tap - 0.04) * (1 - prog(t, tap - 0.04, tap + 0.06));
  const go = prog(t, tap, tap + 0.2);
  const s = mix(0.2, 1, jelly(b * 0.9)) * (1 - press * 0.14) * (1 + go * 2.4);
  return (
    <i
      className="mm-sun"
      style={{
        bottom: f.sun,
        opacity: up * (1 - go),
        transform: `translate(-50%, ${(1 - up) * 50 - 14 * prog(b, 0, 1.35, inOut)}px) scale(${s}, ${s * (1 + go * 0.6)})`,
        borderRadius: `${r(0, 9)} ${r(1.3, 9)} ${r(2.6, 8)} ${r(3.9, 8)} / ${r(0.7, 8)} ${r(2, 9)} ${r(3.3, 8)} ${r(4.6, 9)}`,
      }}
    />
  );
}

function Bloom({ t, tap, f }: { t: number; tap: number; f: Frame }) {
  const g = t - tap;
  const size = mix(60, Math.hypot(f.pw, f.ph) * 2.3, out(prog(g, 0, 0.7)));
  const o = 0.85 * prog(g, 0, 0.08) * (1 - prog(g, 0.2, 0.8, inOut));
  return <i className="mm-bloom" style={{ width: size, height: size, opacity: o, bottom: f.sun + 32 - size / 2 }} />;
}

function render(t: number, ratio: Ratio) {
  const f = FRAME[ratio];
  const scenes: ReactNode[] = [];
  SCENES.forEach((Scene, i) => {
    const a = STARTS[i];
    const tap = TAPS[i] ?? Infinity;
    if (t < a - 0.01 || t > tap + 0.35) return;
    const e = prog(t, tap - 0.05, tap + 0.32, inOut);
    scenes.push(
      <div key={i} className="mm-layer" style={{ opacity: 1 - e, filter: e > 0 ? `blur(${e * 18}px)` : undefined, transform: e > 0 ? `scale(${1 + e * 0.04})` : undefined }}>
        <Scene t={t - a} f={f} />
      </div>,
    );
  });
  const tap = TAPS.find((x) => t > x - 1.4 && t < x + 0.85);
  const launch = 1 - prog(t, 0.25, 1.1, inOut);
  return (
    <div className="f-stage mm-stage" style={{ width: f.w, height: f.h, background: FIELD }}>
      <div className="mm-screen" style={{ width: f.pw, height: f.ph, left: (f.w - f.pw * f.k) / 2, top: f.top, transform: `scale(${f.k})` }}>
        <Sky t={t} />
        <i className="mm-grain" />
        <div className="mm-launch" style={{ opacity: launch }} />
        {scenes}
        {tap !== undefined ? (
          <>
            <Bloom t={t} tap={tap} f={f} />
            <Sun t={t} tap={tap} f={f} />
          </>
        ) : null}
        <div className="mm-lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      </div>
    </div>
  );
}

export const mymind = { length: LENGTH, render };
