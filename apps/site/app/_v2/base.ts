// Set when another site serves this page at its own path and loads this site's files from a prefix
// (christian-tonny.dev/daylens loads them from /daylens-waitlist).
export const ASSETS = process.env.NEXT_PUBLIC_ASSET_PATH ?? "";

export const asset = (p: string) => `${ASSETS}${p}`;

// The path pages are served under on that site (christian-tonny.dev/daylens/privacy). Links between pages use it.
export const ROUTES = process.env.NEXT_PUBLIC_ROUTE_BASE ?? "";

export const route = (p: string) => (p === "/" ? ROUTES || "/" : `${ROUTES}${p}`);
