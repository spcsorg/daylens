import { withBasePath } from "@/app/lib/basePath";

export const SITE_ORIGIN = "https://christian-tonny.dev";
// Production always lives under /daylens, even when a page is rendered in dev without the basePath.
export const SITE_URL = `${SITE_ORIGIN}/daylens`;

export const SITE_TITLE = "Daylens: find anything you saw on your computer";
export const SITE_DESCRIPTION =
  "Daylens remembers which apps, windows and pages you used and writes your day as hours in plain words, so you and the AI you choose can find anything you saw and pick up where you left off. Your history is stored only on your computer.";

export const GITHUB_URL = "https://github.com/irachrist1/daylens";
export const CONTACT_EMAIL = "ctonny111@gmail.com";

export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path === "/" ? "" : path}`;
}

export function convexSiteUrl(): string | null {
  const cloudUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  if (!cloudUrl) return null;
  return cloudUrl.replace(/\.convex\.cloud\/?$/, ".convex.site");
}

export { withBasePath };
