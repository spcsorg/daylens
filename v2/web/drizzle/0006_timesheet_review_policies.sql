-- Admins review timesheets of people in their scope: approve, send back with a comment, or reopen an approved one with a reason.
-- The role can change only the review columns; employees (no app_org_id) change nothing.
-- Every change to a timesheet or its lines bumps its version, so the app can refuse a review of a copy that changed since it was read.
-- An approved timesheet is locked for everyone, the app role and the table owner alike: its lines can't change,
-- and it can only go back to submitted, with a reason.
GRANT UPDATE (status, approved_by, approved_at, review_note) ON timesheets TO daylens_app;
--> statement-breakpoint
CREATE POLICY in_scope_update ON timesheets FOR UPDATE TO daylens_app
  USING (org_id = app_org_id() AND app_can_see(member_id))
  WITH CHECK (org_id = app_org_id() AND app_can_see(member_id) AND status IN ('submitted', 'approved', 'rejected')
    AND (status <> 'approved' OR approved_by = app_admin_id()));
--> statement-breakpoint
CREATE FUNCTION timesheets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.org_id, NEW.member_id, NEW.week_start) IS DISTINCT FROM (OLD.org_id, OLD.member_id, OLD.week_start) THEN
    RAISE EXCEPTION 'A timesheet keeps its person and week' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'approved' AND NEW.status <> 'submitted' THEN
    RAISE EXCEPTION 'Timesheet % is approved and locked. Reopen it first', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'approved' AND (coalesce(NEW.review_note, '') !~ '\S' OR NEW.review_note IS NOT DISTINCT FROM OLD.review_note) THEN
    RAISE EXCEPTION 'Reopening timesheet % needs a reason', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER timesheets_guard BEFORE UPDATE ON timesheets FOR EACH ROW EXECUTE FUNCTION timesheets_guard();
--> statement-breakpoint
CREATE FUNCTION timesheet_lines_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  sheets uuid[] := CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW.timesheet_id] WHEN 'DELETE' THEN ARRAY[OLD.timesheet_id] ELSE ARRAY[OLD.timesheet_id, NEW.timesheet_id] END;
BEGIN
  IF EXISTS (SELECT 1 FROM timesheets WHERE id = ANY (sheets) AND status = 'approved') THEN
    RAISE EXCEPTION 'That timesheet is approved and locked. Reopen it first' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE timesheets SET version = version + 1 WHERE id = ANY (sheets);
  IF TG_OP <> 'DELETE' AND NOT FOUND THEN
    RAISE EXCEPTION 'That timesheet doesn''t exist' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER timesheet_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON timesheet_lines FOR EACH ROW EXECUTE FUNCTION timesheet_lines_guard();
