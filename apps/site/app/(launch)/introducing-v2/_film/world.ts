import { asset } from "../../../_v2/base";

// One invented Tuesday: the spring pricing memo, the Q2 budget and a design sync. Nothing here is a real day.

const icon = (name: string) => asset(`/introducing-v2/${name}.png`);

export const APPS = {
  chrome: icon("chrome"),
  notion: icon("notion"),
  zoom: icon("zoom"),
  mail: icon("mail"),
  messages: icon("messages"),
  claude: icon("claude"),
  cursor: icon("cursor"),
};

export type Hour = { at: string; title: string; line: string; apps: string[]; now?: boolean; away?: boolean; raw?: string[] };

export const DAY_TITLE = "Tuesday, 14 April";

export const HOURS: Hour[] = [
  {
    at: "9 AM",
    title: "Answered the Thursday review notes",
    line: "Read the comments in Google Docs and replied in Mail.",
    apps: [APPS.chrome, APPS.mail],
    raw: ["Review notes – Google Docs", "Re: Thursday review – Mail"],
  },
  {
    at: "10 AM",
    title: "Drafted the spring pricing memo",
    line: "Wrote the first two sections in Google Docs and checked last year’s numbers in Sheets.",
    apps: [APPS.chrome, APPS.notion],
    raw: ["Spring pricing memo – Google Docs", "Q2 budget – Google Sheets", "Pricing research – Notion"],
  },
  {
    at: "11 AM",
    title: "Design sync, then fixes to the pricing page",
    line: "Forty minutes in Zoom with the design team, then edits to the page in Chrome.",
    apps: [APPS.zoom, APPS.chrome],
    raw: ["Design sync – Zoom", "Pricing page v3 – Chrome"],
  },
  { at: "12 PM", title: "Away from the computer", line: "", apps: [], away: true },
  {
    at: "1 PM",
    title: "Sent invoice 1042, then back on the memo",
    line: "Replied to Harbor Studio in Mail and finished the pricing section.",
    apps: [APPS.mail, APPS.chrome],
    raw: ["Invoice 1042 – Mail", "Spring pricing memo – Google Docs"],
  },
  {
    at: "2 PM",
    title: "Chrome · Claude",
    line: "Pricing tiers draft – Claude, Recording now",
    apps: [APPS.chrome, APPS.claude],
    now: true,
    raw: ["Pricing tiers draft – Claude"],
  },
];

export const MORNING_SUMMARY = "Five hours since 9 AM, most of it on the spring pricing memo.";

export const OPEN_HOUR = {
  range: "10 to 11 AM",
  title: "Chrome · Notion",
  pages: [
    { title: "Spring pricing memo – Google Docs", host: "docs.google.com", min: "24 min", icon: APPS.chrome },
    { title: "Q2 budget – Google Sheets", host: "docs.google.com", min: "9 min", icon: APPS.chrome },
    { title: "Per-seat or usage pricing? – Kestrel", host: "kestrel.dev", min: "7 min", icon: APPS.chrome },
    { title: "Hacker News", host: "news.ycombinator.com", min: "6 min", icon: APPS.chrome },
  ],
  windows: [{ title: "Pricing research", host: "Notion", min: "15 min", icon: APPS.notion }],
};

type Block = { col: number; start: number; len: number; label: string };

// Week grid: col 0 is Monday, start is hours after 8 AM.
const block = (col: number, start: number, label: string, len = 1): Block => ({ col, start, len, label });
export const LAST_WEEK = {
  title: "6 to 12 April",
  days: ["Mon 6", "Tue 7", "Wed 8", "Thu 9", "Fri 10", "Sat 11", "Sun 12"],
  blocks: [
    block(0, 1, "Mail · Chrome"), block(0, 2, "Chrome · Notion"), block(0, 3, "Design sync"), block(0, 5, "Chrome · Mail"), block(0, 6, "Cursor · Claude"), block(0, 7, "Cursor"), block(0, 8, "Chrome"),
    block(1, 0, "Chrome"), block(1, 1, "Mail"), block(1, 2, "Chrome · Notion", 2), block(1, 5, "Zoom · Chrome"), block(1, 6, "Cursor · Claude"), block(1, 7, "Cursor · Chrome"),
    block(2, 1, "Mail · Chrome"), block(2, 2, "Cursor · Claude", 2), block(2, 4, "Cursor"), block(2, 6, "Zoom"), block(2, 7, "Chrome · Mail"),
    block(3, 1, "Chrome · Mail"), block(3, 2, "Chrome · Notion"), block(3, 3, "Zoom · Chrome"), block(3, 5, "Chrome · Notion", 2), block(3, 7, "Mail"),
    block(4, 1, "Mail"), block(4, 2, "Chrome · Sheets"), block(4, 3, "Chrome"), block(4, 5, "Zoom"), block(4, 6, "Chrome · Mail"),
    block(5, 2, "Chrome · Spotify"), block(5, 3, "Chrome"),
  ],
  total: "27h 05m",
  byApp: [
    { app: "Chrome", time: "11h 40m", share: 0.43 },
    { app: "Cursor", time: "5h 50m", share: 0.215 },
    { app: "Mail", time: "3h 10m", share: 0.117 },
    { app: "Zoom", time: "2h 20m", share: 0.086 },
    { app: "Other", time: "4h 05m", share: 0.152 },
  ],
};

