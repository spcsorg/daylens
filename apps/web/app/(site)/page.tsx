import type { Metadata } from "next";
import Link from "next/link";
import { MAC_DOWNLOAD_HREF, WINDOWS_DOWNLOAD_HREF } from "@/app/lib/platformLinks";
import { Rail } from "./_components/Rail";
import { SiteFooter, SiteHeader } from "./_components/SiteChrome";
import { WaitlistForm } from "./_components/WaitlistForm";
import { GITHUB_URL, SITE_DESCRIPTION, SITE_TITLE, SITE_URL } from "./_lib/site";

export const metadata: Metadata = {
  title: { absolute: SITE_TITLE },
  description: SITE_DESCRIPTION,
  alternates: { canonical: SITE_URL },
  openGraph: {
    title: "Find anything you saw on your computer. Pick up where you left off.",
    description:
      "Daylens writes your day as hours in plain words and keeps it on your computer. Beta for Windows and Mac from November.",
    url: SITE_URL,
  },
  twitter: {
    title: "Find anything you saw on your computer. Pick up where you left off.",
    description: "Daylens writes your day as hours in plain words and keeps it on your computer.",
  },
};

const BELIEFS = [
  {
    line: "Your computer already saw your day.",
    detail: "You shouldn't have to remember it twice, or explain it to an AI from the start every time.",
  },
  {
    line: "Your history belongs on your computer.",
    detail: "Daylens keeps it there. We never keep a copy.",
  },
  {
    line: "Plain words beat charts.",
    detail: "Your day should read the way you'd tell it: what you worked on, what you finished, where you stopped.",
  },
  {
    line: "Never claim more than it saw.",
    detail: "Opening a file isn't finishing it. When Daylens can't tell what happened, it says so.",
  },
];

const STEPS = [
  {
    title: "Install it.",
    body: "Get it from the Microsoft Store on Windows 11, or download it for Mac. On a Mac it asks for one permission, with one button.",
  },
  {
    title: "Use your computer as usual.",
    body: "Daylens notes which apps, windows and pages you use, and writes each hour in plain words once it ends. It never records what you type or what's on your screen.",
  },
  {
    title: "Find it, or pick it up.",
    body: "Search the way you remember things, ask a question, or open the last thing you were doing. Every result opens the page, file or window itself.",
  },
];

const PROMISES = [
  {
    title: "Stays on your computer",
    body: "Your history lives in a database on your computer. Nothing is uploaded to keep it.",
  },
  {
    title: "Never what you type",
    body: "No keystrokes, no screen images, no audio and no file contents.",
  },
  {
    title: "Private windows are skipped",
    body: "Pages and titles from private and incognito windows are never recorded.",
  },
  {
    title: "You decide what it sees",
    body: "Pause it for an hour or until tomorrow. Leave out any app or site before anything is stored. Password managers and banking are left out from the start.",
  },
  {
    title: "Delete anything",
    body: "The last ten minutes, an hour, a day, or everything. Deleted material is gone from search and from answers too.",
  },
  {
    title: "Works without the internet",
    body: "Turn off the internet and Daylens keeps recording, searching and showing your day. Only AI writing needs a connection.",
  },
];

const AI_CHOICES = [
  { title: "Daylens AI", body: "Built in and on from the start." },
  { title: "Your own key", body: "Your account with an AI provider, billed by them." },
  { title: "An AI tool on your computer", body: "A command-line assistant you already pay for." },
  { title: "No AI", body: "Hours stay as plain facts, and search still finds everything." },
];

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Daylens",
  url: SITE_URL,
  description: SITE_DESCRIPTION,
  applicationCategory: "ProductivityApplication",
  operatingSystem: "Windows 11, macOS",
  license: "https://opensource.org/licenses/MIT",
  sameAs: [GITHUB_URL],
};

