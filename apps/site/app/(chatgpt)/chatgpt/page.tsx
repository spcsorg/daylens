import { Fragment } from "react";
import { DOCS } from "../../_v2/copy";
import { Shell } from "../_chatgpt/Shell";
import { Timeline } from "../_chatgpt/Timeline";
import { WaitlistForm } from "../_chatgpt/WaitlistForm";
import { InfoIcon, LinkIcon } from "../_chatgpt/icons";

export default function Page() {
  return (
    <Shell>
      <header className="cg-pagehead">
        <h1>{DOCS.title}</h1>
        <p>{DOCS.sub}</p>
      </header>
      <article className="cg-prose">
        <div className="cg-callout">
          <div className="cg-callout-row">
            <span className="cg-callout-icon">
              <InfoIcon />
            </span>
            <div className="cg-callout-body">
              <p>{DOCS.callout}</p>
              <WaitlistForm id="waitlist" />
            </div>
          </div>
        </div>
        {DOCS.intro.map((p) => (
          <p key={p}>{p}</p>
        ))}
        <Timeline />
        {DOCS.sections.map((s) => (
          <Fragment key={s.id}>
            <h2 id={s.id}>
              <span>{s.title}</span>
              <button type="button" className="cg-anchor" data-anchor-id={s.id} aria-label={`Copy link to ${s.title}`}>
                <LinkIcon />
              </button>
            </h2>
            {s.paras.map((p) => (
              <p key={p}>{p}</p>
            ))}
            {"list" in s && s.list && (
              <ul>
                {s.list.map((li) => (
                  <li key={li}>{li}</li>
                ))}
              </ul>
            )}
            {"after" in s && s.after && <p>{s.after}</p>}
            {s.id === "join-the-waitlist" && <WaitlistForm id="waitlist-2" />}
          </Fragment>
        ))}
      </article>
    </Shell>
  );
}
