import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "../_components/SiteChrome";
import { CONTACT_EMAIL, GITHUB_URL, OPEN_GRAPH_BASE, TWITTER_BASE, absoluteUrl } from "../_lib/site";

const UPDATED = "October 17, 2026";

export const metadata: Metadata = {
  title: "Privacy policy",
  description:
    "What Daylens records, where it is stored, what leaves your computer and when, and how you control it. Covers the Daylens desktop app, its browser extension and this website.",
  alternates: { canonical: absoluteUrl("/privacy") },
  openGraph: { ...OPEN_GRAPH_BASE, title: "Daylens privacy policy", url: absoluteUrl("/privacy") },
  twitter: TWITTER_BASE,
};

const SECTIONS = [
  ["short", "The short version"],
  ["records", "What Daylens records"],
  ["never", "What Daylens never records"],
  ["stored", "Where it is stored"],
  ["leaves", "What leaves your computer, and when"],
  ["controls", "Your controls"],
  ["extension", "The browser extension"],
  ["website", "This website and the waitlist"],
  ["security", "How it is kept safe"],
  ["sharing", "Who we share data with"],
  ["rights", "Your rights"],
  ["children", "Children"],
  ["changes", "Changes to this policy"],
  ["contact", "Contact"],
] as const;

export default function PrivacyPage() {
  return (
    <>
      <SiteHeader current="privacy" />
      <main id="main" className="page">
        <header className="page-head">
          <h1>Privacy policy</h1>
          <p>
            Your history is stored only on your computer. We never keep a copy. This page explains exactly what that
            means, and the few things that do leave your computer.
          </p>
          <p className="page-meta">
            Last updated {UPDATED}. This policy covers Daylens 2, starting with the beta in November 2026: the
            desktop app for Windows and macOS, the Daylens browser extension, and this website.
          </p>
        </header>

        <nav className="toc" aria-label="On this page">
          <p>On this page</p>
          <ol>
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`}>{label}</a>
              </li>
            ))}
          </ol>
        </nav>

        <article className="prose">
          <h2 id="short">The short version</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">What</th>
                  <th scope="col">Where it goes</th>
                  <th scope="col">Can you turn it off?</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Your history: apps, window titles, pages, times</td>
                  <td>Stays on your computer</td>
                  <td>Pause, exclude or delete any of it</td>
                </tr>
                <tr>
                  <td>An hour being written by AI, or a question in Ask</td>
                  <td>The AI provider you chose. With Daylens AI, it passes through our service without being stored</td>
                  <td>Yes. Choose no AI</td>
                </tr>
                <tr>
                  <td>What a connected assistant reads</td>
                  <td>That assistant, and its own AI service</td>
                  <td>Yes. Don&rsquo;t connect it, or disconnect it</td>
                </tr>
                <tr>
                  <td>Anonymous usage counts and error reports</td>
                  <td>Us, through our analytics service</td>
                  <td>Yes. Settings › Recording and privacy</td>
                </tr>
                <tr>
                  <td>Account, plan, usage counts and payments</td>
                  <td>Us, and the payment provider you pay through</td>
                  <td>Only if you sign in or buy a plan</td>
                </tr>
                <tr>
                  <td>Your waitlist email</td>
                  <td>Us</td>
                  <td>Ask us to remove it</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>We don&rsquo;t sell your data, and we don&rsquo;t use it for advertising.</p>

          <h2 id="records">What Daylens records</h2>
          <p>Daylens records on your computer, so that you and the AI you choose can find anything you saw:</p>
          <ul>
            <li>Which app is in front, and the titles of its windows.</li>
            <li>
              The pages you open in your browsers: their addresses and titles, read from your browsers&rsquo; history
              on your computer, and from the Daylens browser extension if you add it.
            </li>
            <li>When your computer is idle, locked or asleep.</li>
            <li>The time, and your time zone, for each of these.</li>
          </ul>
          <p>Only if you allow it:</p>
          <ul>
            <li>Your calendar events.</li>
            <li>
              Sessions from AI coding assistants that keep logs on your computer: which project folder, when each turn
              started and ended, and short selected excerpts. Full transcripts and command output are not stored.
            </li>
          </ul>
          <p>
            From this record, Daylens writes each hour in plain words and builds a search index, both on your
            computer. Anything you correct, and anything you tell Daylens about an hour, is stored with it.
          </p>

          <h2 id="never">What Daylens never records</h2>
          <ul>
            <li>Keystrokes, or anything you type.</li>
            <li>Screen images, video or audio.</li>
            <li>The contents of your files.</li>
            <li>Pages and titles from private and incognito browser windows.</li>
            <li>Anything in an app or site you&rsquo;ve excluded.</li>
          </ul>
          <p>
            When Daylens can&rsquo;t confirm that a browser window is a normal one, it records only that you used the
            browser, with no page or title. Daylens doesn&rsquo;t record guest browser profiles.
          </p>

          <h2 id="stored">Where it is stored</h2>
          <p>
            Everything Daylens records is stored in a database on your computer, inside your user account. There is
            no copy on our servers, and nothing is uploaded to back it up or sync it.
          </p>
          <p>
            If you turn on day notes, Daylens also saves each finished day as a readable file in a folder you choose.
            If you export, the export is saved where you put it.
          </p>
          <p>
            API keys and sign-in tokens are kept in your operating system&rsquo;s secure storage, never in the
            database or in logs.
          </p>

          <h2 id="leaves">What leaves your computer, and when</h2>

          <h3>When AI writes an hour or answers a question</h3>
          <p>
            If AI is on, Daylens sends the record of an hour (titles, addresses, app names and times) to write that
            hour, and the relevant hours to answer a question you ask. Nothing else is sent. Where it goes depends on
            your choice:
          </p>
          <ul>
            <li>
              <strong>Daylens AI.</strong> Each request passes through our service, which checks your plan, counts
              your usage and forwards it to the AI model provider that writes the answer. We don&rsquo;t store what
              you send or what comes back. We record only what the request was for (writing an hour or answering in
              Ask), what it cost and which plan it counted against.
            </li>
            <li>
              <strong>Your own key.</strong> Daylens sends the request straight from your computer to the provider
              you chose, under your agreement with them. It never touches our servers.
            </li>
            <li>
              <strong>An AI tool on your computer.</strong> Daylens runs a command-line AI tool you have installed,
              which sends the request to its own provider under your subscription. It never touches our servers.
            </li>
            <li>
              <strong>No AI.</strong> Nothing is sent. Hours stay as recorded facts and search still works.
            </li>
          </ul>

          <h3>When an assistant reads your days</h3>
          <p>
            You can connect AI assistants on your computer to Daylens. They read your days through a server that runs
            only on your computer and can only read, never change anything. What an assistant reads can be sent to
            that assistant&rsquo;s own AI service, under its own terms, and Daylens can&rsquo;t recall it afterwards.
            Daylens tells you this when you connect one, logs every read in Settings, and lets you disconnect any
            assistant at any time.
          </p>

          <h3>Anonymous usage counts and error reports</h3>
          <p>
            Usage analytics are on by default. They count which features are used and report errors, so we can tell
            what works and fix what breaks. When Daylens crashes or hits an error, the report says what went wrong
            inside Daylens, with the app version and operating system. Analytics never include window or page titles,
            addresses, file names, prompts or answers. Turn them off in Settings › Recording and privacy, and nothing
            more is sent.
          </p>

          <h3>Your account, plan and payments</h3>
          <p>
            You can use Daylens without paying. If you sign in or buy a plan, our billing service stores your account,
            your plan, your AI usage counts and your payment records. It never receives your history, prompts or
            answers.
          </p>
          <ul>
            <li>
              <strong>Card payments</strong> happen in Polar&rsquo;s hosted checkout. Your card number is entered
              there and never passes through Daylens.
            </li>
            <li>
              <strong>Mobile money</strong> payments go through Flutterwave, which sends a request to your phone that
              you approve with your PIN.
            </li>
          </ul>
          <p>
            Polar and Flutterwave process your payment details under their own privacy policies. They tell us whether
            a payment succeeded, failed, expired or was cancelled.
          </p>

          <h3>Updates</h3>
          <p>
            On Windows, the Microsoft Store installs Daylens and its updates. On macOS, Daylens checks for updates and
            downloads them. These requests carry the app version and platform, not your history.
          </p>

          <h2 id="controls">Your controls</h2>
          <ul>
            <li>
              <strong>Pause</strong> for an hour, until tomorrow, or until you resume, from the tray or menu bar menu
              or Settings. Nothing is recorded while paused.
            </li>
            <li>
              <strong>Exclusions.</strong> Leave out any app or site. Exclusions apply before anything is stored, so an
              excluded app or site leaves only a gap marked &ldquo;excluded&rdquo;. Password managers and banking are
              excluded from the start.
            </li>
            <li>
              <strong>Private windows</strong> are always skipped. There is no setting that records them.
            </li>
            <li>
              <strong>Retention.</strong> Choose how long your history is kept.
            </li>
            <li>
              <strong>Delete</strong> the last ten minutes, an hour, a day, a range, or everything. Deleting reaches
              every copy on your computer: the record, the written hours, the search index, answers in Ask that used
              it, and day notes. Deleted material is never imported again.
            </li>
            <li>
              <strong>Remove a source.</strong> Remove one page or file from a day, and optionally never record that
              site again.
            </li>
            <li>
              <strong>AI.</strong> Switch between Daylens AI, your own key, an AI tool on your computer, or none.
            </li>
            <li>
              <strong>Assistants.</strong> See what each one read, and disconnect any of them.
            </li>
            <li>
              <strong>Usage analytics.</strong> Turn them off in Settings › Recording and privacy.
            </li>
          </ul>

          <h2 id="extension">The browser extension</h2>
          <p>
            The Daylens browser extension is optional and is available for Chrome, Edge and Firefox. It lets Daylens
            know exactly which page you were on, so your hours and search show the right pages.
          </p>
          <h3>What it collects</h3>
          <ul>
            <li>
              The address and title of the tab you&rsquo;re looking at, in the browser window that has focus, when it
              changes.
            </li>
            <li>When you switch tabs or windows, and when focus moves away from the browser.</li>
          </ul>
          <p>
            This is browsing activity (web history). The extension doesn&rsquo;t read page contents, form fields,
            passwords, cookies or your browser history, and it has no access to the pages themselves.
          </p>
          <h3>Where it goes</h3>
          <p>
            Only to the Daylens app on the same computer. On macOS and Linux it uses the browser&rsquo;s native
            messaging. On Windows it connects to Daylens on your computer (<code>127.0.0.1</code>) after you pair the
            browser once, and both sides prove they hold the pairing secret before anything is sent. The extension
            never sends data to us or to anyone else.
          </p>
          <h3>Private windows</h3>
          <p>
            The extension is not allowed to run in private or incognito windows, so it never sees them.
          </p>
          <h3>Permissions</h3>
          <ul>
            <li>
              <code>tabs</code>: to read the address and title of the focused tab.
            </li>
            <li>
              <code>nativeMessaging</code>: to talk to the Daylens app on your computer.
            </li>
            <li>
              Access to <code>127.0.0.1</code>, only where a browser needs it for the Windows connection.
            </li>
          </ul>
          <h3>Your controls</h3>
          <p>
            The extension&rsquo;s popup shows whether it&rsquo;s connected and lets you pause it for that browser.
            Remove the extension at any time. What it reported is part of your history in Daylens, so every Daylens
            control above applies to it. On Firefox, the extension asks for your consent to share browsing activity
            with Daylens before it starts.
          </p>
          <p>
            The use of information received from the extension adheres to the Chrome Web Store User Data Policy,
            including the Limited Use requirements. It is used only to show your own history to you in Daylens. It is
            not sold, not used for advertising or creditworthiness, and not read by people.
          </p>

          <h2 id="website">This website and the waitlist</h2>
          <p>
            The public pages of this website don&rsquo;t use analytics or advertising cookies. Our hosting provider
            keeps standard request logs, such as IP address, browser and the page requested, to run and protect the
            site.
          </p>
          <p>
            If you join the waitlist, we store your email address, when you joined, which form you used, and whether
            you picked Windows or Mac. We use it only to invite you to the beta and to write to you about it. To stop
            abuse, the form counts sign-ups from each network address for an hour; those counts, which include the IP
            address, are deleted within two hours. We keep your waitlist email until you ask us to remove it.
          </p>

          <h2 id="security">How it is kept safe</h2>
          <ul>
            <li>
              Your history stays on your computer, in your user account. Anyone who can sign in to that account can
              read it, so turn on your computer&rsquo;s disk encryption to protect it if the computer is lost.
            </li>
            <li>API keys and sign-in tokens live in your operating system&rsquo;s secure storage.</li>
            <li>
              Text Daylens captures, such as page titles, is treated as untrusted. The AI that writes your hours has no
              tools and can take no actions, and what it writes is checked before it is stored.
            </li>
            <li>
              Releases are signed: by the Microsoft Store on Windows, and with a notarized Developer ID on macOS.
              Updates are verified before they install.
            </li>
            <li>Card numbers are entered only in the payment provider&rsquo;s checkout.</li>
            <li>
              Daylens is open source under the MIT license, so anyone can check what it does:{" "}
              <a href={GITHUB_URL}>{GITHUB_URL.replace("https://", "")}</a>.
            </li>
          </ul>

          <h2 id="sharing">Who we share data with</h2>
          <p>We share data only with the services that run Daylens for you:</p>
          <ul>
            <li>The AI model provider behind Daylens AI, for the requests described above, when you use Daylens AI.</li>
            <li>Polar and Flutterwave, for payments you make.</li>
            <li>Our analytics service, for anonymous usage counts and error reports, unless you turn them off.</li>
            <li>The services that host our website, waitlist and billing service.</li>
          </ul>
          <p>
            We may disclose information if the law requires it. Your history isn&rsquo;t on our servers, so we
            can&rsquo;t hand it over.
          </p>

          <h2 id="rights">Your rights</h2>
          <p>
            Your history is on your computer, so you can see, export and delete it yourself at any time. For anything
            we hold (your account, plan, payment records and waitlist email), you can ask to see it, correct it,
            export it or delete it by emailing <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. We keep billing
            records for as long as your account exists, and longer only where tax or payment law requires it.
          </p>

          <h2 id="children">Children</h2>
          <p>
            Daylens is not meant for children under 13, or under the minimum age for this kind of service where you
            live. We don&rsquo;t knowingly collect information from them. If you think a child has given us their
            information, email us and we&rsquo;ll delete it.
          </p>

          <h2 id="changes">Changes to this policy</h2>
          <p>
            When this policy changes, we update the date at the top of this page. We describe material changes in the{" "}
            <Link href="/devlog">devlog</Link> before they take effect.
          </p>

          <h2 id="contact">Contact</h2>
          <p>
            Questions about privacy, or a request about your data: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
          </p>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
