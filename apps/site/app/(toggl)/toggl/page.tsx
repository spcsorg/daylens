import {
  ASSISTANT_NAMES,
  AUDIENCES,
  CONTROLS,
  DOCS,
  EXAMPLE_LABEL,
  EXAMPLE_NOTE,
  FEATURES,
  FOOTER,
  FORM,
  HERO,
  LABELS,
  NEVER,
  PHRASES,
  RECORDS,
  SUPERLOGICAL,
} from "../../_v2/copy";
import { DAY, HOURS, ICONS } from "../../_v2/day";
import { HeroTicks } from "../_toggl/HeroTicks";
import { Nav } from "../_toggl/Nav";
import { PopScope } from "../_toggl/PopScope";
import { Problem } from "../_toggl/Problem";
import { Tabs } from "../_toggl/Tabs";
import { AppIcon, HeroAssistantsCard, HeroDayCard, SearchWindow, WindowShot } from "../_toggl/ui";
import { WaitlistForm } from "../_toggl/WaitlistForm";
import { Words } from "../_toggl/Words";

const ROWS = ["8 AM", "9 AM", "10 AM", "11 AM", "12 PM", "1 PM", "2 PM", "3 PM", "4 PM"];
const sentences = (s: string) => s.replace(/\.\s+/g, ".\n").split("\n");

const TAB_SIZES = "(max-width: 767px) calc(100vw - 4rem), 44vw";

const TABS = [
  { id: "hours", label: PHRASES[0], f: FEATURES.hours, note: EXAMPLE_NOTE, screen: <WindowShot screen="today" sizes={TAB_SIZES} /> },
  { id: "search", label: PHRASES[1], f: FEATURES.search, note: FEATURES.search.short, screen: <SearchWindow /> },
  { id: "ask", label: PHRASES[2], f: FEATURES.ask, note: FEATURES.ask.short, screen: <WindowShot screen="ask" sizes={TAB_SIZES} /> },
  { id: "fix", label: PHRASES[3], f: FEATURES.fix, note: FEATURES.fix.short, screen: <WindowShot screen="today" sizes={TAB_SIZES} /> },
  { id: "assistants", label: PHRASES[4], f: FEATURES.assistants, note: FEATURES.assistants.note, screen: <WindowShot screen="assistants" sizes={TAB_SIZES} /> },
];

const GRID = [FEATURES.hours, FEATURES.fix, FEATURES.search, FEATURES.ask, FEATURES.assistants, FEATURES.time, FEATURES.ai, FEATURES.privacy];

function Corners({ cls }: { cls: string }) {
  return (
    <>
      <span className={`${cls} ${cls}--tl`} aria-hidden="true" />
      <span className={`${cls} ${cls}--tr`} aria-hidden="true" />
      <span className={`${cls} ${cls}--br`} aria-hidden="true" />
      <span className={`${cls} ${cls}--bl`} aria-hidden="true" />
    </>
  );
}

