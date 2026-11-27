/* Kestrel & Vale Advisory: the invented firm from the design prototype. No real people, clients or days. */
import { addDays, dayStart, isoWeekday } from "./time";

export const ORG = {
  name: "Kestrel & Vale Advisory",
  shortName: "Kestrel & Vale",
  domain: "kestrelvale.example",
  tenant: "00000000-0000-4000-8000-00000000c0de",
  timeZone: "Africa/Kigali",
  coreStart: 8 * 60 + 30,
  coreEnd: 17 * 60 + 30,
};

export const TEAMS = ["Audit", "Tax", "Advisory", "Operations"] as const;
export type Team = (typeof TEAMS)[number];

export const CLIENTS = [
  { key: "lkb", name: "Lakeside Breweries", code: "LKB", billable: true, aliases: ["Lakeside", "LSB"], domains: ["lakesidebrew.example"] },
  { key: "nyt", name: "Nyota Telecom", code: "NYT", billable: true, aliases: ["Nyota"], domains: ["nyotatel.example"] },
  { key: "hcs", name: "Hillcrest Schools Trust", code: "HCS", billable: true, aliases: ["Hillcrest", "HST"], domains: ["hillcrest-trust.example"] },
  { key: "kvs", name: "Kivu Shipping", code: "KVS", billable: true, aliases: ["Kivu"], domains: ["kivuship.example"] },
  { key: "umf", name: "Umuco Microfinance", code: "UMF", billable: true, aliases: ["Umuco"], domains: ["umuco-mfi.example"] },
  { key: "twg", name: "Twiga Logistics", code: "TWG", billable: true, aliases: ["Twiga"], domains: ["twigalog.example"] },
  { key: "rzp", name: "Ruzizi Power", code: "RZP", billable: true, aliases: ["Ruzizi"], domains: [] },
  { key: "int", name: "Kestrel & Vale (internal)", code: "KV", billable: false, aliases: [], domains: [] },
];

type Work = { label: string; summary: string; apps: string[]; docs: string[]; site?: string };