export const THIS_WEEK = {
  title: "13 to 19 April",
  days: ["Mon 13", "Tue 14", "Wed 15", "Thu 16", "Fri 17", "Sat 18", "Sun 19"],
  blocks: [
    block(0, 1, "Mail · Chrome"), block(0, 2, "Chrome · Sheets"), block(0, 3, "Chrome · Notion"), block(0, 5, "Zoom"), block(0, 6, "Cursor · Claude", 2), block(0, 8, "Chrome"),
    block(1, 1, "Mail · Chrome"), block(1, 2, "Chrome · Notion"), block(1, 3, "Zoom · Chrome"), block(1, 5, "Mail · Chrome"), block(1, 6, "Chrome · Claude"),
  ],
};

// April 2026 starts on a Wednesday; Daylens was set up on Monday the 6th.
export const MONTH = {
  title: "April 2026",
  lead: [30, 31],
  days: Array.from({ length: 30 }, (_, i) => i + 1),
  totals: {
    6: ["6h 40m", "Chrome, Mail"],
    7: ["7h 05m", "Chrome, Cursor"],
    8: ["6h 15m", "Cursor, Claude"],
    9: ["5h 50m", "Chrome, Notion"],
    10: ["4h 30m", "Chrome, Zoom"],
    11: ["1h 10m", "Chrome"],
    13: ["6h 55m", "Chrome, Mail"],
    14: ["5h 05m", "Chrome, Zoom"],
  } as Record<number, [string, string]>,
  total: "43h 30m",
};

export const SEARCH = {
  query: "the pricing memo from monday",
  pages: [
    { title: "Spring pricing memo – Google Docs", meta: "Chrome · Monday 10:14 AM", hour: "In 10 AM: Chrome · Notion", icon: APPS.chrome },
    { title: "Pricing memo comments", meta: "Mail · Monday 4:02 PM", hour: "In 4 PM: Mail · Chrome", icon: APPS.mail },
    { title: "Pricing research", meta: "Notion · Monday 10:40 AM", hour: "In 10 AM: Chrome · Notion", icon: APPS.notion },
  ],
  hours: [
    { title: "Chrome · Notion", meta: "Hour · Monday 10 AM" },
    { title: "Mail · Chrome", meta: "Hour · Monday 4 PM" },
  ],
};

export const ASK = {
  question: "what was that site about pricing I looked at on Tuesday?",
  answer:
    "Kestrel’s post on per-seat versus usage pricing. You read it Tuesday morning while drafting the spring pricing memo, then went back to it after lunch for the pricing tiers.",
  page: { title: "Per-seat or usage pricing? – Kestrel", host: "kestrel.dev/blog/per-seat-or-usage", icon: APPS.chrome },
  hours: [
    { at: "Tue 10 AM", title: "Drafted the spring pricing memo", line: "Wrote the first two sections in Google Docs.", apps: [APPS.chrome, APPS.notion] },
    { at: "Tue 2 PM", title: "Pricing tiers with Claude", line: "Drafted three tiers in Claude, with the Kestrel post open.", apps: [APPS.chrome, APPS.claude] },
  ],
};

export const PRIVACY =
  "The record stays on this computer. With AI on, only the hour being written (with a little context from the hours around it), or the excerpts a question needs, go to the AI provider you pick.";

export const WAITLIST_URL = "christian-tonny.dev/daylens";
