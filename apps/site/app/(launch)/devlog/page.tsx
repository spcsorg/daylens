import type { Metadata } from "next";
import { route } from "../../_v2/base";
import { Footer, Nav } from "../_launch/Chrome";
import { docMetadata } from "../_launch/doc";
import { POSTS, formatPostDate } from "../_launch/posts";

const INTRO = "Notes from building Daylens 2: what we built, what we got wrong, and what we changed.";

export const metadata: Metadata = docMetadata("/devlog", "Daylens devlog", INTRO);

export default function DevlogPage() {
  return (
    <>
      <Nav />
      <main id="main" className="lx-doc">
        <header className="lx-doc-head">
          <h1>Devlog</h1>
          <p>{INTRO}</p>
        </header>
        <ol className="lx-posts">
          {POSTS.map((post) => (
            <li key={post.slug}>
              <a href={route(`/devlog/${post.slug}`)}>
                <time dateTime={post.date}>{formatPostDate(post.date)}</time>
                <span className="lx-post-title">{post.title}</span>
                <span className="lx-post-summary">{post.summary}</span>
              </a>
            </li>
          ))}
        </ol>
      </main>
      <Footer />
    </>
  );
}
