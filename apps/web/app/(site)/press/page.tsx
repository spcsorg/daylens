import type { Metadata } from "next";
import Link from "next/link";
import { assetPath } from "@/app/lib/basePath";
import { SiteFooter, SiteHeader } from "../_components/SiteChrome";
import { CONTACT_EMAIL, GITHUB_URL, OPEN_GRAPH_BASE, SITE_URL, TWITTER_BASE, absoluteUrl } from "../_lib/site";

export const metadata: Metadata = {
  title: "Press kit",
  description: "The Daylens logo, a description you can quote, and the facts about Daylens 2.",
  alternates: { canonical: absoluteUrl("/press") },
  openGraph: { ...OPEN_GRAPH_BASE, title: "Daylens press kit", url: absoluteUrl("/press") },
  twitter: TWITTER_BASE,
};

const DESCRIPTION =
  "Daylens is a desktop app for Windows 11 and macOS that remembers which apps, windows and pages you used, so you and the AI you choose can find anything you saw and pick up where you left off. It writes your day as hours in plain words. Your history is stored only on your computer, and the makers of Daylens never keep a copy. Private browser windows are never recorded, and you can pause, exclude or delete anything. Daylens works with the AI you choose, or none, and is open source under the MIT license.";

export default function PressPage() {
  return (
    <>
      <SiteHeader current="press" />
      <main id="main" className="page">
        <header className="page-head">
          <h1>Press kit</h1>
          <p>Everything you need to write about Daylens. Use any of it without asking.</p>
        </header>

        <div className="press-grid">
          <section className="press-block" aria-labelledby="press-about">
            <h2 id="press-about">About Daylens</h2>
            <p className="press-copy">{DESCRIPTION}</p>
            <ul>
              <li>Tagline: Your day, remembered. For you and your AI.</li>
              <li>Platforms: Windows 11 (Microsoft Store) and macOS (signed download).</li>
              <li>Beta: invites in waves from November 2026. Stable release after the beta.</li>
              <li>License: MIT. Source code at <a href={GITHUB_URL}>{GITHUB_URL.replace("https://", "")}</a>.</li>
              <li>
                Website: <a href={SITE_URL}>{SITE_URL.replace("https://", "")}</a>
              </li>
              <li>
                Background: <Link href="/devlog/why-we-are-rebuilding-daylens">Why we&rsquo;re rebuilding Daylens</Link>
              </li>
            </ul>
          </section>

          <section className="press-block" aria-labelledby="press-logo">
            <h2 id="press-logo">Logo</h2>
            <p>The app icon, 256 by 256 pixels, transparent PNG. Please don&rsquo;t recolor or crop it.</p>
            <div className="press-logos">
              <div className="press-logo">
                <img src={assetPath("/app-icon.png")} alt="Daylens app icon" width={96} height={96} loading="lazy" />
                <span>On light</span>
              </div>
              <div className="press-logo is-dark">
                <img src={assetPath("/app-icon.png")} alt="Daylens app icon on a dark background" width={96} height={96} loading="lazy" />
                <span>On dark</span>
              </div>
            </div>
            <p>
              <a href={assetPath("/app-icon.png")} download="daylens-icon.png" className="text-link">
                Download the icon (PNG)
              </a>
            </p>

            <h2 id="press-screens" style={{ marginTop: "2.5rem" }}>
              Screenshots
            </h2>
            <div className="press-shot" role="img" aria-label="Screenshot placeholder">
              Screenshots of Daylens 2 arrive with the beta in November.
            </div>
          </section>
        </div>

        <section className="press-block" aria-labelledby="press-contact" style={{ marginTop: "2.5rem", maxWidth: "44rem" }}>
          <h2 id="press-contact">Contact</h2>
          <p>
            For interviews, early access or anything else: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
