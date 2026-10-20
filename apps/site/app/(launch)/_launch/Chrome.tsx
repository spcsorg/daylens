import { asset, route } from "../../_v2/base";
import { COPY } from "./content";

const GITHUB = "https://github.com/irachrist1/daylens";

export function Nav({ sticky }: { sticky?: boolean }) {
  return (
    <header className={sticky ? "lx-nav" : "lx-nav is-static"}>
      <a className="lx-logo" href={route("/")} aria-label="Daylens home">
        <img src={asset("/icons/daylens.svg")} alt="" width={28} height={28} />
        <span>Daylens</span>
      </a>
      <a className="lx-nav-join" href={`${route("/")}#join`}>
        {COPY.join}
      </a>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="lx-footer">
      <span>{COPY.copyright}</span>
      <nav aria-label="Footer">
        <a href={route("/privacy")}>Privacy</a>
        <a href={route("/devlog")}>Devlog</a>
        <a href={route("/press")}>Press</a>
        <a href={GITHUB}>GitHub</a>
      </nav>
    </footer>
  );
}
