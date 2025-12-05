import 'dotenv/config'
import path from 'node:path'
import type { PrismaConfig } from 'prisma'

// If USE_RENDER_DB is set, override DATABASE_URL with RENDER_DATABASE_URL
if (process.env.USE_RENDER_DB === 'true' && process.env.RENDER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.RENDER_DATABASE_URL
}

export default {
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    // Execute from repo root; use compiled JS in production
    seed: process.env.NODE_ENV === 'production' ? 'node dist/prisma/seed.js' : 'ts-node prisma/seed.ts',
  },
  views: {
    path: path.join('prisma', 'views'),
  },
  typedSql: {
    path: path.join('prisma', 'queries'),
  },
} satisfies PrismaConfig
