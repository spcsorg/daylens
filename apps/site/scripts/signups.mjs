// Waitlist signups per source, with a full-access Resend key (the site's own key can't be pulled from Vercel):
//   RESEND_API_KEY=$(security find-generic-password -s RESEND_API_KEY -w) node scripts/signups.mjs
const KEY = process.env.RESEND_API_KEY;
if (!KEY) throw new Error("RESEND_API_KEY must be set");

const headers = { Authorization: `Bearer ${KEY}` };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  for (;;) {
    const res = await fetch(`https://api.resend.com${path}`, { headers });
    // Resend allows a few requests a second.
    if (res.status === 429) {
      await wait(1000);
      continue;
    }
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }
}

const ids = [];
for (let after = ""; ; ) {
  const page = await get(`/contacts?limit=100${after && `&after=${after}`}`);
  ids.push(...page.data.map((c) => c.id));
  if (!page.has_more) break;
  after = page.data.at(-1).id;
}

// The list leaves out properties, so each contact is read on its own.
const counts = {};
for (const id of ids) {
  const contact = await get(`/contacts/${id}`);
  // Contacts from before Oct 30, 2026 have no source.
  const source = contact.properties?.source?.value || "none";
  counts[source] = (counts[source] ?? 0) + 1;
  await wait(250);
}

console.table(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([source, signups]) => ({ source, signups })));
console.log(`${ids.length} signups`);
