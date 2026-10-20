import Image from "next/image";
import { EXAMPLE_LABEL, LABELS } from "../../_v2/copy";
import { ASSISTANTS, DAY, HOURS, SEARCH, SCREENS } from "../../_v2/day";

export function AppIcon({ src, size = 16, className }: { src: string; size?: number; className?: string }) {
  return <Image src={src} alt="" width={size} height={size} className={className} unoptimized={src.endsWith(".svg")} />;
}

function Check() {
  return (
    <svg className="a-check" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="10" fill="currentColor" />
      <path d="m6 10.2 2.6 2.6L14 7.4" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Hero collage, left: the example day as hour rows, like the Today screen.
export function HeroDayCard() {
  const rows = HOURS.slice(0, 4);
  return (
    <div className="a-card t-hero_card">
      <div className="a-card_in">
      <div className="a-card_head">
        <p className="a-card_title">{DAY.label}</p>
        <p className="a-card_note">{EXAMPLE_LABEL}</p>
      </div>
      <ul className="a-hours">
        {rows.map((h) => (
          <li key={h.time} className={`a-hour${h.quiet ? " is-quiet" : ""}`}>
            <span className="a-hour_time">{h.time}</span>
            <span className="a-hour_body">
              <span className="a-hour_title">
                {h.title}
                {h.edited ? <span className="a-badge">Edited</span> : null}
              </span>
              {h.icons.length ? (
                <span className="a-hour_icons">
                  {h.icons.map((src) => (
                    <AppIcon key={src} src={src} size={14} />
                  ))}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      </div>
    </div>
  );
}

// Hero collage, right: connected assistants, like the assistants screen.
export function HeroAssistantsCard() {
  return (
    <div className="a-card t-hero_card">
      <div className="a-card_in">
      <div className="a-card_head">
        <p className="a-card_title">{LABELS.assistants}</p>
      </div>
      <ul className="a-list">
        {ASSISTANTS.map((a) => (
          <li key={a.name} className="a-list_row">
            <AppIcon src={a.icon} size={20} className="a-list_icon" />
            <span className="a-list_text">
              <span className="a-list_name">{a.name}</span>
              <span className="a-list_meta">{a.meta}</span>
            </span>
            <Check />
          </li>
        ))}
      </ul>
      </div>
    </div>
  );
}

export function WindowShot({ screen, sizes }: { screen: keyof typeof SCREENS; sizes: string }) {
  const s = SCREENS[screen];
  return <Image className="t-shot" src={s.src} alt={s.alt} width={s.w} height={s.h} sizes={sizes} quality={80} />;
}

// The search screen's heading uses retired wording, so its search box is rebuilt here instead of showing the image.
export function SearchWindow() {
  return (
    <div className="a-window" role="img" aria-label={SCREENS.find.alt}>
      <div className="a-window_bar" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="a-window_body a-search">
        <div className="a-search_box">
          <div className="a-search_input">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m20 20-4.2-4.2M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <span>{SEARCH.query}</span>
          </div>
          <div className="a-search_result">
            <AppIcon src={SEARCH.result.icon} size={26} />
            <span className="a-list_text">
              <span className="a-list_name">{SEARCH.result.name}</span>
              <span className="a-list_meta">{SEARCH.result.meta}</span>
            </span>
            <svg className="a-arrow" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 11 11 5M6 5h5v5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
