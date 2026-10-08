-- New-submission alerts start sending in this release. The toggle used to do
-- nothing ("New submission in my accounts", on by default), so a saved "on"
-- wasn't a choice to hear about every new item. Keep them to admins, as for a
-- member without saved preferences, until a member turns them on.
UPDATE "notification_preferences" SET "new_submission_realtime" = false
WHERE "workspace_user_id" IN (SELECT "id" FROM "workspace_users" WHERE "role" <> 'admin');
