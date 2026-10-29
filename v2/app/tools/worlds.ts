// The invented worlds app/tools/seed.ts fills a data folder with. Nothing here is anyone's real day.
import type { AppIdentity } from '../../capture/protocol.ts'

/** [minutes into the hour, app, window or page title] */
export type Seg = [number, AppIdentity, string]
/** An hour as the hour writer would have written it. */
export interface Written {
  title: string
  summary: string
  detail: string
}
/** One clock hour: windows in front, the computer asleep, or pages only the browser's own history holds. */
export type WorldHour = { hour: number; segs: Seg[]; written?: Written; history?: true } | { hour: number; away: true }
/** A day's hours in clock order. Daylens runs from its first recorded hour to the end of its last. */
export type WorldDay = WorldHour[]

export function app(appId: string, name: string, path: string): AppIdentity {
  return { app_id: appId, name, path, pid: 100, registered_browser: false, engine: 'none', signer: null, version_info: null, identity_state: 'ok', store: null }
}

const notes = app('com.apple.Notes', 'Notes', '/System/Applications/Notes.app')
const mail = app('com.apple.mail', 'Mail', '/System/Applications/Mail.app')
const calendar = app('com.apple.iCal', 'Calendar', '/System/Applications/Calendar.app')
const preview = app('com.apple.Preview', 'Preview', '/System/Applications/Preview.app')
const textedit = app('com.apple.TextEdit', 'TextEdit', '/System/Applications/TextEdit.app')
const reminders = app('com.apple.reminders', 'Reminders', '/System/Applications/Reminders.app')
const terminal = app('com.apple.Terminal', 'Terminal', '/System/Applications/Utilities/Terminal.app')
const chrome = app('com.google.Chrome', 'Google Chrome', '/Applications/Google Chrome.app')
const notion = app('notion.id', 'Notion', '/Applications/Notion.app')
const zoom = app('us.zoom.xos', 'Zoom', '/Applications/zoom.us.app')
const messages = app('com.apple.MobileSMS', 'Messages', '/System/Applications/Messages.app')
const cursor = app('com.todesktop.230313mzl4w4u92', 'Cursor', '/Applications/Cursor.app')
const spotify = app('com.spotify.client', 'Spotify', '/Applications/Spotify.app')

// What the browser extension reports for the pages open in Chrome; without it a browser window's title isn't kept.
export const PAGES: Record<string, string> = {
  'Mill Lane Flour – wholesale prices': 'https://millaneflour.example/wholesale',
  'Corner Café – menu and opening hours': 'https://cornercafe.example/menu',
  'Spring pricing memo – Google Docs': 'https://docs.google.com/document/d/spring-pricing-memo/edit',
  'Q2 budget – Google Sheets': 'https://docs.google.com/spreadsheets/d/q2-budget/edit',
  'Review notes – Google Docs': 'https://docs.google.com/document/d/thursday-review-notes/edit',
  'Per-seat or usage pricing? – Kestrel': 'https://kestrel.dev/blog/per-seat-or-usage',
  'Pricing page v3 – Figma': 'https://www.figma.com/design/pricing-page-v3',
  'Pricing tiers draft – Claude': 'https://claude.ai/chat/pricing-tiers-draft',
  'Hacker News': 'https://news.ycombinator.com/',
  'Pricing – Tessellate': 'https://tessellate.example/pricing',
  'Plans and pricing – Quillmate': 'https://quillmate.example/pricing',
  'Usage-based pricing – Stripe Docs': 'https://docs.stripe.com/billing/subscriptions/usage-based',
  'Pricing – Larkspur (staging)': 'https://staging.larkspur.example/pricing',
  'Riverside loop – Trailmap': 'https://trailmap.example/routes/riverside-loop',
  'Weather – Riverside': 'https://weather.example/riverside',
}

// --- The bakery: the evaluations' world -----------------------------------------------------------------------------

