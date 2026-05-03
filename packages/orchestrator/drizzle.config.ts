/**
 * Phase 3.2: schema and migrations moved to @orbital/db (packages/db/).
 * Use `npm run migrate:generate -w @orbital/db` to generate new migrations.
 * This config is kept as a redirect.
 */
import type { Config } from 'drizzle-kit'

export default {
  schema: '../db/src/schema/*.ts',
  out: '../db/src/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://orbital:orbital_dev_password@localhost:5432/orbital',
  },
  strict: true,
  verbose: true,
} satisfies Config
