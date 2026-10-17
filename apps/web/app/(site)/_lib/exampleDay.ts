export type TicketSource = {
  kind: "page" | "file" | "chat" | "excluded";
  label: string;
};

export type Ticket = {
  number: number;
  time: string;
  title: string;
  summary: string;
  sources: TicketSource[];
  terms: string;
  live?: boolean;
  leftOff?: string;
};

export const EXAMPLE_DAY: Ticket[] = [
  {
    number: 1,
    time: "7:00–8:00",
    title: "Answered the morning's cake orders",
    summary: "Confirmed 9 orders in chat and added them to the order sheet. One question about a birthday cake is still open.",
    sources: [
      { kind: "chat", label: "Orders chat" },
      { kind: "file", label: "Order sheet, Saturday" },
    ],
    terms: "cake orders order sheet chat messages birthday customers saturday confirmed",
  },
  {
    number: 2,
    time: "8:00–9:00",
    title: "Wrote the price list for the new sourdough",
    summary: "Worked on the price list with the flour invoice open alongside. Stopped at the delivery prices.",
    sources: [
      { kind: "file", label: "Price list 2026" },
      { kind: "file", label: "Flour invoice, October" },
    ],
    terms: "price list prices sourdough bread flour invoice delivery stopped stop left off where",
  },
  {
    number: 3,
    time: "9:00–10:00",
    title: "Watched a video on pricing bread",
    summary: "A video about pricing for small bakeries, then two numbers copied into the price list.",
    sources: [
      { kind: "page", label: "How to price bread for a small bakery" },
      { kind: "file", label: "Price list 2026" },
    ],
    terms: "video watched watch pricing price bread small bakery youtube tutorial",
  },
  {
    number: 4,
    time: "10:00–11:00",
    title: "Sent this week's invoices",
    summary: "Four invoices sent by email. Time on the bank's site was excluded, so nothing from it was kept.",
    sources: [
      { kind: "file", label: "Invoice 0142" },
      { kind: "excluded", label: "Banking, excluded" },
    ],
    terms: "invoices invoice sent email billing customers bank banking payment paid",
  },
  {
    number: 5,
    time: "11:00–now",
    title: "Now",
    summary: "Order sheet 12 min · Orders chat 6 min",
    sources: [],
    leftOff: "Price list 2026, at the delivery prices",
    terms: "now current today left off order sheet",
    live: true,
  },
];

export const EXAMPLE_SEARCHES = [
  "that bread pricing video i watched",
  "the flour invoice",
  "where did i stop on the price list",
];

const STOPWORDS = new Set([
  "a", "an", "the", "i", "my", "me", "on", "in", "of", "to", "for", "and", "that", "this",
  "did", "was", "were", "it", "about", "from", "with", "at", "what", "which", "last", "week",
  "some", "someone",
]);

export function searchDay(query: string): { ticket: Ticket; source: TicketSource | null } | null {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
  if (words.length === 0) return null;

  let best: { ticket: Ticket; score: number } | null = null;
  for (const ticket of EXAMPLE_DAY) {
    if (ticket.live) continue;
    const haystack = `${ticket.title} ${ticket.summary} ${ticket.terms}`.toLowerCase();
    const score = words.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { ticket, score };
  }
  if (!best) return null;

  const source =
    best.ticket.sources
      .filter((item) => item.kind !== "excluded")
      .map((item) => ({
        item,
        score: words.filter((word) => item.label.toLowerCase().includes(word)).length,
      }))
      .sort((a, b) => b.score - a.score)[0]?.item ?? null;

  return { ticket: best.ticket, source };
}
