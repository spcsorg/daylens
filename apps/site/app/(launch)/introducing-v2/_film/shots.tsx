import type { CSSProperties, ReactNode } from "react";
import { back, clamp, inOut, keys, mix, out, prog, typed, type Key } from "./time";
import { ASSISTANTS_TIMING, AssistantsView } from "./assistants";
import { AppIcons, Cursor, Glyph, Segmented, Window } from "./ui";
import { ASK, DAY_TITLE, HOURS, LAST_WEEK, MONTH, MORNING_SUMMARY, OPEN_HOUR, SEARCH, THIS_WEEK, type Hour } from "./world";

// A shot is one stretch of the app on screen. t runs from 0 to dur.
// camera: s is zoom, x and y are the window point held at the frame's centre, w the width of what must stay in frame.
export type Shot = {
  id: string;
  dur: number;
  view: (t: number) => ReactNode;
  camera: Key[];
  cursor?: Key[];
};

type Cam = { t: number; s: number; x: number; y: number; w: number };
export const cam = (t: number, s: number, x: number, y: number, w: number): Cam => ({ t, s, x, y, w });
type Pt = { t: number; x: number; y: number; press: number };
export const pt = (t: number, x: number, y: number, press = 0): Pt => ({ t, x, y, press });
// A click: arrive, press for 0.12 s, release.
export const click = (t: number, x: number, y: number): Pt[] => [pt(t - 0.12, x, y), pt(t, x, y, 1), pt(t + 0.14, x, y)];

export function cursorAt(frames: Key[] | undefined, t: number) {
  if (!frames) return null;
  const k = keys(frames, t);
  const shown = prog(t, frames[0].t - 0.3, frames[0].t);
  return <div style={{ opacity: shown }}>{<Cursor x={k.x} y={k.y} press={k.press} />}</div>;
}

// Words go from blurred and faint to sharp, one after another.
export function Ink({ text, t, start, step = 0.06, dur = 0.4 }: { text: string; t: number; start: number; step?: number; dur?: number }) {
  return (
    <>
      {text.split(" ").map((w, i) => {
        const k = prog(t, start + i * step, start + i * step + dur);
        return (
          <span key={i} className="f-word" style={{ opacity: 0.12 + 0.88 * k, filter: k < 1 ? `blur(${(1 - k) * 6}px)` : undefined }}>
            {w}{" "}
          </span>
        );
      })}
    </>
  );
}

export function Caret({ t }: { t: number }) {
  return <i className="f-caret" style={{ opacity: Math.floor(t * 2) % 2 ? 0 : 1 }} />;
}

function HourRow({ h, style, children }: { h: Hour; style?: CSSProperties; children?: ReactNode }) {
  return (
    <div className={h.away ? "f-hour is-away" : "f-hour"} style={style}>
      <div className={h.now ? "f-at is-now" : "f-at"}>{h.at}</div>
      <div className="f-hour-body">
        <div className="f-hour-title">{h.title}</div>
        {h.line ? <div className="f-hour-line">{h.line}</div> : null}
        {h.apps.length ? <AppIcons apps={h.apps} /> : null}
        {children}
      </div>
    </div>
  );
}

/* 1 · Welcome: the first screen of onboarding, as on the Figma Launch page (W1). */

const PREVIEW = [HOURS[0], HOURS[1], HOURS[2], HOURS[5]];
const PERKS = [
  { icon: "search", text: "Find any page you saw, the way you remember it" },
  { icon: "today", text: "See every hour with the apps, windows and pages behind it" },
  { icon: "pause", text: "Pause it, keep apps out, or delete any hour" },
];
const W_CLICK = 2.68;

