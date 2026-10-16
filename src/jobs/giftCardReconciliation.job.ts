import type { CronJob } from 'cron'
import { Prisma } from '@prisma/client'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { recordGiftCardAnomaly } from '../services/giftCards/giftCardAnomaly'
import { activarSobresDeCuentaPagadaEnTx, dineroDeLaCuenta } from '../services/giftCards/giftCardLedger'
import { sqlOrdenEsCuentaDeTarjetas } from '../services/giftCards/giftCardMarks'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '../services/shared/paymentShiftClaim'
import prisma from '../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { utcTs } from '../utils/sqlDates'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

/**
 * Revisión nocturna de tarjetas de regalo (spec §6; índice B7). Es la red de seguridad de todo lo demás: la activación en los 11
 * caminos que dejan una cuenta PAGADA (A6), el gancho único de reembolsos (B1) y la cancelación (B2). Cada diferencia deja un
 * `MoneyAnomaly` con llave determinista (`giftcard:<check>:<id>`, R6: repetirla no duplica); `recordGiftCardAnomaly` suena el 🚨
 * con el negocio sólo cuando la fila es NUEVA, así que un hallazgo que persiste no repite la alerta cada noche.
 *
 * Sólo REPARA una cosa: la cuenta pagada con sobres PENDING, que se activa con la MISMA función que el cobro. Todo lo demás se
 * observa: reescribir dinero de noche, sin una persona, es peor que avisar.
 *
 * Lecturas acotadas POR PÁGINA: cada búsqueda devuelve a lo más `LIMITE` hallazgos, con cursor por id (keyset); los cobros, de los
 * últimos 7 días. r1 B-6: la corrida recorre TODAS las páginas de cada búsqueda (patrón de `hybridPlanCatchUp.ts`): con un solo
 * `LIMIT 200` sin cursor, 200 hallazgos que persisten (registrar la anomalía no quita su condición) escondían para siempre a los de
 * después, y los contadores parecían totales siendo una muestra.
 */

const LIMITE = 200
const VENTANA_DE_COBROS_MS = 7 * 24 * 60 * 60 * 1000
const GRACIA_MS = 10 * 60 * 1000
const CANCELACION_ATORADA_MS = 24 * 60 * 60 * 1000
const SIN_MOVIMIENTO_MS = 24 * 60 * 60 * 1000

type CronHandle = Pick<CronJob, 'start' | 'stop'>
type AnomaliaDeTarjeta = Parameters<typeof recordGiftCardAnomaly>[1]
type Pagina = { despuesDe: string | null; limite: number }

export interface SaldoDescuadrado {
  giftCardId: string
  venueId: string
  balance: string
  libreta: string
}
export interface CuentaPagadaConPendientes {
  orderId: string
  venueId: string
}
export interface CobroSinCanje {
  paymentId: string
  venueId: string
  orderId: string
}
export interface ReembolsoSinReverso {
  refundPaymentId: string
  venueId: string
  originalPaymentId: string | null
}
export interface CancelacionAtorada {
  giftCardId: string
  venueId: string
  bloqueadoEn: Date
}
/** Nota 1 del coordinador: dinero conservado mayor que lo que respaldan los sobres NO desactivados (pesos con 2 decimales). */
export interface CuentaConDineroSinRespaldo {
  orderId: string
  venueId: string
  cobrado: string
  reembolsado: string
  conservado: string
  respaldo: string
  sobres: Array<{ id: string; status: string }>
}
/** Nota 2 del coordinador: tuvo reembolso, quedó en $0 o menos, sigue abierta con sobres PENDING y nadie la ha movido en 24 h. */
export interface CuentaEnCeroAbierta {
  orderId: string
  venueId: string
  cobrado: string
  reembolsado: string
  conservado: string
}

/**
 * r1 B-6: cada contador de hallazgos es lo RECORRIDO en esta corrida, página por página hasta agotar la búsqueda: el total de lo que
 * había al correr, no una muestra. `cuentasActivadas` y `fallidas` cuentan lo que pasó con ellos.
 */
export interface GiftCardReconciliationResult {
  saldosDescuadrados: number
  cuentasPagadasConPendientes: number
  cuentasActivadas: number
  cobrosSinCanje: number
  reembolsosSinReverso: number
  cancelacionesAtoradas: number
  cuentasCanceladasConDinero: number
  cuentasEnCeroAbiertas: number
  fallidas: number
  dryRun: boolean
  skipped: boolean
}

