import { ICONS } from "../../_v2/day";

// The day runs 8 AM to 4 PM; every time below is minutes after 8 AM.
export const DAY_START_HOUR = 8;
export const DAY_MINUTES = 8 * 60;
export const DATE = "Wednesday, 3 June";

export const HOUR_LABELS = ["8 AM", "9 AM", "10 AM", "11 AM", "12 PM", "1 PM", "2 PM", "3 PM", "4 PM"];

export type Block = { id: string; start: number; end: number; title: string; icons: string[]; match?: boolean };

export const BLOCKS: Block[] = [
  { id: "menu", start: 0, end: 52, title: "Published the autumn menu on the website and Instagram", icons: [ICONS.youtube, ICONS.chrome, ICONS.instagram] },
  { id: "font", start: 62, end: 100, title: "Checked the Instagram post, then picked a font", icons: [ICONS.instagram, ICONS.reddit, ICONS.googleFonts] },
  { id: "fx", start: 182, end: 204, title: "Converted the supplier invoice to euros", icons: [ICONS.chrome] },
  { id: "form", start: 240, end: 408, title: "Built the order form for the bakery site", icons: [ICONS.cursor, ICONS.chrome], match: true },
  { id: "call", start: 420, end: 458, title: "Called the payment provider about the order form", icons: [ICONS.chrome], match: true },
];

export type Event = { start: number; end: number; title: string };

export const CALENDAR: Event[] = [
  { start: 90, end: 120, title: "Flour delivery" },
  { start: 180, end: 210, title: "Coffee with Amara" },
  { start: 300, end: 360, title: "Lunch" },
  { start: 420, end: 450, title: "Payment provider call" },
];

// What the computer reported, in order. `block` is where each line ends up; a line with none drops out.
export type Raw = { at: string; icon: string | null; text: string; block: string | null };

export const RAW: Raw[] = [
  { at: "08:02", icon: ICONS.youtube, text: "Spiced pear tart, start to finish · YouTube", block: "menu" },
  { at: "08:14", icon: ICONS.chrome, text: "Brightside Bakery · Site editor", block: "menu" },
  { at: "08:37", icon: ICONS.instagram, text: "New post · Instagram", block: "menu" },
  { at: "09:04", icon: ICONS.instagram, text: "brightsidebakery · Instagram", block: "font" },
  { at: "09:21", icon: ICONS.reddit, text: "Which font for a bakery menu? · r/typography", block: "font" },
  { at: "09:33", icon: ICONS.googleFonts, text: "Browse fonts · Google Fonts", block: "font" },
  { at: "10:12", icon: null, text: "Screen locked", block: null },
  { at: "11:03", icon: ICONS.chrome, text: "RWF to EUR · Currency converter", block: "fx" },
  { at: "12:01", icon: ICONS.cursor, text: "order-form.tsx · brightside-site", block: "form" },
  { at: "12:04", icon: ICONS.chrome, text: "Brightside Bakery · Order form", block: "form" },
  { at: "13:12", icon: ICONS.cursor, text: "checkout.ts · brightside-site", block: "form" },
  { at: "14:40", icon: ICONS.chrome, text: "Test cards · Payments docs", block: "form" },
  { at: "15:02", icon: ICONS.chrome, text: "Support call · Payment provider", block: "call" },
];

export const ASK = {
  question: "where did i leave the order form",
  answer: "In checkout.ts in Cursor at 1:12 PM. You tested cards in the payments docs at 2:40, then called the payment provider at 3.",
};

export const ASSISTANTS = [
  { icon: ICONS.claude, name: "Claude", asks: "What did I finish today?" },
  { icon: ICONS.codex, name: "Codex", asks: "Where is the order form code?" },
  { icon: ICONS.cursor, name: "Cursor", asks: "What was I doing at noon?" },
];

export const STEPS = [
  "This is what your laptop did on Wednesday.",
  "Daylens turns it into a calendar of what you actually did.",
  "Next to what your calendar said you would do.",
  "Ask about any day. The answer shows the hours it came from.",
  "Claude, ChatGPT, Codex and Cursor can read it too.",
];

export const COPY = {
  title: "A calendar of what you did.",
  sub: "Daylens records the apps, windows and pages you use and turns them into a calendar of what you did, one you can ask anything.",
  email: "What's your email?",
  join: "Join the waitlist",
  joining: "Joining",
  done: "You're on the list. Check your inbox for a welcome email.",
  essay: [
    "Most work now happens on a computer, spread across a browser, a handful of apps and dozens of windows. By Friday it is hard to say what Tuesday was, and the assistants you work with know even less.",
    "Daylens keeps that record for you. Search it the way you remember things, ask about any day and get answers that point to the pages and windows they used, or see how long you spent in each app.",
    "When a block is wrong, rewrite it and your version sticks.",
  ],
  records: { title: "What it records", items: ["The apps you use and their window titles", "Pages you visit in normal browser windows", "When your computer is idle, locked or asleep", "Your commits, and when your Claude Code and Codex sessions ran"] },
  never: {
    title: "What it never records",
    items: ["Screenshots or audio, unless you turn them on", "Keystrokes or anything you type", "File contents", "Private and incognito windows"],
  },
  local:
    "The record stays on this computer. With AI on, only the hour being written (with a little context from the hours around it), or the excerpts a question needs, go to the AI provider you pick. Pause recording or delete any of it, from one page up to everything, and choose apps and sites to keep out before recording starts. The beta sends no usage analytics.",
  ai: "You choose the AI: in the beta, your own API key or no AI at all. What an assistant reads can go to its own AI service.",
  closing: "Daylens V2 is coming.",
  platforms: "Beta available early November, open source on GitHub.",
  platform: "Your computer",
  platformChoices: [
    { value: "mac", label: "Mac" },
    { value: "windows", label: "Windows" },
    { value: "linux", label: "Linux" },
  ],
  copyright: "© 2026 Daylens",
};
