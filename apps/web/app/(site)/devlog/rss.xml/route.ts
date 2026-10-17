import { SITE_URL, absoluteUrl } from "../../_lib/site";
import { POSTS } from "../posts";

export const dynamic = "force-static";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function GET() {
  const items = POSTS.map((post) => {
    const url = absoluteUrl(`/devlog/${post.slug}`);
    const content = post.body.map((paragraph) => `<p>${escapeXml(paragraph)}</p>`).join("");
    return `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${new Date(`${post.date}T12:00:00Z`).toUTCString()}</pubDate>
      <description>${escapeXml(post.summary)}</description>
      <content:encoded><![CDATA[${content}]]></content:encoded>
    </item>`;
  }).join("\n");

  const feedUrl = absoluteUrl("/devlog/rss.xml");
  const lastBuild = POSTS[0] ? new Date(`${POSTS[0].date}T12:00:00Z`).toUTCString() : new Date(0).toUTCString();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Daylens devlog</title>
    <link>${absoluteUrl("/devlog")}</link>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml" />
    <description>Notes from building Daylens 2.</description>
    <language>en</language>
    <image>
      <url>${SITE_URL}/app-icon.png</url>
      <title>Daylens devlog</title>
      <link>${absoluteUrl("/devlog")}</link>
    </image>
    <lastBuildDate>${lastBuild}</lastBuildDate>
${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
