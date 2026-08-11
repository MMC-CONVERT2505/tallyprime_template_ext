-- Hand-written (not schema-diffed): Prisma's schema DSL cannot express a
-- partial unique index, so this migration exists outside schema.prisma. See
-- the doc comment on TallyConnection in schema.prisma for the pointer back.
--
-- Root cause being fixed: nothing ever stopped two active TallyConnection
-- rows from sharing the same (orgId, defaultCompany) — every re-run of the
-- pairing flow (manual create, or Device Authorization poll) minted a brand
-- new row instead of reusing the existing one. That made
-- ExtractionsService.resolveConnectionByCompany ambiguous. Two steps:
--
-- 1) One-time cleanup: within each (orgId, defaultCompany) group of active,
--    company-pinned connections, keep exactly one — whichever last actually
--    authenticated over the tunnel (lastSeenAt), tie-broken by whichever was
--    paired most recently — and revoke (isActive = false) the rest. Rows
--    with no defaultCompany (multi-company/generic agents) are untouched:
--    there's no dedup key for them.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY "orgId", "defaultCompany"
           ORDER BY "lastSeenAt" DESC NULLS LAST, "createdAt" DESC
         ) AS rn
  FROM "tally_connections"
  WHERE "isActive" = true AND "defaultCompany" IS NOT NULL
)
UPDATE "tally_connections"
SET "isActive" = false
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 2) Going forward, enforce it at the DB level too (application-level upsert
--    in ConnectionsService.upsertForCompany is the primary guard; this is the
--    backstop against races/bugs). Partial: only active, company-pinned rows
--    conflict — a revoked row must never block re-pairing that company, and
--    company-less agents can still have as many rows as needed.
CREATE UNIQUE INDEX "tally_connections_org_company_active_key"
  ON "tally_connections" ("orgId", "defaultCompany")
  WHERE "isActive" = true AND "defaultCompany" IS NOT NULL;
