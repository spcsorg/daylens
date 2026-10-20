import { NextResponse } from "next/server";

const RESEND = "https://api.resend.com";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

  let input: { email?: unknown; company?: unknown };
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

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error("waitlist: RESEND_API_KEY is not set");
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  const segment = process.env.RESEND_SEGMENT_ID;

  try {
    const res = await fetch(`${RESEND}/contacts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, unsubscribed: false, ...(segment ? { segments: [{ id: segment }] } : {}) }),
      cache: "no-store",
    });
    // Signing up twice is not an error the visitor needs to see.
    if (res.ok || res.status === 409) return NextResponse.json({ ok: true });
    const body = await res.text();
    if (/already exists/i.test(body)) return NextResponse.json({ ok: true });
    console.error("waitlist: create contact failed", res.status, body.slice(0, 300));
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  } catch (err) {
    console.error("waitlist: resend unreachable", err);
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }
}