const welcome: Shot = {
  id: "welcome",
  dur: 3.6,
  view: (t) => (
    <Window>
      <div className="f-track">
        <i style={{ width: `${mix(20, 34, prog(t, W_CLICK + 0.2, W_CLICK + 0.8, inOut))}%` }} />
      </div>
      <div className="f-welcome">
        <h1 className="f-display">
          <Ink text="Your day, written down" t={t} start={0.15} />
        </h1>
        <p className="f-sub" style={{ opacity: prog(t, 0.5, 1.1) }}>
          Daylens notes the apps, windows and pages you use, and turns them into a calendar of your day.
        </p>
        <div className="f-start-row" style={{ opacity: prog(t, 0.8, 1.3) }}>
          <span className="f-button" style={{ transform: `scale(${1 - prog(t, W_CLICK - 0.06, W_CLICK) * 0.04 + prog(t, W_CLICK + 0.06, W_CLICK + 0.22) * 0.04})` }}>
            Get started
          </span>
          <span>Takes about two minutes</span>
        </div>
        <hr style={{ opacity: prog(t, 0.95, 1.4) }} />
        <p className="f-perks-head" style={{ opacity: prog(t, 1.0, 1.45) }}>
          Once it’s set up:
        </p>
        {PERKS.map((p, i) => (
          <div key={p.icon} className="f-perk" style={{ opacity: prog(t, 1.1 + i * 0.1, 1.5 + i * 0.1), transform: `translateY(${(1 - prog(t, 1.1 + i * 0.1, 1.6 + i * 0.1, out)) * 8}px)` }}>
            <span>
              <Glyph name={p.icon} />
            </span>
            {p.text}
          </div>
        ))}
      </div>
      <div className="f-preview">
        <div className="f-preview-head">
          <span className="f-title-serif">Tuesday</span>
        </div>
        {PREVIEW.map((h, i) => {
          const k = prog(t, 0.55 + i * 0.13, 1.15 + i * 0.13, back);
          return <HourRow key={h.at} h={h} style={{ opacity: clamp(k * 1.6), transform: `translateY(${(1 - k) * -18}px)` }} />;
        })}
      </div>
    </Window>
  ),
  camera: [cam(0, 1.06, 560, 370, 1120), cam(2.2, 1.1, 556, 372, 1120), cam(3.6, 1.14, 552, 374, 1120)],
  cursor: [pt(1.3, 760, 520), pt(2.4, 124, 346), ...click(W_CLICK, 118, 340), pt(3.6, 134, 352)],
};

/* 2 · Your morning: the day fills in, hour by hour (W6a). */

const MORNING_START = 1.5;
const EACH = 0.62;
const M_OPEN = 7.05;

