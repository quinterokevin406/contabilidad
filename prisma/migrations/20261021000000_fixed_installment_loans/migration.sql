-- Fixed-instalment loans: a closed term with one quoted figure per period.
--
-- Purely additive. Every existing loan keeps repaymentPlan = OPEN_ENDED, which
-- is exactly how it already behaved, and the four new columns stay null on it.
-- No row changes meaning, so there is nothing to backfill and nothing to undo.

-- CreateEnum
CREATE TYPE "RepaymentPlan" AS ENUM ('OPEN_ENDED', 'FIXED_INSTALLMENTS');

-- AlterTable
ALTER TABLE "loan_periods" ADD COLUMN     "principalDue" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "loans" ADD COLUMN     "agreedTotal" DECIMAL(18,2),
ADD COLUMN     "installmentAmount" DECIMAL(18,2),
ADD COLUMN     "installmentQuantum" DECIMAL(18,2),
ADD COLUMN     "repaymentPlan" "RepaymentPlan" NOT NULL DEFAULT 'OPEN_ENDED',
ADD COLUMN     "termPeriods" INTEGER;
