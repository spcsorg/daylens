import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { route } from "../../../_v2/base";
import { Footer, Nav } from "../../_launch/Chrome";
import { docMetadata } from "../../_launch/doc";
import { POSTS, formatPostDate, getPost } from "../../_launch/posts";

export const dynamicParams = false;

export function generateStaticParams() {
  return POSTS.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const post = getPost((await params).slug);
  return post ? docMetadata(`/devlog/${post.slug}`, post.title, post.summary) : {};
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const post = getPost((await params).slug);
  if (!post) notFound();
  return (
    <>
      <Nav />
      <main id="main" className="lx-doc">
        <article>
          <header className="lx-doc-head">
            <p className="lx-doc-meta">
              <a href={route("/devlog")}>Devlog</a> · <time dateTime={post.date}>{formatPostDate(post.date)}</time>
            </p>
            <h1>{post.title}</h1>
          </header>
          <div className="lx-prose">
            {post.body.map((paragraph) => (
              <p key={paragraph.slice(0, 40)}>{paragraph}</p>
            ))}
          </div>
        </article>
      </main>
      <Footer />
    </>
  );
}
