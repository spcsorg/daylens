import type { Metadata } from "next";
import Link from "next/link";
import { assetPath } from "@/app/lib/basePath";
import { SiteFooter, SiteHeader } from "../_components/SiteChrome";
import { absoluteUrl } from "../_lib/site";
import { POSTS, formatPostDate } from "./posts";

export const metadata: Metadata = {
  title: "Devlog",
  description: "Notes from building Daylens 2: what we built, what we got wrong, and what we changed.",
  alternates: { canonical: absoluteUrl("/devlog") },
  openGraph: { title: "Daylens devlog", url: absoluteUrl("/devlog") },
};

export default function DevlogPage() {
  return (
    <>
      <SiteHeader current="devlog" />
      <main id="main" className="page">
        <header className="page-head">
          <h1>Devlog</h1>
          <p>Notes from building Daylens 2: what we built, what we got wrong, and what we changed.</p>
          <a className="rss-link" href={assetPath("/devlog/rss.xml")}>
            Follow by RSS
          </a>
        </header>
        <ol className="post-list" reversed>
          {POSTS.map((post) => (
            <li key={post.slug}>
              <time dateTime={post.date}>{formatPostDate(post.date)}</time>
              <h2>
                <Link href={`/devlog/${post.slug}`}>{post.title}</Link>
              </h2>
              <p>{post.summary}</p>
            </li>
          ))}
        </ol>
      </main>
      <SiteFooter />
    </>
  );
}
