-- AlterTable
ALTER TABLE "tally_connections" ADD COLUMN     "lastProbeAt" TIMESTAMP(3),
ADD COLUMN     "tallyReachable" BOOLEAN;
