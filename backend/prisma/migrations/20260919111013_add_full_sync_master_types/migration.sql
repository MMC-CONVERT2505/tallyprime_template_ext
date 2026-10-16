-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ExtractionType" ADD VALUE 'STOCK_GROUPS';
ALTER TYPE "ExtractionType" ADD VALUE 'STOCK_CATEGORIES';
ALTER TYPE "ExtractionType" ADD VALUE 'UNITS';
ALTER TYPE "ExtractionType" ADD VALUE 'CURRENCIES';
ALTER TYPE "ExtractionType" ADD VALUE 'GODOWNS';
ALTER TYPE "ExtractionType" ADD VALUE 'COST_CATEGORIES';
ALTER TYPE "ExtractionType" ADD VALUE 'VOUCHER_TYPES';
ALTER TYPE "ExtractionType" ADD VALUE 'FULL_SYNC';
