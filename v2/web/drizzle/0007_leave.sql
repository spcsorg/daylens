CREATE TABLE "leave" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"type" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	CONSTRAINT "leave_dates_in_order" CHECK ("leave"."ends_on" >= "leave"."starts_on")
);
--> statement-breakpoint
ALTER TABLE "leave" ADD CONSTRAINT "leave_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave" ADD CONSTRAINT "leave_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leave_org_id_starts_on_index" ON "leave" USING btree ("org_id","starts_on");--> statement-breakpoint
CREATE INDEX "leave_member_id_starts_on_index" ON "leave" USING btree ("member_id","starts_on");