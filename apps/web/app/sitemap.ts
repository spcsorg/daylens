import type { MetadataRoute } from "next";
import { POSTS } from "./(site)/devlog/posts";
import { absoluteUrl } from "./(site)/_lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const latestPost = POSTS[0]?.date;
  return [
    { url: absoluteUrl("/"), changeFrequency: "weekly", priority: 1 },
    { url: absoluteUrl("/privacy"), changeFrequency: "monthly", priority: 0.6 },
    { url: absoluteUrl("/devlog"), lastModified: latestPost, changeFrequency: "weekly", priority: 0.7 },
    ...POSTS.map((post) => ({
      url: absoluteUrl(`/devlog/${post.slug}`),
      lastModified: post.date,
      changeFrequency: "yearly" as const,
      priority: 0.5,
    })),
    { url: absoluteUrl("/press"), changeFrequency: "monthly", priority: 0.4 },
    { url: absoluteUrl("/changelog"), changeFrequency: "weekly", priority: 0.4 },
    { url: absoluteUrl("/docs"), changeFrequency: "monthly", priority: 0.4 },
  ];
}
