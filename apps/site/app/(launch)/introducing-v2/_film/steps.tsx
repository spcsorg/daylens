import { back, clamp, inOut, prog } from "./time";

// A step caption: a small numbered card over the app that names what the viewer is watching. at and to are shot times.
export type Step = { at: number; to: number; n?: number; label: string; hint?: string; kicker?: string };

export function StepCaption({ step, t }: { step: Step; t: number }) {
  const { at, to } = step;
  const enter = prog(t, at, at + 0.55);
  const leave = prog(t, to - 0.4, to, inOut);
  if (enter <= 0 || leave >= 1) return null;
  const words = step.label.split(" ");
  const badge = prog(t, at + 0.05, at + 0.5, back);
  return (
    <div
      className="f-step"
      style={{
        opacity: Math.min(clamp(enter * 1.4), 1 - leave),
        transform: `translateY(${(1 - enter) * 18 - leave * 10}px)`,
        filter: enter < 1 ? `blur(${(1 - enter) * 8}px)` : leave > 0 ? `blur(${leave * 6}px)` : undefined,
      }}
    >
      {step.n ? (
        <span className="f-step-n" style={{ transform: `scale(${0.6 + 0.4 * badge})` }}>
          {step.n}
        </span>
      ) : null}
      <div>
        {step.kicker ? <small className="f-step-kicker" style={{ opacity: prog(t, at + 0.2, at + 0.6) }}>{step.kicker}</small> : null}
        <p>
          {words.map((w, i) => (
            <span key={i} style={{ opacity: 0.22 + 0.78 * prog(t, at + 0.12 + i * 0.07, at + 0.42 + i * 0.07) }}>
              {w}{" "}
            </span>
          ))}
        </p>
        {step.hint ? <small style={{ opacity: prog(t, at + 0.45, at + 0.9) }}>{step.hint}</small> : null}
      </div>
    </div>
  );
}
