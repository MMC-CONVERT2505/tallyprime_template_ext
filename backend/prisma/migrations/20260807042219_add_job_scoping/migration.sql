-- DropForeignKey
ALTER TABLE "tally_connections" DROP CONSTRAINT "tally_connections_orgId_fkey";

-- AlterTable
ALTER TABLE "extraction_jobs" ADD COLUMN     "connectionId" TEXT,
ADD COLUMN     "orgId" TEXT;

-- AddForeignKey
ALTER TABLE "extraction_jobs" ADD CONSTRAINT "extraction_jobs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_jobs" ADD CONSTRAINT "extraction_jobs_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "tally_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tally_connections" ADD CONSTRAINT "tally_connections_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