interface Dependencies {
  cron?: CronHandle
  now: () => Date
  retryEntry: typeof retry
  // r1 B-6: cada búsqueda es UNA página: los de id > `despuesDe` (null = desde el principio), en orden de id, a lo más `limite`.
  buscarSaldosDescuadrados: (o: Pagina) => Promise<SaldoDescuadrado[]>
  buscarCuentasPagadasConPendientes: (o: { antesDe: Date } & Pagina) => Promise<CuentaPagadaConPendientes[]>
  activarCuenta: (c: CuentaPagadaConPendientes) => Promise<{ activated: string[] }>
  buscarCobrosConSaldoSinCanje: (o: { desde: Date } & Pagina) => Promise<CobroSinCanje[]>
  buscarReembolsosSinReverso: (o: { desde: Date } & Pagina) => Promise<ReembolsoSinReverso[]>
  buscarCancelacionesAtoradas: (o: { antesDe: Date } & Pagina) => Promise<CancelacionAtorada[]>
  buscarCuentasConDineroSinRespaldo: (o: Pagina) => Promise<CuentaConDineroSinRespaldo[]>
  buscarCuentasEnCeroAbiertas: (o: { sinMovimientoDesde: Date } & Pagina) => Promise<CuentaEnCeroAbierta[]>
  registrarAnomalia: (a: AnomaliaDeTarjeta) => Promise<void>
  nombresDeNegocios: (venueIds: string[]) => Promise<Map<string, string>>
}

/** r1 B-6: la página que sigue a `despuesDe` (keyset por id). */
const despuesDeId = (columna: 'g.id' | 'o.id' | 'p.id', despuesDe: string | null): Prisma.Sql =>
  despuesDe === null ? Prisma.empty : Prisma.sql`AND ${Prisma.raw(columna)} > ${despuesDe}`

/**
 * Notas 1-2: búsquedas cuya cifra decide `dineroDeLaCuenta` (la MISMA fórmula que la activación; no hay copia en SQL). Las candidatas
 * salen por keyset en SQL y cada una se mide; regresa una página de HALLAZGOS —a lo más `limite`, en orden de id; menos de `limite` =
 * se agotaron las candidatas—. Si se llena a media página, el cursor del job (el último hallazgo) retoma justo después.
 */
export async function hallazgosPorPaginas<C extends { orderId: string }, H>(
  o: Pagina,
  candidatas: (p: Pagina) => Promise<C[]>,
  hallazgo: (c: C) => Promise<H | null>,
): Promise<H[]> {
  const hallazgos: H[] = []
  let despuesDe = o.despuesDe
  for (;;) {
    const pagina = await candidatas({ despuesDe, limite: o.limite })
    for (const c of pagina) {
      const h = await hallazgo(c)
      if (h !== null) hallazgos.push(h)
      if (hallazgos.length === o.limite) return hallazgos
    }
    if (pagina.length < o.limite) return hallazgos
    despuesDe = pagina[pagina.length - 1].orderId
  }
}

/**
 * El saldo de un sobre es la suma con signo de su libreta (spec §4.2): suman ACTIVATE, REDEEM_REVERSAL y ADJUST_INCREMENT; restan
 * REDEEM, ADJUST_DECREMENT y DEACTIVATE; BLOCK, UNBLOCK, CLAIM y CODE_REPLACED valen 0. Sólo sobres activados alguna vez.
 */
async function buscarSaldosDescuadradosEnDb(o: Pagina): Promise<SaldoDescuadrado[]> {
  return prisma.$queryRaw<SaldoDescuadrado[]>(Prisma.sql`
    SELECT g.id AS "giftCardId", g."venueId" AS "venueId", g.balance::text AS balance, l.suma::text AS libreta
    FROM "GiftCard" g
    JOIN LATERAL (
      SELECT COALESCE(SUM(CASE a.type
               WHEN 'ACTIVATE' THEN a.amount
               WHEN 'REDEEM_REVERSAL' THEN a.amount
               WHEN 'ADJUST_INCREMENT' THEN a.amount
               WHEN 'REDEEM' THEN -a.amount
               WHEN 'ADJUST_DECREMENT' THEN -a.amount
               WHEN 'DEACTIVATE' THEN -a.amount
               ELSE 0 END), 0) AS suma,
             bool_or(a.type = 'ACTIVATE') AS activada
      FROM "GiftCardActivity" a
      WHERE a."giftCardId" = g.id
    ) l ON l.activada
    WHERE l.suma <> g.balance
      ${despuesDeId('g.id', o.despuesDe)}
    ORDER BY g.id
    LIMIT ${o.limite}`)
}

