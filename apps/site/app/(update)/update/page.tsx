import Image from "next/image";
import { EXAMPLE_LABEL, EXAMPLE_NOTE, FEATURES, FOOTER, LABELS, UPDATE_POST } from "../../_v2/copy";
import { NoiseGradient } from "../_update/NoiseGradient";
import { Signup } from "../_update/Signup";
import { Wordmark } from "../_update/Wordmark";
import shot from "../../../public/screens/today-hour-open-window.png";

const LINKED = "the waitlist";

function Intro() {
  const [before, after] = UPDATE_POST.intro.split(LINKED);
  if (after === undefined) return <p>{UPDATE_POST.intro}</p>;
  return (
    <p>
      {before}
      <a href="#mailing-list">{LINKED}</a>
      {after}
    </p>
  );
}

export default function Page() {
  return (
    <div className="u-page">
      <div className="u-shell">
        <Wordmark />
        <main>
          <article id="u-article" className="u-article">
            <header className="u-head">
              <h1 className="u-title">{UPDATE_POST.title}</h1>
              <p className="u-byline">{UPDATE_POST.byline}</p>
              <div className="u-date-space" aria-hidden="true" />
            </header>
            <div className="u-body">
              <div className="u-prose">
                <Intro />
                <figure className="u-wide">
                  <div className="u-shot">
                    <NoiseGradient />
                    <div className="u-stage">
                      <div className="u-media">
                        <Image
                          src={shot}
                          alt={`${EXAMPLE_LABEL}: ${FEATURES.hours.short}`}
                          sizes="(min-width: 1440px) 1057px, 75vw"
                          priority
                          quality={90}
                        />
                        <div className="u-overlay">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src="/icons/daylens.svg" alt="" width={64} height={64} />
                        </div>
                      </div>
                    </div>
                  </div>
                  <figcaption>{EXAMPLE_NOTE}</figcaption>
                </figure>
                <p>{UPDATE_POST.lead}</p>
                {UPDATE_POST.sections.map((s) => (
                  <section key={s.title} className="u-section">
                    <h2>{s.title}</h2>
                    {s.paras.map((p) => (
                      <p key={p}>{p}</p>
                    ))}
                  </section>
                ))}
              </div>
              <Signup />
            </div>
          </article>
        </main>
        <footer className="u-footer">
          <nav className="u-footer-nav" aria-label="Footer">
            <span className="u-footer-left">{FOOTER.copyright}</span>
            <span className="u-footer-rule" aria-hidden="true" />
            <a className="u-footer-link" href="#mailing-list">
              {LABELS.join}
            </a>
          </nav>
        </footer>
      </div>
    </div>
  );
}
