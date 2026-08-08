-- Table has zero real rows (agent pairing wasn't built until now), so this is
-- a clean schema correction, not a data migration.

-- Drop columns left over from the pre-tunnel local-first sketch: the cloud
-- never needs to know where Tally is, only the agent does (its own env).
ALTER TABLE "tally_connections" DROP COLUMN "host";
ALTER TABLE "tally_connections" DROP COLUMN "port";

-- Real per-connection device credential (argon2 hash of the token shown to
-- the user exactly once at creation).
ALTER TABLE "tally_connections" ADD COLUMN "tokenHash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "tally_connections" ALTER COLUMN "tokenHash" DROP DEFAULT;
CREATE UNIQUE INDEX "tally_connections_tokenHash_key" ON "tally_connections"("tokenHash");

-- A connection must belong to an org — the earlier nullable FK was a
-- placeholder before any real usage existed.
ALTER TABLE "tally_connections" ALTER COLUMN "orgId" SET NOT NULL;
