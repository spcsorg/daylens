import type { MetadataRoute } from "next";
import { SITE_URL } from "./_v2/meta";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: SITE_URL, changeFrequency: "weekly", priority: 1 }];
}
