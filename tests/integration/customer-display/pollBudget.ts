// tests/integration/customer-display/pollBudget.ts
// Lo que comparten la regresión del presupuesto del poll (`pollBudget.integration.test.ts`, corre siempre) y la medición
// pesada (`pollBudget.measure.integration.test.ts`, sólo con MEDIR_POLL=1).
// 🔴 Este módulo no importa NADA que toque la base: las fábricas de `jest.mock` lo cargan, y el mock de
// `@/utils/prismaClient` no puede depender de sí mismo.
import os from 'os'
import type { NextFunction, Request, Response } from 'express'
import { pollWorkLimiter } from '@/services/customer-display/pollWork'

export type Sentencia = { query: string; params: string; duration: number; timestamp: Date }

/**
 * 🔴 El MISMO cliente que el singleton (Codex r1 #11; M1 de la revisión de la Task 13): la URL sale de `buildDatasourceUrl`,
 * la receta de `src/utils/prismaClient.ts` con su rama de pgbouncer (ya no una copia), más el mismo `omit` y las mismas
 * extensiones, y el evento `query`. Medir con otro pool no mide nada. Se usa como fábrica:
 * `jest.mock('@/utils/prismaClient', () => jest.requireActual('./pollBudget').clienteDeMedicion())`.
 */
export function clienteDeMedicion() {
  const { PrismaClient } = jest.requireActual('@prisma/client')
  const { buildDatasourceUrl } = jest.requireActual('@/utils/prismaClient')
  const { extensionResultadoGigante } = jest.requireActual('@/utils/queryResultGuard')
  const { extensionCancellableReads, extensionCancellableTransactions } = jest.requireActual('@/utils/requestCancellation')
  const url: string = buildDatasourceUrl()
  const cliente = new PrismaClient({
    datasources: { db: { url } },
    omit: { product: { createdById: true }, venue: { catalogGovernanceEnforcedAt: true } },
    log: [{ emit: 'event', level: 'query' }],
  })
  const sentencias: Sentencia[] = []
  cliente.$on('query', (e: Sentencia) => sentencias.push(e))
  const extendido = cliente
    .$extends(extensionResultadoGigante)
    .$extends(extensionCancellableReads)
    .$extends(extensionCancellableTransactions)
  return { __esModule: true, default: extendido, sentencias, urlDeMedicion: url }
}

/** Sin `Authorization`: el CUERPO del poll, aislado (sesión simulada). Con `Authorization`: la cadena REAL. */
export function autenticacionDeMedicion() {
  const real = jest.requireActual('@/middlewares/authenticateToken.middleware')
  return {
    ...real,
    authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
      if (req.headers.authorization) return real.authenticateTokenMiddleware(req, res, next)
      ;(req as any).authContext = { userId: 'medicion', venueId: req.params.venueId }
      next()
    },
  }
}

/** Lo mismo para la membresía: sin `Authorization` se salta; con él, la REAL (`Staff` + `StaffVenue`). */
export function membresiaDeMedicion() {
  const real = jest.requireActual('@/middlewares/validateVenueAccess.middleware')
  return {
    ...real,
    requireVenueMembership: (req: Request, res: Response, next: NextFunction) =>
      req.headers.authorization ? real.requireVenueMembership(req, res, next) : next(),
  }
}

export const esperar = (ms: number) => new Promise(res => setTimeout(res, ms))
export const carga = () =>
  `loadavg ${os
    .loadavg()
    .map(x => x.toFixed(1))
    .join(' / ')} (1/5/15 min)`
export const imprimir = (titulo: string, cuerpo: unknown) =>
  process.stdout.write(`\n=== ${titulo} ===\n${typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo, null, 2)}\n`)

const normal = (sql: string) => sql.replace(/\s+/g, ' ').trim()
/**
 * La tabla principal de cada sentencia. La de firmas es UNA sentencia cruda con subconsultas: se reconoce por SU texto
 * (`venueSignaturesSql(…).text`, M3), no por un alias que alguien podría renombrar.
 */
export const tablaDeLaSentencia = (sql: string, textoDeFirmas: string) =>
  normal(sql) === normal(textoDeFirmas)
    ? 'firmas (cruda)'
    : (sql.match(/\b(?:FROM|UPDATE|INTO)\s+(?:"public"\.)?"(\w+)"/)?.[1] ?? normal(sql).slice(0, 40))

/** La consulta ligera «por abrir» del carrusel: la única que ordena las promociones por `validFrom`, con tope. Una por construcción. */
export const esLigeraPorAbrir = (s: Sentencia) => /"Promotion"\."validFrom" ASC/.test(s.query) && s.query.includes('LIMIT')

/**
 * Espera a que lo que arrancó un poll termine: ninguna sentencia nueva en `quieto` ms y, con `conTope`, el tope sin
 * trabajos. `ignorar` saca de la cuenta las sentencias que no son del poll (la sonda de cobro, que no para). 🔴 Al llegar a
 * `maximo` LANZA (M2): regresar en silencio dejaría contar a la mitad. Límite que queda: el evento `query` llega cuando la
 * sentencia TERMINA, así que una que tarde más que `quieto` sin que termine otra no se ve.
 */
export async function esperarQuietudDe(
  sentencias: Sentencia[],
  {
    quieto = 500,
    maximo = 30_000,
    conTope = true,
    ignorar,
  }: { quieto?: number; maximo?: number; conTope?: boolean; ignorar?: (s: Sentencia) => boolean } = {},
) {
  const contar = () => (ignorar ? sentencias.filter(s => !ignorar(s)).length : sentencias.length)
  const hasta = Date.now() + maximo
  for (;;) {
    const n = contar()
    await esperar(quieto)
    const nuevas = contar() - n
    if (nuevas === 0 && (!conTope || pollWorkLimiter.enVuelo === 0)) return
    if (Date.now() > hasta) {
      throw new Error(
        `Sin quietud en ${maximo} ms: ${nuevas} sentencias en el último tramo y ${pollWorkLimiter.enVuelo} trabajos en el tope`,
      )
    }
  }
}
