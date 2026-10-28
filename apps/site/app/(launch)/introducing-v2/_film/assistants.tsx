import { asset } from "../../../_v2/base";
import { clamp, prog } from "./time";
import { Glyph, Window } from "./ui";
import { APPS } from "./world";

// V5 onboarding, Assistants: connect Claude Code, Codex and Cursor, then one of them asks Daylens about the morning.

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
const ASKED = 2.9;
const READ = 3.4;
const ANSWERED = 4.1;

export function AssistantsView(t: number) {
  const words = clamp((t - ANSWERED) * 12, 0, WORDS.length);
  const reading = t > READ && t < ANSWERED;
  return (
    <Window>
      <div className="f-track">
        <i style={{ width: "100%" }} />
      </div>
      <div className="f-welcome">
        <h1 className="f-display">Let your assistants ask Daylens</h1>
        <p className="f-sub">Claude Code, Codex and Cursor can look up your day the same way you search it.</p>
        <div className="f-assistants">
          {ASSISTANTS.map((a, i) => {
            const on = prog(t, CONNECT + 0.2 + i * 0.18, CONNECT + 0.45 + i * 0.18);
            return (
              <div key={a.name} className="f-assistant">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.icon} width={20} height={20} alt="" />
                <div>
                  <b>{a.name}</b>
                  <small className={on > 0.5 ? "is-ok" : undefined}>{on > 0.5 ? "Connected" : "Found on this computer"}</small>
                </div>
                {on > 0.5 ? (
                  <span className="f-connected" style={{ opacity: on }}>
                    <Glyph name="check" size={14} />
                    Connected
                  </span>
                ) : (
                  <span className="f-ghost" style={{ opacity: 1 - on * 2 }}>
                    Connect
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <span className="f-button f-start" style={{ transform: `scale(${1 - prog(t, CONNECT - 0.06, CONNECT) * 0.04 + prog(t, CONNECT + 0.04, CONNECT + 0.2) * 0.04})` }}>
          {t > CONNECT + 0.7 ? "Continue" : "Connect all three"}
        </span>
      </div>
      <div className="f-preview">
        <div className="f-preview-head">
          <span className="f-title-serif f-with-icon">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={APPS.claude} width={22} height={22} alt="" />
            Claude Code
          </span>
        </div>
        <div className="f-chat" style={{ opacity: prog(t, ASKED - 0.2, ASKED + 0.2) }}>
          <span className="f-bubble" style={{ transform: `translateY(${(1 - prog(t, ASKED - 0.2, ASKED + 0.3)) * 10}px)` }}>
            {QUESTION}
          </span>
          <span className="f-tool" style={{ opacity: prog(t, READ, READ + 0.25), transform: `scale(${0.94 + 0.06 * prog(t, READ, READ + 0.3)})` }}>
            <span className={reading ? "f-shimmer" : undefined} style={reading ? { backgroundPosition: `${-200 + ((t * 160) % 400)}px 0` } : undefined}>
              Daylens · read Tuesday, 9 AM to 12 PM
            </span>
          </span>
          <p className="f-answer f-answer--chat">
            {WORDS.map((w, i) => {
              const k = clamp(words - i);
              return (
                <span key={i} style={{ opacity: k, filter: k < 1 ? `blur(${(1 - k) * 3}px)` : undefined }}>
                  {w}{" "}
                </span>
              );
            })}
          </p>
        </div>
        <p className="f-footnote" style={{ opacity: prog(t, ANSWERED + 1.4, ANSWERED + 1.8) }}>
          Every read shows up in Settings › Assistants, with the assistant’s name.
        </p>
      </div>
    </Window>
  );
}

export const ASSISTANTS_TIMING = { CONNECT, dur: ANSWERED + WORDS.length / 12 + 1.6 };
