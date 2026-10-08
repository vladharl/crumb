-- Public changelog entries reach customers from this release: the widget's
-- What's new tab, the public changelog page and its email followers. Drafting
-- used to mark every shipped initiative's entry public, private initiatives'
-- too, while nothing customer-facing listed them. Make those private, as
-- drafting now does, so no private initiative's name shows up on deploy.
UPDATE "changelog_entries" SET "is_public" = false
FROM "initiatives"
WHERE "changelog_entries"."initiative_id" = "initiatives"."id"
  AND "initiatives"."is_public" = false
  AND "changelog_entries"."is_public" = true;
