export const SITE = {
  name: "Daylens",
  title: "Daylens: your day, remembered",
  description:
    "Daylens remembers your workday on your computer, names every hour in plain words, and gives the AI you choose the context of your day. Join the V2 waitlist.",
  platforms: "Mac, Windows and Linux",
};

export const SCREENS = {
  find: { src: "/screens/find-it-window.png", alt: "Daylens search finding a page called Sourdough hydration, explained, from last night" },
  morning: { src: "/screens/morning-remembered-window.png", alt: "Your morning, remembered: four hours of a Wednesday, each named in plain words" },
  today: { src: "/screens/today-hour-open-window.png", alt: "Daylens Today with the 8 AM hour open, showing its sources and a Fix this hour button" },
  ask: { src: "/screens/ask-answer-window.png", alt: "Daylens Ask answering where did i leave the order form, with the pages and hours it used" },
  assistants: { src: "/screens/assistants-connected-window.png", alt: "Claude, Codex and Cursor connected to Daylens and able to read your days" },
} as const;

export type ScreenKey = keyof typeof SCREENS;

export const REEL: { key: ScreenKey; caption: string }[] = [
  { key: "today", caption: "Every hour, in plain words." },
  { key: "morning", caption: "Your morning, remembered." },
  { key: "ask", caption: "Ask about any day." },
  { key: "assistants", caption: "Give your AI the same picture." },
];

export type Hour = {
  time: string;
  raw?: string[];
  title: string;
  facts?: string;
  icons?: string[];
  kind?: "quiet" | "live";
  fix?: string;
};

// Illustrative day from the Figma file: the owner of Brightside Bakery, Wednesday 14 October.
export const HOURS: Hour[] = [
  {
    time: "8 AM",
    raw: ["YouTube", "Chrome", "Brightside Bakery site", "Instagram"],
    title: "Watched a baking video, then edited the Brightside menu",
    facts: "A baking video on YouTube, then the Brightside Bakery site and Instagram.",
    icons: ["/icons/youtube.png", "/icons/chrome.svg", "/icons/instagram.svg"],
    fix: "Published the Brightside autumn menu on the website and Instagram",
  },
  {
    time: "9 AM",
    raw: ["Instagram", "Reddit", "Google Fonts"],
    title: "Checked the Instagram post, then picked a font on Reddit",
    facts: "Your Instagram post, then Reddit and Google Fonts.",
    icons: ["/icons/instagram.svg", "/icons/reddit.svg", "/icons/google-fonts.svg"],
  },
  { time: "10 AM", title: "No browser pages found for this hour", kind: "quiet" },
  {
    time: "11 AM",
    raw: ["Chrome", "1 page"],
    title: "Used a currency converter",
    facts: "One page in Chrome.",
    icons: ["/icons/chrome.svg"],
  },
  {
    time: "12 PM",
    title: "Daylens",
    facts: "Recording now. This hour gets its name when it ends.",
    icons: ["/icons/daylens.png"],
    kind: "live",
  },
];

export const ASK = {
  question: "where did i leave the order form",
  without:
    "I don't know what you worked on today. Tell me which app or site the order form was in, and roughly when, and I'll help from there.",
  with: "You left the Brightside order form in Cursor around 3 PM on Wednesday 14 October, right after a call with the payment provider. One test order still needs to go all the way through.",
  pages: [
    { icon: "/icons/cursor.png", name: "brightside-site", meta: "Window in Cursor · Wed 14 Oct, 12–3 PM" },
    { icon: "/icons/chrome.svg", name: "Brightside Bakery · Order form", meta: "Page in Chrome · Wed 14 Oct, 12:04 PM" },
  ],
  hours: [
    { icon: "/icons/daylens.png", name: "12 PM · Built the Brightside order form", meta: "Hour · Wed 14 Oct" },
    { icon: "/icons/daylens.png", name: "3 PM · Called the payment provider about the order form", meta: "Hour · Wed 14 Oct" },
  ],
};

export const ASSISTANTS = [
  { icon: "/icons/claude.png", name: "Claude" },
  { icon: "/icons/codex.png", name: "Codex" },
  { icon: "/icons/cursor.png", name: "Cursor" },
];

export const RECORDS = [
  "Apps you use and their window titles",
  "Pages you visit in normal browser windows",
  "When your computer is idle, locked or asleep",
];

export const NEVER = [
  "Screenshots, screen video or audio",
  "Keystrokes, what you type, file contents",
  "Private and incognito windows",
];

export const KEEP_OUT = ["Messages", "WhatsApp", "1Password", "Banking sites"];

export const FAQ = [
  {
    q: "When can I use it?",
    a: "Join the waitlist. You'll get one email, when your invite is ready.",
  },
  {
    q: "Which computers does it run on?",
    a: "Mac, Windows and Linux.",
  },
  {
    q: "Which AI names my hours?",
    a: "You choose: Daylens AI, your own key, Claude Code or Codex on your computer, or no AI at all. With no AI, each hour keeps its window and page titles.",
  },
  {
    q: "Where is my history kept?",
    a: "Recorded and stored on your computer. Pause or delete any time, from one page in one hour to everything.",
  },
  {
    q: "What can a connected assistant do?",
    a: "Read your days. It can't change anything. What an assistant reads can go to its own AI service, so you choose which ones to connect.",
  },
  {
    q: "What happens to my email?",
    a: "It's used to confirm you and to send your invite. Every email has a one-click unsubscribe.",
  },
];
