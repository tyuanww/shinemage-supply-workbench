CREATE TABLE "factory_ownership_guards" (
  "order_line_id" text PRIMARY KEY REFERENCES "order_lines" ("id") ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO "factory_ownership_guards" ("order_line_id") SELECT "id" FROM "order_lines";
--> statement-breakpoint
CREATE FUNCTION "_new_factory_ownership_guard"() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  INSERT INTO "factory_ownership_guards" ("order_line_id") VALUES (NEW."id");
  RETURN NEW;
END
$body$;
--> statement-breakpoint
CREATE TRIGGER "_new_factory_ownership_guard" AFTER INSERT ON "order_lines"
FOR EACH ROW EXECUTE FUNCTION "_new_factory_ownership_guard"();