// [minutes into the hour, app, window title], one hour's worth of focus changes, 8 AM to 6 PM.
const BAKERY_HOURS: Seg[][] = [
  [[0, mail, 'Weekend cake orders'], [18, notes, 'Order list for Saturday'], [40, calendar, 'Week of deliveries']],
  [[0, reminders, 'Flour and butter costs'], [20, chrome, 'Mill Lane Flour – wholesale prices'], [35, mail, 'Re: Supplier price change']],
  [[0, textedit, 'Autumn menu draft.rtf'], [30, preview, 'Autumn menu proof.pdf']],
  [[0, terminal, 'brightside-site — npm run dev'], [25, textedit, 'order-form notes.txt'], [50, notes, 'Order form checklist']],
  [[0, terminal, 'brightside-site — git log'], [20, notes, 'Card payment questions']],
  [[0, mail, 'Corner Café invoice for October'], [15, reminders, 'Invoices to send'], [45, mail, 'Sent: October invoice']],
  [[0, calendar, 'Pickup schedule'], [30, notes, 'Pickup reminders']],
  [[0, preview, 'Packaging labels.pdf'], [40, textedit, 'Label wording.rtf']],
  [[0, mail, 'Wholesale enquiry'], [10, chrome, 'Corner Café – menu and opening hours'], [20, reminders, 'Wholesale follow-ups']],
  [[0, notes, 'Tomorrow’s bakes'], [30, calendar, 'Thursday']],
]

// [minutes after midnight, title]: pages the browser's own history holds from before Daylens started today.
const BAKERY_HISTORY: [number, string][] = [
  [100, 'Croissant lamination, step by step'],
  [370, 'Saturday market forecast'],
  [395, 'Farmers’ market stall booking'],
  [430, 'Sourdough starter feeding schedule'],
  [455, 'Mill Lane Flour – wholesale prices'],
]
Object.assign(PAGES, {
  'Croissant lamination, step by step': 'https://recipes.example/croissant-lamination',
  'Saturday market forecast': 'https://weather.example/market',
  'Farmers’ market stall booking': 'https://market.example/stalls',
  'Sourdough starter feeding schedule': 'https://bakers.example/starter',
})

/**
 * The same day `days` times, 8 AM to 6 PM, nothing written. Every day but today sleeps through lunch, 12 to 1; with
 * `history`, today also has pages from the browser's history before Daylens started at 8.
 */
export function bakery(days: number, history: boolean): WorldDay[] {
  return Array.from({ length: days }, (_, i) => {
    const today = i === days - 1
    const day: WorldDay = BAKERY_HOURS.map((segs, h) => (h === 4 && !today ? { hour: 12, away: true } : { hour: 8 + h, segs }))
    if (!today || !history) return day
    const early = new Map<number, Seg[]>()
    for (const [m, title] of BAKERY_HISTORY) early.set(Math.floor(m / 60), [...(early.get(Math.floor(m / 60)) ?? []), [m % 60, chrome, title]])
    return [...[...early].map(([hour, segs]): WorldHour => ({ hour, segs, history: true })), ...day]
  })
}

// --- The pricing-memo world: the launch film's ------------------------------------------------------------------------

