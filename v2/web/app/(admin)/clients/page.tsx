import { getCatalog } from "@/lib/data";
import { period } from "@/lib/period";
import { requireSession, today } from "@/lib/session";
import { ClientsScreen } from "./ClientsScreen";

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const [{ project }, session, now] = [await searchParams, await requireSession(), await today()];
  const week = period("week", undefined, now);
  const data = await getCatalog(session, { from: week.from, to: week.to });
  return <ClientsScreen data={data} selected={project} />;
}
