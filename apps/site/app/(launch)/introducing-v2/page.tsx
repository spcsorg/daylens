import type { Metadata } from "next";
import { asset, route } from "../../_v2/base";
import { pageMetadata, SITE_URL } from "../../_v2/meta";
import { Footer, Nav } from "../_launch/Chrome";
import { COPY } from "../_launch/content";
import Signup from "../_launch/Signup";
import "./_film/film.css";
import { CUTS } from "./_film/cuts";
import { SKY, startOf, type ShotId } from "./_film/Film";
import { serif } from "./_film/fonts";
import Player from "./_film/Player";
import { SHOTS } from "./_film/shots";
import { AVAILABILITY, BETA, CLOSING, DEK, FEATURES, POST, PRIVACY_LINE, PRIVACY_MORE, TITLE } from "./copy";
import "./v2.css";

const URL_ = `${SITE_URL}/introducing-v2`;

export const metadata: Metadata = (() => {
  const base = pageMetadata();
  const image = { url: new URL(asset("/introducing-v2/og.png"), new URL(SITE_URL).origin).href, width: 1200, height: 630, alt: "Daylens answering a question about Tuesday with the page and hours it came from" };
  return {
    ...base,
    title: TITLE,
    description: DEK,
    alternates: { canonical: URL_ },
    openGraph: { ...base.openGraph, title: TITLE, description: DEK, url: URL_, images: [image] },
    twitter: { card: "summary_large_image", title: TITLE, description: DEK, images: [image.url] },
  };
})();

const FIELD: Record<ShotId, string> = { welcome: SKY.dawn, morning: SKY.morning, today: SKY.noon, search: SKY.noon, ask: SKY.dusk, assistants: SKY.morning, trust: SKY.afternoon };
const POSTER = startOf(CUTS.duet, SHOTS.ask) + SHOTS.ask.dur - 1;

function Feature({ id, children }: { id: Exclude<ShotId, "ask">; children?: React.ReactNode }) {
  const f = FEATURES[id];
  return (
    <section className="iv-feature" aria-labelledby={`iv-${id}`}>
      <div className="iv-text">
        <h2 id={`iv-${id}`}>{f.title}</h2>
        <p>{f.body}</p>
        {children}
      </div>
      <Player shot={id} sky={FIELD[id]} still={SHOTS[id].dur} label={f.title} controls />
    </section>
  );
}

export default function Page() {
  const ask = FEATURES.ask;
  return (
    <div className={`lx-page iv-page ${serif.variable}`}>
      <Nav sticky />
      <main id="top">
        <header className="iv-hero">
          <h1>{TITLE}</h1>
          <p className="iv-dek">{DEK}</p>
          <p className="iv-avail">{AVAILABILITY}</p>
        </header>

        <div className="iv-film">
          <Player still={POSTER} label="The Daylens V2 launch film: setting up, the day filling in, Today, Search, Ask, and pausing and deleting" controls />
        </div>

        <div className="iv-join iv-join--top">
          <Signup id="iv-email-top" />
        </div>

        {POST.length ? (
          <article className="iv-post" aria-label="Announcement">
            {POST.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </article>
        ) : null}

        <Feature id="welcome" />
        <Feature id="morning" />
        <Feature id="today" />
        <Feature id="search" />

        <section className="iv-feature iv-ask" aria-labelledby="iv-ask">
          <div className="iv-text">
            <h2 id="iv-ask">{ask.title}</h2>
            <p>{ask.body}</p>
          </div>
          <Player shot="ask" sky={FIELD.ask} still={SHOTS.ask.dur} label={ask.title} controls />
          <div className="iv-ask-more">
            <ul className="iv-questions" aria-label="Questions you can ask">
              {ask.examples.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
            {ask.points.map((p) => (
              <div key={p.title} className="iv-point">
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </div>
            ))}
          </div>
        </section>

        <Feature id="assistants" />
        <Feature id="trust" />

        <section className="iv-privacy" aria-labelledby="iv-privacy">
          <h2 id="iv-privacy">{PRIVACY_LINE.slice(0, PRIVACY_LINE.indexOf(".") + 1)}</h2>
          <p>{PRIVACY_LINE.slice(PRIVACY_LINE.indexOf(".") + 2)}</p>
          <div className="iv-lists">
            <div>
              <h3>{COPY.records.title}</h3>
              <ul>
                {COPY.records.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>{COPY.never.title}</h3>
              <ul>
                {COPY.never.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className="iv-small">
            {PRIVACY_MORE.join(" ")} <a href={route("/privacy")}>Privacy</a>
          </p>
        </section>

        <section className="iv-beta" aria-labelledby="iv-beta">
          <h2 id="iv-beta">{BETA.title}</h2>
          {BETA.body.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </section>

        <section className="iv-closing" id="join" aria-labelledby="iv-closing">
          <h2 id="iv-closing">{CLOSING}</h2>
          <Signup id="iv-email-closing" />
        </section>

        <Footer />
      </main>
    </div>
  );
}