// Pieces of work an hour can go to, each with the hour as Daylens writes it.
type Kind = { segs: Seg[]; written: Written }
const K = {
  inbox: {
    segs: [[0, mail, 'Inbox'], [25, mail, 'Re: Q2 budget'], [40, calendar, 'This week'], [50, messages, 'Dana Whitfield']],
    written: {
      title: 'Email and the week ahead',
      summary: 'You went through email, most of it the Q2 budget thread, and looked over the week in Calendar.',
      detail: 'About 40 minutes on email, 15 of them on the Q2 budget thread. Then 10 minutes on this week’s calendar and a few minutes messaging Dana.',
    },
  },
  standup: {
    segs: [[0, zoom, 'Weekly standup'], [30, notion, 'Weekly notes'], [45, mail, 'Inbox']],
    written: {
      title: 'Weekly standup and notes',
      summary: 'The weekly standup on Zoom, then the week’s notes in Notion.',
      detail: 'The standup took half an hour. You spent 15 minutes on the weekly notes after it and 15 on email.',
    },
  },
  research: {
    segs: [[0, chrome, 'Pricing – Tessellate'], [15, chrome, 'Plans and pricing – Quillmate'], [30, notion, 'Pricing research'], [50, chrome, 'Hacker News']],
    written: {
      title: 'Competitor pricing',
      summary: 'You compared Tessellate’s and Quillmate’s pricing pages and spent time in your pricing research notes.',
      detail: 'About 15 minutes on each pricing page and 20 on the research notes in Notion, plus 10 minutes on Hacker News.',
    },
  },
  memoStart: {
    segs: [[0, chrome, 'Spring pricing memo – Google Docs'], [35, notion, 'Pricing research'], [50, chrome, 'Q2 budget – Google Sheets']],
    written: {
      title: 'Spring pricing memo',
      summary: 'The first session on the spring pricing memo, with your pricing research notes beside it.',
      detail: 'About 35 minutes in the memo, 15 going back over the research notes, and 10 in the Q2 budget.',
    },
  },
  memo: {
    segs: [[0, chrome, 'Spring pricing memo – Google Docs'], [24, chrome, 'Q2 budget – Google Sheets'], [33, chrome, 'Per-seat or usage pricing? – Kestrel'], [40, notion, 'Pricing research'], [55, chrome, 'Hacker News']],
    written: {
      title: 'Spring pricing memo and Q2 numbers',
      summary: 'You worked on the spring pricing memo, then checked the Q2 budget numbers behind it.',
      detail: 'About 25 minutes on the memo and 10 on the budget numbers. You read Kestrel’s post on per-seat or usage pricing and spent 15 minutes in your pricing research notes, plus a few minutes on Hacker News.',
    },
  },
  designSync: {
    segs: [[0, zoom, 'Design sync'], [40, chrome, 'Pricing page v3 – Figma']],
    written: {
      title: 'Design sync, then the pricing page',
      summary: 'Forty minutes in the design sync on Zoom, then version 3 of the pricing page in Figma.',
      detail: 'The sync took 40 minutes and the pricing page design the last 20.',
    },
  },
  reviewNotes: {
    segs: [[0, chrome, 'Review notes – Google Docs'], [30, mail, 'Re: Thursday review'], [45, mail, 'Sent: Re: Thursday review'], [50, messages, 'Dana Whitfield']],
    written: {
      title: 'Answered the Thursday review notes',
      summary: 'You went through the comments in the Thursday review notes and sent your reply to the thread.',
      detail: 'Half an hour on the review notes and 20 minutes on the email thread, with your reply sent by 9:45. A few minutes messaging Dana after.',
    },
  },
  invoice: {
    segs: [[0, mail, 'Invoice 1042 – Harbor Studio'], [15, mail, 'Sent: Invoice 1042 – Harbor Studio'], [20, chrome, 'Spring pricing memo – Google Docs']],
    written: {
      title: 'Sent invoice 1042, then back on the memo',
      summary: 'You sent Harbor Studio invoice 1042, then went back to the spring pricing memo.',
      detail: 'The invoice took 20 minutes and was sent by 1:15. The other 40 went to the memo.',
    },
  },
  tiers: {
    segs: [[0, chrome, 'Pricing tiers draft – Claude'], [25, chrome, 'Per-seat or usage pricing? – Kestrel'], [35, chrome, 'Pricing tiers draft – Claude'], [50, chrome, 'Spring pricing memo – Google Docs']],
    written: {
      title: 'Pricing tiers with Claude',
      summary: 'You drafted the pricing tiers with Claude, going back to Kestrel’s post on per-seat or usage pricing.',
      detail: 'About 40 minutes on the tiers draft and 10 rereading the Kestrel post, then 10 minutes in the memo.',
    },
  },
  pricingReview: {
    segs: [[0, zoom, 'Pricing review with Dana'], [45, chrome, 'Spring pricing memo – Google Docs']],
    written: {
      title: 'Pricing review with Dana',
      summary: 'A pricing review with Dana on Zoom, then back to the spring pricing memo.',
      detail: 'The review took 45 minutes and the memo the last 15.',
    },
  },
  build: {
    segs: [[0, cursor, 'pricing-tiers.tsx — larkspur-web'], [30, chrome, 'Pricing – Larkspur (staging)'], [40, cursor, 'pricing-tiers.tsx — larkspur-web']],
    written: {
      title: 'Pricing tiers component',
      summary: 'You worked on the website’s pricing tiers component, checking it on the staging pricing page.',
      detail: 'About 50 minutes in the component and 10 on the staging page.',
    },
  },
  meter: {
    segs: [[0, cursor, 'usage-meter.ts — larkspur-web'], [35, chrome, 'Usage-based pricing – Stripe Docs'], [50, cursor, 'usage-meter.ts — larkspur-web']],
    written: {
      title: 'Usage meter for billing',
      summary: 'You worked on the usage meter in the web app, with Stripe’s docs on usage-based pricing.',
      detail: 'About 45 minutes in the code and 15 on Stripe’s usage-based pricing docs.',
    },
  },
  tests: {
    segs: [[0, cursor, 'checkout.test.ts — larkspur-web'], [40, chrome, 'Pricing – Larkspur (staging)'], [50, messages, 'Theo Martins']],
    written: {
      title: 'Checkout tests',
      summary: 'You worked on the checkout tests, then looked over the staging pricing page.',
      detail: '40 minutes on the tests and 10 on the staging page, then 10 minutes messaging Theo.',
    },
  },
  call: {
    segs: [[0, zoom, 'Call with Harbor Studio'], [35, notion, 'Customer interviews']],
    written: {
      title: 'Call with Harbor Studio',
      summary: 'A call with Harbor Studio on Zoom, then your customer interview notes.',
      detail: 'The call took 35 minutes and the notes the rest of the hour.',
    },
  },
  interviews: {
    segs: [[0, notion, 'Customer interviews'], [30, chrome, 'Plans and pricing – Quillmate'], [45, mail, 'Inbox']],
    written: {
      title: 'Customer interview notes',
      summary: 'You went through your customer interview notes and looked at Quillmate’s plans.',
      detail: '30 minutes on the interview notes, 15 on Quillmate’s pricing page, and 15 on email.',
    },
  },
  budget: {
    segs: [[0, chrome, 'Q2 budget – Google Sheets'], [40, mail, 'Re: Q2 budget']],
    written: {
      title: 'Q2 budget',
      summary: 'You worked in the Q2 budget, then read the email thread about it.',
      detail: '40 minutes in the budget and 20 on the thread.',
    },
  },
  roadmap: {
    segs: [[0, notion, 'Q2 roadmap'], [35, chrome, 'Spring pricing memo – Google Docs'], [50, messages, 'Dana Whitfield']],
    written: {
      title: 'Q2 roadmap',
      summary: 'You worked on the Q2 roadmap in Notion, with some time in the spring pricing memo.',
      detail: '35 minutes on the roadmap and 15 on the memo, then 10 minutes messaging Dana.',
    },
  },
  comments: {
    segs: [[0, mail, 'Pricing memo comments'], [20, chrome, 'Spring pricing memo – Google Docs'], [50, chrome, 'Hacker News']],
    written: {
      title: 'Comments on the pricing memo',
      summary: 'You read the comments on the pricing memo, then went back into the memo.',
      detail: '20 minutes on the comments and 30 in the memo, plus 10 on Hacker News.',
    },
  },
  reading: {
    segs: [[0, chrome, 'Hacker News'], [20, chrome, 'Usage-based pricing – Stripe Docs'], [40, mail, 'Inbox']],
    written: {
      title: 'Stripe’s pricing docs and email',
      summary: 'You read Stripe’s docs on usage-based pricing, with time on Hacker News and email.',
      detail: 'About 20 minutes each on Hacker News, the Stripe docs and email.',
    },
  },
  discount: {
    segs: [[0, mail, 'Re: Annual plan discount'], [20, chrome, 'Q2 budget – Google Sheets'], [40, notion, 'Pricing research']],
    written: {
      title: 'Annual plan discount',
      summary: 'You read the thread on an annual plan discount and checked it against the Q2 budget and your pricing research.',
      detail: '20 minutes each on the thread, the budget and the research notes.',
    },
  },
  planning: {
    segs: [[0, notion, 'Weekly notes'], [30, calendar, 'This week']],
    written: {
      title: 'Plans for the rest of the week',
      summary: 'You went over your weekly notes and the calendar for the rest of the week.',
      detail: 'Half an hour on each.',
    },
  },
  saturday: {
    segs: [[0, chrome, 'Riverside loop – Trailmap'], [20, spotify, 'Weekend mix'], [40, chrome, 'Hacker News']],
    written: {
      title: 'A running route and Hacker News',
      summary: 'You looked at the Riverside loop route on Trailmap, with music and Hacker News.',
      detail: 'About 20 minutes each on the route, Spotify and Hacker News.',
    },
  },
  saturdayLater: {
    segs: [[0, messages, 'Theo Martins'], [15, chrome, 'Plans and pricing – Quillmate'], [35, chrome, 'Hacker News']],
    written: {
      title: 'Quillmate’s plans',
      summary: 'A few minutes messaging Theo, then Quillmate’s pricing page and Hacker News.',
      detail: '15 minutes on messages, 20 on Quillmate’s plans, and 25 on Hacker News.',
    },
  },
} satisfies Record<string, Kind>
type Piece = keyof typeof K

