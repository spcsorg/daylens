-- Writes go through the same two layers as reads. Owners and admins write clients and projects in their org;
-- an admin scoped to teams assigns only people and teams in that scope. Clients and projects are archived, never deleted.
-- Every write adds an audit_log row as the signed-in admin.
GRANT INSERT, UPDATE ON clients, projects TO daylens_app;
--> statement-breakpoint
GRANT INSERT, UPDATE, DELETE ON assignments TO daylens_app;
--> statement-breakpoint
GRANT INSERT ON audit_log TO daylens_app;
--> statement-breakpoint
CREATE FUNCTION app_can_assign(member uuid, team uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT CASE
      WHEN member IS NOT NULL AND team IS NULL THEN app_can_see(member)
      WHEN team IS NOT NULL AND member IS NULL THEN EXISTS (
        SELECT 1 FROM teams t JOIN members a ON a.org_id = t.org_id
        WHERE t.id = team AND a.id = app_admin_id() AND a.status = 'active'
          AND (a.role = 'owner' OR (a.role = 'admin' AND a.admin_scope = 'org')
            OR (a.role = 'admin' AND EXISTS (SELECT 1 FROM team_members s WHERE s.member_id = a.id AND s.team_id = t.id AND s.is_admin_scope)))
      )
      ELSE false
    END
  $$;
--> statement-breakpoint
CREATE POLICY own_org_insert ON clients FOR INSERT TO daylens_app WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
CREATE POLICY own_org_update ON clients FOR UPDATE TO daylens_app USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
CREATE POLICY own_org_insert ON projects FOR INSERT TO daylens_app
  WITH CHECK (org_id = app_org_id() AND EXISTS (SELECT 1 FROM clients c WHERE c.id = client_id AND c.org_id = app_org_id()));
--> statement-breakpoint
CREATE POLICY own_org_update ON projects FOR UPDATE TO daylens_app USING (org_id = app_org_id())
  WITH CHECK (org_id = app_org_id() AND EXISTS (SELECT 1 FROM clients c WHERE c.id = client_id AND c.org_id = app_org_id()));
--> statement-breakpoint
CREATE POLICY in_scope_insert ON assignments FOR INSERT TO daylens_app
  WITH CHECK (org_id = app_org_id() AND app_can_assign(member_id, team_id) AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.org_id = app_org_id()));
--> statement-breakpoint
CREATE POLICY in_scope_update ON assignments FOR UPDATE TO daylens_app
  USING (org_id = app_org_id() AND app_can_assign(member_id, team_id))
  WITH CHECK (org_id = app_org_id() AND app_can_assign(member_id, team_id) AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.org_id = app_org_id()));
--> statement-breakpoint
CREATE POLICY in_scope_delete ON assignments FOR DELETE TO daylens_app USING (org_id = app_org_id() AND app_can_assign(member_id, team_id));
--> statement-breakpoint
CREATE POLICY own_org_insert ON audit_log FOR INSERT TO daylens_app WITH CHECK (org_id = app_org_id() AND actor_id = app_admin_id());
