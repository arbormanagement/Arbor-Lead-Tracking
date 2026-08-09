--> Leasing now draws only from pools flagged `is_dni`, so that a number
--> provisioned for a mailer/billboard cannot be handed to website visitors before
--> the admin marks it static. New numbers default to pool 'reserved' (is_dni
--> false) and are therefore out of rotation until deliberately placed in a pool.
-->
--> Numbers that are ALREADY rotating must keep rotating: under the previous rule
--> every active non-static number was in the website pool regardless of its pool
--> label, so any such number still sitting in 'reserved' would silently drop out
--> of rotation the moment the join lands — emptying the live pool and sending
--> every visitor to the static fallback. Move them into a DNI-flagged pool so
--> behavior is unchanged for traffic that exists today.
-->
--> 'direct' is the site's default-source pool; the choice is cosmetic because
--> leasing treats all DNI pools as one shared rotation.
UPDATE "tracking_numbers"
SET "pool" = 'direct'
WHERE "is_static" = false
  AND "status" = 'active'
  AND "pool" IN (
    SELECT "key" FROM "pools" WHERE "is_dni" = false
  );