const AWAY = null
// Weekdays, cycled so no two weeks line up: [first hour, then each hour's piece of work, AWAY for lunch].
const WEEKDAYS: [number, (Piece | null)[]][] = [
  [9, ['inbox', 'research', 'call', AWAY, 'interviews', 'meter', 'meter', 'budget']],
  [8, ['reading', 'standup', 'build', 'build', AWAY, 'tests', 'roadmap', 'discount', 'planning']],
  [9, ['inbox', 'budget', 'designSync', AWAY, 'research', 'interviews', 'reading']],
  [9, ['standup', 'meter', 'tests', AWAY, 'call', 'roadmap', 'budget', 'planning', 'build']],
  [9, ['inbox', 'pricingReview', 'tests', AWAY, 'reading', 'build', 'call']],
  [8, ['standup', 'meter', 'meter', 'designSync', AWAY, 'budget', 'interviews', 'roadmap', 'reading']],
  [9, ['inbox', 'roadmap', 'research', AWAY, 'discount', 'tests', 'planning']],
]
// The day before today: the memo starts, and its comments come in at 4.
const MEMO_DAY: [number, (Piece | null)[]] = [9, ['standup', 'memoStart', 'budget', AWAY, 'call', 'build', 'discount', 'comments', 'planning']]
// Today, the film's Tuesday.
const TODAY: [number, (Piece | null)[]] = [9, ['reviewNotes', 'memo', 'designSync', AWAY, 'invoice', 'tiers', 'pricingReview', 'budget', 'planning']]