export const PROJECTS: { key: string; client: string; name: string; code: string; billable: boolean; keywords: string[]; work: Work[] }[] = [
  { key: "lkb-aud", client: "lkb", name: "FY2026 statutory audit", code: "LKB-AUD-26", billable: true, keywords: ["year-end", "stock count", "revenue testing"], work: [
    { label: "Lakeside stock count reconciliation", summary: "Matched the warehouse count sheets against the stock report and flagged the bins that don’t agree.", apps: ["Excel", "Outlook"], docs: ["Stock count reconciliation FY26.xlsx"] },
    { label: "Lakeside revenue testing", summary: "Traced the December sales sample from invoices to delivery notes.", apps: ["Excel", "Edge"], docs: ["Revenue sample – December.xlsx"], site: "portal.lakesidebrew.example" },
    { label: "Lakeside cut-off testing", summary: "Checked goods received either side of year-end against the purchase ledger.", apps: ["Excel", "Acrobat"], docs: ["Cut-off testing FY26.xlsx"] },
    { label: "Lakeside audit planning meeting", summary: "Walked the team through the testing plan and agreed who covers the depots.", apps: ["Teams", "PowerPoint"], docs: ["Revenue testing plan.pptx"] },
  ] },
  { key: "nyt-vat", client: "nyt", name: "Q4 VAT and withholding returns", code: "NYT-TAX-Q4", billable: true, keywords: ["VAT", "WHT", "return"], work: [
    { label: "Nyota VAT return workings", summary: "Reconciled output VAT to the sales ledger and listed the queries for the client.", apps: ["Excel", "Outlook"], docs: ["Nyota VAT workings Q4.xlsx"] },
    { label: "Nyota withholding tax schedule", summary: "Built the withholding schedule from the supplier payments and checked the rates.", apps: ["Excel", "Edge"], docs: ["WHT schedule Q4.xlsx"], site: "etax.revenue.example" },
  ] },
  { key: "hcs-grant", client: "hcs", name: "Grant compliance audit", code: "HCS-AUD-GR", billable: true, keywords: ["grant", "donor report"], work: [
    { label: "Hillcrest grant working papers", summary: "Tied the donor report back to the grant ledger and wrote up the unsupported expenses.", apps: ["Excel", "Word", "Acrobat"], docs: ["Grant ledger tie-out.xlsx", "Hillcrest findings draft.docx"] },
    { label: "Hillcrest grant schedules", summary: "Checked the remaining grant schedules before the review.", apps: ["Excel"], docs: ["Grant schedules FY26.xlsx"] },
  ] },
  { key: "kvs-tp", client: "kvs", name: "Transfer pricing study", code: "KVS-TP-26", billable: true, keywords: ["transfer pricing", "benchmarking"], work: [
    { label: "Kivu benchmarking search", summary: "Screened comparable companies and noted why each was kept or dropped.", apps: ["Excel", "Edge"], docs: ["Kivu comparables.xlsx"], site: "data.benchmarks.example" },
    { label: "Kivu transfer pricing report", summary: "Drafted the functional analysis section of the report.", apps: ["Word"], docs: ["Kivu TP report draft.docx"] },
  ] },
  { key: "umf-lbr", client: "umf", name: "Loan book review", code: "UMF-ADV-LBR", billable: true, keywords: ["loan book", "portfolio at risk", "PAR"], work: [
    { label: "Umuco loan book sampling", summary: "Pulled the loan sample and checked arrears ageing against the portfolio report.", apps: ["Excel"], docs: ["Umuco loan sample.xlsx"] },
    { label: "Umuco review findings", summary: "Wrote up the portfolio-at-risk findings for the steering meeting.", apps: ["Word", "Teams"], docs: ["Loan book findings.docx"] },
  ] },
  { key: "twg-erp", client: "twg", name: "ERP selection", code: "TWG-ADV-ERP", billable: true, keywords: ["ERP", "vendor demo", "RFP"], work: [
    { label: "Twiga ERP vendor demo", summary: "Sat in on a vendor demo and scored it against the requirements.", apps: ["Teams", "Excel"], docs: ["ERP scoring matrix.xlsx"] },
    { label: "Twiga ERP requirements", summary: "Tidied the requirements list after the warehouse workshop.", apps: ["Word"], docs: ["ERP requirements v3.docx"] },
  ] },
  { key: "rzp-tm", client: "rzp", name: "Tariff model review", code: "RZP-ADV-TM", billable: true, keywords: ["tariff", "model"], work: [
    { label: "Ruzizi tariff model review", summary: "Followed the tariff build-up through the model and logged the formula issues.", apps: ["Excel"], docs: ["Tariff model review log.xlsx"] },
  ] },
  { key: "lkb-tax", client: "lkb", name: "Tax health check", code: "LKB-TAX-HC", billable: true, keywords: ["health check"], work: [
    { label: "Lakeside tax health check", summary: "Went through last year’s returns for gaps and listed the risks to raise.", apps: ["Excel", "Word"], docs: ["Lakeside tax health check.docx"] },
  ] },
  { key: "kv-bd", client: "int", name: "Business development", code: "KV-BD", billable: false, keywords: ["proposal", "pitch"], work: [
    { label: "Proposal for Umuco", summary: "Drafted the scope and fee sections of the internal audit proposal.", apps: ["Word", "PowerPoint"], docs: ["Umuco proposal.docx"] },
  ] },
  { key: "kv-trn", client: "int", name: "Training and CPD", code: "KV-TRN", billable: false, keywords: ["CPD", "IFRS", "course"], work: [
    { label: "IFRS 18 refresher course", summary: "The firm’s online course on the new presentation rules.", apps: ["Edge"], docs: ["IFRS 18 refresher"], site: "learn.ifrs-academy.example" },
  ] },
  { key: "kv-adm", client: "int", name: "Firm admin", code: "KV-ADM", billable: false, keywords: ["timesheet", "HR", "IT"], work: [
    { label: "Team stand-up and email", summary: "Morning stand-up, then cleared the inbox.", apps: ["Teams", "Outlook"], docs: ["Inbox"] },
    { label: "Office and IT requests", summary: "Worked through the open laptop and access requests.", apps: ["Edge", "Outlook"], docs: ["Service desk"], site: "kestrelvale.sharepoint.example" },
  ] },
];

