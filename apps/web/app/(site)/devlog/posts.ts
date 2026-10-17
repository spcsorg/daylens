export type Post = {
  slug: string;
  title: string;
  date: string;
  summary: string;
  body: string[];
};

export const POSTS: Post[] = [
  {
    slug: "why-we-are-rebuilding-daylens",
    title: "Why we're rebuilding Daylens",
    date: "2026-10-17",
    summary:
      "Daylens 1 kept a faithful record of your day, but it didn't always tell it back in a way you'd recognize. Daylens 2 starts there.",
    body: [
      "If you've used Daylens 1, you've seen what it does well and where it falls short. It kept a faithful record of your apps and pages. But when you opened a day, it often read like a report about someone else: blocks called \"Morning\", hours of \"mixed work\", a summary that could describe anyone's Tuesday.",
      "A record you don't recognize is a record you won't use. So for Daylens 2 we changed the question we test against. Not \"is the data right?\" but \"does the day read true?\" You should be able to glance at an hour and know it was yours.",
      "That one decision changed most of the rest. Each hour is now written the way you'd describe it: what you worked on, how things connected, what you finished and where you left off. Daylens says something is finished only when there's proof, like a sent message or a published page. When it can't tell what happened, it says so instead of guessing.",
      "Search moved to the middle. You remember things in half-sentences, like \"that video about saving money I watched last week\", so that's how search works, across every day, with or without AI. And the last thing you were doing is one click away, so you can pick it up again.",
      "The privacy promise stays the same: your history is stored only on your computer, and we never keep a copy. What's new is that every place something can leave your computer is now yours to see and control: the AI you choose (or none), the assistants you connect, and the anonymous usage counts, which you can switch off.",
      "Windows is not an afterthought this time. Most people who use Daylens are on Windows, so Daylens 2 ships through the Microsoft Store, with the same screens, words and speed as on a Mac.",
      "It also has to be fast. Every screen opens from what's already on your computer, before any AI has written a word, and Daylens should use so little of your computer that you forget it's running. We kept the desktop shell from Daylens 1 and are rewriting what runs inside it.",
      "The beta starts in November. Invites go out in waves, and people on the waitlist get them first. We'll write here as it comes together: what we built, what we got wrong, and what we changed because of it.",
    ],
  },
];

export function getPost(slug: string): Post | undefined {
  return POSTS.find((post) => post.slug === slug);
}

export function formatPostDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
