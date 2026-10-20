import Image from "next/image";
import { EXAMPLE_NOTE, FOOTER, LABELS, NEVER, RECORDS, SUPERLOGICAL } from "../../_v2/copy";
import { HOURS } from "../../_v2/day";
import Field from "../_superlogical/Field";
import Signup from "../_superlogical/Signup";
import Wheel from "../_superlogical/Wheel";

const S = SUPERLOGICAL;
const SELECTED = S.wheel[S.wheel.length - 1];
const PHRASES = S.wheel.slice(0, -1);
const DAY_HOURS = HOURS.filter((h) => !h.quiet).slice(0, 4);

export default function Page() {
  return (
    <div className="sl-shell">
      <Field />
      <div className="sl-article">
        <header className="sl-header">
          <p className="sl-logo">Daylens</p>
        </header>

        <div className="sl-sticky">
          <section className="sl-hero">
            <h1 className="sl-h1">
              <span className="sl-prefix">{S.wheelPrefix}</span> <span className="sl-slot-line">
                <Wheel selected={SELECTED} phrases={PHRASES} />
              </span>
            </h1>
          </section>
        </div>

        <a href="#mailing-list" className="sl-banner">
          <span className="sl-banner-icon">
            <Image src="/icons/daylens.svg" alt="" width={56} height={56} priority />
          </span>
          <span className="sl-banner-text">
            <span>{S.bannerText}</span>
            <span className="sl-accent sl-banner-link">{S.bannerLink}</span>
          </span>
        </a>

        <section className="sl-section sl-narrow">
          <div className="sl-stack">
            {S.essay.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
        </section>

        <section className="sl-section sl-narrow">
          <h2 className="sl-label">{S.recordsTitle}</h2>
          <div className="sl-stack">
            <p>{S.recordsIntro}</p>
            <ol className="sl-ol">
              {RECORDS.map((r, i) => (
                <li key={r}>
                  <span className="sl-num">{i + 1}</span>
                  <span>{r}</span>
                </li>
              ))}
            </ol>
            <p>{S.neverIntro}</p>
            <p>{S.storage}</p>
            <p>{S.aiChoice}</p>
          </div>
        </section>

        <section className="sl-section">
          <h2 className="sl-label">{S.hoursTitle}</h2>
          <div className="sl-narrow">
            <p className="sl-small">{EXAMPLE_NOTE}</p>
          </div>
          <ul className="sl-hours">
            {DAY_HOURS.map((h) => (
              <li key={h.time}>
                <div className="sl-tile" aria-hidden="true">
                  {h.icons.map((src) => (
                    <Image key={src} src={src} alt="" width={28} height={28} sizes="28px" className="sl-tile-icon" />
                  ))}
                </div>
                <div className="sl-hour-body">
                  <h3 className="sl-small">{h.time}</h3>
                  <p className="sl-small sl-hour-title">{h.title}</p>
                  {h.detail && <p className="sl-small sl-hour-title">{h.detail}</p>}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="sl-section">
          <h2 className="sl-label">{S.neverTitle}</h2>
          <ul className="sl-grid">
            {NEVER.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>

        <Signup />

        <footer className="sl-footer">
          <nav className="sl-footer-nav" aria-label="Footer">
            <span className="sl-footer-first">{FOOTER.copyright}</span>
            <span className="sl-footer-rule" aria-hidden="true" />
            <a className="sl-footer-link" href="#mailing-list">
              {LABELS.join}
            </a>
          </nav>
        </footer>
      </div>
    </div>
  );
}
