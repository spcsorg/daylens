import type { MetadataRoute } from "next";
import { withBasePath } from "./lib/basePath";
import { absoluteUrl } from "./(site)/_lib/site";

// Crawlers only read robots.txt at the domain root, so this file matters once Daylens has its own domain.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/dashboard", "/history", "/settings", "/chat", "/recap", "/apps", "/focus", "/link", "/recover"].map(
          withBasePath,
        ),
      },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
