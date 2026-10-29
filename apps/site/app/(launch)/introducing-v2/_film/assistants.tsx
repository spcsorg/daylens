import { asset } from "../../../_v2/base";
import { clamp, mix, prog, typed } from "./time";
import { Glyph, Window } from "./ui";
import { APPS } from "./world";

// V5 onboarding, Assistants: connect Claude Code, Codex and Cursor, then Claude Code, in its own terminal, asks Daylens about the morning.

const ASSISTANTS = [
  { name: "Claude Code", icon: APPS.claude },
  { name: "Codex", icon: asset("/icons/codex.png") },
  { name: "Cursor", icon: APPS.cursor },
];
export const ASSISTANT_ICONS = ASSISTANTS.map((a) => a.icon);

const QUESTION = "what did i get done this morning";
const ANSWER = "This morning you answered the Thursday review notes and drafted most of the spring pricing memo. The design sync ran long, and you fixed the pricing page right after.";
const WORDS = ANSWER.split(" ");

const CONNECT = 1.6;
const TYPE = 2.4;
const ASKED = 3.35;
const READ = 3.6;
const ANSWERED = 4.2;
const WPS = 16;

function Terminal({ t }: { t: number }) {
  const draft = t < ASKED ? typed(QUESTION, t, TYPE, 36) : "";
  const words = clamp((t - ANSWERED) * WPS, 0, WORDS.length);
  const reading = t > READ && t < ANSWERED;
  return (
    <div className="f-term">
      <div className="f-term-welcome">
        <b>✻</b> Welcome to Claude Code
        <small>cwd: ~/projects/pricing</small>
      </div>
      <div className="f-term-log">
        <p className="f-term-you" style={{ opacity: prog(t, ASKED, ASKED + 0.2) }}>
          &gt; {QUESTION}
        </p>
        <div style={{ opacity: prog(t, READ, READ + 0.2) }}>
          <p>
            <i className={reading ? "is-busy" : "is-ok"} style={reading ? { opacity: Math.floor(t * 4) % 2 ? 0.3 : 1 } : undefined}>
              ⏺
            </i>
            <b>daylens - get_day</b> (MCP)(date: &quot;2026-04-14&quot;)
          </p>
          <p className="f-term-dim" style={{ opacity: prog(t, ANSWERED - 0.2, ANSWERED) }}>
            {"  ⎿  "}
            {'{"date": "2026-04-14", "hours": [ … +38 lines'}
          </p>
        </div>
        <p className="f-term-answer">
          <i style={{ opacity: prog(t, ANSWERED, ANSWERED + 0.15) }}>⏺</i>
          <span>
            {WORDS.map((w, i) => {
              const k = clamp(words - i);
              return (
                <span key={i} style={{ opacity: k, filter: k < 1 ? `blur(${(1 - k) * 3}px)` : undefined }}>
                  {w}{" "}
                </span>
              );
            })}
          </span>
        </p>
      </div>
      <div className="f-term-input">
        <span>&gt; </span>
        {draft}
        <i className="f-term-caret" style={{ opacity: Math.floor(t * 2) % 2 ? 0 : 1 }} />
      </div>
      <small className="f-term-hint">? for shortcuts</small>
    </div>
  );
}

export function AssistantsView(t: number) {
  const press = prog(t, CONNECT - 0.06, CONNECT) * (1 - prog(t, CONNECT + 0.06, CONNECT + 0.22));
  return (
    <Window>
      <div className="f-track">
        <i style={{ width: `${mix(80, 100, prog(t, CONNECT + 0.8, CONNECT + 1.4))}%` }} />
      </div>
      <div className="f-welcome">
        <h1 className="f-display">Connect assistants</h1>
        <p className="f-sub">Claude Code, Codex and Cursor can look up your day the same way you search it.</p>
        <div className="f-tiles">
          {ASSISTANTS.map((a, i) => {
            const on = prog(t, CONNECT + 0.2 + i * 0.18, CONNECT + 0.45 + i * 0.18);
            return (
              <div key={a.name} className="f-tile">
                <span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.icon} width={30} height={30} alt="" />
                  <i style={{ opacity: on, transform: `scale(${mix(0.5, 1, on)})` }}>
                    <Glyph name="check" size={11} />
                  </i>
                </span>
                {a.name}
              </div>
            );
          })}
        </div>
        <div className="f-logs">
          <span>
            <Glyph name="check" size={12} />
          </span>
          <div>
            <b>Read their session logs</b>
            Only times, project folders and branches, never what was said.
          </div>
        </div>
        <div className="f-assist-foot">
          <div>
            <span className="f-button is-quiet">Not now</span>
            <span className="f-button" style={{ transform: `scale(${1 - press * 0.04})` }}>
              {t > CONNECT + 0.7 ? "Connected" : "Connect 3"}
              <Glyph name="return" size={14} />
            </span>
          </div>
        </div>
      </div>
      <Terminal t={t} />
    </Window>
  );
}

export const ASSISTANTS_TIMING = { CONNECT, dur: ANSWERED + WORDS.length / WPS + 1.6 };
