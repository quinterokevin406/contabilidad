-- The operator of the platform, as distinct from a lender's own administrator.
--
-- Every customer has an ADMIN, so that role cannot gate anything that crosses
-- organizations. This flag is granted from the server only.
ALTER TABLE "users" ADD COLUMN "isPlatformOwner" BOOLEAN NOT NULL DEFAULT false;

-- Reading it is how the application decides whether to cross tenants at all,
-- so the lookup has to be cheap and the set is expected to be tiny.
CREATE INDEX "users_isPlatformOwner_idx" ON "users" ("isPlatformOwner")
  WHERE "isPlatformOwner";