async function buscarCuentasPagadasConPendientesEnDb(o: { antesDe: Date } & Pagina): Promise<CuentaPagadaConPendientes[]> {
  // Nota 3: una cuenta con algún sobre DEACTIVATED no se intenta activar (un sobre desactivado nunca revive); la avisa el barrido
  // de dinero sin respaldo con la llave de A6.
  return prisma.$queryRaw<CuentaPagadaConPendientes[]>(Prisma.sql`
    SELECT DISTINCT o.id AS "orderId", o."venueId" AS "venueId"
    FROM "GiftCard" g
    JOIN "OrderItem" oi ON oi."giftCardId" = g.id
    JOIN "Order" o ON o.id = oi."orderId"
    WHERE g.status = 'PENDING'
      AND o."paymentStatus" = 'PAID'
      AND o."updatedAt" < ${utcTs(o.antesDe)}
      AND NOT EXISTS (
        SELECT 1 FROM "OrderItem" di JOIN "GiftCard" dg ON dg.id = di."giftCardId"
        WHERE di."orderId" = o.id AND dg.status = 'DEACTIVATED'
      )
      ${despuesDeId('o.id', o.despuesDe)}
    ORDER BY o.id
    LIMIT ${o.limite}`)
}

async function activarCuentaEnDb(c: CuentaPagadaConPendientes): Promise<{ activated: string[] }> {
  return prisma.$transaction(async tx => {
    // Mismo candado que el cobro: Order primero (la activación toma los sobres después).
    if (!(await lockExistingOrderForPayment(tx, { venueId: c.venueId, orderId: c.orderId }))) return { activated: [] }
    return activarSobresDeCuentaPagadaEnTx(tx, { venueId: c.venueId, orderId: c.orderId, staffId: null })
  }, ORDER_LOCK_WAIT_BUDGET)
}

async function buscarCobrosConSaldoSinCanjeEnDb(o: { desde: Date } & Pagina): Promise<CobroSinCanje[]> {
  return prisma.$queryRaw<CobroSinCanje[]>(Prisma.sql`
    SELECT p.id AS "paymentId", p."venueId" AS "venueId", p."orderId" AS "orderId"
    FROM "VenueTenderType" t
    JOIN "Payment" p ON p."venueId" = t."venueId" AND p."tenderTypeId" = t.id
    WHERE t."systemKind" = 'GIFT_CARD'
      AND p.status = 'COMPLETED'
      AND p.type IS DISTINCT FROM 'REFUND'
      AND p."createdAt" >= ${utcTs(o.desde)}
      AND NOT EXISTS (SELECT 1 FROM "GiftCardActivity" a WHERE a."paymentId" = p.id AND a.type = 'REDEEM')
      ${despuesDeId('p.id', o.despuesDe)}
    ORDER BY p.id
    LIMIT ${o.limite}`)
}

async function buscarReembolsosSinReversoEnDb(o: { desde: Date } & Pagina): Promise<ReembolsoSinReverso[]> {
  return prisma.$queryRaw<ReembolsoSinReverso[]>(Prisma.sql`
    SELECT p.id AS "refundPaymentId", p."venueId" AS "venueId", p."processorData"->>'originalPaymentId' AS "originalPaymentId"
    FROM "VenueTenderType" t
    JOIN "Payment" p ON p."venueId" = t."venueId" AND p."tenderTypeId" = t.id
    WHERE t."systemKind" = 'GIFT_CARD'
      AND p.status = 'COMPLETED'
      AND p.type = 'REFUND'
      AND p."createdAt" >= ${utcTs(o.desde)}
      AND NOT EXISTS (SELECT 1 FROM "GiftCardActivity" a WHERE a."refundPaymentId" = p.id AND a.type = 'REDEEM_REVERSAL')
      ${despuesDeId('p.id', o.despuesDe)}
    ORDER BY p.id
    LIMIT ${o.limite}`)
}