const UNATTRIBUTED: Work[] = [
  { label: "Email with two clients", summary: "Replies on two clients’ queries, mixed together.", apps: ["Outlook"], docs: ["Inbox"] },
  { label: "Shared drive tidy-up", summary: "Moved files between client folders on the shared drive.", apps: ["Edge"], docs: ["Shared documents"], site: "kestrelvale.sharepoint.example" },
];

const NAMES = ["Grace Mukamana", "Eric Nkurunziza", "Aline Uwera", "Patrick Mugisha", "Leah Wanjiru", "Samuel Okafor", "Diane Ingabire", "Tomás Herrera", "Priya Raman", "Kwame Mensah", "Aoife Byrne", "Wen Liu", "Claudine Umutoni", "Olivier Habimana", "Fatuma Said", "Daniel Kimani", "Ruth Achieng", "Moses Tumusiime", "Joyce Nyiramana", "Ivan Petrov", "Sofia Marques", "Brian Otieno", "Chantal Uwase", "Yusuf Abdi", "Esther Mutoni", "Felix Ndayishimiye", "Nadia Haddad", "Ken Baraka", "Alice Iradukunda", "Jonas Berg", "Mercy Atieno", "Noah Gasana", "Hana Tesfaye", "Rajiv Menon", "Beatrice Kayitesi", "Paul Mwangi", "Zainab Bello", "Theo Rukundo", "Ines Carvalho", "David Ishimwe"];
const TEAM_OF: Team[] = ["Audit", "Audit", "Audit", "Audit", "Tax", "Tax", "Audit", "Advisory", "Tax", "Advisory", "Advisory", "Advisory", "Audit", "Audit", "Tax", "Audit", "Tax", "Audit", "Operations", "Advisory", "Tax", "Audit", "Audit", "Tax", "Operations", "Audit", "Advisory", "Tax", "Operations", "Advisory", "Audit", "Tax", "Advisory", "Tax", "Operations", "Audit", "Advisory", "Audit", "Operations", "Tax"];
const TITLES: Record<Team, string[]> = {
  Audit: ["Audit senior", "Audit associate", "Audit manager"],
  Tax: ["Tax consultant", "Tax senior", "Tax manager"],
  Advisory: ["Consultant", "Senior consultant", "Manager"],
  Operations: ["Office manager", "IT and facilities", "Finance officer"],
};
const PRIMARY: Record<Team, string[]> = {
  Audit: ["lkb-aud", "lkb-aud", "hcs-grant"],
  Tax: ["nyt-vat", "nyt-vat", "lkb-tax", "kvs-tp"],
  Advisory: ["umf-lbr", "twg-erp", "kvs-tp", "rzp-tm"],
  Operations: ["kv-adm"],
};
const SECONDARY: Record<Team, [string, string]> = {
  Audit: ["hcs-grant", "lkb-aud"],
  Tax: ["lkb-tax", "nyt-vat"],
  Advisory: ["umf-lbr", "twg-erp"],
  Operations: ["kv-bd", "kv-trn"],
};

export function rng(seed: number) {
  let s = seed % 233280;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

export type SeedMember = {
  key: string;
  name: string;
  email: string;
  oid: string;
  team: Team;
  title: string;
  role: "owner" | "admin" | "employee";
  adminOf: Team[];
  primary: string;
  secondary: string;
  eveningRate: number;
  activeNow: boolean;
};

export const MEMBERS: SeedMember[] = NAMES.map((name, i) => {
  const r = rng(i * 7 + 3);
  const team = TEAM_OF[i]!;
  const primary = PRIMARY[team][Math.floor(r() * PRIMARY[team].length)]!;
  const title = i === 0 ? "Audit associate" : i === 6 ? "Audit partner" : i === 35 ? "Managing partner" : TITLES[team][Math.floor(r() * 3)]!;
  return {
    key: "m" + i,
    name,
    email: name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ /g, ".") + "@" + ORG.domain,
    oid: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    team,
    title,
    role: i === 35 ? "owner" : i === 6 ? "admin" : "employee",
    adminOf: i === 6 ? ["Audit", "Tax"] : [],
    primary: i === 0 ? "lkb-aud" : primary,
    secondary: SECONDARY[team][primary === SECONDARY[team][0] ? 1 : 0],
    eveningRate: i === 13 ? 0.9 : r() < 0.3 ? 0.5 : 0.08,
    activeNow: i === 0 || (i !== 17 && r() < 0.62),
  };
});

