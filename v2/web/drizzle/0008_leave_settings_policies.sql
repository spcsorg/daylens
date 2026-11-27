-- Leave: admins record, change and remove leave for people in their scope, through the same two layers as every write.
-- Settings: only an active owner changes the org's policy, members' roles, admin scope, status and teams, and rebuilds the
-- org's rollups when the policy changes how a day is counted. Every org keeps at least one active owner, for every role,
-- the table owner included.
GRANT SELECT, INSERT, UPDATE, DELETE ON leave TO daylens_app;
--> statement-breakpoint
ALTER TABLE leave ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY in_scope ON leave FOR ALL TO daylens_app
  USING (org_id = app_org_id() AND app_can_see(member_id))
  WITH CHECK (org_id = app_org_id() AND app_can_see(member_id));
--> statement-breakpoint
CREATE FUNCTION app_is_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT EXISTS (SELECT 1 FROM members WHERE id = app_admin_id() AND status = 'active' AND role = 'owner') $$;
--> statement-breakpoint
GRANT UPDATE (policy) ON orgs TO daylens_app;
--> statement-breakpoint
CREATE POLICY owner_update ON orgs FOR UPDATE TO daylens_app
  USING (id = app_org_id() AND app_is_owner()) WITH CHECK (id = app_org_id() AND app_is_owner());
--> statement-breakpoint
GRANT UPDATE (role, admin_scope, status) ON members TO daylens_app;
--> statement-breakpoint
CREATE POLICY owner_update ON members FOR UPDATE TO daylens_app
  USING (org_id = app_org_id() AND app_is_owner()) WITH CHECK (org_id = app_org_id() AND app_is_owner());
--> statement-breakpoint
GRANT INSERT, DELETE ON team_members TO daylens_app;
--> statement-breakpoint
CREATE POLICY owner_insert ON team_members FOR INSERT TO daylens_app
  WITH CHECK (org_id = app_org_id() AND app_is_owner()
    AND EXISTS (SELECT 1 FROM teams t WHERE t.id = team_id AND t.org_id = app_org_id())
    AND EXISTS (SELECT 1 FROM members m WHERE m.id = member_id AND m.org_id = app_org_id()));
--> statement-breakpoint
CREATE POLICY owner_delete ON team_members FOR DELETE TO daylens_app USING (org_id = app_org_id() AND app_is_owner());
--> statement-breakpoint
GRANT INSERT, DELETE ON daily_rollups TO daylens_app;
--> statement-breakpoint
CREATE POLICY owner_insert ON daily_rollups FOR INSERT TO daylens_app
  WITH CHECK (org_id = app_org_id() AND app_is_owner() AND EXISTS (SELECT 1 FROM members m WHERE m.id = member_id AND m.org_id = app_org_id()));
--> statement-breakpoint
CREATE POLICY owner_delete ON daily_rollups FOR DELETE TO daylens_app USING (org_id = app_org_id() AND app_is_owner());
--> statement-breakpoint
CREATE FUNCTION members_keep_an_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.role = 'owner' AND OLD.status = 'active' AND (NEW.role <> 'owner' OR NEW.status <> 'active') THEN
    -- One owner change per org at a time, so two owners can't demote each other at once.
    PERFORM 1 FROM orgs WHERE id = OLD.org_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM members WHERE org_id = OLD.org_id AND id <> OLD.id AND role = 'owner' AND status = 'active') THEN
      RAISE EXCEPTION 'An org needs at least one active owner' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER members_keep_an_owner BEFORE UPDATE OF role, status ON members FOR EACH ROW EXECUTE FUNCTION members_keep_an_owner();
