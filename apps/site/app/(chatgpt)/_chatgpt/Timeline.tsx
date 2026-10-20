import Image from "next/image";
import { EXAMPLE_LABEL, EXAMPLE_NOTE } from "../../_v2/copy";
import { DAY, HOURS } from "../../_v2/day";
import { ChevronDownIcon } from "./icons";

function AppIcon({ src }: { src: string }) {
  return (
    <span className="cg-tl-icon">
      <Image src={src} alt="" width={24} height={24} unoptimized />
    </span>
  );
}

export function Timeline() {
  return (
    <figure className="cg-tl" role="img" aria-label={EXAMPLE_NOTE}>
      <div className="cg-tl-pad" aria-hidden="true">
        <div className="cg-tl-head">
          <span>{DAY.label}</span>
          <ChevronDownIcon className="cg-tl-chev" />
          <span className="cg-tl-label">{EXAMPLE_LABEL}</span>
        </div>
        <div className="cg-tl-list">
          {HOURS.map((h, i) => (
            <div key={h.time} className="cg-tl-entry" data-quiet={h.quiet || undefined}>
              <time>{h.time}</time>
              <div className="cg-tl-railcol">
                <span className="cg-tl-line" data-first={i === 0 || undefined} />
                <span className="cg-tl-dot" />
              </div>
              <div className="cg-tl-body">
                <div className="cg-tl-title">{h.title}</div>
                {h.detail && <p>{h.detail}</p>}
                {h.icons.length > 0 && (
                  <div className="cg-tl-icons">
                    {h.icons.map((src) => (
                      <AppIcon key={src} src={src} />
                    ))}
                  </div>
                )}
                {h.sources && (
                  <div className="cg-tl-box">
                    <div className="cg-tl-box-title">Sources</div>
                    {h.sources.map((s) => (
                      <div key={s.name} className="cg-tl-source">
                        <AppIcon src={s.icon} />
                        <div>
                          <div className="cg-tl-source-name">{s.name}</div>
                          <div className="cg-tl-source-meta">{s.meta}</div>
                        </div>
                      </div>
                    ))}
                    <span className="cg-tl-link">Fix this hour</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}