export type SeedBlock = {
  start: number;
  end: number;
  kind: "work" | "idle" | "away";
  label?: string;
  summary?: string;
  app?: string;
  title?: string;
  siteDomain?: string;
  projectKey?: string;
  confidence?: number;
  evidence?: string[];
};

const MIN = 60_000;

function pickWork(m: SeedMember, r: () => number): { projectKey?: string; work: Work; evidence: string[]; confidence: number } {
  const x = r();
  const project = (key: string) => PROJECTS.find((p) => p.key === key)!;
  const choose = <T,>(list: T[]) => list[Math.floor(r() * list.length)]!;
  if (x < 0.05) return { work: choose(UNATTRIBUTED), evidence: [], confidence: 0.4 + r() * 0.2 };
  const key = x < 0.66 ? m.primary : x < 0.9 ? m.secondary : choose(["kv-trn", "kv-adm", "kv-bd"]);
  const assigned = key === m.primary || key === m.secondary;
  return {
    projectKey: key,
    work: choose(project(key).work),
    evidence: assigned ? ["assignment", "title"] : ["keyword"],
    confidence: assigned ? 0.88 + r() * 0.1 : 0.78 + r() * 0.12,
  };
}

function segment(m: SeedMember, start: number, end: number, r: () => number): SeedBlock[] {
  const { projectKey, work, evidence, confidence } = pickWork(m, r);
  const parts = Math.min(work.apps.length, 1 + Math.floor(r() * 3));
  const out: SeedBlock[] = [];
  const step = Math.round((end - start) / parts / MIN) * MIN;
  for (let i = 0; i < parts; i++) {
    const app = work.apps[i]!;
    const browser = app === "Edge";
    out.push({
      start: start + i * step,
      end: i === parts - 1 ? end : start + (i + 1) * step,
      kind: "work",
      label: work.label,
      summary: work.summary,
      app,
      title: browser && work.site ? work.docs[0] : work.docs[i % work.docs.length],
      siteDomain: browser ? work.site : undefined,
      projectKey,
      confidence: Math.round(confidence * 100) / 100,
      evidence,
    });
  }
  return out;
}

function fill(m: SeedMember, from: number, to: number, r: () => number): SeedBlock[] {
  const out: SeedBlock[] = [];
  for (let t = from; t < to - 10 * MIN; ) {
    const len = Math.min(to - t, (30 + Math.floor(r() * 17) * 5) * MIN);
    out.push(...segment(m, t, t + len, r));
    t += len;
  }
  return out;
}

const at = (base: number, h: number, min: number) => base + (h * 60 + min) * MIN;

