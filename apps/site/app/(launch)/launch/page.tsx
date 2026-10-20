import Backdrop from "../../(ramp)/_ramp/Backdrop";
import { Footer, Nav } from "../_launch/Chrome";
import { COPY } from "../_launch/content";
import Signup from "../_launch/Signup";
import Stage from "../_launch/Stage";

const RECORD_ICONS = [
  "M3 5.5A1.5 1.5 0 0 1 4.5 4h11A1.5 1.5 0 0 1 17 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5v-9ZM3 7.5h14",
  "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM3 10h14M10 3c1.8 1.9 2.7 4.2 2.7 7s-.9 5.1-2.7 7c-1.8-1.9-2.7-4.2-2.7-7s.9-5.1 2.7-7Z",
  "M15.5 12.4A6.5 6.5 0 0 1 7.6 4.5a6.5 6.5 0 1 0 7.9 7.9Z",
];
const NEVER_ICONS = [
  "M3 7a2 2 0 0 1 2-2h1.5l1-1.5h5l1 1.5H15a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7ZM10 13.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  "M3 6.5A1.5 1.5 0 0 1 4.5 5h11A1.5 1.5 0 0 1 17 6.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 13.5v-7ZM6 8h.01M9 8h.01M12 8h.01M15 8h.01M6 11h.01M14 11h.01M8 11h4",
  "M5.5 3h6L15 6.5V16a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM11 3v4h4",
  "M3 9.5c2-1 4.3-1.5 7-1.5s5 .5 7 1.5M6 12.5a2 2 0 1 0 0 .01M14 12.5a2 2 0 1 0 0 .01M8 12.5h4M5.5 8l1.5-4h6l1.5 4",
];

function List({ items, icons, never }: { items: string[]; icons: string[]; never?: boolean }) {
  return (
    <ul className="lx-list">
      {items.map((t, i) => (
        <li key={t}>
          <svg viewBox="0 0 20 20" aria-hidden="true" className={never ? "lx-ic is-never" : "lx-ic"}>
            <path d={icons[i]} />
            {never ? <path d="M3 17 17 3" className="lx-ic-strike" /> : null}
          </svg>
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

export default function Page() {
  return (
    <div className="lx-page">
      <Backdrop />
      <Nav sticky />

      <main id="top">
        <Stage />

        <div className="lx-paper">
          <section className="lx-essay" aria-label="Why Daylens">
            {COPY.essay.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </section>

          <section className="lx-cards" aria-label="What Daylens records">
            <article className="lx-card lx-card--records">
              <h2>{COPY.records.title}</h2>
              <List items={COPY.records.items} icons={RECORD_ICONS} />
            </article>
            <article className="lx-card lx-card--never">
              <h2>{COPY.never.title}</h2>
              <List items={COPY.never.items} icons={NEVER_ICONS} never />
            </article>
          </section>

          <section className="lx-essay lx-essay--after" aria-label="Your history, your AI">
            <p>{COPY.local}</p>
            <p>{COPY.ai}</p>
          </section>

          <section className="lx-closing" id="join" aria-labelledby="lx-closing-title">
            <h2 id="lx-closing-title">{COPY.closing}</h2>
            <p>{COPY.platforms}</p>
            <Signup id="lx-email-closing" source="launch-closing" />
          </section>

          <Footer />
        </div>
      </main>
    </div>
  );
}