async function buscarCancelacionesAtoradasEnDb(o: { antesDe: Date } & Pagina): Promise<CancelacionAtorada[]> {
  return prisma.$queryRaw<CancelacionAtorada[]>(Prisma.sql`
    SELECT g.id AS "giftCardId", g."venueId" AS "venueId", b."createdAt" AS "bloqueadoEn"
    FROM "GiftCard" g
    JOIN LATERAL (
      SELECT a.type, a.reason, a."createdAt"
      FROM "GiftCardActivity" a
      WHERE a."giftCardId" = g.id AND a.type IN ('BLOCK', 'UNBLOCK')
      ORDER BY a."createdAt" DESC, a.id DESC
      LIMIT 1
    ) b ON TRUE
    WHERE g.status = 'BLOCKED'
      AND b.type = 'BLOCK'
      AND b.reason = 'CANCEL_IN_PROGRESS'
      AND b."createdAt" < ${utcTs(o.antesDe)}
      ${despuesDeId('g.id', o.despuesDe)}
    ORDER BY g.id
    LIMIT ${o.limite}`)
}

/**
 * Nota 1: candidatas = cuenta de tarjetas (R11) con algún sobre DEACTIVATED o la Order CANCELLED, y con al menos un cobro (sin
 * cobros no hay dinero conservado: condición necesaria; la cifra la decide `dineroDeLaCuenta`). `respaldo` = suma de `initialAmount`
 * de los sobres NO desactivados.
 * ponytail: toda venta de tarjetas cancelada con cobro se vuelve a medir cada noche (2 agregados por cuenta); si pasan de decenas de
 * miles, ventana por el último movimiento de la cuenta o el gemelo en SQL de `dineroDeLaCuenta`.
 */
async function candidatasSinRespaldoEnDb(
  o: Pagina,
): Promise<Array<{ orderId: string; venueId: string; respaldo: string; sobres: Array<{ id: string; status: string }> }>> {
  return prisma.$queryRaw(Prisma.sql`
    WITH candidatas AS (
      SELECT DISTINCT o.id, o."venueId"
      FROM "GiftCard" g
      JOIN "OrderItem" oi ON oi."giftCardId" = g.id
      JOIN "Order" o ON o.id = oi."orderId"
      WHERE (g.status = 'DEACTIVATED' OR o.status = 'CANCELLED')
        AND ${sqlOrdenEsCuentaDeTarjetas('o.id')}
        AND EXISTS (
          SELECT 1 FROM "Payment" p
          WHERE p."venueId" = o."venueId" AND p."orderId" = o.id AND p.status = 'COMPLETED' AND p.type IS DISTINCT FROM 'REFUND'
        )
        ${despuesDeId('o.id', o.despuesDe)}
      ORDER BY o.id
      LIMIT ${o.limite}
    )
    SELECT c.id AS "orderId", c."venueId" AS "venueId", s.respaldo::text AS respaldo, s.sobres
    FROM candidatas c
    JOIN LATERAL (
      SELECT COALESCE(SUM(g."initialAmount") FILTER (WHERE g.status <> 'DEACTIVATED'), 0) AS respaldo,
             json_agg(json_build_object('id', g.id, 'status', g.status) ORDER BY g.id) AS sobres
      FROM "OrderItem" oi
      JOIN "GiftCard" g ON g.id = oi."giftCardId"
      WHERE oi."orderId" = c.id
    ) s ON TRUE
    ORDER BY c.id`)
}

async function buscarCuentasConDineroSinRespaldoEnDb(o: Pagina): Promise<CuentaConDineroSinRespaldo[]> {
  return hallazgosPorPaginas(o, candidatasSinRespaldoEnDb, async c => {
    const dinero = await dineroDeLaCuenta(prisma, c)
    const respaldo = new Prisma.Decimal(c.respaldo)
    if (!dinero.conservado.greaterThan(respaldo)) return null
    return {
      orderId: c.orderId,
      venueId: c.venueId,
      cobrado: dinero.cobrado.toFixed(2),
      reembolsado: dinero.reembolsado.toFixed(2),
      conservado: dinero.conservado.toFixed(2),
      respaldo: respaldo.toFixed(2),
      sobres: c.sobres,
    }
  })
}