/** Grace's Thursday from the prototype, kept exact so the person view can be checked against it. */
function graceThursday(base: number): SeedBlock[] {
  const w = (s: [number, number], e: [number, number], projectKey: string | undefined, label: string, summary: string, app: string, title: string, confidence: number, evidence: string[], siteDomain?: string): SeedBlock =>
    ({ start: at(base, ...s), end: at(base, ...e), kind: "work", projectKey, label, summary, app, title, confidence, evidence, siteDomain });
  const lkb = ["assignment", "title"];
  return [
    w([8, 12], [9, 10], "lkb-aud", "Lakeside stock count reconciliation", "Matched the warehouse count sheets against the stock report and flagged two bins that don’t agree.", "Excel", "Stock count reconciliation FY26.xlsx", 0.96, lkb),
    w([9, 10], [9, 40], "lkb-aud", "Lakeside stock count reconciliation", "Matched the warehouse count sheets against the stock report and flagged two bins that don’t agree.", "Outlook", "Stock count queries", 0.96, lkb),
    w([9, 40], [10, 5], undefined, "Email with two clients", "Replies on the Nyota VAT queries and a Lakeside document request, mixed together.", "Outlook", "Inbox", 0.48, []),
    w([10, 5], [11, 10], "lkb-aud", "Lakeside audit planning meeting", "Walked the team through the revenue testing plan and agreed who covers the depots.", "Teams", "Lakeside planning call", 0.93, lkb),
    w([11, 10], [11, 30], "lkb-aud", "Lakeside audit planning meeting", "Walked the team through the revenue testing plan and agreed who covers the depots.", "PowerPoint", "Revenue testing plan.pptx", 0.93, lkb),
    w([11, 30], [12, 3], "lkb-aud", "Lakeside revenue testing", "Picked the December sales sample and started tracing invoices to delivery notes.", "Excel", "Revenue sample – December.xlsx", 0.91, lkb),
    w([12, 3], [12, 30], "lkb-aud", "Lakeside revenue testing", "Picked the December sales sample and started tracing invoices to delivery notes.", "Edge", "Lakeside client portal", 0.91, lkb, "portal.lakesidebrew.example"),
    { start: at(base, 12, 30), end: at(base, 13, 15), kind: "away" },
    w([13, 15], [14, 21], "hcs-grant", "Hillcrest grant working papers", "Tied the donor report back to the grant ledger and wrote up one unsupported expense.", "Excel", "Grant ledger tie-out.xlsx", 0.88, ["keyword"]),
    w([14, 21], [14, 51], "hcs-grant", "Hillcrest grant working papers", "Tied the donor report back to the grant ledger and wrote up one unsupported expense.", "Word", "Hillcrest findings draft.docx", 0.88, ["keyword"]),
    w([14, 51], [15, 0], "hcs-grant", "Hillcrest grant working papers", "Tied the donor report back to the grant ledger and wrote up one unsupported expense.", "Acrobat", "Donor report FY26.pdf", 0.88, ["keyword"]),
    { start: at(base, 15, 0), end: at(base, 15, 20), kind: "idle" },
    w([15, 20], [16, 40], "kv-trn", "IFRS 18 refresher course", "The firm’s online course on the new presentation rules, two modules done.", "Edge", "IFRS 18 refresher", 0.82, ["keyword"], "learn.ifrs-academy.example"),
    w([16, 40], [17, 30], "lkb-aud", "Lakeside revenue testing", "Finished tracing the sample; three invoices still need delivery notes from the client.", "Excel", "Revenue sample – December.xlsx", 0.94, lkb),
    w([19, 50], [20, 35], "hcs-grant", "Hillcrest grant schedules", "Checked the remaining schedules from home before tomorrow’s review.", "Excel", "Grant schedules FY26.xlsx", 0.86, ["keyword"]),
  ];
}

/** One member's invented working day, cut off at now. Weekends stay empty. */
export function seedDay(m: SeedMember, index: number, date: string, now: number, graceDate: string): SeedBlock[] {
  if (isoWeekday(date) > 5) return [];
  const base = dayStart(date, ORG.timeZone);
  if (base > now) return [];
  let blocks: SeedBlock[];
  if (m.key === "m0" && date === graceDate) {
    blocks = graceThursday(base);
  } else {
    const r = rng(index * 1009 + Number(date.replaceAll("-", "")) % 100_000);
    const begin = at(base, 7, 55) + Math.floor(r() * 10) * 5 * MIN;
    const lunch = at(base, 12, 15) + Math.floor(r() * 6) * 5 * MIN;
    const back = lunch + (40 + Math.floor(r() * 5) * 5) * MIN;
    const idle = at(base, 14, 45) + Math.floor(r() * 9) * 5 * MIN;
    const idleEnd = idle + (10 + Math.floor(r() * 4) * 5) * MIN;
    const finish = at(base, 17, 0) + Math.floor(r() * 10) * 5 * MIN;
    blocks = [
      ...fill(m, begin, lunch, r),
      { start: lunch, end: back, kind: "away" },
      ...fill(m, back, idle, r),
      { start: idle, end: idleEnd, kind: "idle" },
      ...fill(m, idleEnd, finish, r),
    ];
    if (r() < m.eveningRate) {
      const eve = at(base, 19, 30) + Math.floor(r() * 6) * 5 * MIN;
      blocks.push(...segment(m, eve, eve + (30 + Math.floor(r() * 10) * 5) * MIN, r));
    }
  }
  const cut = blocks.filter((b) => b.start < now).map((b) => ({ ...b, end: Math.min(b.end, now) }));
  const last = cut.at(-1);
  if (m.activeNow && last && last.kind === "work" && now - last.end < 3 * 60 * MIN) last.end = now;
  return cut;
}

/** The Thursday on or before today, the day the prototype opens for Grace. */
export function graceDateFor(today: string): string {
  const back = (isoWeekday(today) - 4 + 7) % 7;
  return addDays(today, -back);
}
