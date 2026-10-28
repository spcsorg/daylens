import type { MetadataRoute } from "next";
import { SITE_URL } from "./_v2/meta";

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/", disallow: "/api/" }, sitemap: `${SITE_URL}/sitemap.xml` };
}