const morning: Shot = {
  id: "morning",
  dur: 7.4,
  view: (t) => {
    const scroll = keys([{ t: 0, y: 0 }, { t: 3.4, y: 0 }, { t: 5.2, y: 300 }], t).y;
    return (
      <Window>
        <div className="f-top-fade" />
        <div className="f-morning" style={{ transform: `translateY(${-scroll}px)` }}>
          <h1 className="f-display-xl">
            <Ink text="Tuesday, so far" t={t} start={0.05} />
          </h1>
          <p className="f-lede">
            <Ink text={MORNING_SUMMARY} t={t} start={0.5} step={0.035} dur={0.35} />
          </p>
          <div className="f-hours">
            {HOURS.map((h, i) => {
              const a = MORNING_START + i * EACH;
              const land = prog(t, a + 0.3, a + 0.7, back);
              const raw = h.raw ?? [];
              const collapse = prog(t, a + 0.22, a + 0.42);
              return (
                <div key={h.at} className="f-fill" style={{ gridTemplateRows: `${prog(t, a - 0.1, a + 0.3, inOut)}fr`, opacity: prog(t, a - 0.05, a + 0.1) }}>
                  <div>
                    <div className="f-raw" style={{ opacity: 1 - collapse, transform: `translateY(${-collapse * 10}px) scale(${1 - collapse * 0.06})` }}>
                      {raw.map((r, j) => (
                        <div key={r} style={{ opacity: prog(t, a - 0.1 + j * 0.05, a + 0.02 + j * 0.05) }}>
                          {r}
                        </div>
                      ))}
                    </div>
                    <HourRow
                      h={h}
                      style={{
                        opacity: prog(t, a + 0.32, a + 0.55),
                        transform: `translateY(${(1 - land) * 10}px) scaleY(${mix(0.95, 1, land)})`,
                        filter: land < 1 ? `blur(${(1 - clamp(land)) * 4}px)` : undefined,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="f-bottom-bar">
          <span className="f-button" style={{ opacity: prog(t, 5.0, 5.5), transform: `scale(${1 - prog(t, M_OPEN - 0.06, M_OPEN) * 0.04})` }}>
            Open Today
            <Glyph name="return" size={14} />
          </span>
        </div>
      </Window>
    );
  },
  camera: [cam(0, 1.3, 559, 230, 740), cam(2.0, 1.3, 559, 300, 740), cam(4.6, 1.24, 559, 420, 740), cam(6.2, 1.0, 575, 360, 800), cam(7.4, 1.0, 575, 360, 800)],
  cursor: [pt(6.0, 940, 520), pt(6.8, 836, 674), ...click(M_OPEN, 836, 676)],
};

/* 3 · Today: day, then week, then month. */

function DayList({ t0 = -1, t, hidden }: { t0?: number; t: number; hidden?: boolean }) {
  return (
    <div className="f-day" style={{ opacity: hidden ? 0 : 1 }}>
      {HOURS.map((h, i) => (
        <HourRow key={h.at} h={h} style={t0 < 0 ? undefined : { opacity: prog(t, t0 + i * 0.05, t0 + 0.3 + i * 0.05) }} />
      ))}
    </div>
  );
}

function WeekGrid({ week, t, t0 }: { week: typeof THIS_WEEK | typeof LAST_WEEK; t: number; t0: number }) {
  return (
    <div className="f-week">
      <div className="f-week-days">
        {week.days.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="f-week-grid">
        {["8 AM", "9 AM", "10 AM", "11 AM", "12 PM", "1 PM", "2 PM", "3 PM", "4 PM", "5 PM"].map((h, i) => (
          <div key={h} className="f-week-line" style={{ top: i * 31 }}>
            <span>{h}</span>
          </div>
        ))}
        {week.blocks.map((b, i) => {
          const k = prog(t, t0 + b.col * 0.09 + b.start * 0.025, t0 + 0.38 + b.col * 0.09 + b.start * 0.025, back);
          return (
            <div
              key={i}
              className="f-block"
              style={{ left: `calc(${b.col} * (100% / 7) + 2px)`, top: b.start * 31 + 2, height: b.len * 31 - 4, opacity: clamp(k * 1.5), transform: `translateY(${(1 - k) * -10}px)` }}
            >
              {b.label}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ByApp({ t, t0 }: { t: number; t0: number }) {
  const shades = ["#141619", "#4b5158", "#686e75", "#c9cdd1", "#e4e6e9"];
  let left = 0;
  return (
    <div className="f-byapp" style={{ opacity: prog(t, t0, t0 + 0.3) }}>
      <div className="f-byapp-head">
        <span>Time by app</span>
        <span>{LAST_WEEK.total}</span>
      </div>
      <div className="f-bar">
        {LAST_WEEK.byApp.map((a, i) => {
          const w = a.share * 100 * prog(t, t0 + 0.1, t0 + 0.9);
          const el = <i key={a.app} style={{ left: `${left}%`, width: `calc(${w}% - 2px)`, background: shades[i] }} />;
          left += w;
          return el;
        })}
      </div>
      <div className="f-legend">
        {LAST_WEEK.byApp.map((a, i) => (
          <span key={a.app}>
            <i style={{ background: shades[i] }} />
            <b>{a.app}</b> {a.time}
          </span>
        ))}
      </div>
    </div>
  );
}

function MonthGrid({ t, t0 }: { t: number; t0: number }) {
  const cells: (number | null)[] = [...MONTH.lead.map(() => null), ...MONTH.days, 1, 2, 3];
  return (
    <div className="f-month">
      <div className="f-month-days">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="f-month-grid">
        {cells.map((d, i) => {
          const label = d ?? MONTH.lead[i];
          const total = d !== null && i < 32 ? MONTH.totals[d] : undefined;
          const k = prog(t, t0 + i * 0.022, t0 + 0.3 + i * 0.022);
          return (
            <div key={i} className="f-cell" style={{ opacity: 0.2 + 0.8 * k }}>
              <span className={d === 14 ? "f-at is-now" : undefined}>{label}</span>
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

const W_WEEK = 2.0;
const W_PREV = 3.4;
const W_MONTH = 4.9;

const today: Shot = {
  id: "today",
  dur: 6.6,
  view: (t) => {
    const mode = t < W_WEEK ? "Day" : t < W_MONTH ? "Week" : "Month";
    const title = mode === "Day" ? DAY_TITLE : mode === "Month" ? MONTH.title : t < W_PREV ? THIS_WEEK.title : LAST_WEEK.title;
    const hover = t > W_WEEK - 0.5 && t < W_WEEK ? "Week" : t > W_MONTH - 0.5 && t < W_MONTH ? "Month" : undefined;
    return (
      <Window sidebar="today">
        <div className="f-head">
          <h1 className="f-title-serif" key={title} style={{ opacity: prog(t, [0, W_WEEK, W_PREV, W_MONTH].filter((x) => x <= t).pop()!, [0, W_WEEK, W_PREV, W_MONTH].filter((x) => x <= t).pop()! + 0.25) }}>
            {title}
          </h1>
          <Segmented value={mode} hover={hover} />
        </div>
        {mode === "Day" ? <DayList t={t} /> : null}
        {mode === "Week" ? (
          <>
            <WeekGrid week={t < W_PREV ? THIS_WEEK : LAST_WEEK} t={t} t0={t < W_PREV ? W_WEEK : W_PREV} />
            {t >= W_PREV ? <ByApp t={t} t0={W_PREV + 0.5} /> : null}
          </>
        ) : null}
        {mode === "Month" ? <MonthGrid t={t} t0={W_MONTH} /> : null}
      </Window>
    );
  },
  camera: [cam(0, 1.0, 590, 360, 740), cam(1.6, 1.0, 590, 360, 740), cam(2.6, 1.12, 676, 300, 860), cam(4.6, 1.12, 676, 300, 860), cam(5.4, 1.0, 676, 360, 860), cam(6.6, 1.04, 676, 350, 860)],
  cursor: [pt(0.4, 700, 420), ...click(W_WEEK, 928, 64), ...click(W_PREV, 1013, 64), pt(4.3, 1000, 120), ...click(W_MONTH, 991, 64), pt(6.6, 1010, 160)],
};

/* 4 · Search: find a page the way you remember it. */

const S_OPEN = 0.5;
const S_TYPE = 0.9;

const search: Shot = {
  id: "search",
  dur: 6.0,
  view: (t) => {
    const q = typed(SEARCH.query, t, S_TYPE, 17);
    const n = q.length;
    const open = prog(t, S_OPEN, S_OPEN + 0.3);
    return (
      <Window
        sidebar={t >= S_OPEN ? "search" : "today"}
        overlay={
          <>
        <div className="f-scrim" style={{ opacity: open }} />
        <div className="f-search" style={{ opacity: open, transform: `translateY(${(1 - open) * -8}px) scale(${mix(0.98, 1, open)})` }}>
          <div className="f-search-field">
            <Glyph name="search" />
            <span>
              {q || <span className="f-placeholder">Search your days</span>}
              {t > S_TYPE && n < SEARCH.query.length + 1 ? <Caret t={t} /> : null}
            </span>
          </div>
          {n > 10 ? (
            <div className="f-results">
              <div className="f-results-head">
                <span>Pages, files and windows</span>
                <span>Show more</span>
              </div>
              {SEARCH.pages.map((p, i) => {
                const k = prog(t, S_TYPE + 0.7 + i * 0.12, S_TYPE + 1.0 + i * 0.12);
                return (
                  <div key={p.title} className={i === 0 && t > 3.3 ? "f-result is-on" : "f-result"} style={{ opacity: k, transform: `translateY(${(1 - k) * 6}px)` }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.icon} width={18} height={18} alt="" />
                    <div>
                      <b>{p.title}</b>
                      <small>{p.meta}</small>
                      <small>{p.hour}</small>
                    </div>
                  </div>
                );
              })}
              <div className="f-results-head" style={{ opacity: prog(t, S_TYPE + 1.3, S_TYPE + 1.6) }}>
                <span>Hours</span>
              </div>
              {SEARCH.hours.map((h, i) => (
                <div key={h.meta} className="f-result" style={{ opacity: prog(t, S_TYPE + 1.4 + i * 0.12, S_TYPE + 1.7 + i * 0.12) }}>
                  <Glyph name="today" />
                  <div>
                    <b>{h.title}</b>
                    <small>{h.meta}</small>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
          </>
        }
      >
        <div className="f-head">
          <h1 className="f-title-serif">{DAY_TITLE}</h1>
          <Segmented value="Day" />
        </div>
        <DayList t={t} />
      </Window>
    );
  },
  camera: [cam(0, 1.0, 590, 360, 740), cam(0.8, 1.0, 590, 360, 740), cam(1.8, 1.5, 668, 200, 680), cam(3.4, 1.5, 668, 250, 680), cam(6.0, 1.6, 668, 260, 680)],
  cursor: [pt(0.0, 900, 300), ...click(S_OPEN - 0.05, 120, 92), pt(2.6, 700, 420), pt(3.3, 600, 228), pt(6.0, 610, 232)],
};

/* 5 · Ask: the question, then a calm answer with the pages and hours it came from. */

const A_TYPE = 0.6;
export const A_SEND = A_TYPE + ASK.question.length / 19 + 0.35;
const A_ANSWER = A_SEND + 1.5;
const A_WORDS = ASK.answer.split(" ");
const A_SOURCES = A_ANSWER + A_WORDS.length / 10 + 0.25;

const ask: Shot = {
  id: "ask",
  dur: A_SOURCES + 3.0,
  view: (t) => {
    const sent = t >= A_SEND;
    const draft = typed(ASK.question, t, A_TYPE, 19);
    const thinking = prog(t, A_SEND + 0.2, A_SEND + 0.5) * (1 - prog(t, A_ANSWER - 0.1, A_ANSWER + 0.2));
    const words = clamp((t - A_ANSWER) * 10, 0, A_WORDS.length);
    const cards = prog(t, A_SOURCES, A_SOURCES + 0.5);
    // Duet's focus pull: the cited page lifts, everything else steps back.
    const focus = prog(t, A_SOURCES + 1.0, A_SOURCES + 1.6);
    const back = 1 - 0.55 * focus;
    return (
      <Window sidebar="ask">
        <div className="f-ask">
          {sent ? (
            <h2 className="f-question" style={{ opacity: prog(t, A_SEND, A_SEND + 0.35), transform: `translateY(${(1 - prog(t, A_SEND, A_SEND + 0.5)) * 30}px)` }}>
              {ASK.question}
            </h2>
          ) : null}
          {sent ? (
            <p className="f-thinking" style={{ opacity: thinking }}>
              <span className="f-shimmer" style={{ backgroundPosition: `${-200 + ((t * 160) % 400)}px 0` }}>
                Reading Tuesday
              </span>
            </p>
          ) : null}
          <p className="f-answer" style={{ opacity: back }}>
            {A_WORDS.map((w, i) => {
              const k = clamp(words - i);
              return (
                <span key={i} style={{ opacity: k, filter: k < 1 ? `blur(${(1 - k) * 3}px)` : undefined }}>
                  {w}{" "}
                </span>
              );
            })}
          </p>
          <div className="f-sources" style={{ opacity: cards, transform: `translateY(${(1 - cards) * 16}px)` }}>
            <div className="f-sources-head" style={{ opacity: back }}>
              From this page and these hours
            </div>
            <div
              className="f-source-page"
              style={{
                opacity: prog(t, A_SOURCES + 0.15, A_SOURCES + 0.5),
                transform: `scale(${1 + 0.04 * focus})`,
                boxShadow: `0 ${18 * focus}px ${40 * focus}px -${12 * focus}px rgb(20 22 25 / ${0.28 * focus}), 0 0 0 1px var(--w-line)`,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={ASK.page.icon} width={18} height={18} alt="" />
              <div>
                <b>{ASK.page.title}</b>
                <small>{ASK.page.host}</small>
              </div>
              <Glyph name="arrow" />
            </div>
            {ASK.hours.map((h, i) => (
              <div key={h.at} className="f-source-hour" style={{ opacity: prog(t, A_SOURCES + 0.35 + i * 0.15, A_SOURCES + 0.7 + i * 0.15) * back }}>
                <span className="f-at">{h.at}</span>
                <div>
                  <b>{h.title}</b>
                  <small>{h.line}</small>
                  <AppIcons apps={h.apps} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="f-composer">
          <span>
            {sent ? <span className="f-placeholder">Ask about any day</span> : draft || <span className="f-placeholder">Ask about any day</span>}
            {!sent && t > A_TYPE ? <Caret t={t} /> : null}
          </span>
          <i className={!sent && draft ? "is-ready" : undefined}>
            <Glyph name="arrow" size={14} />
          </i>
        </div>
      </Window>
    );
  },
  camera: [
    cam(0, 1.0, 590, 360, 740),
    cam(0.5, 1.6, 620, 600, 680),
    cam(A_SEND - 0.1, 1.6, 620, 600, 680),
    cam(A_SEND + 0.7, 1.55, 620, 170, 680),
    cam(A_SOURCES - 0.2, 1.5, 620, 190, 680),
    cam(A_SOURCES + 1.2, 1.38, 620, 300, 680),
    cam(A_SOURCES + 3.0, 1.38, 620, 310, 680),
  ],
  cursor: [pt(0.0, 800, 500), ...click(0.35, 560, 662), pt(1.6, 640, 700), pt(A_SEND + 1.2, 980, 700), pt(A_SOURCES + 1.4, 720, 334), pt(A_SOURCES + 3.0, 730, 338)],
};

/* 6 · Trust: remove a page from an hour, then pause. */

const T_X = 1.25;
const T_REMOVE = 2.35;
const T_PAUSE = 3.4;

const trust: Shot = {
  id: "trust",
  dur: 5.6,
  view: (t) => {
    const ask = prog(t, T_X, T_X + 0.25);
    const gone = prog(t, T_REMOVE, T_REMOVE + 0.4, inOut);
    const pause = prog(t, T_PAUSE, T_PAUSE + 0.45);
    return (
      <Window sidebar="today">
        <div className="f-head">
          <h1 className="f-title-serif">{DAY_TITLE}</h1>
          <Segmented value="Day" />
        </div>
        <div className="f-paused" style={{ height: 44 * pause, opacity: pause, marginBottom: 14 * pause }}>
          <Glyph name="pause" size={14} />
          Paused until 3:00 PM. Nothing is recorded.<span>Resume</span>
        </div>
        <div className="f-open">
          <div className="f-open-head">
            <div>
              <small>{OPEN_HOUR.range}</small>
              <b>{OPEN_HOUR.title}</b>
            </div>
            <span className="f-ghost">Done</span>
          </div>
          <small className="f-open-label">Pages</small>
          {OPEN_HOUR.pages.map((p, i) => {
            const target = i === 3;
            return (
              <div key={p.title} className="f-open-row" style={target ? { height: 47 * (1 - gone), opacity: 1 - gone } : undefined}>
                {target && ask > 0 ? (
                  <div className="f-confirm" style={{ opacity: ask }}>
                    <span>Remove {p.title} from Tuesday?</span>
                    <span className="f-check">
                      <i />
                      Never record this site
                    </span>
                    <span>Cancel</span>
                    <span className="f-danger">Remove</span>
                  </div>
                ) : (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.icon} width={16} height={16} alt="" />
                    <div>
                      <b>{p.title}</b>
                      <small>{p.host}</small>
                    </div>
                    <span className="f-min">{p.min}</span>
                    <Glyph name="x" size={14} />
                  </>
                )}
              </div>
            );
          })}
          <small className="f-open-label">Windows</small>
          {OPEN_HOUR.windows.map((p) => (
            <div key={p.title} className="f-open-row">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.icon} width={16} height={16} alt="" />
              <div>
                <b>{p.title}</b>
                <small>{p.host}</small>
              </div>
              <span className="f-min">{p.min}</span>
              <Glyph name="x" size={14} />
            </div>
          ))}
        </div>
      </Window>
    );
  },
  camera: [cam(0, 1.0, 590, 360, 740), cam(0.6, 1.42, 604, 330, 720), cam(3.0, 1.42, 604, 330, 720), cam(3.6, 1.3, 604, 270, 720), cam(5.6, 1.3, 604, 270, 720)],
  cursor: [pt(0, 760, 520), ...click(T_X, 780, 372), pt(1.8, 760, 372), ...click(T_REMOVE, 762, 372), pt(T_PAUSE, 840, 300), pt(5.6, 850, 300)],
};

/* 7 · Assistants: connect Claude Code, Codex and Cursor; one asks about the morning. */

const assistants: Shot = {
  id: "assistants",
  dur: ASSISTANTS_TIMING.dur,
  view: AssistantsView,
  camera: [cam(0, 1.0, 560, 380, 1120), cam(2.2, 1.0, 560, 380, 1120), cam(3.0, 1.34, 824, 388, 580), cam(ASSISTANTS_TIMING.dur, 1.38, 824, 392, 580)],
  cursor: [pt(0.4, 700, 300), pt(1.3, 368, 664), ...click(ASSISTANTS_TIMING.CONNECT, 361, 658), pt(2.4, 400, 620), pt(ASSISTANTS_TIMING.dur, 410, 620)],
};

export const SHOTS = { welcome, morning, today, search, ask, assistants, trust };

