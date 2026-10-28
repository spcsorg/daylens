import { ASK, PRIVACY } from "./_film/world";

export const TITLE = "Introducing Daylens V2";
export const DEK = "Daylens writes down your day from the apps, windows and pages you use, so you can look back at any hour, find what you saw, and ask about it.";
export const AVAILABILITY = "Mac beta in early November. Open source.";

// The founder note: Christian's own post, first person.
export const POST = [
  "Today I’m announcing something I’ve been working on for a long time, and I’m proud to share it with you: Daylens V2.",
  "It’s a Mac app that writes down your day. It notes the apps, windows and pages you use and turns every hour into a line that says what you did, so by Friday you can still tell what Tuesday was.",
  "You can look back at any day, week or month, find a page the way you remember it, or just ask. When I can’t find the post about pricing I read on Tuesday, I ask Daylens, and it tells me which one it was and when I read it, with the pages and hours the answer came from.",
  "The record stays on this computer. With AI on, only the hour being written, or the excerpts a question needs, go to the AI provider you pick. AI is your own key or none, and the beta sends no usage analytics.",
  "The Mac beta comes out in early November, open source. Ask, AI-written hours and assistants are being finished for it now. If you want it, join the waitlist and I’ll email you when it’s out.",
];

export const FEATURES = {
  welcome: {
    title: "Set up in about two minutes",
    body: "Allow window titles, pick an AI or none, and Daylens starts writing down your day.",
  },
  morning: {
    title: "Your day, hour by hour",
    body: "Each hour gets a line that says what you did, with the apps, windows and pages behind it. With AI off, you see the apps and pages on their own.",
  },
  today: {
    title: "Any day, week or month",
    body: "See where a Tuesday went, how a week was spread, and which apps the month went to.",
  },
  search: {
    title: "Find a page the way you remember it",
    body: "Type what you remember, like “the pricing memo from monday”, and get the page, the window and the hour it was in.",
  },
  ask: {
    title: "Ask about any day",
    body: "Ask in your own words. The answer is short, and it shows the pages and hours it came from, so you can check it.",
    examples: [ASK.question, "when did I work on the pricing memo this week?", "what did I get done this morning?"],
    points: [
      { title: "It answers from your record", body: "Ask reads the hours and pages Daylens recorded on this computer." },
      { title: "It shows where the answer came from", body: "The pages and hours it read sit under every answer." },
      { title: "You pick the AI", body: "Ask uses the provider you choose, with your own key, and sends only the excerpts a question needs." },
    ],
  },
  assistants: {
    title: "Your assistants can ask too",
    body: "Connect Claude Code, Codex and Cursor, and they look up your day the same way you search it. Every read shows up in Settings with the assistant’s name. They can pause recording or keep an app out; anything that changes your record waits for your yes in Daylens.",
  },
  trust: {
    title: "Pause it. Delete any of it.",
    body: "Pause from the menu bar. Remove one page from an hour, a whole day, or everything. Keep apps and sites out before recording starts.",
  },
};

export const PRIVACY_LINE = PRIVACY;
export const PRIVACY_MORE = ["The beta sends no usage analytics.", "AI is your own key, or none at all."];

export const BETA = {
  title: "The beta",
  body: [
    "The beta comes out in early November as open source on GitHub, for Mac first. Windows and Linux follow.",
    "Ask, AI-written hours and assistants are being finished for it now. The screens on this page show an invented Tuesday.",
  ],
};

export const CLOSING = "Get the beta when it’s out.";
