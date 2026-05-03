import type { Config } from 'drizzle-kit'

export default {
  schema: './src/schema/*.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://orbital:orbital_dev_password@localhost:5432/orbital',
  },
  strict: true,
  verbose: true,
} satisfies Config
