import { NextResponse } from "next/server";
import { SOURCES } from "../../_v2/source";

const RESEND = "https://api.resend.com";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PLATFORMS = new Set(["mac", "windows", "linux"]);

// Best effort per instance.
const hits = new Map<string, number[]>();
function limited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > 5;
}

function hostOf(origin: string) {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

// Sites that serve this page under their own domain, comma separated (christian-tonny.dev).
const ALLOWED = new Set((process.env.ALLOWED_ORIGIN_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean));

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const from = origin ? hostOf(origin) : null;
  if (origin && host && from !== host && !(from && ALLOWED.has(from))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  if (limited(ip)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  let input: { email?: unknown; company?: unknown; platform?: unknown; source?: unknown };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Honeypot: bots fill every field. Pretend it worked.
  if (typeof input.company === "string" && input.company) return NextResponse.json({ ok: true });

  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  // Length first: the pattern backtracks quadratically on long inputs.
  if (email.length > 254 || !EMAIL.test(email)) return NextResponse.json({ error: "invalid_email" }, { status: 400 });

  const platform = typeof input.platform === "string" && PLATFORMS.has(input.platform) ? input.platform : null;
  const source = typeof input.source === "string" && SOURCES.has(input.source) ? input.source : "direct";

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error("waitlist: RESEND_API_KEY is not set");
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  const segment = process.env.RESEND_SEGMENT_ID;
  const welcome = process.env.RESEND_WELCOME_TEMPLATE;
  const auth = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  try {
    // Creating a contact that exists also returns 200, so look first to keep repeat signups from getting a second welcome.
    const existing = await fetch(`${RESEND}/contacts/${encodeURIComponent(email)}`, { headers: auth, cache: "no-store" });
    if (existing.ok) return NextResponse.json({ ok: true });

    const res = await fetch(`${RESEND}/contacts`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        email,
        unsubscribed: false,
        ...(segment ? { segments: [{ id: segment }] } : {}),
        properties: { source, ...(platform ? { platform } : {}) },
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 409 || /already exists/i.test(body)) return NextResponse.json({ ok: true });
      console.error("waitlist: create contact failed", res.status, body.slice(0, 300));
      return NextResponse.json({ error: "upstream" }, { status: 502 });
    }

    if (welcome && existing.status === 404) {
      const sent = await fetch(`${RESEND}/emails`, {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": `waitlist-welcome/${email}` },
        body: JSON.stringify({ to: [email], template: { id: welcome } }),
        cache: "no-store",
      });
      // The signup already counts; a failed welcome is logged, not shown.
      if (!sent.ok) console.error("waitlist: welcome email failed", sent.status, (await sent.text()).slice(0, 300));
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("waitlist: resend unreachable", err);
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }
}
