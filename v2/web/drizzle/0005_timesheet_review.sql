ALTER TABLE "audit_log" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "timesheet_lines" ADD CONSTRAINT "timesheet_lines_quarter_hours" CHECK ("timesheet_lines"."hours" > 0 and "timesheet_lines"."hours" <= 24 and "timesheet_lines"."hours" * 4 = trunc("timesheet_lines"."hours" * 4));--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_rejected_has_note" CHECK ("timesheets"."status" <> 'rejected' or length(trim(coalesce("timesheets"."review_note", ''))) > 0);--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_approved_has_approver" CHECK ("timesheets"."status" <> 'approved' or ("timesheets"."approved_by" is not null and "timesheets"."approved_at" is not null));