import { PrismaClient } from '@prisma/client'

// Configure PrismaClient with connection pooling for Railway
// Note: Connection pooling is managed via DATABASE_URL parameters
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
