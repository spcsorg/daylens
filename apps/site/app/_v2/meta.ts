import type { Metadata } from "next";
import { createElement } from "react";
import { asset } from "./base";
import { META, PLATFORMS } from "./copy";

export const ACTIVE_VARIANT = process.env.NEXT_PUBLIC_SITE_VARIANT ?? "";

const host = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? (host ? `https://${host}` : "http://localhost:3000");



const OG_IMAGE = { url: new URL(asset("/opengraph-image"), new URL(SITE_URL).origin).href, width: 1200, height: 630, alt: "Daylens" };

// Only the version served at "/" is indexed; the other six are review candidates.
export function pageMetadata(variant: string): Metadata {
  const active = variant === ACTIVE_VARIANT;
  // Absolute, because SITE_URL can carry a path (christian-tonny.dev/daylens) that a relative URL would drop.
  const path = active ? SITE_URL : `${SITE_URL}/${variant}`;
  return {
    metadataBase: new URL(SITE_URL),
    title: META.title,
    description: META.description,
    applicationName: "Daylens",
    alternates: { canonical: path },
    robots: active ? { index: true, follow: true } : { index: false, follow: false },
    icons: { icon: asset("/icons/daylens.png"), apple: asset("/icons/daylens.png") },
    openGraph: { type: "website", siteName: "Daylens", url: path, title: META.title, description: META.description, images: [OG_IMAGE] },
    twitter: { card: "summary_large_image", title: META.title, description: META.description, images: [OG_IMAGE.url] },
  };
}

const SCHEMA = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Daylens",
  description: META.description,
  applicationCategory: "ProductivityApplication",
  operatingSystem: PLATFORMS.replace(" and ", ", "),
  url: SITE_URL,
});

export function SiteSchema() {
  return createElement("script", { type: "application/ld+json", dangerouslySetInnerHTML: { __html: SCHEMA } });
}