/**
 * Nota 2: candidatas = cuenta de tarjetas (R11) con sobres PENDING, abierta (ni cancelada ni cerrada; una PAGADA la avisa la
 * activación con `DINERO_DEVUELTO`), con algún reembolso y sin pagos creados ni tocados desde `sinMovimientoDesde`.
 */
async function candidatasEnCeroEnDb(o: { sinMovimientoDesde: Date } & Pagina): Promise<Array<{ orderId: string; venueId: string }>> {
  return prisma.$queryRaw(Prisma.sql`
    SELECT DISTINCT o.id AS "orderId", o."venueId" AS "venueId"
    FROM "GiftCard" g
    JOIN "OrderItem" oi ON oi."giftCardId" = g.id
    JOIN "Order" o ON o.id = oi."orderId"
    WHERE g.status = 'PENDING'
      AND o.status NOT IN ('CANCELLED', 'DELETED', 'COMPLETED')
      AND o."paymentStatus" <> 'PAID'
      AND ${sqlOrdenEsCuentaDeTarjetas('o.id')}
      AND EXISTS (
        SELECT 1 FROM "Payment" p
        WHERE p."venueId" = o."venueId" AND p."orderId" = o.id AND p.status = 'COMPLETED' AND p.type = 'REFUND'
      )
      AND NOT EXISTS (
        SELECT 1 FROM "Payment" p
        WHERE p."venueId" = o."venueId" AND p."orderId" = o.id
          AND (p."createdAt" >= ${utcTs(o.sinMovimientoDesde)} OR p."updatedAt" >= ${utcTs(o.sinMovimientoDesde)})
      )
      ${despuesDeId('o.id', o.despuesDe)}
    ORDER BY o.id
    LIMIT ${o.limite}`)
}

async function buscarCuentasEnCeroAbiertasEnDb(o: { sinMovimientoDesde: Date } & Pagina): Promise<CuentaEnCeroAbierta[]> {
  return hallazgosPorPaginas(
    o,
    p => candidatasEnCeroEnDb({ ...p, sinMovimientoDesde: o.sinMovimientoDesde }),
    async c => {
      const dinero = await dineroDeLaCuenta(prisma, c)
      if (!dinero.reembolsado.greaterThan(0) || dinero.conservado.greaterThan(0)) return null
      return {
        orderId: c.orderId,
        venueId: c.venueId,
        cobrado: dinero.cobrado.toFixed(2),
        reembolsado: dinero.reembolsado.toFixed(2),
        conservado: dinero.conservado.toFixed(2),
      }
    },
  )
}

async function nombresDeNegociosEnDb(venueIds: string[]): Promise<Map<string, string>> {
  if (venueIds.length === 0) return new Map()
  const filas = await prisma.venue.findMany({ where: { id: { in: venueIds } }, select: { id: true, name: true }, take: venueIds.length })
  return new Map(filas.map(v => [v.id, v.name]))
}

export const defaults: Dependencies = {
  now: () => new Date(),
  retryEntry: retry,
  buscarSaldosDescuadrados: buscarSaldosDescuadradosEnDb,
  buscarCuentasPagadasConPendientes: buscarCuentasPagadasConPendientesEnDb,
  activarCuenta: activarCuentaEnDb,
  buscarCobrosConSaldoSinCanje: buscarCobrosConSaldoSinCanjeEnDb,
  buscarReembolsosSinReverso: buscarReembolsosSinReversoEnDb,
  buscarCancelacionesAtoradas: buscarCancelacionesAtoradasEnDb,
  buscarCuentasConDineroSinRespaldo: buscarCuentasConDineroSinRespaldoEnDb,
  buscarCuentasEnCeroAbiertas: buscarCuentasEnCeroAbiertasEnDb,
  registrarAnomalia: a => recordGiftCardAnomaly(prisma, a),
  nombresDeNegocios: nombresDeNegociosEnDb,
}

export class GiftCardReconciliationJob {
  private readonly d: Dependencies
  private readonly cron: CronHandle
  private running = false

  constructor(overrides: Partial<Dependencies> = {}) {
    this.d = { ...defaults, ...overrides }
    this.cron =
      overrides.cron ??
      scheduleJob(
        'gift-card-reconciliation',
        DATABASE_JOB_SCHEDULES.giftCardReconciliation,
        () => {
          void this.runNow().catch(error => logger.error('Gift-card reconciliation failed', { error }))
        },
        null,
        false,
        'America/Mexico_City',
      )
  }

