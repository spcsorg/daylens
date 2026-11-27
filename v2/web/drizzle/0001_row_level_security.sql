-- Second layer of tenant isolation. The app reads as daylens_app with app.admin_id set for the transaction;
-- these policies then return only rows in the admin's org and scope, whatever the query asks for.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daylens_app') THEN CREATE ROLE daylens_app NOLOGIN; END IF;
END $$;
--> statement-breakpoint
GRANT daylens_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO daylens_app;
--> statement-breakpoint
GRANT SELECT ON orgs, members, teams, team_members, devices, clients, projects, assignments, blocks, daily_rollups, timesheets, timesheet_lines, audit_log TO daylens_app;
--> statement-breakpoint
CREATE FUNCTION app_admin_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.admin_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app_org_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT org_id FROM members WHERE id = app_admin_id() AND status = 'active' AND role <> 'employee' $$;
--> statement-breakpoint
CREATE FUNCTION app_can_see(member uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM members a JOIN members m ON m.org_id = a.org_id
      WHERE a.id = app_admin_id() AND m.id = member AND a.status = 'active'
        AND (a.role = 'owner' OR (a.role = 'admin' AND a.admin_scope = 'org'))
    ) OR EXISTS (
      SELECT 1 FROM members a
      JOIN team_members s ON s.member_id = a.id AND s.is_admin_scope
      JOIN team_members t ON t.team_id = s.team_id
      WHERE a.id = app_admin_id() AND a.status = 'active' AND a.role = 'admin' AND t.member_id = member
    )
  $$;
--> statement-breakpoint
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own_org ON orgs FOR SELECT TO daylens_app USING (id = app_org_id());
--> statement-breakpoint
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own_org ON teams FOR SELECT TO daylens_app USING (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own_org ON clients FOR SELECT TO daylens_app USING (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own_org ON projects FOR SELECT TO daylens_app USING (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own_org ON assignments FOR SELECT TO daylens_app USING (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own_org ON audit_log FOR SELECT TO daylens_app USING (org_id = app_org_id());
--> statement-breakpoint
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY in_scope ON members FOR SELECT TO daylens_app
  USING (org_id = app_org_id() AND (id = app_admin_id() OR app_can_see(id)));
--> statement-breakpoint
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY in_scope ON team_members FOR SELECT TO daylens_app
  USING (org_id = app_org_id() AND (member_id = app_admin_id() OR app_can_see(member_id)));
--> statement-breakpoint
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY in_scope ON devices FOR SELECT TO daylens_app USING (org_id = app_org_id() AND app_can_see(member_id));
--> statement-breakpoint
ALTER TABLE blocks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY in_scope ON blocks FOR SELECT TO daylens_app USING (org_id = app_org_id() AND app_can_see(member_id));
--> statement-breakpoint
ALTER TABLE daily_rollups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY in_scope ON daily_rollups FOR SELECT TO daylens_app USING (org_id = app_org_id() AND app_can_see(member_id));
--> statement-breakpoint
ALTER TABLE timesheets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY in_scope ON timesheets FOR SELECT TO daylens_app USING (org_id = app_org_id() AND app_can_see(member_id));
--> statement-breakpoint
ALTER TABLE timesheet_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY in_scope ON timesheet_lines FOR SELECT TO daylens_app
  USING (EXISTS (SELECT 1 FROM timesheets t WHERE t.id = timesheet_id));
