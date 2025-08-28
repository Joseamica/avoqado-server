import 'dotenv/config'
import path from 'node:path'
import type { PrismaConfig } from 'prisma'

export default {
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: process.env.NODE_ENV === 'production' 
      ? `node ${path.join(process.cwd(), 'dist', 'prisma', 'seed.js')}`
      : 'ts-node prisma/seed.ts',
  },
  views: {
    path: path.join('prisma', 'views'),
  },
  typedSql: {
    path: path.join('prisma', 'queries'),
  },
} satisfies PrismaConfig
