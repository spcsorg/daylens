import Link from "next/link";
import { getSettings } from "@/lib/data";
import { requireSession } from "@/lib/session";
import { Header } from "../../ui/parts";
import { MembersTab, PolicyTab } from "./SettingsScreen";

type Params = Record<string, string | undefined>;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const data = await getSettings(await requireSession());
  const tab = params.tab === "members" ? "members" : "policy";
  return (
    <>
      <Header title="Settings" sub={data.canEdit ? "Firm policy, people and roles" : "Only an owner can change these. You can see them."} />
      <div className="scroll">
        <nav className="settings-tabs" aria-label="Settings">
          <Link href="/settings" aria-current={tab === "policy" ? "page" : undefined}>Policy</Link>
          <Link href="/settings?tab=members" aria-current={tab === "members" ? "page" : undefined}>
            Members <span className="faint">{data.members.filter((m) => m.active).length}</span>
          </Link>
        </nav>
        {tab === "policy" ? <PolicyTab data={data} /> : <MembersTab data={data} />}
      </div>
    </>
  );
}
