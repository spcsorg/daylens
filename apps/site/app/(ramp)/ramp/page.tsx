import { FOOTER, HERO, LABELS } from "../../_v2/copy";
import Backdrop from "../_ramp/Backdrop";
import Film from "../_ramp/Film";
import JoinLink from "../_ramp/JoinLink";
import Signup from "../_ramp/Signup";

// Ramp's spell reveal: each character fades, unblurs and rises over 0.5 s, staggered by its index.
function Spell({ text, delay = 0, step = 0.027 }: { text: string; delay?: number; step?: number }) {
  let index = 0;
  const words = text.split(" ");
  return (
    <span aria-hidden="true">
      {words.map((word, w) => {
        const start = index;
        index += word.length + 1;
        return (
          <span className="rp-word" key={w}>
            {Array.from(word).map((ch, c) => (
              <span className="rp-ch" key={c} style={{ animationDelay: `${(delay + (start + c) * step).toFixed(3)}s` }}>
                {ch}
              </span>
            ))}
            {w < words.length - 1 ? <span>{"\u00a0"}</span> : null}
          </span>
        );
      })}
    </span>
  );
}

export default function Page() {
  return (
    <div className="rp">
      <header className="rp-header">
        <div className="rp-header__row">
          <a className="rp-wordmark" href="#top" aria-label="Daylens">
            Daylens
          </a>
          <JoinLink className="rp-btn-dark">{LABELS.join}</JoinLink>
        </div>
      </header>
      <main id="top">
        <div className="rp-study">
          <Backdrop />
          <section className="rp-hero" aria-labelledby="rp-headline">
            <div className="rp-hero__content">
              <h1 id="rp-headline" className="rp-h1 rp-trim" aria-label="Daylens">
                <Spell text="Daylens" />
              </h1>
              <p className="rp-desc rp-trim">
                <span className="rp-sr">{HERO.tagline}</span>
                <Spell text={HERO.tagline} delay={0.16} step={0.007} />
              </p>
              <div className="rp-signup" id="join">
                <Signup />
              </div>
            </div>
            <Film />
          </section>
        </div>
      </main>
      <footer className="rp-footer">
        <div className="rp-footer__corners" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24">
            <path d="M0 24H24C10.7452 24 0 13.2548 0 0V24Z" />
          </svg>
          <svg width="24" height="24" viewBox="0 0 24 24">
            <path d="M24 24V0C24 13.2548 13.2548 24 0 24H24Z" />
          </svg>
        </div>
        <div className="rp-footer__inner">
          <div className="rp-footer__links">
            <JoinLink className="rp-footer__link rp-trim">{LABELS.join}</JoinLink>
          </div>
          <p className="rp-footer__copy rp-trim">{FOOTER.copyright}</p>
        </div>
      </footer>
    </div>
  );
}
