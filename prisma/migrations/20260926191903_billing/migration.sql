-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED');

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "price" DECIMAL(18,2) NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "billingDay" INTEGER NOT NULL DEFAULT 1,
    "paidThrough" DATE,
    "graceDays" INTEGER NOT NULL DEFAULT 5,
    "renewalBasis" "RenewalDueBasis" NOT NULL DEFAULT 'PREVIOUS_DUE_DATE',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIAL',
    "startedAt" DATE NOT NULL,
    "endedAt" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_payments" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "paidOn" DATE NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "periodsCovered" INTEGER NOT NULL DEFAULT 1,
    "coversFrom" DATE NOT NULL,
    "coversThrough" DATE NOT NULL,
    "recordedById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_organizationId_key" ON "subscriptions"("organizationId");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE INDEX "subscriptions_paidThrough_idx" ON "subscriptions"("paidThrough");

-- CreateIndex
CREATE INDEX "subscription_payments_organizationId_paidOn_idx" ON "subscription_payments"("organizationId", "paidOn");

-- CreateIndex
CREATE INDEX "subscription_payments_subscriptionId_paidOn_idx" ON "subscription_payments"("subscriptionId", "paidOn");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security for the two new tenant-scoped tables.
--
-- They hold the platform's revenue rather than a lender's books, but they carry
-- an organizationId and therefore follow the same rule as everything else: a
-- query that forgets its filter returns nothing.
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "subscriptions"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());

ALTER TABLE "subscription_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscription_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "subscription_payments"
  USING (app_is_system() OR "organizationId" = app_current_organization())
  WITH CHECK (app_is_system() OR "organizationId" = app_current_organization());
