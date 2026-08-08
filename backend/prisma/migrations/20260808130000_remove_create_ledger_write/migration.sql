/*
  Warnings:
  - The value [CREATE_LEDGER] on the enum `ExtractionType` will be removed.
    This project's scope was narrowed to Tally *extraction* only (see
    docs/architecture.md) — CREATE_LEDGER was the one write/import path and
    has been removed entirely (TallyService.createLedger, POST /tally/ledgers,
    EnvelopeBuilder.buildCreateLedgerRequest, TallyResponseParser.parseImportResponse).
    Any existing audit rows for it are deleted below since they can no longer
    map to a valid ExtractionType — they were audit trail for a capability
    that no longer exists, not extracted financial data.
*/
-- AlterEnum
BEGIN;
DELETE FROM "extraction_jobs" WHERE "type" = 'CREATE_LEDGER';
CREATE TYPE "ExtractionType_new" AS ENUM ('COMPANIES', 'LEDGERS', 'VOUCHERS', 'RAW', 'STOCK_ITEMS', 'GROUPS');
ALTER TABLE "extraction_jobs" ALTER COLUMN "type" TYPE "ExtractionType_new" USING ("type"::text::"ExtractionType_new");
ALTER TYPE "ExtractionType" RENAME TO "ExtractionType_old";
ALTER TYPE "ExtractionType_new" RENAME TO "ExtractionType";
DROP TYPE "ExtractionType_old";
COMMIT;
