import { PrismaClient } from '@prisma/client'

/**
 * Prisma Client Singleton
 *
 * ⚠️ CRITICAL DESIGN DECISION:
 * This file exports a SINGLE instance of PrismaClient to prevent multiple connection pools.
 *
 * Why singleton?
 * - Each PrismaClient instance creates its own connection pool to the database
 * - Multiple instances = exhausted database connections + performance degradation
 * - Singleton pattern = one pool shared across entire application
 *
 * Usage: Import this instance everywhere you need database access
 * ```typescript
 * import prisma from '@/utils/prismaClient'
 * const users = await prisma.user.findMany()
 * ```
 *
 * Connection pooling is configured via DATABASE_URL parameters
 */
const prisma = new PrismaClient({
  // log: process.env.NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
})

// Graceful shutdown to close database connections
process.on('beforeExit', async () => {
  await prisma.$disconnect()
})

process.on('SIGINT', async () => {
  await prisma.$disconnect()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await prisma.$disconnect()
  process.exit(0)
})

// For debugging (uncomment if needed):
// const prisma = new PrismaClient({
//   log: [
//     {
//       emit: 'stdout',
//       level: 'query',
//     },
//     {
//       emit: 'stdout',
//       level: 'info',
//     },
//     {
//       emit: 'stdout',
//       level: 'warn',
//     },
//     {
//       emit: 'stdout',
//       level: 'error',
//     },
//   ],
// });

export default prisma
