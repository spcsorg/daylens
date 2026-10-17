import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("delete expired rate limits", { minutes: 15 }, internal.httpRateLimits.deleteExpired, {});

export default crons;