export default function LandingPage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title">Find anything you saw on your computer. Pick up where you left off.</h1>
            <p className="hero-lede">
              Daylens remembers the apps, windows and pages you use and writes your day as hours in plain words. It
              all stays on your computer.
            </p>
            <WaitlistForm source="hero" />
            <p className="hero-meta">Beta for Windows 11 and Mac. Invites go out in waves from November.</p>
          </div>
          <Rail />
          <p className="rail-caption">An example morning. Daylens writes yours from what you actually did.</p>
        </section>

        <section className="section beliefs" aria-labelledby="beliefs-title">
          <h2 id="beliefs-title">What we believe</h2>
          <ul className="belief-list">
            {BELIEFS.map((belief) => (
              <li key={belief.line}>
                <p className="belief-line">{belief.line}</p>
                <p className="belief-detail">{belief.detail}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="section how" id="how" aria-labelledby="how-title">
          <h2 id="how-title">How it works</h2>
          <ol className="steps">
            {STEPS.map((step) => (
              <li key={step.title}>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="section trust" id="privacy" aria-labelledby="trust-title">
          <div className="check">
            <h2 id="trust-title">Your history is stored only on your computer. We never keep a copy.</h2>
            <dl className="check-lines">
              {PROMISES.map((promise) => (
                <div key={promise.title}>
                  <dt>{promise.title}</dt>
                  <dd>{promise.body}</dd>
                </div>
              ))}
              <div>
                <dt>Open source</dt>
                <dd>
                  Every line is public under the MIT license. <a href={GITHUB_URL}>Check it yourself</a>.
                </dd>
              </div>
            </dl>
            <div className="check-foot">
              <h3>When AI writes your hours</h3>
              <p>
                With Daylens AI, each hour passes through our service to the AI provider so it can be written. We
                don&rsquo;t store it. With your own key or an AI tool on your computer, it goes straight from your
                computer to that provider and never touches our servers. With no AI, it never leaves your computer.
              </p>
              <p>
                Anonymous usage counts are on by default, and you can turn them off in Settings. They never include
                titles, addresses, prompts or answers.
              </p>
              <p>
                <Link href="/privacy" className="text-link">
                  Read the privacy policy
                </Link>
              </p>
            </div>
          </div>
        </section>

        <section className="section ai" aria-labelledby="ai-title">
          <h2 id="ai-title">Use any AI, or none.</h2>
          <dl className="ai-choices">
            {AI_CHOICES.map((choice) => (
              <div key={choice.title}>
                <dt>{choice.title}</dt>
                <dd>{choice.body}</dd>
              </div>
            ))}
          </dl>
          <p className="ai-assistants">
            The AI assistants you already use can read your days too, once you connect them, so a new chat starts
            from your day instead of from zero. They can only read. What an assistant reads goes to that
            assistant&rsquo;s own service, so you choose which ones to connect.
          </p>
        </section>

        <section className="section join" id="join" aria-labelledby="join-title">
          <div className="join-inner">
            <h2 id="join-title">Join the beta.</h2>
            <p>
              Email only. Invites go out in waves starting in November, on Windows and Mac, and people on this list
              get V2 first.
            </p>
            <WaitlistForm source="closing" />
            <dl className="channels">
              <div>
                <dt>Nightly</dt>
                <dd>Open to anyone. Rough edges included.</dd>
              </div>
              <div>
                <dt>Beta</dt>
                <dd>This list, invited in waves from November.</dd>
              </div>
              <div>
                <dt>Stable</dt>
                <dd>For everyone, after the beta.</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="section today" aria-label="The current version">
          <p>
            Using Daylens today? The current version is still here:{" "}
            <a href={WINDOWS_DOWNLOAD_HREF}>Windows</a>, <a href={MAC_DOWNLOAD_HREF}>Mac</a>,{" "}
            <Link href="/changelog">changelog</Link> and <Link href="/docs">docs</Link>.
          </p>
        </section>
      </main>
      <SiteFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />
    </>
  );
}
