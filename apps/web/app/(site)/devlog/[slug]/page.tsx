import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "../../_components/SiteChrome";
import { OPEN_GRAPH_BASE, TWITTER_BASE, absoluteUrl } from "../../_lib/site";
import { POSTS, formatPostDate, getPost } from "../posts";

export const dynamicParams = false;

export function generateStaticParams() {
  return POSTS.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const post = getPost((await params).slug);
  if (!post) return {};
  const url = absoluteUrl(`/devlog/${post.slug}`);
  return {
    title: post.title,
    description: post.summary,
    alternates: { canonical: url },
    twitter: TWITTER_BASE,
    openGraph: { ...OPEN_GRAPH_BASE, type: "article", title: post.title, description: post.summary, url, publishedTime: post.date },
  };
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const post = getPost((await params).slug);
  if (!post) notFound();

  return (
    <>
      <SiteHeader current="devlog" />
      <main id="main" className="page">
        <article>
          <header className="page-head">
            <p className="page-meta">
              <Link href="/devlog">Devlog</Link> · <time dateTime={post.date}>{formatPostDate(post.date)}</time>
            </p>
            <h1>{post.title}</h1>
          </header>
          <div className="prose">
            {post.body.map((paragraph) => (
              <p key={paragraph.slice(0, 40)}>{paragraph}</p>
            ))}
          </div>
          <footer className="post-end">
            <p>
              <Link href="/#join" className="text-link">
                Join the beta waitlist
              </Link>
            </p>
            <p>
              <Link href="/devlog">All devlog posts</Link>
            </p>
          </footer>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
