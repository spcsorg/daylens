import { devSignInEnabled, signInChoices } from "@/lib/auth";
import { initials } from "@/lib/format";
import { signIn } from "../actions";
import { Empty } from "../ui/parts";

export const dynamic = "force-dynamic";

export default async function SignIn() {
  if (!devSignInEnabled()) {
    return (
      <main className="signin">
        <Empty lede="Sign-in isn’t set up here" line="Daylens Enterprise signs people in with their work Microsoft account. That arrives with the Entra sign-in; this server only has the dev sign-in, and it’s off." />
      </main>
    );
  }
  const choices = await signInChoices();
  return (
    <main className="signin">
      <h1>Dev sign-in</h1>
      <p className="muted">Pick someone from the invented firm. Only owners and admins can open the dashboard; picking anyone else shows what they would see.</p>
      {choices.length === 0 && <Empty lede="No one to sign in as" line="Seed the database first: npm run db:seed." />}
      <div>
        {choices.map((c) => (
          <form key={c.id} action={signIn.bind(null, c.id)}>
            <button type="submit" className="app-row">
              <span className="avatar">{initials(c.name)}</span>
              <span className="app-row-text">
                <span className="app-row-name">{c.name}</span>
                <span className="app-row-detail">
                  {c.title} · {c.role === "owner" ? "Owner" : c.role === "admin" ? "Admin" : "Employee"} · {c.org}
                </span>
              </span>
            </button>
          </form>
        ))}
      </div>
    </main>
  );
}
