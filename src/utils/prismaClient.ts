import { PrismaClient } from '@prisma/client'
import { extensionResultadoGigante } from './queryResultGuard'
import { extensionCancellableReads, extensionCancellableTransactions } from './requestCancellation'
import { buildDatasourceUrl } from './datasourceUrl'

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

// La receta del pool vive aparte (sin Prisma) y se reexporta: la usan el tope de simulaciones (S10) y la medición del poll.
export { buildDatasourceUrl }

const datasourceUrl = buildDatasourceUrl()

// These H1 server-only scalars are opt-in provenance/fence inputs, not legacy
// response fields. Global omit also protects Product rows nested by endpoints
// we did not enumerate; internal H1 readers can override with select/omit=false.
const serverOnlyOmit = {
  product: { createdById: true },
  venue: { catalogGovernanceEnforcedAt: true },
} as const

// Prisma encodes global omit in the client's generic type, which otherwise
// makes this singleton incompatible with the repo's many narrow PrismaClient /
// TransactionClient ports. The stable public type preserves those ports while
// the constructed runtime client still enforces the omit; H1 readers opt in
// explicitly with select or omit:false.
const prismaBase = datasourceUrl
  ? new PrismaClient({
      datasources: { db: { url: datasourceUrl } },
      omit: serverOnlyOmit,
      // log: process.env.NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
    })
  : new PrismaClient({
      omit: serverOnlyOmit,
      // log: process.env.NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
    })

// Guardia del incidente 2026-09-01: todo findMany que devuelva un resultado gigante se
// denuncia en el log con modelo + tamaño (el contexto le estampa el endpoint). Nunca
// recorta ni lanza — ver src/utils/queryResultGuard.ts. El mismo cast de abajo aplica:
// $extends cambia el tipo genérico y rompería los puertos estrechos del repo.
//
// Freno del incidente 2026-09-23: dentro de una petición cancelada (sólo el MCP las marca hoy), la
// siguiente LECTURA se rechaza en vez de seguir quemando el único hilo. Una escritura nunca se corta, y
// tras la primera escritura ya no se corta nada. Fuera de una petición cancelable es un no-op — ver
// src/utils/requestCancellation.ts. La última extensión envuelve `$transaction`: dentro de una petición del MCP, una
// transacción cuenta como UN trabajo de principio a fin y recupera el cupo antes de empezar; fuera, devuelve la promesa
// de Prisma tal cual (el resto de la plataforma no cambia).
const prisma = prismaBase
  .$extends(extensionResultadoGigante)
  .$extends(extensionCancellableReads)
  .$extends(extensionCancellableTransactions) as unknown as PrismaClient

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
