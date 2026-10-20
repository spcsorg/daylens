import type { Metadata } from "next";
import { asset } from "../../_v2/base";
import { SITE_URL } from "../../_v2/meta";

const OG = new URL(asset("/opengraph-image"), new URL(SITE_URL).origin).href;

// Metadata for the reading pages around the launch page; each one is indexed at its own canonical address.
export function docMetadata(path: string, title: string, description: string): Metadata {
  const url = `${SITE_URL}${path}`;
  return {
    metadataBase: new URL(SITE_URL),
    title,
    description,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    icons: { icon: asset("/icons/daylens.png"), apple: asset("/icons/daylens.png") },
    openGraph: { type: "article", siteName: "Daylens", url, title, description, images: [{ url: OG, width: 1200, height: 630, alt: "Daylens" }] },
    twitter: { card: "summary_large_image", title, description, images: [OG] },
  };
}
