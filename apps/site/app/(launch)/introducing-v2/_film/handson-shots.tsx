import { cam, Caret, click, pt, type Shot } from "./shots";
import { clamp, inOut, prog, typed } from "./time";
import { AppIcons, Glyph, Window } from "./ui";
import { ASK_THREAD } from "./world";

// A shot made for the hands-on cut: Ask as a thread of three questions.

/* Ask, three questions in one thread. Each answer replaces the last, with its page and hours. */

const CPS = 32;
const WPS = 15;

type Turn = (typeof ASK_THREAD)[number] & { words: string[]; type: number; send: number; reply: number; sources: number };

// The next question starts typing while the last answer is still on screen, like a real follow-up.
const PLAN = ASK_THREAD.reduce<Turn[]>((all, x, i) => {
  const type = i ? all[i - 1].sources + 0.8 : 0.5;
  const send = type + x.question.length / CPS + 0.3;
  const reply = send + (i ? 0.7 : 1.0);
  const words = x.answer.split(" ");
  return [...all, { ...x, words, type, send, reply, sources: reply + words.length / WPS + 0.2 }];
}, []).map((x, i, all) => ({ ...x, next: all[i + 1]?.send ?? Infinity }));

const LAST = PLAN[PLAN.length - 1];
const SEND_X = 916;
const SEND_Y = 665;

function Exchange({ x, t }: { x: (typeof PLAN)[number]; t: number }) {
  const gone = prog(t, x.next - 0.05, x.next + 0.3, inOut);
  if (t < x.send || gone >= 1) return null;
  const rise = prog(t, x.send + 0.1, x.send + 0.6);
  const thinking = prog(t, x.send + 0.2, x.send + 0.45) * (1 - prog(t, x.reply - 0.1, x.reply + 0.2));
  const words = clamp((t - x.reply) * WPS, 0, x.words.length);
  const cards = prog(t, x.sources, x.sources + 0.5);
  return (
    <div className="f-exchange" style={{ opacity: 1 - gone, transform: `translateY(${-gone * 48}px)`, filter: gone > 0 ? `blur(${gone * 6}px)` : undefined }}>
      <h2 className="f-question" style={{ opacity: prog(t, x.send + 0.15, x.send + 0.5), transform: `translateY(${(1 - rise) * 30}px)` }}>
        {x.question}
      </h2>
      <p className="f-thinking" style={{ opacity: thinking }}>
        <span className="f-shimmer" style={{ backgroundPosition: `${-200 + ((t * 160) % 400)}px 0` }}>
          {x.reading}
        </span>
      </p>
      <p className="f-answer">
        {x.words.map((w, i) => {
          const k = clamp(words - i);
          return (
            <span key={i} style={{ opacity: k, filter: k < 1 ? `blur(${(1 - k) * 3}px)` : undefined }}>
              {w}{" "}
            </span>
          );
        })}
      </p>
      <div className="f-sources" style={{ opacity: cards, transform: `translateY(${(1 - cards) * 16}px)` }}>
        <div className="f-sources-head">{x.hours.length > 1 ? "From this page and these hours" : "From this page and this hour"}</div>
        <div className="f-source-page" style={{ opacity: prog(t, x.sources + 0.15, x.sources + 0.5) }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={x.page.icon} width={18} height={18} alt="" />
          <div>
            <b>{x.page.title}</b>
            <small>{x.page.host}</small>
          </div>
          <Glyph name="arrow" />
        </div>
        {x.hours.map((h, i) => (
          <div key={h.at} className="f-source-hour" style={{ opacity: prog(t, x.sources + 0.35 + i * 0.15, x.sources + 0.7 + i * 0.15) }}>
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
  );
}

const askThread: Shot = {
  id: "ask-thread",
  dur: LAST.sources + 1.8,
  view: (t) => {
    const drafting = PLAN.find((x) => t >= x.type && t < x.send);
    const draft = drafting ? typed(drafting.question, t, drafting.type, CPS) : "";
    return (
      <Window sidebar="ask">
        <div className="f-ask">
          {PLAN.map((x) => (
            <Exchange key={x.question} x={x} t={t} />
          ))}
        </div>
        <div className="f-composer">
          <span>
            {draft || <span className="f-placeholder">{PLAN[0].send < t ? "Ask a follow-up" : "Ask about any day"}</span>}
            {drafting ? <Caret t={t} /> : null}
          </span>
          <i className={draft ? "is-ready" : undefined}>
            <Glyph name="arrow" size={14} />
          </i>
        </div>
      </Window>
    );
  },
  camera: [cam(0, 1.0, 590, 360, 740), cam(0.9, 1.2, 620, 372, 680), cam(LAST.sources + 1.8, 1.24, 620, 366, 680)],
  cursor: [
    pt(0, 800, 520),
    ...click(0.35, 560, SEND_Y),
    ...PLAN.flatMap((x) => [pt(x.send - 0.55, SEND_X - 30, SEND_Y + 40), ...click(x.send, SEND_X, SEND_Y), pt(x.send + 0.9, SEND_X + 50, SEND_Y + 30)]),
    pt(LAST.sources + 1.8, SEND_X + 60, SEND_Y + 30),
  ],
};

export const HANDSON_SHOTS = { askThread };
