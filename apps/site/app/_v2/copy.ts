// Copy deck for versions 1-7. Every claim here is in the approved fact list; add nothing beyond it.

export const META = {
  title: "Daylens: what you did on your computer, as a calendar",
  description:
    "Daylens records the apps, windows and pages you use and cleans them into a calendar of what you actually did. Search it, ask about it, or let your AI assistants read it. Join the waitlist.",
};

export const PLATFORMS = "Mac, Windows and Linux";

// Second person: Beam, Ramp, Rize, Toggl.
export const HERO = {
  title: "Every hour at your computer, written down.",
  titleLong: "What you did on your computer, written down every hour.",
  sub: "Daylens records the apps, windows and pages you use and writes one line for each hour. Search it, ask about it, or let your AI read it.",
  subShort: "One line for each hour, from the apps, windows and pages you used.",
  // Name-first heroes (Ramp): the name is the title, this line sits under it.
  tagline: "Writes down what you did on your computer, every hour.",
  // Small plain line where a reference has a pill or eyebrow. Never styled as a pill.
  eyebrow: "Daylens V2 for Mac, Windows and Linux",
};

export const FORM = {
  placeholder: "you@example.com",
  placeholderAlt: "Your email",
  label: "Email address",
  button: "Join the waitlist",
  buttonShort: "Join waitlist",
  sending: "Joining",
  doneTitle: "You're on the list.",
  done: (email: string) => `We'll email ${email} when your invite is ready.`,
  doneShort: "You're on the list.",
  useAnother: "Use a different email",
  errors: {
    invalid: "Enter a valid email address.",
    network: "Couldn't connect. Try again.",
    rateLimited: "Too many tries. Wait a minute and try again.",
    server: "Something went wrong. Try again in a minute.",
  },
  // CTA headings for a second form lower on the page.
  closingTitle: "Join the Daylens waitlist.",
  closingTitleAlt: "Start writing down your days.",
};

// One real thing per section. `screen` names a file in public/screens or an HTML recreation of it.
export const FEATURES = {
  hours: {
    title: "Each hour gets one line.",
    body: "Daylens looks at the apps, windows and pages from each hour and describes it in plain words. Open an hour to see the pages and windows behind it.",
    short: "Every hour, described in plain words.",
    screen: "today",
  },
  fix: {
    title: "Rewrite any hour.",
    body: "If a line is wrong, click Fix this hour and write what happened. Your version sticks.",
    short: "Wrong line? Rewrite it. Your version sticks.",
    screen: "today",
  },
  search: {
    title: "Search the way you remember.",
    body: "Type what you remember, not the exact title. “That sourdough thing I read last night” finds the page, and when you saw it.",
    short: "Type what you remember. Get the page back.",
    screen: "find",
  },
  ask: {
    title: "Ask about any day.",
    body: "Ask where you left the order form or what took up Tuesday. Every answer lists the pages, windows and hours it used.",
    short: "Answers that show the pages, windows and hours they used.",
    screen: "ask",
  },
  assistants: {
    title: "Let your AI read your days.",
    body: "Connect Claude, Codex, Cursor or any MCP app, so they know what you were working on. They can read your days. They can't change anything.",
    short: "Claude, Codex and Cursor know what you were working on.",
    note: "What an assistant reads can go to its own AI service.",
    screen: "assistants",
  },
  time: {
    title: "See where the time went.",
    body: "How long you spent in each app, per day or per week.",
    short: "Time in each app, per day or per week.",
  },
  ai: {
    title: "You pick the AI that writes your hours.",
    body: "Daylens AI, your own API key, Claude Code or Codex already on your computer, or no AI at all.",
    short: "Daylens AI, your own key, Claude Code, Codex, or none.",
  },
  privacy: {
    title: "It records what you opened, not what you typed.",
    body: "Your history is recorded and stored on your computer. Pause or delete it any time, from one page in one hour up to everything.",
    keepOut: "Choose apps and sites to keep out before recording starts.",
    short: "Stored on your computer. Pause or delete any time.",
  },
} as const;

export const RECORDS = [
  "The apps you use and their window titles",
  "Pages you visit in normal browser windows",
  "When your computer is idle, locked or asleep",
];

export const NEVER = [
  "Screenshots",
  "Screen video or audio",
  "Keystrokes or anything you type",
  "File contents",
  "Private and incognito windows",
];

export const CONTROLS = [
  "Pause recording any time",
  "Delete one page, one hour, or everything",
  "Keep apps and sites out before recording starts",
  "Rewrite any hour; your version sticks",
];

export const ASSISTANT_NAMES = ["Claude", "Codex", "Cursor", "Any MCP app"];

export const AI_CHOICES = ["Daylens AI", "Your own API key", "Claude Code on your computer", "Codex on your computer", "No AI"];

// Rize / Toggl style "how it works" steps.
export const STEPS = [
  { title: "Choose what to keep out", body: "Pick the apps and sites Daylens should never record, before it starts." },
  { title: "Work as usual", body: "Daylens records the apps, windows and pages you use and writes one line for each hour." },
  { title: "Look back, or let your AI", body: "Search your days, ask about them, or connect Claude, Codex, Cursor or any MCP app." },
];

