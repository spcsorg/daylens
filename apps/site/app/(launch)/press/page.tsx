import type { Metadata } from "next";
import { asset, route } from "../../_v2/base";
import { SITE_URL } from "../../_v2/meta";
import { Footer, Nav } from "../_launch/Chrome";
import { docMetadata } from "../_launch/doc";
import { CONTACT_EMAIL, GITHUB_URL } from "../_launch/site";

const DESCRIPTION =
  "Daylens is a desktop app for Mac and Windows that records the apps, windows and pages you use and cleans them into a calendar of what you actually did. You can search it, ask about any day, and let the AI assistants you already use read it. Your history is stored only on your computer, and the makers of Daylens never keep a copy. Private browser windows are never recorded, and you can pause, exclude or delete anything. Daylens works with the AI you choose, or none, and is open source under the MIT license.";

export const metadata: Metadata = docMetadata("/press", "Daylens press kit", "The Daylens logo, a description you can quote, and the facts about Daylens 2.");

export default function PressPage() {
  return (
    <>
      <Nav />
      <main id="main" className="lx-doc">
        <header className="lx-doc-head">
          <h1>Press kit</h1>
          <p>Everything you need to write about Daylens. Use any of it without asking.</p>
        </header>
        <div className="lx-prose">
          <h2>About Daylens</h2>
          <p>{DESCRIPTION}</p>
          <ul>
            <li>Platforms: Windows 11 through the Microsoft Store, and macOS as a signed download. Linux as a nightly build.</li>
            <li>
              License: MIT. Source code at <a href={GITHUB_URL}>{GITHUB_URL.replace("https://", "")}</a>.
            </li>
            <li>
              Website: <a href={SITE_URL}>{SITE_URL.replace("https://", "")}</a>
            </li>
            <li>
              Background: <a href={route("/devlog/why-we-are-rebuilding-daylens")}>Why we&rsquo;re rebuilding Daylens</a>
            </li>
          </ul>

          <h2>Logo</h2>
          <p>The app icon, 256 by 256 pixels, transparent PNG. Please don&rsquo;t recolor or crop it.</p>
          <div className="lx-logos">
            <figure>
              <img src={asset("/icons/app-icon.png")} alt="Daylens app icon" width={96} height={96} loading="lazy" />
              <figcaption>On light</figcaption>
            </figure>
            <figure className="is-dark">
              <img src={asset("/icons/app-icon.png")} alt="Daylens app icon on a dark background" width={96} height={96} loading="lazy" />
              <figcaption>On dark</figcaption>
            </figure>
          </div>
          <p>
            <a href={asset("/icons/app-icon.png")} download="daylens-icon.png">
              Download the icon (PNG)
            </a>
          </p>

          <h2>Contact</h2>
          <p>
            For interviews, early access or anything else: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </p>
        </div>
      </main>
      <Footer />
    </>
  );
}
