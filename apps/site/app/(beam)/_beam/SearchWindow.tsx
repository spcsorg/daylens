import { SCREENS, SEARCH } from "../../_v2/day";
import { OpenArrow, Search } from "./icons";

// HTML rebuild of find-it-window.png without its retired heading. Sized in em so it scales with the card.
export function SearchWindow() {
  return (
    <div className="b-app" role="img" aria-label={SCREENS.find.alt}>
      <div className="b-app-bar" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="b-app-body" aria-hidden="true">
        <div className="b-app-search">
          <div className="b-app-query">
            <Search className="b-app-glass" />
            <span>{SEARCH.query}</span>
          </div>
          <div className="b-app-result">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={SEARCH.result.icon} alt="" className="b-app-icon" />
            <div className="b-app-text">
              <div className="b-app-name">{SEARCH.result.name}</div>
              <div className="b-app-meta">{SEARCH.result.meta}</div>
            </div>
            <OpenArrow className="b-app-open" />
          </div>
        </div>
      </div>
    </div>
  );
}