// Problem statements, for references that open a section with the pain.
export const PROBLEMS = [
  { title: "Tuesday is already a blur.", body: "By Friday, most of the week is hard to account for. Daylens keeps a line for every hour." },
  { title: "Timesheets get written from memory.", body: "See how long you spent in each app, per day or per week, and what each hour was." },
  { title: "Your AI doesn't know what you did today.", body: "Connected assistants can read your days, so you don't start every chat by explaining." },
];

// Who it's for. Plain labels, no claims about results.
export const AUDIENCES = [
  { title: "If you bill by the hour", body: "Every hour has a line and the pages behind it. Time per app, per day or per week." },
  { title: "If you work with AI assistants", body: "Claude, Codex and Cursor can read what you worked on. They can't change anything." },
  { title: "If you write up your week", body: "Each day reads as a list of hours in plain words. Search or ask instead of digging." },
  { title: "If you track your own time", body: "See which apps took the day, and fix any hour Daylens got wrong." },
];

export const FAQ = [
  {
    q: "What does Daylens record?",
    a: "The apps you use and their window titles, the pages you visit in normal browser windows, and when your computer is idle, locked or asleep.",
  },
  {
    q: "What does it never record?",
    a: "Screenshots, screen video or audio, keystrokes or anything you type, file contents, and private or incognito windows.",
  },
  {
    q: "Where is my history stored?",
    a: "On your computer. Pause recording or delete your history any time, from one page in one hour up to everything.",
  },
  {
    q: "Can I keep apps or sites out?",
    a: "Yes. Choose the apps and sites to keep out before recording starts.",
  },
  {
    q: "Which AI writes the hour descriptions?",
    a: "You choose: Daylens AI, your own API key, Claude Code or Codex already on your computer, or no AI at all.",
  },
  {
    q: "What if an hour is described wrong?",
    a: "Rewrite it. Your version sticks.",
  },
  {
    q: "What can connected assistants do?",
    a: "Read your days. They can't change anything. What an assistant reads can go to its own AI service.",
  },
  {
    q: "Which computers does it run on?",
    a: "Mac, Windows and Linux.",
  },
  {
    q: "What happens after I join?",
    a: "You're on the list. We email you once, when your invite is ready.",
  },
];

export const EXAMPLE_LABEL = "Example day";
export const EXAMPLE_NOTE = "Example data: a bakery owner's Wednesday, 14 October.";

export const FOOTER = { copyright: "© 2026 Daylens" };

// Superlogical home (first person, "we"). Wheel: the prefix stays, the items rotate, the last item is the resting state.
export const SUPERLOGICAL = {
  wheelPrefix: "We are building a record of every hour in",
  wheel: ["Figma.", "Chrome.", "Cursor.", "Slack.", "Excel.", "your inbox.", "Notion.", "the terminal.", "Google Docs.", "Photoshop.", "Linear.", "every app."],
  bannerText: "Daylens V2 waitlist is open.",
  bannerLink: "Join the waitlist",
  essay: [
    "Most work now happens on a computer, spread across a browser, a handful of apps and dozens of windows. By Friday it is hard to say what Tuesday was, and the assistants we work with know even less.",
    "Daylens records the apps, windows and pages you use. Every hour, it writes one line that says what you did in that hour. Your day becomes a timeline you can read.",
    "You can search that timeline the way you remember things, ask questions about any day, and see how long you spent in each app. Every answer cites the pages, windows and hours it used.",
    "The AI assistants you already use can read it too. Connect Claude, Codex, Cursor or any MCP app and they know what you were working on. They can read your days. They can't change anything.",
  ],
  recordsTitle: "What it records",
  recordsIntro: "Daylens records three things:",
  neverIntro: "It never records screenshots, screen video or audio, keystrokes or anything you type, file contents, or private and incognito windows.",
  storage:
    "Your history is recorded and stored on your computer. You can pause it or delete it any time, from one page in one hour up to everything, and choose apps and sites to keep out before recording starts.",
  aiChoice:
    "The AI that describes your hours is your choice: Daylens AI, your own API key, Claude Code or Codex already on your computer, or no AI at all. If a description is wrong, you rewrite it and your version sticks.",
  hoursTitle: "What a day looks like",
  neverTitle: "Daylens never records:",
  formTitle: "Sign up for the Daylens waitlist",
};

