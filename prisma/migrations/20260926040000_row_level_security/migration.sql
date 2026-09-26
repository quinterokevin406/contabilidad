-- Row-Level Security: tenant isolation enforced by PostgreSQL itself.
--
-- The application already filters every query by organizationId. This is the
-- layer underneath that: if one query ever forgets, the database returns zero
-- rows instead of another lender's clients. A missing filter becomes an empty
-- screen — a bug someone reports — rather than a silent data leak nobody
-- notices until it is in court.
--
-- The context is a transaction-local setting. It is never session-wide, so it
-- cannot survive a connection being returned to the pool and picked up by the
-- next request.

-- Empty when unset, which matches no organization: absence of context denies
-- access rather than granting it.
CREATE OR REPLACE FUNCTION app_current_organization() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(current_setting('app.organization_id', true), '') $$;

-- Reserved for migrations, the seed and backups, which legitimately operate
-- across every tenant. Application code must never set this value.
CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(current_setting('app.organization_id', true), '') = '*' $$;

ALTER TABLE "alert_events" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "alert_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "alert_events"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "alert_rules" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "alert_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "alert_rules"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_logs"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "capital_events" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "capital_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "capital_events"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "cash_accounts" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "cash_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cash_accounts"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "cash_closures" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "cash_closures" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cash_closures"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "cash_movements" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "cash_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cash_movements"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "client_tags" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "client_tags" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "client_tags"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "clients" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "clients"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "expense_entries" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "expense_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "expense_entries"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "goals" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "goals" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "goals"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "idempotency_keys"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "income_entries" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "income_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "income_entries"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "loan_periods" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "loan_periods" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "loan_periods"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "loans" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "loans" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "loans"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notifications"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "organization_settings" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "organization_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "organization_settings"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "payment_allocations" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "payment_allocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payment_allocations"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "payment_methods" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "payment_methods" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payment_methods"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payments"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "period_snapshot_metrics" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "period_snapshot_metrics" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "period_snapshot_metrics"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "period_snapshots" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "period_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "period_snapshots"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "receipt_sequences" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "receipt_sequences" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "receipt_sequences"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "renewals" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "renewals" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "renewals"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "reversals" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "reversals" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reversals"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "settlements" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "settlements" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "settlements"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "transaction_categories" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "transaction_categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "transaction_categories"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "users"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "organizations"
  USING (app_is_system() OR "id" = app_current_organization())
  WITH CHECK (app_is_system() OR "id" = app_current_organization());

ALTER TABLE "client_tag_links" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "client_tag_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "client_tag_links"
  USING (app_is_system() OR EXISTS (SELECT 1 FROM "clients" c WHERE c."id" = "client_tag_links"."clientId"))
  WITH CHECK (app_is_system() OR EXISTS (SELECT 1 FROM "clients" c WHERE c."id" = "client_tag_links"."clientId"));

ALTER TABLE "portfolio_aging_buckets" ENABLE ROW LEVEL SECURITY;
-- FORCE so the owner is subject to it too. Without this the application role,
-- which owns the tables, would bypass every policy and this file would be
-- decoration.
ALTER TABLE "portfolio_aging_buckets" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "portfolio_aging_buckets"
  USING (app_is_system() OR EXISTS (SELECT 1 FROM "period_snapshots" s WHERE s."id" = "portfolio_aging_buckets"."snapshotId"))
  WITH CHECK (app_is_system() OR EXISTS (SELECT 1 FROM "period_snapshots" s WHERE s."id" = "portfolio_aging_buckets"."snapshotId"));

-- Deliberately NOT covered: _prisma_migrations (schema bookkeeping) and the
-- sessions/accounts/verification_tokens tables, which are read to authenticate
-- a request before any tenant context can exist. They hold no financial data.
