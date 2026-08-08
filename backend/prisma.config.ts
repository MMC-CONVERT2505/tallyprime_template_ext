import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 moved the datasource URL out of schema.prisma (see prisma/schema.prisma)
// into this CLI-only config file. Only used by `prisma migrate`/`generate`/etc. — the
// running app never reads this; PrismaService builds its own connection string from
// DB_* env vars (see src/config/configuration.ts) so app boot never depends on this
// file being correct.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
});