  start(): void {
    this.cron.start()
    logger.info('Gift-card reconciliation started')
  }

  stop(): void {
    this.cron.stop()
    logger.info('Gift-card reconciliation stopped')
  }

  /** `dryRun` cuenta sin activar ni registrar: es lo que hace seguro correrla a mano contra producción. */
  async runNow(opts: { dryRun?: boolean } = {}): Promise<GiftCardReconciliationResult> {
    const dryRun = opts.dryRun === true
    const r: GiftCardReconciliationResult = {
      saldosDescuadrados: 0,
      cuentasPagadasConPendientes: 0,
      cuentasActivadas: 0,
      cobrosSinCanje: 0,
      reembolsosSinReverso: 0,
      cancelacionesAtoradas: 0,
      cuentasCanceladasConDinero: 0,
      cuentasEnCeroAbiertas: 0,
      fallidas: 0,
      dryRun,
      skipped: false,
    }
    if (this.running) return { ...r, skipped: true }
    this.running = true
    try {
      const ahora = this.d.now()
      // Cada lectura es pura y va con el reintento de conexión (regla de cron): una a la vez, para no sumar a la estampida.
      const leer = <T>(contexto: string, fn: () => Promise<T>) =>
        this.d.retryEntry(fn, {
          retries: 2,
          initialDelay: 1500,
          shouldRetry: shouldRetryDbConnectionError,
          context: `gift-card-reconciliation.${contexto}`,
        })
      const desde = new Date(ahora.getTime() - VENTANA_DE_COBROS_MS)
      const nombres = new Map<string, string>()
      const conNombres = async (venueIds: string[]) => {
        const faltan = [...new Set(venueIds)].filter(id => !nombres.has(id))
        if (faltan.length === 0) return
        const nuevos = await leer('negocios', () => this.d.nombresDeNegocios(faltan))
        for (const [id, nombre] of nuevos) nombres.set(id, nombre)
      }
      const avisar = async (check: AnomaliaDeTarjeta['check'], id: string, venueId: string, detail: Record<string, unknown>) => {
        // info, no error: el 🚨 lo suena `recordGiftCardAnomaly` sólo con la fila NUEVA; aquí queda el inventario de cada noche.
        logger.info(`🎁 [tarjetas de regalo] revisión nocturna: ${check}`, {
          venueId,
          venueName: nombres.get(venueId) ?? null,
          id,
          ...detail,
        })
        try {
          await this.d.registrarAnomalia({ check, id, venueId, detail })
        } catch (error) {
          r.fallidas += 1
          logger.warn('🎁 [tarjetas de regalo] no se pudo registrar la anomalía', { check, id, venueId, error: (error as Error)?.message })
        }
      }
      /**
       * r1 B-6: recorre TODAS las páginas de una búsqueda dentro de esta corrida (keyset por id, `LIMITE` por página) y procesa
       * cada una antes de pedir la siguiente. El cursor avanza pase lo que pase con cada hallazgo: uno que persiste o que truena
       * no esconde ni frena a los de después. Devuelve cuántos recorrió. En `dryRun` sólo cuenta.
       */
      const recorrer = async <T extends { venueId: string }>(
        contexto: string,
        buscar: (despuesDe: string | null) => Promise<T[]>,
        idDe: (x: T) => string,
        procesar: (x: T) => Promise<void>,
      ): Promise<number> => {
        let despuesDe: string | null = null
        let recorridos = 0
        for (;;) {
          const cursor = despuesDe
          const pagina = await leer(contexto, () => buscar(cursor))
          recorridos += pagina.length
          if (!dryRun && pagina.length > 0) {
            await conNombres(pagina.map(x => x.venueId))
            for (const x of pagina) await procesar(x)
          }
          if (pagina.length < LIMITE) return recorridos
          despuesDe = idDe(pagina[pagina.length - 1])
        }
      }

      r.saldosDescuadrados = await recorrer(
        'saldos',
        despuesDe => this.d.buscarSaldosDescuadrados({ despuesDe, limite: LIMITE }),
        s => s.giftCardId,
        s => avisar('BALANCE_MISMATCH', s.giftCardId, s.venueId, { balance: s.balance, libreta: s.libreta }),
      )
      r.cuentasPagadasConPendientes = await recorrer(
        'pagadas',
        despuesDe =>
          this.d.buscarCuentasPagadasConPendientes({ antesDe: new Date(ahora.getTime() - GRACIA_MS), despuesDe, limite: LIMITE }),
        c => c.orderId,
        async c => {
          try {
            const { activated } = await this.d.activarCuenta(c)
            // Sin sobres activados: lo cobrado no cuadra con los sobres (o se devolvió dinero, r1 F8) y la activación ya dejó su
            // ACTIVATION_AMOUNT_MISMATCH.
            if (activated.length === 0) return
            r.cuentasActivadas += 1
            await avisar('PAID_WITH_PENDING', c.orderId, c.venueId, { activated })
          } catch (error) {
            r.fallidas += 1
            logger.warn('🎁 [tarjetas de regalo] no se pudo activar una cuenta pagada', {
              orderId: c.orderId,
              venueId: c.venueId,
              error: (error as Error)?.message,
            })
          }
        },
      )
      r.cobrosSinCanje = await recorrer(
        'cobros',
        despuesDe => this.d.buscarCobrosConSaldoSinCanje({ desde, despuesDe, limite: LIMITE }),
        c => c.paymentId,
        c => avisar('TENDER_WITHOUT_REDEEM', c.paymentId, c.venueId, { orderId: c.orderId }),
      )
      r.reembolsosSinReverso = await recorrer(
        'reembolsos',
        despuesDe => this.d.buscarReembolsosSinReverso({ desde, despuesDe, limite: LIMITE }),
        x => x.refundPaymentId,
        x => avisar('REFUND_WITHOUT_REVERSAL', x.refundPaymentId, x.venueId, { originalPaymentId: x.originalPaymentId }),
      )
      r.cancelacionesAtoradas = await recorrer(
        'cancelaciones',
        despuesDe =>
          this.d.buscarCancelacionesAtoradas({ antesDe: new Date(ahora.getTime() - CANCELACION_ATORADA_MS), despuesDe, limite: LIMITE }),
        a => a.giftCardId,
        a => avisar('CANCEL_STUCK', a.giftCardId, a.venueId, { bloqueadoEn: a.bloqueadoEn.toISOString() }),
      )
      // Nota 1: la MISMA llave que A6 (`PAID_WITH_DEACTIVATED` + orderId): si el cobro ya avisó, esta fila no se duplica.
      r.cuentasCanceladasConDinero = await recorrer(
        'sin-respaldo',
        despuesDe => this.d.buscarCuentasConDineroSinRespaldo({ despuesDe, limite: LIMITE }),
        c => c.orderId,
        c =>
          avisar('PAID_WITH_DEACTIVATED', c.orderId, c.venueId, {
            motivo: 'REVISION_NOCTURNA',
            orderId: c.orderId,
            cobrado: c.cobrado,
            reembolsado: c.reembolsado,
            conservado: c.conservado,
            respaldo: c.respaldo,
            sobres: c.sobres,
          }),
      )
      // Nota 2: sólo avisa; cerrar la cuenta mueve su estado y no le toca a la noche.
      r.cuentasEnCeroAbiertas = await recorrer(
        'en-cero',
        despuesDe =>
          this.d.buscarCuentasEnCeroAbiertas({
            sinMovimientoDesde: new Date(ahora.getTime() - SIN_MOVIMIENTO_MS),
            despuesDe,
            limite: LIMITE,
          }),
        c => c.orderId,
        c =>
          avisar('OPEN_AT_ZERO_WITH_PENDING', c.orderId, c.venueId, {
            motivo: 'REVISION_NOCTURNA',
            orderId: c.orderId,
            cobrado: c.cobrado,
            reembolsado: c.reembolsado,
            conservado: c.conservado,
          }),
      )
      if (dryRun) return r

      const hallazgos =
        r.saldosDescuadrados +
        r.cuentasPagadasConPendientes +
        r.cobrosSinCanje +
        r.reembolsosSinReverso +
        r.cancelacionesAtoradas +
        r.cuentasCanceladasConDinero +
        r.cuentasEnCeroAbiertas
      if (hallazgos > 0) logger.info('🎁 [tarjetas de regalo] revisión nocturna', { ...r })
      return r
    } finally {
      this.running = false
    }
  }
}

export const giftCardReconciliationJob = new GiftCardReconciliationJob()
