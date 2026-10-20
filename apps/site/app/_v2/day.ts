// Invented day from the Figma file: a bakery owner's Wednesday, 14 October. Pages show it without an "example" label.

export const ICONS = {
  chrome: "/icons/chrome.svg",
  youtube: "/icons/youtube.png",
  instagram: "/icons/instagram.svg",
  reddit: "/icons/reddit.svg",
  googleFonts: "/icons/google-fonts.svg",
  cursor: "/icons/cursor.png",
  claude: "/icons/claude.png",
  codex: "/icons/codex.png",
  daylens: "/icons/daylens.png",
} as const;

export const SCREENS = {
  today: { src: "/screens/today-hour-open-window.png", w: 2244, h: 1444, alt: "Example day in Daylens: Wednesday, 14 October, with the 8 AM hour open, its sources, and a Fix this hour button" },
  ask: { src: "/screens/ask-answer-window.png", w: 2244, h: 1444, alt: "Daylens answering where did i leave the order form, with the pages, windows and hours it used" },
  assistants: { src: "/screens/assistants-connected-window.png", w: 2244, h: 1444, alt: "Claude, Codex and Cursor connected to Daylens, each able to read your days" },
  morning: { src: "/screens/morning-remembered-window.png", w: 2244, h: 1444, alt: "Example morning in Daylens: four hours, each described in one line" },
  // Its heading uses retired wording; crop to the search box or rebuild the search UI in HTML instead of showing it whole.
  find: { src: "/screens/find-it-window.png", w: 2244, h: 1444, alt: "Daylens search finding the page Sourdough hydration, explained, from last night" },
} as const;

export const DAY = { label: "Wednesday, 14 October", short: "Wed 14 Oct" };

export type Hour = {
  time: string;
  title: string;
  detail?: string;
  icons: string[];
  edited?: boolean;
  quiet?: boolean;
  sources?: { icon: string; name: string; meta: string }[];
};

export const HOURS: Hour[] = [
  {
    time: "8 AM",
    title: "Published the Brightside autumn menu on the website and Instagram",
    detail: "A baking video on YouTube, then the Brightside Bakery site and Instagram.",
    icons: [ICONS.youtube, ICONS.chrome, ICONS.instagram],
    edited: true,
    sources: [
      { icon: ICONS.chrome, name: "Brightside Bakery · Site editor", meta: "Page in Chrome · 8 AM" },
      { icon: ICONS.instagram, name: "Instagram", meta: "Page in Chrome · 8 AM" },
    ],
  },
  {
    time: "9 AM",
    title: "Checked the Instagram post, then picked a font on Reddit",
    detail: "Your Instagram post, then Reddit and Google Fonts.",
    icons: [ICONS.instagram, ICONS.reddit, ICONS.googleFonts],
  },
  { time: "10 AM", title: "No browser pages found for this hour", icons: [], quiet: true },
  { time: "11 AM", title: "Used a currency converter", detail: "One page in Chrome.", icons: [ICONS.chrome] },
  {
    time: "12 PM",
    title: "Built the Brightside order form",
    detail: "The brightside-site project in Cursor, and the order form page in Chrome.",
    icons: [ICONS.cursor, ICONS.chrome],
  },
  {
    time: "3 PM",
    title: "Called the payment provider about the order form",
    icons: [ICONS.cursor, ICONS.chrome],
  },
];

// The 8 AM hour before and after Fix this hour.
export const FIX = {
  before: "Watched a baking video, then edited the Brightside menu",
  after: "Published the Brightside autumn menu on the website and Instagram",
};

export const SEARCH = {
  query: "that sourdough hydration thing i read last night",
  result: { icon: ICONS.chrome, name: "Sourdough hydration, explained", meta: "Page in Chrome · Last night, 12:04 AM" },
};

export const ASK = {
  question: "where did i leave the order form",
  answer:
    "You left the Brightside order form in Cursor around 3 PM on Wednesday 14 October, right after a call with the payment provider. One test order still needs to go all the way through.",
  pages: [
    { icon: ICONS.cursor, name: "brightside-site", meta: "Window in Cursor · Wed 14 Oct, 12–3 PM" },
    { icon: ICONS.chrome, name: "Brightside Bakery · Order form", meta: "Page in Chrome · Wed 14 Oct, 12:04 PM" },
  ],
  hours: [
    { name: "12 PM · Built the Brightside order form", meta: "Hour · Wed 14 Oct" },
    { name: "3 PM · Called the payment provider about the order form", meta: "Hour · Wed 14 Oct" },
  ],
};

export const ASSISTANTS = [
  { icon: ICONS.claude, name: "Claude", meta: "Connected · can read your days" },
  { icon: ICONS.codex, name: "Codex", meta: "Connected · can read your days" },
  { icon: ICONS.cursor, name: "Cursor", meta: "Connected · can read your days" },
];

// Daylens app UI tokens (Ship's log mode, Figma Daylens-V2), for HTML recreations of app screens. App UI font is Geist.
export const APP_TOKENS = {
  bg: "#fafaf7",
  sidebar: "#f1f0eb",
  raised: "#ffffff",
  selected: "#e9e8e1",
  text: "#14213d",
  text2: "#4e5871",
  text3: "#6b7287",
  line: "#e4e2db",
  lineStrong: "#cfcdc4",
  accent: "#14213d",
  live: "#2e8b57",
};