function CheckList({ items, never }: { items: string[]; never?: boolean }) {
  return (
    <ul className="t-checks">
      {items.map((t) => (
        <li key={t}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="7" fill="currentColor" />
            <path d={never ? "m5.5 5.5 5 5m0-5-5 5" : "m5 8.2 2 2L11 6"} fill="none" stroke="#e9f4b3" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

function CtaDeco() {
  const ticks = Array.from({ length: 12 }, (_, i) => i * 30);
  return (
    <>
      <svg className="t-cta_frame" viewBox="0 0 1210 793" fill="none" aria-hidden="true">
        <g stroke="currentColor" strokeWidth="0.72">
          <rect x="587" y="0.4" width="36" height="1210" />
          <rect x="290" y="75.5" width="630" height="1059" />
          <rect x="0.4" y="587" width="1209" height="36" />
          <rect x="75.5" y="290" width="1059" height="630" />
        </g>
      </svg>
      <div className="t-cta_clock-wrap" aria-hidden="true">
        <svg className="t-cta_clock" viewBox="0 0 1039 1039" fill="none">
          {ticks.map((a) => (
            <rect key={a} x="506.6" y="0.2" width="25.3" height="45.9" fill="currentColor" transform={`rotate(${a} 519.5 519.5)`} />
          ))}
        </svg>
      </div>
    </>
  );
}

export default function Page() {
  const h = HOURS;
  return (
    <div className="t-page" id="top">
      <Nav />
      <main>
        <section className="t-hero" aria-labelledby="hero-title">
          <div className="t-hero_top">
            <div className="t-hero_circle" aria-hidden="true">
              <div className="t-hero_circle-inner" />
              <HeroTicks />
            </div>
            <div className="t-hero_content">
              <div className="t-hero_heading-wrap">
                <h1 className="t-title-1 t-hero_title" id="hero-title">
                  {HERO.title}
                </h1>
                <p className="t-text-1 t-hero_sub">{HERO.subShort}</p>
              </div>
              <WaitlistForm id="hero-email" variant="hero" />
            </div>
            <div className="t-hero_images">
              <HeroDayCard />
              <HeroAssistantsCard />
            </div>
          </div>
        </section>

        <Problem />

        <section className="t-lime" id="how" aria-labelledby="how-title">
          <div className="t-container">
            <p className="t-eyebrow">{LABELS.how}</p>
            <Words as="h2" className="t-title-1 t-lime_title" text={FEATURES.hours.title} id="how-title" />
          </div>
        </section>

        <section className="t-found">
          <div className="t-container">
            <div className="t-found_inner">
              <div className="t-found_left">
                <p className="t-title-4 t-found_heading">{FEATURES.hours.short}</p>
                <div className="t-text-2 t-found_body">
                  <p>{FEATURES.hours.body}</p>
                  <p>{FEATURES.fix.body}</p>
                  <p>
                    {FEATURES.ai.title} {FEATURES.ai.body}
                  </p>
                </div>
              </div>
              <PopScope className="t-tl">
                <div className="t-tl_bar" aria-hidden="true">
                  <span className="t-tl_play">
                    <svg viewBox="0 0 44 44">
                      <circle cx="22" cy="22" r="22" fill="currentColor" />
                      <path d="M18 15.5v13l10.5-6.5L18 15.5Z" fill="#fff" />
                    </svg>
                  </span>
                </div>
                <ol className="t-tl_rows" aria-label={DAY.label}>
                  {ROWS.map((r) => (
                    <li className="t-tl_row" key={r}>
                      <span className="t-tl_label">{r}</span>
                      <span className="t-tl_line" />
                    </li>
                  ))}
                </ol>

                <article className="t-tl-card t-tl-card--hour">
                  <div className="t-tl-card_head" data-pop>
                    {h[1].icons.map((src) => (
                      <AppIcon key={src} src={src} size={18} />
                    ))}
                  </div>
                  <p className="t-title-5 t-tl-card_title" data-pop>
                    {h[1].title}
                  </p>
                  <div className="t-tl-card_foot" data-pop>
                    <p className="t-text-2 t-weaker">{h[1].detail}</p>
                    <p className="t-text-2 t-soft">{h[1].time}</p>
                  </div>
                </article>

                <article className="t-tl-card t-tl-card--meeting">
                  <p className="t-title-7 t-tl-card_green" data-pop>
                    {h[3].title}
                  </p>
                  <div className="t-tl-card_row" data-pop>
                    <p className="t-text-2 t-soft">{h[3].time}</p>
                    <AppIcon src={ICONS.chrome} size={14} />
                  </div>
                </article>

                <article className="t-tl-card t-tl-card--time">
                  <div className="t-tl-card_row" data-pop>
                    <p className="t-tl-card_strong">{DAY.short}</p>
                    <p className="t-tl-card_strong">{h[4].time}</p>
                  </div>
                  <div data-pop>
                    <p className="t-text-1">{h[4].title}</p>
                    <div className="t-tl-card_tags">
                      <span className="t-tag t-tag--magenta">
                        <i />
                        Cursor
                      </span>
                      <span className="t-tag t-tag--muted">
                        <i />
                        Chrome
                      </span>
                    </div>
                  </div>
                </article>

                <article className="t-tl-card t-tl-card--bill">
                  <div className="t-tl-card_inline" data-pop>
                    <AppIcon src={ICONS.cursor} size={40} className="t-tl-card_bill-ic" />
                    <div>
                      <p className="t-text-1medium t-soft">{h[5].title}</p>
                      <p className="t-text-2 t-weaker">{h[5].time}</p>
                    </div>
                  </div>
                </article>

                <div className="t-reached t-reached--1" data-pop>
                  <div className="t-color-card" data-deco>
                    <p className="t-color-card_tag">
                      <i />
                      {h[2].time}
                    </p>
                    <p className="t-color-card_text">{h[2].title}</p>
                  </div>
                </div>
                <div className="t-reached t-reached--2" data-pop>
                  <div className="t-color-card t-color-card--magenta" data-deco>
                    <p className="t-color-card_tag">
                      <i />
                      {h[0].time}
                    </p>
                    <p className="t-color-card_text">{FEATURES.fix.short}</p>
                  </div>
                </div>
                <div className="t-reached t-reached--3" data-pop>
                  <div className="t-color-card t-color-card--magenta t-color-card--label" data-deco>
                    <p className="t-color-card_text">{EXAMPLE_LABEL}</p>
                    <p className="t-color-card_text">{DAY.short}</p>
                  </div>
                </div>
                <div className="t-solid-card" data-pop aria-hidden="true" />
              </PopScope>
            </div>
          </div>
        </section>

        <section className="t-features" id="features" aria-labelledby="features-title">
          <div className="t-deco-lines" aria-hidden="true">
            <span />
            <span />
          </div>
          <div className="t-container">
            <Words as="h2" className="t-title-2 t-features_title" text={DOCS.sections[0].title} id="features-title" />
            <Tabs
              panels={TABS.map((t) => ({
                id: t.id,
                label: t.label,
                content: (
                  <div className="t-track">
                    <div className="t-track_inner">
                      <div className="t-track_left">
                        <div className="t-track_header">
                          <h3 className="t-title-3 t-track_title" data-tab-item>
                            {t.f.title}
                          </h3>
                        </div>
                        <div className="t-track_body">
                          <ul className="t-track_list">
                            {sentences(t.f.body).map((s) => (
                              <li key={s} className="t-text-2" data-tab-item>
                                {s}
                              </li>
                            ))}
                          </ul>
                          <div className="t-track_study" data-tab-item>
                            <p className="t-text-2medium">{t.note}</p>
                          </div>
                        </div>
                      </div>
                      <div className="t-track_right">
                        <div className="t-track_shot" data-tab-item>
                          {t.screen}
                        </div>
                      </div>
                    </div>
                    <Corners cls="t-corner" />
                  </div>
                ),
              }))}
            />
          </div>
        </section>

        <section className="t-grid-sec" aria-labelledby="grid-title">
          <div className="t-container">
            <div className="t-grid-sec_head">
              <h2 className="t-title-2 t-grid-sec_title" id="grid-title">
                {HERO.eyebrow}
              </h2>
              <p className="t-text-2medium t-grid-sec_sub">{HERO.sub}</p>
            </div>
            <ul className="t-grid">
              {GRID.map((f) => (
                <li className="t-grid_item" key={f.title}>
                  <h3 className="t-title-6">{f.title}</h3>
                  <p className="t-text-2">{f.short}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="t-teams" aria-labelledby="teams-title">
          <div className="t-container">
            <div className="t-teams_heading">
              <h2 className="t-title-2 t-teams_title" id="teams-title">
                {HERO.titleLong}
              </h2>
              <p className="t-text-t2 t-teams_sub">{AUDIENCES.map((a) => a.title).join(" · ")}</p>
            </div>
            <div className="t-teams_grid">
              {AUDIENCES.map((a) => (
                <article className="t-team" key={a.title}>
                  <div className="t-team_top">
                    <h3 className="t-title-3 t-team_title">{a.title}</h3>
                    <p className="t-text-2 t-team_desc">{a.body}</p>
                  </div>
                  <Corners cls="t-tcorner" />
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="t-privacy" id="privacy" aria-labelledby="privacy-title">
          <div className="t-container">
            <div className="t-privacy_heading">
              <h2 className="t-title-2 t-privacy_title" id="privacy-title">
                {FEATURES.privacy.title}
              </h2>
              <p className="t-text-2 t-privacy_sub">{FEATURES.privacy.body}</p>
            </div>
            <div className="t-plans">
              <article className="t-plan">
                <div className="t-plan_head">
                  <h3 className="t-title-4 t-plan_title">{LABELS.records}</h3>
                  <p className="t-text-2 t-plan_desc">{SUPERLOGICAL.recordsIntro}</p>
                </div>
                <CheckList items={RECORDS} />
                <span className="t-plan_lines" aria-hidden="true" />
              </article>
              <article className="t-plan">
                <div className="t-plan_head">
                  <h3 className="t-title-4 t-plan_title">{LABELS.never}</h3>
                  <p className="t-text-2 t-plan_desc">{SUPERLOGICAL.neverTitle}</p>
                </div>
                <CheckList items={NEVER} never />
                <span className="t-plan_lines" aria-hidden="true" />
              </article>
              <article className="t-plan">
                <div className="t-plan_head">
                  <h3 className="t-title-4 t-plan_title">{LABELS.controls}</h3>
                  <p className="t-text-2 t-plan_desc">{FEATURES.privacy.short}</p>
                </div>
                <CheckList items={CONTROLS} />
                <span className="t-plan_lines" aria-hidden="true" />
              </article>
              <article className="t-plan t-plan--dark">
                <p className="t-plan_label">{LABELS.assistants}</p>
                <div className="t-plan_bot">
                  <h3 className="t-title-4 t-plan_dark-title">{FEATURES.assistants.title}</h3>
                  <p className="t-text-2 t-plan_dark-p">{FEATURES.assistants.note}</p>
                  <ul className="t-plan_tags">
                    {ASSISTANT_NAMES.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </div>
              </article>
            </div>
          </div>
        </section>

        <section className="t-cta" id="join" aria-labelledby="cta-title">
          <CtaDeco />
          <div className="t-container">
            <div className="t-cta_inner">
              <Words as="h2" className="t-title-3 t-cta_title" text={FORM.closingTitle} id="cta-title" />
              <div className="t-cta_actions">
                <span className="t-cta_band" aria-hidden="true" />
                <WaitlistForm id="cta-email" variant="cta" />
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="t-footer">
        <div className="t-container">
          <div className="t-footer_inner">
            <a className="t-footer_logo" href="#top">
              Daylens
            </a>
            <nav className="t-footer_nav" aria-label="Footer">
              <ul className="t-footer_list">
                <li>
                  <a href="#how">{LABELS.how}</a>
                </li>
                <li>
                  <a href="#features">{LABELS.features}</a>
                </li>
                <li>
                  <a href="#privacy">{LABELS.privacy}</a>
                </li>
                <li>
                  <a href="#join">{LABELS.join}</a>
                </li>
              </ul>
            </nav>
            <p className="t-footer_legal">{FOOTER.copyright}</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
