ALTER TABLE "clients" ADD COLUMN "email_domains" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_org_id_code_index" ON "clients" USING btree ("org_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_id_code_index" ON "projects" USING btree ("org_id",lower("code"));--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_one_assignee" CHECK (("assignments"."member_id" is null) <> ("assignments"."team_id" is null));--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_dates_in_order" CHECK ("assignments"."ends_at" is null or "assignments"."starts_at" is null or "assignments"."ends_at" >= "assignments"."starts_at");