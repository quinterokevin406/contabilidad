-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'COLLECTOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "InterestMethod" AS ENUM ('SIMPLE_ON_ORIGINAL_PRINCIPAL', 'SIMPLE_ON_OUTSTANDING_PRINCIPAL');

-- CreateEnum
CREATE TYPE "Periodicity" AS ENUM ('DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PeriodAnchor" AS ENUM ('CALENDAR', 'FIXED_DAYS');

-- CreateEnum
CREATE TYPE "RoundingMode" AS ENUM ('HALF_UP', 'HALF_EVEN', 'DOWN', 'UP');

-- CreateEnum
CREATE TYPE "LoanLifecycle" AS ENUM ('ACTIVE', 'PAID', 'CANCELLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ComplianceStatus" AS ENUM ('CURRENT', 'DUE_SOON', 'OVERDUE');

-- CreateEnum
CREATE TYPE "LoanPeriodStatus" AS ENUM ('SCHEDULED', 'PENDING', 'PARTIALLY_PAID', 'PAID', 'WAIVED');

-- CreateEnum
CREATE TYPE "OpenPeriodPolicy" AS ENUM ('NOT_CHARGED', 'FULL_PERIOD', 'PRORATED');

-- CreateEnum
CREATE TYPE "RenewalDueBasis" AS ENUM ('PREVIOUS_DUE_DATE', 'EFFECTIVE_DATE');

-- CreateEnum
CREATE TYPE "AllocationStrategy" AS ENUM ('INTEREST_FIRST', 'PRINCIPAL_FIRST', 'MANUAL_ONLY');

-- CreateEnum
CREATE TYPE "AllocationKind" AS ENUM ('INTEREST', 'PRINCIPAL', 'FEE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "SettlementKind" AS ENUM ('FULL_PAYMENT', 'WRITE_OFF');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('CAPITAL_CONTRIBUTION', 'LOAN_DISBURSEMENT', 'PRINCIPAL_RECOVERY', 'INTEREST_COLLECTION', 'FEE_COLLECTION', 'EXTRAORDINARY_INCOME', 'EXPENSE', 'OWNER_WITHDRAWAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CashDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "FinancialClass" AS ENUM ('PRINCIPAL', 'INTEREST', 'OPERATING_INCOME', 'OPERATING_EXPENSE', 'EQUITY_CONTRIBUTION', 'EQUITY_WITHDRAWAL', 'TRANSFER');

-- CreateEnum
CREATE TYPE "CapitalEventKind" AS ENUM ('CONTRIBUTION', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "SnapshotKind" AS ENUM ('WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "SnapshotStatus" AS ENUM ('DRAFT', 'CLOSED');

-- CreateEnum
CREATE TYPE "GoalKind" AS ENUM ('EQUITY_TARGET', 'MONTHLY_PROFIT', 'MAX_DELINQUENCY_RATIO', 'MAX_MONTHLY_EXPENSE', 'INTEREST_COLLECTED', 'RECOVERY_RATIO');

-- CreateEnum
CREATE TYPE "GoalDirection" AS ENUM ('AT_LEAST', 'AT_MOST');

-- CreateEnum
CREATE TYPE "AlertMetric" AS ENUM ('DELINQUENCY_RATIO', 'MONTHLY_EXPENSE_TOTAL', 'EXPENSE_TO_INCOME_RATIO', 'OVERDUE_LOAN_COUNT', 'OVERDUE_DAYS_MAX', 'CASH_DISCREPANCY_ABS', 'MISSING_MONTHLY_CLOSURE', 'MISSING_DAILY_CLOSURE');

-- CreateEnum
CREATE TYPE "AlertComparator" AS ENUM ('GREATER_THAN', 'GREATER_OR_EQUAL', 'LESS_THAN', 'LESS_OR_EQUAL');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertEventStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'REVERSE', 'ARCHIVE', 'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'EXPORT', 'SETTINGS_CHANGE');

-- CreateEnum
CREATE TYPE "ReversalTargetType" AS ENUM ('PAYMENT', 'CASH_MOVEMENT', 'EXPENSE_ENTRY', 'INCOME_ENTRY', 'CAPITAL_EVENT', 'RENEWAL', 'LOAN_DISBURSEMENT');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('DUE_TODAY', 'DUE_TOMORROW', 'OVERDUE', 'PENDING_DAILY_CLOSURE', 'PENDING_MONTHLY_CLOSURE', 'ALERT_TRIGGERED');

-- CreateTable
CREATE TABLE "period_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "SnapshotKind" NOT NULL,
    "status" "SnapshotStatus" NOT NULL DEFAULT 'DRAFT',
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodIndex" INTEGER NOT NULL,
    "openingEquity" DECIMAL(18,2) NOT NULL,
    "closingEquity" DECIMAL(18,2) NOT NULL,
    "ownerContributions" DECIMAL(18,2) NOT NULL,
    "ownerWithdrawals" DECIMAL(18,2) NOT NULL,
    "principalOutstanding" DECIMAL(18,2) NOT NULL,
    "cashAvailable" DECIMAL(18,2) NOT NULL,
    "principalDisbursed" DECIMAL(18,2) NOT NULL,
    "principalRecovered" DECIMAL(18,2) NOT NULL,
    "interestAccrued" DECIMAL(18,2) NOT NULL,
    "interestCollected" DECIMAL(18,2) NOT NULL,
    "otherIncome" DECIMAL(18,2) NOT NULL,
    "operatingExpenses" DECIMAL(18,2) NOT NULL,
    "netProfitCash" DECIMAL(18,2) NOT NULL,
    "netProfitAccrual" DECIMAL(18,2) NOT NULL,
    "portfolioOutstanding" DECIMAL(18,2) NOT NULL,
    "portfolioOverdue" DECIMAL(18,2) NOT NULL,
    "activeClients" INTEGER NOT NULL,
    "activeLoans" INTEGER NOT NULL,
    "newLoans" INTEGER NOT NULL,
    "settledLoans" INTEGER NOT NULL,
    "renewals" INTEGER NOT NULL,
    "overdueLoans" INTEGER NOT NULL,
    "avgOverdueDays" INTEGER NOT NULL DEFAULT 0,
    "executiveNotes" JSONB,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "period_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "period_snapshot_metrics" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "numerator" DECIMAL(18,2) NOT NULL,
    "denominator" DECIMAL(18,2) NOT NULL,
    "value" DECIMAL(12,4),
    "isComparable" BOOLEAN NOT NULL DEFAULT true,
    "notComparableReason" TEXT,
    "previousValue" DECIMAL(12,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "period_snapshot_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio_aging_buckets" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "fromDays" INTEGER NOT NULL,
    "toDays" INTEGER,
    "label" TEXT NOT NULL,
    "loanCount" INTEGER NOT NULL,
    "clientCount" INTEGER NOT NULL,
    "principalAmount" DECIMAL(18,2) NOT NULL,
    "interestAmount" DECIMAL(18,2) NOT NULL,
    "totalAmount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "portfolio_aging_buckets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "GoalKind" NOT NULL,
    "direction" "GoalDirection" NOT NULL,
    "label" TEXT NOT NULL,
    "targetValue" DECIMAL(18,4) NOT NULL,
    "effectiveFrom" DATE,
    "effectiveTo" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "metric" "AlertMetric" NOT NULL,
    "comparator" "AlertComparator" NOT NULL,
    "threshold" DECIMAL(18,4) NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'WARNING',
    "label" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "observedValue" DECIMAL(18,4) NOT NULL,
    "threshold" DECIMAL(18,4) NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "status" "AlertEventStatus" NOT NULL DEFAULT 'OPEN',
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evaluatedOn" DATE NOT NULL,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "beforeValues" JSONB,
    "afterValues" JSONB,
    "summary" TEXT,
    "reason" TEXT,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reversals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "targetType" "ReversalTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "originalSnapshot" JSONB NOT NULL,
    "reversedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reversals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "quantity" INTEGER,
    "amount" DECIMAL(18,2),
    "href" TEXT,
    "referenceDate" DATE NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_accounts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "openingBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "openedOn" DATE NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "cash_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "cashAccountId" TEXT NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "direction" "CashDirection" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "financialClass" "FinancialClass" NOT NULL,
    "occurredOn" DATE NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "loanId" TEXT,
    "clientId" TEXT,
    "paymentId" TEXT,
    "renewalId" TEXT,
    "expenseId" TEXT,
    "incomeId" TEXT,
    "capitalEventId" TEXT,
    "reversesMovementId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_categories" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "financialClass" "FinancialClass" NOT NULL,
    "systemKey" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transaction_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "income_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "occurredOn" DATE NOT NULL,
    "concept" TEXT NOT NULL,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "income_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "occurredOn" DATE NOT NULL,
    "concept" TEXT NOT NULL,
    "notes" TEXT,
    "receiptUrl" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "expense_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capital_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "CapitalEventKind" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "occurredOn" DATE NOT NULL,
    "concept" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "capital_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_closures" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "cashAccountId" TEXT NOT NULL,
    "closureDate" DATE NOT NULL,
    "openingBalance" DECIMAL(18,2) NOT NULL,
    "totalIn" DECIMAL(18,2) NOT NULL,
    "totalOut" DECIMAL(18,2) NOT NULL,
    "expectedBalance" DECIMAL(18,2) NOT NULL,
    "countedBalance" DECIMAL(18,2) NOT NULL,
    "difference" DECIMAL(18,2) NOT NULL,
    "notes" TEXT,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reopenedAt" TIMESTAMP(3),
    "reopenedReason" TEXT,

    CONSTRAINT "cash_closures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "documentType" TEXT,
    "documentNumber" TEXT,
    "phone" TEXT,
    "whatsappPhone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "city" TEXT,
    "referenceName" TEXT,
    "referencePhone" TEXT,
    "notes" TEXT,
    "photoUrl" TEXT,
    "status" "ClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "assignedCollectorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_tags" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "colorToken" TEXT NOT NULL DEFAULT 'slate',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_tag_links" (
    "clientId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "client_tag_links_pkey" PRIMARY KEY ("clientId","tagId")
);

-- CreateTable
CREATE TABLE "loans" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "originalPrincipal" DECIMAL(18,2) NOT NULL,
    "currentPrincipalBase" DECIMAL(18,2) NOT NULL,
    "outstandingPrincipal" DECIMAL(18,2) NOT NULL,
    "ratePercent" DECIMAL(9,4) NOT NULL,
    "periodicity" "Periodicity" NOT NULL,
    "customPeriodDays" INTEGER,
    "interestMethod" "InterestMethod" NOT NULL,
    "allocationStrategy" "AllocationStrategy" NOT NULL,
    "periodAnchor" "PeriodAnchor" NOT NULL,
    "roundingMode" "RoundingMode" NOT NULL,
    "openPeriodPolicy" "OpenPeriodPolicy" NOT NULL,
    "renewalDueBasis" "RenewalDueBasis" NOT NULL,
    "moneyQuantum" DECIMAL(18,2) NOT NULL,
    "disbursedOn" DATE NOT NULL,
    "firstDueOn" DATE NOT NULL,
    "nextDueOn" DATE,
    "maturityOn" DATE,
    "lastPeriodIndex" INTEGER NOT NULL DEFAULT 0,
    "lastAccruedAt" TIMESTAMP(3),
    "lifecycle" "LoanLifecycle" NOT NULL DEFAULT 'ACTIVE',
    "compliance" "ComplianceStatus" NOT NULL DEFAULT 'CURRENT',
    "daysOverdue" INTEGER NOT NULL DEFAULT 0,
    "renewalCount" INTEGER NOT NULL DEFAULT 0,
    "closedOn" DATE,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_periods" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "periodIndex" INTEGER NOT NULL,
    "startsOn" DATE NOT NULL,
    "dueOn" DATE NOT NULL,
    "principalBasis" DECIMAL(18,2) NOT NULL,
    "rateApplied" DECIMAL(9,4) NOT NULL,
    "interestAccrued" DECIMAL(18,2) NOT NULL,
    "interestPaid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "interestWaived" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "LoanPeriodStatus" NOT NULL DEFAULT 'SCHEDULED',
    "accruedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "closedByRenewalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loan_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "renewals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "effectiveOn" DATE NOT NULL,
    "previousPrincipalBase" DECIMAL(18,2) NOT NULL,
    "newPrincipalBase" DECIMAL(18,2) NOT NULL,
    "additionalDisbursed" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "principalCollected" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "interestCollected" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "newDueOn" DATE NOT NULL,
    "dueBasisApplied" "RenewalDueBasis" NOT NULL,
    "interestCarried" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paymentId" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "renewals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "kind" "SettlementKind" NOT NULL,
    "settledOn" DATE NOT NULL,
    "openPeriodPolicyApplied" "OpenPeriodPolicy" NOT NULL,
    "openPeriodCharge" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "principalOutstandingAtSettlement" DECIMAL(18,2) NOT NULL,
    "interestOutstandingAtSettlement" DECIMAL(18,2) NOT NULL,
    "principalCollected" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "interestCollected" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amountWrittenOff" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "paidOn" DATE NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentMethodId" TEXT,
    "manualAllocation" BOOLEAN NOT NULL DEFAULT false,
    "strategyApplied" "AllocationStrategy" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'POSTED',
    "reversedAt" TIMESTAMP(3),
    "reversalId" TEXT,
    "notes" TEXT,
    "createdById" TEXT,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "kind" "AllocationKind" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "loanPeriodId" TEXT,
    "concept" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'ADMIN',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "sessionVersion" INTEGER NOT NULL DEFAULT 1,
    "lastLoginAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "organization_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "logoUrl" TEXT,
    "currencyCode" TEXT NOT NULL DEFAULT 'COP',
    "timeZone" TEXT NOT NULL DEFAULT 'America/Bogota',
    "locale" TEXT NOT NULL DEFAULT 'es-CO',
    "defaultInterestMethod" "InterestMethod" NOT NULL DEFAULT 'SIMPLE_ON_ORIGINAL_PRINCIPAL',
    "defaultPeriodicity" "Periodicity" NOT NULL DEFAULT 'MONTHLY',
    "defaultAllocationStrategy" "AllocationStrategy" NOT NULL DEFAULT 'INTEREST_FIRST',
    "defaultPeriodAnchor" "PeriodAnchor" NOT NULL DEFAULT 'CALENDAR',
    "defaultRoundingMode" "RoundingMode" NOT NULL DEFAULT 'HALF_UP',
    "defaultOpenPeriodPolicy" "OpenPeriodPolicy" NOT NULL DEFAULT 'FULL_PERIOD',
    "defaultRenewalDueBasis" "RenewalDueBasis" NOT NULL DEFAULT 'PREVIOUS_DUE_DATE',
    "moneyQuantum" DECIMAL(18,2) NOT NULL DEFAULT 1,
    "dueSoonLeadDays" INTEGER NOT NULL DEFAULT 3,
    "overdueGraceDays" INTEGER NOT NULL DEFAULT 0,
    "rateReviewThresholdPercent" DECIMAL(9,4),
    "rateReviewNote" TEXT,
    "receiptPrefix" TEXT NOT NULL DEFAULT 'REC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "systemKey" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_sequences" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipt_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "resultId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "period_snapshots_organizationId_kind_periodYear_periodIndex_idx" ON "period_snapshots"("organizationId", "kind", "periodYear", "periodIndex");

-- CreateIndex
CREATE INDEX "period_snapshots_organizationId_kind_status_idx" ON "period_snapshots"("organizationId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "period_snapshots_organizationId_kind_periodStart_key" ON "period_snapshots"("organizationId", "kind", "periodStart");

-- CreateIndex
CREATE INDEX "period_snapshot_metrics_organizationId_metricKey_idx" ON "period_snapshot_metrics"("organizationId", "metricKey");

-- CreateIndex
CREATE UNIQUE INDEX "period_snapshot_metrics_snapshotId_metricKey_key" ON "period_snapshot_metrics"("snapshotId", "metricKey");

-- CreateIndex
CREATE UNIQUE INDEX "portfolio_aging_buckets_snapshotId_fromDays_key" ON "portfolio_aging_buckets"("snapshotId", "fromDays");

-- CreateIndex
CREATE INDEX "goals_organizationId_isActive_idx" ON "goals"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "goals_organizationId_kind_idx" ON "goals"("organizationId", "kind");

-- CreateIndex
CREATE INDEX "alert_rules_organizationId_isActive_idx" ON "alert_rules"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "alert_rules_organizationId_metric_comparator_threshold_key" ON "alert_rules"("organizationId", "metric", "comparator", "threshold");

-- CreateIndex
CREATE INDEX "alert_events_organizationId_status_triggeredAt_idx" ON "alert_events"("organizationId", "status", "triggeredAt");

-- CreateIndex
CREATE UNIQUE INDEX "alert_events_ruleId_evaluatedOn_key" ON "alert_events"("ruleId", "evaluatedOn");

-- CreateIndex
CREATE INDEX "audit_logs_organizationId_createdAt_idx" ON "audit_logs"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_organizationId_entity_entityId_idx" ON "audit_logs"("organizationId", "entity", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_organizationId_action_createdAt_idx" ON "audit_logs"("organizationId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "reversals_organizationId_createdAt_idx" ON "reversals"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "reversals_targetType_targetId_key" ON "reversals"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "notifications_organizationId_readAt_idx" ON "notifications"("organizationId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_organizationId_kind_referenceDate_key" ON "notifications"("organizationId", "kind", "referenceDate");

-- CreateIndex
CREATE INDEX "cash_accounts_organizationId_isActive_idx" ON "cash_accounts"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "cash_accounts_organizationId_name_key" ON "cash_accounts"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "cash_movements_reversesMovementId_key" ON "cash_movements"("reversesMovementId");

-- CreateIndex
CREATE INDEX "cash_movements_organizationId_occurredOn_idx" ON "cash_movements"("organizationId", "occurredOn");

-- CreateIndex
CREATE INDEX "cash_movements_organizationId_financialClass_occurredOn_idx" ON "cash_movements"("organizationId", "financialClass", "occurredOn");

-- CreateIndex
CREATE INDEX "cash_movements_organizationId_type_occurredOn_idx" ON "cash_movements"("organizationId", "type", "occurredOn");

-- CreateIndex
CREATE INDEX "cash_movements_cashAccountId_occurredOn_idx" ON "cash_movements"("cashAccountId", "occurredOn");

-- CreateIndex
CREATE INDEX "transaction_categories_organizationId_financialClass_isActi_idx" ON "transaction_categories"("organizationId", "financialClass", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_categories_organizationId_name_financialClass_key" ON "transaction_categories"("organizationId", "name", "financialClass");

-- CreateIndex
CREATE INDEX "income_entries_organizationId_occurredOn_idx" ON "income_entries"("organizationId", "occurredOn");

-- CreateIndex
CREATE INDEX "income_entries_categoryId_occurredOn_idx" ON "income_entries"("categoryId", "occurredOn");

-- CreateIndex
CREATE INDEX "expense_entries_organizationId_occurredOn_idx" ON "expense_entries"("organizationId", "occurredOn");

-- CreateIndex
CREATE INDEX "expense_entries_categoryId_occurredOn_idx" ON "expense_entries"("categoryId", "occurredOn");

-- CreateIndex
CREATE INDEX "capital_events_organizationId_occurredOn_idx" ON "capital_events"("organizationId", "occurredOn");

-- CreateIndex
CREATE INDEX "capital_events_organizationId_kind_occurredOn_idx" ON "capital_events"("organizationId", "kind", "occurredOn");

-- CreateIndex
CREATE INDEX "cash_closures_organizationId_closureDate_idx" ON "cash_closures"("organizationId", "closureDate");

-- CreateIndex
CREATE UNIQUE INDEX "cash_closures_cashAccountId_closureDate_key" ON "cash_closures"("cashAccountId", "closureDate");

-- CreateIndex
CREATE INDEX "clients_organizationId_status_idx" ON "clients"("organizationId", "status");

-- CreateIndex
CREATE INDEX "clients_organizationId_fullName_idx" ON "clients"("organizationId", "fullName");

-- CreateIndex
CREATE INDEX "clients_organizationId_phone_idx" ON "clients"("organizationId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "clients_organizationId_code_key" ON "clients"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "clients_organizationId_documentNumber_key" ON "clients"("organizationId", "documentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "client_tags_organizationId_name_key" ON "client_tags"("organizationId", "name");

-- CreateIndex
CREATE INDEX "client_tag_links_tagId_idx" ON "client_tag_links"("tagId");

-- CreateIndex
CREATE INDEX "loans_organizationId_lifecycle_compliance_idx" ON "loans"("organizationId", "lifecycle", "compliance");

-- CreateIndex
CREATE INDEX "loans_organizationId_nextDueOn_idx" ON "loans"("organizationId", "nextDueOn");

-- CreateIndex
CREATE INDEX "loans_organizationId_clientId_idx" ON "loans"("organizationId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "loans_organizationId_code_key" ON "loans"("organizationId", "code");

-- CreateIndex
CREATE INDEX "loan_periods_organizationId_dueOn_status_idx" ON "loan_periods"("organizationId", "dueOn", "status");

-- CreateIndex
CREATE INDEX "loan_periods_organizationId_status_idx" ON "loan_periods"("organizationId", "status");

-- CreateIndex
CREATE INDEX "loan_periods_loanId_status_idx" ON "loan_periods"("loanId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "loan_periods_loanId_periodIndex_key" ON "loan_periods"("loanId", "periodIndex");

-- CreateIndex
CREATE UNIQUE INDEX "renewals_paymentId_key" ON "renewals"("paymentId");

-- CreateIndex
CREATE INDEX "renewals_organizationId_effectiveOn_idx" ON "renewals"("organizationId", "effectiveOn");

-- CreateIndex
CREATE UNIQUE INDEX "renewals_loanId_sequence_key" ON "renewals"("loanId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_loanId_key" ON "settlements"("loanId");

-- CreateIndex
CREATE INDEX "settlements_organizationId_settledOn_idx" ON "settlements"("organizationId", "settledOn");

-- CreateIndex
CREATE UNIQUE INDEX "payments_reversalId_key" ON "payments"("reversalId");

-- CreateIndex
CREATE INDEX "payments_organizationId_paidOn_idx" ON "payments"("organizationId", "paidOn");

-- CreateIndex
CREATE INDEX "payments_organizationId_status_idx" ON "payments"("organizationId", "status");

-- CreateIndex
CREATE INDEX "payments_loanId_paidOn_idx" ON "payments"("loanId", "paidOn");

-- CreateIndex
CREATE INDEX "payments_clientId_paidOn_idx" ON "payments"("clientId", "paidOn");

-- CreateIndex
CREATE UNIQUE INDEX "payments_organizationId_receiptNumber_key" ON "payments"("organizationId", "receiptNumber");

-- CreateIndex
CREATE INDEX "payment_allocations_paymentId_idx" ON "payment_allocations"("paymentId");

-- CreateIndex
CREATE INDEX "payment_allocations_loanPeriodId_idx" ON "payment_allocations"("loanPeriodId");

-- CreateIndex
CREATE INDEX "payment_allocations_organizationId_kind_idx" ON "payment_allocations"("organizationId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "users_organizationId_role_idx" ON "users"("organizationId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "users_organizationId_email_key" ON "users"("organizationId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_providerAccountId_key" ON "accounts"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_sessionToken_key" ON "sessions"("sessionToken");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_token_key" ON "verification_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_identifier_token_key" ON "verification_tokens"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "organization_settings_organizationId_key" ON "organization_settings"("organizationId");

-- CreateIndex
CREATE INDEX "payment_methods_organizationId_isActive_idx" ON "payment_methods"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_organizationId_name_key" ON "payment_methods"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_sequences_organizationId_scope_key" ON "receipt_sequences"("organizationId", "scope");

-- CreateIndex
CREATE INDEX "idempotency_keys_organizationId_operation_idx" ON "idempotency_keys"("organizationId", "operation");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_organizationId_key_key" ON "idempotency_keys"("organizationId", "key");

-- AddForeignKey
ALTER TABLE "period_snapshots" ADD CONSTRAINT "period_snapshots_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "period_snapshots" ADD CONSTRAINT "period_snapshots_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "period_snapshot_metrics" ADD CONSTRAINT "period_snapshot_metrics_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "period_snapshot_metrics" ADD CONSTRAINT "period_snapshot_metrics_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "period_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_aging_buckets" ADD CONSTRAINT "portfolio_aging_buckets_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "period_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reversals" ADD CONSTRAINT "reversals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reversals" ADD CONSTRAINT "reversals_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_accounts" ADD CONSTRAINT "cash_accounts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "cash_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_renewalId_fkey" FOREIGN KEY ("renewalId") REFERENCES "renewals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "expense_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_incomeId_fkey" FOREIGN KEY ("incomeId") REFERENCES "income_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_capitalEventId_fkey" FOREIGN KEY ("capitalEventId") REFERENCES "capital_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_reversesMovementId_fkey" FOREIGN KEY ("reversesMovementId") REFERENCES "cash_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_categories" ADD CONSTRAINT "transaction_categories_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "income_entries" ADD CONSTRAINT "income_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "income_entries" ADD CONSTRAINT "income_entries_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "transaction_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "income_entries" ADD CONSTRAINT "income_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "transaction_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capital_events" ADD CONSTRAINT "capital_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capital_events" ADD CONSTRAINT "capital_events_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_closures" ADD CONSTRAINT "cash_closures_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_closures" ADD CONSTRAINT "cash_closures_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "cash_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_closures" ADD CONSTRAINT "cash_closures_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_assignedCollectorId_fkey" FOREIGN KEY ("assignedCollectorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_tags" ADD CONSTRAINT "client_tags_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_tag_links" ADD CONSTRAINT "client_tag_links_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_tag_links" ADD CONSTRAINT "client_tag_links_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "client_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_periods" ADD CONSTRAINT "loan_periods_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_periods" ADD CONSTRAINT "loan_periods_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_periods" ADD CONSTRAINT "loan_periods_closedByRenewalId_fkey" FOREIGN KEY ("closedByRenewalId") REFERENCES "renewals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewals" ADD CONSTRAINT "renewals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewals" ADD CONSTRAINT "renewals_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewals" ADD CONSTRAINT "renewals_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewals" ADD CONSTRAINT "renewals_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_reversalId_fkey" FOREIGN KEY ("reversalId") REFERENCES "reversals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_loanPeriodId_fkey" FOREIGN KEY ("loanPeriodId") REFERENCES "loan_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_sequences" ADD CONSTRAINT "receipt_sequences_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