// Superlogical update post (first person, "we").
export const UPDATE_POST = {
  title: "The Daylens V2 waitlist is open",
  byline: "Daylens team",
  intro: "Daylens V2 is a desktop app for Mac, Windows and Linux that writes down what you did on your computer, one line for every hour. We're opening the waitlist today.",
  lead: "Daylens records the apps, windows and pages you use. Every hour, it writes one line describing that hour, so your day becomes a timeline you can read, search and ask about. The AI assistants you already use can read it too.",
  sections: [
    {
      title: "What it does",
      paras: [
        "Each hour gets a plain-words description. Open one to see the pages and windows behind it. If a description is wrong, rewrite it and your version sticks.",
        "Search your history the way you remember things. Ask questions about any day and get answers that cite the pages, windows and hours they used. See how long you spent in each app, per day or per week.",
      ],
    },
    {
      title: "What it records",
      paras: [
        "The apps you use and their window titles, pages you visit in normal browser windows, and when the computer is idle, locked or asleep.",
        "It never records screenshots, screen video or audio, keystrokes or anything you type, file contents, or private and incognito windows.",
      ],
    },
    {
      title: "Where your history lives",
      paras: [
        "Your history is recorded and stored on your computer. You can pause it or delete it any time, from one page in one hour up to everything. You choose apps and sites to keep out before recording starts.",
      ],
    },
    {
      title: "Your AI, your choice",
      paras: [
        "Connected assistants (Claude, Codex, Cursor, or any MCP app) can read your days but can't change anything. What an assistant reads can go to its own AI service.",
        "The AI that describes your hours can be Daylens AI, your own API key, Claude Code or Codex already on your computer, or no AI at all.",
      ],
    },
    {
      title: "What happens next",
      paras: ["Join with your email below. We email you once, when your invite is ready."],
    },
  ],
  formTitle: "Sign up for the Daylens waitlist",
};

// ChatGPT docs page (docs voice, third person about the product, "you" for the reader).
export const DOCS = {
  title: "Daylens",
  sub: "Daylens turns the apps, windows and pages you use into an hourly timeline you can search, ask about, and let your AI assistants read.",
  callout:
    "Daylens V2 is a desktop app for Mac, Windows and Linux. Join the waitlist to get an invite.",
  intro: [
    "Daylens records the apps, windows and pages you use. Every hour, it writes one line describing what you did in that hour, so your day becomes a readable timeline. You can search it, ask questions about any day, and let the AI assistants you already use read it.",
    "Your history is recorded and stored on your computer. You choose apps and sites to keep out before recording starts, and you can pause or delete your history any time.",
    "Daylens does not record screenshots, screen video or audio, keystrokes or anything you type, file contents, or private and incognito windows.",
  ],
  sections: [
    {
      id: "how-daylens-helps",
      title: "How Daylens helps",
      paras: ["With Daylens, you can:"],
      list: [
        "Read any day as a list of hours, each described in plain words.",
        "Search your history the way you remember things.",
        "Ask questions about a day and get answers that cite the pages, windows and hours they used.",
        "See how long you spent in each app, per day or per week.",
        "Let Claude, Codex, Cursor or any MCP app read your days, so they know what you were working on.",
      ],
    },
    {
      id: "how-daylens-works",
      title: "How Daylens works",
      paras: [
        "Daylens records the app in front of you and its window title, the pages you visit in normal browser windows, and when your computer is idle, locked or asleep. At the end of each hour, it writes one line that describes the hour.",
        "Open an hour to see the pages and windows it came from. If a description is wrong, choose Fix this hour and rewrite it. Your version sticks.",
      ],
    },
    {
      id: "what-is-recorded",
      title: "What is recorded",
      paras: ["Daylens records:"],
      list: [
        "The apps you use and their window titles",
        "Pages you visit in normal browser windows",
        "When your computer is idle, locked or asleep",
      ],
      after: "Daylens never records screenshots, screen video or audio, keystrokes or anything you type, file contents, or private and incognito windows.",
    },
    {
      id: "control-what-is-included",
      title: "Control what is included",
      paras: [
        "Before recording starts, choose the apps and sites to keep out. They are never recorded.",
        "You can pause recording any time. You can delete history at any size, from one page in one hour up to everything.",
      ],
    },
    {
      id: "search-and-ask",
      title: "Search and ask",
      paras: [
        "Search with the words you remember, not the exact title. Ask a question about any day, such as where you left a document. Each answer lists the pages, windows and hours it used, so you can open them.",
      ],
    },
    {
      id: "connect-assistants",
      title: "Connect your AI assistants",
      paras: [
        "Claude, Codex, Cursor and any MCP app can connect to Daylens. Connected assistants can read your days but can't change anything.",
        "What an assistant reads can go to its own AI service.",
      ],
    },
    {
      id: "choose-the-ai",
      title: "Choose the AI that writes your hours",
      paras: ["The descriptions of your hours can come from:"],
      list: ["Daylens AI", "Your own API key", "Claude Code or Codex already on your computer", "No AI at all"],
    },
    {
      id: "join-the-waitlist",
      title: "Join the waitlist",
      paras: ["Enter your email. We email you once, when your invite is ready."],
    },
  ],
};

// Nav and section labels. Nav links only point at sections on the same page.
export const LABELS = {
  features: "Features",
  how: "How it works",
  privacy: "Privacy",
  assistants: "Assistants",
  faq: "FAQ",
  faqTitle: "Questions and answers",
  join: "Join the waitlist",
  records: "Records",
  never: "Never records",
  controls: "You control",
};

// Two-to-five-word phrases for rotating or animated text (Ramp card, tickers, tabs).
export const PHRASES = ["One line per hour", "Search what you saw", "Ask about any day", "Rewrite any hour", "Your AI can read it", "Stored on your computer"];
