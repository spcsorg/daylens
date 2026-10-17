import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const WAITLIST_SOURCES = ["hero", "closing", "devlog", "press"] as const;
export type WaitlistSource = (typeof WAITLIST_SOURCES)[number];
export type WaitlistPlatform = "windows" | "macos";

const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeWaitlistEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

export function parseWaitlistSource(value: unknown): WaitlistSource | "unknown" {
  return WAITLIST_SOURCES.find((source) => source === value) ?? "unknown";
}

export function parseWaitlistPlatform(value: unknown): WaitlistPlatform | undefined {
  return value === "windows" || value === "macos" ? value : undefined;
}

export const join = internalMutation({
  args: {
    email: v.string(),
    source: v.string(),
    platform: v.optional(v.union(v.literal("windows"), v.literal("macos"))),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("waitlist")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();

    if (existing) {
      if (args.platform && !existing.platform) {
        await ctx.db.patch(existing._id, { platform: args.platform });
      }
      return { added: false };
    }

    await ctx.db.insert("waitlist", {
      email: args.email,
      createdAt: Date.now(),
      source: args.source,
      platform: args.platform,
    });
    return { added: true };
  },
});
