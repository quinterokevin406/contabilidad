-- AlterEnum
ALTER TYPE "CashMovementType" ADD VALUE 'PRINCIPAL_WRITE_OFF';

-- AlterTable
ALTER TABLE "cash_movements" ADD COLUMN     "affectsCash" BOOLEAN NOT NULL DEFAULT true;
