-- A member always sees their own row, so the app can tell a signed-in employee from a stranger.
-- app_org_id() is null for employees and deactivated members, which hid their own row.
DROP POLICY in_scope ON members;
--> statement-breakpoint
CREATE POLICY in_scope ON members FOR SELECT TO daylens_app
  USING (id = app_admin_id() OR (org_id = app_org_id() AND app_can_see(id)));
