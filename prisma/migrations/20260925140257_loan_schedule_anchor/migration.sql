/*
  Warnings:

  - Added the required column `scheduleAnchorOn` to the `loans` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "loans" ADD COLUMN     "scheduleAnchorIndex" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scheduleAnchorOn" DATE NOT NULL;