function hours([first, pieces]: [number, (Piece | null)[]]): WorldDay {
  return pieces.map((p, i) => (p === null ? { hour: first + i, away: true } : { hour: first + i, segs: K[p].segs as Seg[], written: K[p].written }))
}

/**
 * About three weeks of an invented product manager's work at Larkspur, ending today: the spring pricing memo, the Q2
 * budget, design syncs, the pricing page and billing code. Every past hour is written. Saturdays are short and
 * Sundays empty; today and one evening also have hours known only from the browser's history. `weekdays[i]` is the day
 * of the week of day i, oldest first; the last is today.
 */
export function pricing(weekdays: number[]): WorldDay[] {
  const last = weekdays.length - 1
  let cycle = 0
  // One evening when Daylens wasn't running: the latest weekday at least two days back.
  const evening = weekdays.findLastIndex((dow, i) => i <= last - 2 && dow >= 1 && dow <= 5)
  return weekdays.map((dow, i) => {
    if (i === last) {
      const early: WorldDay = [
        { hour: 7, history: true, segs: [[40, chrome, 'Hacker News'], [52, chrome, 'Usage-based pricing – Stripe Docs']], written: { title: 'Hacker News and Stripe’s pricing docs', summary: 'Before Daylens started: Hacker News, then Stripe’s docs on usage-based pricing.', detail: 'Hacker News at 7:40 and the Stripe docs at 7:52, from your browser’s history.' } },
        { hour: 8, history: true, segs: [[5, chrome, 'Weather – Riverside'], [30, chrome, 'Plans and pricing – Quillmate']], written: { title: 'Weather and Quillmate’s plans', summary: 'Before Daylens started: the weather, then Quillmate’s pricing page.', detail: 'The weather at 8:05 and Quillmate’s plans at 8:30, from your browser’s history.' } },
      ]
      return [...early, ...hours(TODAY)]
    }
    if (i === last - 1) return hours(MEMO_DAY)
    if (dow === 0) return []
    if (dow === 6) return hours([10, ['saturday', 'saturdayLater']])
    const day = hours(WEEKDAYS[cycle++ % WEEKDAYS.length]!)
    if (i === evening) day.push({ hour: 21, history: true, segs: [[10, chrome, 'Pricing – Tessellate'], [25, chrome, 'Plans and pricing – Quillmate'], [40, chrome, 'Hacker News']], written: { title: 'Tessellate and Quillmate pricing', summary: 'While Daylens wasn’t running: Tessellate’s and Quillmate’s pricing pages, then Hacker News.', detail: 'Tessellate at 9:10 PM, Quillmate at 9:25 and Hacker News at 9:40, from your browser’s history.' } })
    return day
  })
}
