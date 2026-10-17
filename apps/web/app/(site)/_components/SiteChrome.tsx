import Link from "next/link";
import { assetPath } from "@/app/lib/basePath";
import { MAC_DOWNLOAD_HREF, WINDOWS_DOWNLOAD_HREF } from "@/app/lib/platformLinks";
import { CONTACT_EMAIL, GITHUB_URL } from "../_lib/site";

export function Logo() {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- pre-sized 2x WebP; next/image would add a loader round trip */}
      <img src={assetPath("/app-icon-56.webp")} alt="" width={28} height={28} className="logo-icon" />
      <span className="logo-word">Daylens</span>
    </>
  );
}

export function SiteHeader({ current }: { current?: "privacy" | "devlog" | "press" }) {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link href="/" className="logo" aria-label="Daylens home">
          <Logo />
        </Link>
        <nav aria-label="Site">
          <Link href="/#how" className="nav-optional">
            How it works
          </Link>
          <Link href="/privacy" aria-current={current === "privacy" ? "page" : undefined}>
            Privacy
          </Link>
          <Link href="/devlog" aria-current={current === "devlog" ? "page" : undefined}>
            Devlog
          </Link>
          <Link href="/#join" className="button button-primary button-small">
            Join the beta
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <Link href="/" className="logo" aria-label="Daylens home">
            <Logo />
          </Link>
          <p>Your day, remembered. For you and your AI.</p>
        </div>
        <nav aria-label="Daylens V2">
          <p className="footer-heading">Daylens</p>
          <Link href="/privacy">Privacy policy</Link>
          <Link href="/devlog">Devlog</Link>
          <a href={assetPath("/devlog/rss.xml")}>RSS</a>
          <Link href="/press">Press kit</Link>
          <a href={GITHUB_URL}>Source code</a>
        </nav>
        <nav aria-label="Current version">
          <p className="footer-heading">Current version</p>
          <a href={WINDOWS_DOWNLOAD_HREF}>Download for Windows</a>
          <a href={MAC_DOWNLOAD_HREF}>Download for Mac</a>
          <Link href="/changelog">Changelog</Link>
          <Link href="/docs">Docs</Link>
          <Link href="/roadmap">Roadmap</Link>
        </nav>
        <p className="site-footer-contact">
          Questions: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          <br />
          Open source under the MIT license.
        </p>
      </div>
    </footer>
  );
}
