import type { CronJob } from 'cron'
import { Prisma } from '@prisma/client'
import logger from '../config/logger'
import { scheduleJob } from '../observability/jobContext'
import { recordGiftCardAnomaly } from '../services/giftCards/giftCardAnomaly'
import {
  activarSobresDeCuentaPagadaEnTx,
  dineroDeLaCuenta,
  dineroSinRespaldoEnTexto,
  medirDineroSinRespaldo,
} from '../services/giftCards/giftCardLedger'
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
 * Sólo REPARA una cosa: la cuenta pagada con sobres PENDING, que se activa con la MISMA función que el cobro, y va PRIMERO (r1 M2).
 * Todo lo demás se observa: reescribir dinero de noche, sin una persona, es peor que avisar.
 *
 * Lecturas acotadas POR PÁGINA: cada búsqueda devuelve a lo más `LIMITE` filas, con cursor por id (keyset); los cobros, los
 * reembolsos y las cuentas de las notas 1-2, de los últimos 7 días. r1 B-6: la corrida recorre TODAS las páginas de cada búsqueda
 * (patrón de `hybridPlanCatchUp.ts`): con un solo `LIMIT 200` sin cursor, 200 hallazgos que persisten (registrar la anomalía no quita
 * su condición) escondían para siempre a los de después, y los contadores parecían totales siendo una muestra.
 * r1 M2: cada barrido y cada hallazgo están aislados; lo que truena suma a `fallidas` y lo demás sigue.
 */

const LIMITE = 200
/** Cobros y reembolsos con saldo, y (r1 M1) las cuentas que se movieron: la anomalía ya escrita persiste y deduplica. */
const VENTANA_MS = 7 * 24 * 60 * 60 * 1000
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
/** Una cuenta (Order) de tarjetas: la que se activa, o la candidata de las notas 1 y 2 antes de medirla. */
export interface CuentaDeTarjetas {
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
/** Nota 1 (r1 #1): lo conservado pasa de lo que respaldan sus sobres (vivos + lo que los desactivados canjearon). Pesos en texto. */
export interface CuentaConDineroSinRespaldo extends CuentaDeTarjetas, ReturnType<typeof dineroSinRespaldoEnTexto> {}
/** Nota 2: tuvo reembolso, quedó en $0 o menos, sigue abierta con sobres PENDING y nadie la ha movido en 24 h. */
export interface CuentaEnCeroAbierta extends CuentaDeTarjetas {
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
  buscarCuentasPagadasConPendientes: (o: { antesDe: Date } & Pagina) => Promise<CuentaDeTarjetas[]>
  activarCuenta: (c: CuentaDeTarjetas) => Promise<{ activated: string[] }>
  buscarSaldosDescuadrados: (o: Pagina) => Promise<SaldoDescuadrado[]>
  buscarCobrosConSaldoSinCanje: (o: { desde: Date } & Pagina) => Promise<CobroSinCanje[]>
  buscarReembolsosSinReverso: (o: { desde: Date } & Pagina) => Promise<ReembolsoSinReverso[]>
  buscarCancelacionesAtoradas: (o: { antesDe: Date } & Pagina) => Promise<CancelacionAtorada[]>
  // Notas 1-2: el SQL trae candidatas (un superconjunto) y la medición por cuenta decide; `null` = no es hallazgo.
  buscarCandidatasSinRespaldo: (o: { movidasDesde: Date } & Pagina) => Promise<CuentaDeTarjetas[]>
  medirSinRespaldo: (c: CuentaDeTarjetas) => Promise<CuentaConDineroSinRespaldo | null>
  buscarCandidatasEnCero: (o: { movidasDesde: Date; sinMovimientoDesde: Date } & Pagina) => Promise<CuentaDeTarjetas[]>
  medirEnCero: (c: CuentaDeTarjetas) => Promise<CuentaEnCeroAbierta | null>
  registrarAnomalia: (a: AnomaliaDeTarjeta) => Promise<void>
  nombresDeNegocios: (venueIds: string[]) => Promise<Map<string, string>>
}

/** r1 B-6: la página que sigue a `despuesDe` (keyset por id). */
const despuesDeId = (columna: 'g.id' | 'o.id' | 'p.id', despuesDe: string | null): Prisma.Sql =>
  despuesDe === null ? Prisma.empty : Prisma.sql`AND ${Prisma.raw(columna)} > ${despuesDe}`

/** r1 M1: la cuenta `o` se movió desde `desde`: un pago suyo creado o tocado, un sobre suyo desactivado o la Order misma tocada. */
const seMovioDesde = (desde: Date): Prisma.Sql => Prisma.sql`(
  o."updatedAt" >= ${utcTs(desde)}
  OR EXISTS (
    SELECT 1 FROM "Payment" mp
    WHERE mp."venueId" = o."venueId" AND mp."orderId" = o.id AND (mp."createdAt" >= ${utcTs(desde)} OR mp."updatedAt" >= ${utcTs(desde)})
  )
  OR EXISTS (
    SELECT 1 FROM "OrderItem" mi JOIN "GiftCard" mg ON mg.id = mi."giftCardId"
    WHERE mi."orderId" = o.id AND mg."deactivatedAt" >= ${utcTs(desde)}
  )
)`

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

async function buscarCuentasPagadasConPendientesEnDb(o: { antesDe: Date } & Pagina): Promise<CuentaDeTarjetas[]> {
  // Nota 3: una cuenta con algún sobre DEACTIVATED no se intenta activar (un sobre desactivado nunca revive); la avisa el barrido
  // de dinero sin respaldo con la llave de A6.
  return prisma.$queryRaw<CuentaDeTarjetas[]>(Prisma.sql`
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

async function activarCuentaEnDb(c: CuentaDeTarjetas): Promise<{ activated: string[] }> {
  return prisma.$transaction(async tx => {
    // Mismo candado que el cobro: Order primero (la activación toma los sobres después).
    if (!(await lockExistingOrderForPayment(tx, { venueId: c.venueId, orderId: c.orderId }))) return { activated: [] }
    const resultado = await activarSobresDeCuentaPagadaEnTx(tx, { venueId: c.venueId, orderId: c.orderId, staffId: null })
    // r1 M3: el rastro va en la MISMA transacción que activa: si no se puede escribir, la activación se deshace y la noche que
    // sigue lo vuelve a intentar; nunca quedan sobres activados de noche sin su anomalía.
    if (resultado.activated.length > 0) {
      await recordGiftCardAnomaly(tx, {
        check: 'PAID_WITH_PENDING',
        id: c.orderId,
        venueId: c.venueId,
        detail: { activated: resultado.activated },
      })
    }
    return resultado
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
 * Nota 1, candidatas: cuenta de tarjetas (R11) con algún sobre DEACTIVATED, al menos un cobro (sin cobros no hay dinero conservado)
 * y movimiento en la ventana (r1 M1). Es un superconjunto: la cifra la decide `medirDineroSinRespaldo`, la MISMA del cobro (A6).
 */
async function buscarCandidatasSinRespaldoEnDb(o: { movidasDesde: Date } & Pagina): Promise<CuentaDeTarjetas[]> {
  return prisma.$queryRaw<CuentaDeTarjetas[]>(Prisma.sql`
    SELECT DISTINCT o.id AS "orderId", o."venueId" AS "venueId"
    FROM "GiftCard" g
    JOIN "OrderItem" oi ON oi."giftCardId" = g.id
    JOIN "Order" o ON o.id = oi."orderId"
    WHERE g.status = 'DEACTIVATED'
      AND ${sqlOrdenEsCuentaDeTarjetas('o.id')}
      AND EXISTS (
        SELECT 1 FROM "Payment" p
        WHERE p."venueId" = o."venueId" AND p."orderId" = o.id AND p.status = 'COMPLETED' AND p.type IS DISTINCT FROM 'REFUND'
      )
      AND ${seMovioDesde(o.movidasDesde)}
      ${despuesDeId('o.id', o.despuesDe)}
    ORDER BY o.id
    LIMIT ${o.limite}`)
}

async function medirSinRespaldoEnDb(c: CuentaDeTarjetas): Promise<CuentaConDineroSinRespaldo | null> {
  const m = await medirDineroSinRespaldo(prisma, c)
  return m?.sinRespaldo ? { orderId: c.orderId, venueId: c.venueId, ...dineroSinRespaldoEnTexto(m) } : null
}

/**
 * Nota 2, candidatas: cuenta de tarjetas (R11) con sobres PENDING, abierta (ni cancelada ni cerrada; una PAGADA la avisa la
 * activación con `DINERO_DEVUELTO`), con algún reembolso, movida en la ventana (r1 M1) y sin pagos creados ni tocados desde
 * `sinMovimientoDesde`. La medición con `dineroDeLaCuenta` decide si quedó en $0.
 */
async function buscarCandidatasEnCeroEnDb(o: { movidasDesde: Date; sinMovimientoDesde: Date } & Pagina): Promise<CuentaDeTarjetas[]> {
  return prisma.$queryRaw<CuentaDeTarjetas[]>(Prisma.sql`
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
      AND ${seMovioDesde(o.movidasDesde)}
      ${despuesDeId('o.id', o.despuesDe)}
    ORDER BY o.id
    LIMIT ${o.limite}`)
}

async function medirEnCeroEnDb(c: CuentaDeTarjetas): Promise<CuentaEnCeroAbierta | null> {
  const dinero = await dineroDeLaCuenta(prisma, c)
  if (!dinero.reembolsado.greaterThan(0) || dinero.conservado.greaterThan(0)) return null
  return {
    orderId: c.orderId,
    venueId: c.venueId,
    cobrado: dinero.cobrado.toFixed(2),
    reembolsado: dinero.reembolsado.toFixed(2),
    conservado: dinero.conservado.toFixed(2),
  }
}

async function nombresDeNegociosEnDb(venueIds: string[]): Promise<Map<string, string>> {
  if (venueIds.length === 0) return new Map()
  const filas = await prisma.venue.findMany({ where: { id: { in: venueIds } }, select: { id: true, name: true }, take: venueIds.length })
  return new Map(filas.map(v => [v.id, v.name]))
}

export const defaults: Dependencies = {
  now: () => new Date(),
  retryEntry: retry,
  buscarCuentasPagadasConPendientes: buscarCuentasPagadasConPendientesEnDb,
  activarCuenta: activarCuentaEnDb,
  buscarSaldosDescuadrados: buscarSaldosDescuadradosEnDb,
  buscarCobrosConSaldoSinCanje: buscarCobrosConSaldoSinCanjeEnDb,
  buscarReembolsosSinReverso: buscarReembolsosSinReversoEnDb,
  buscarCancelacionesAtoradas: buscarCancelacionesAtoradasEnDb,
  buscarCandidatasSinRespaldo: buscarCandidatasSinRespaldoEnDb,
  medirSinRespaldo: medirSinRespaldoEnDb,
  buscarCandidatasEnCero: buscarCandidatasEnCeroEnDb,
  medirEnCero: medirEnCeroEnDb,
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

  /** `dryRun` cuenta (y mide, que sólo lee) sin activar ni registrar: es lo que hace seguro correrla a mano contra producción. */
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
      const hace = (ms: number) => new Date(ahora.getTime() - ms)
      // Cada lectura es pura y va con el reintento de conexión (regla de cron): una a la vez, para no sumar a la estampida.
      const leer = <T>(contexto: string, fn: () => Promise<T>) =>
        this.d.retryEntry(fn, {
          retries: 2,
          initialDelay: 1500,
          shouldRetry: shouldRetryDbConnectionError,
          context: `gift-card-reconciliation.${contexto}`,
        })
      const nombres = new Map<string, string>()
      const conNombres = async (venueIds: string[]) => {
        const faltan = [...new Set(venueIds)].filter(id => !nombres.has(id))
        if (faltan.length === 0) return
        const nuevos = await leer('negocios', () => this.d.nombresDeNegocios(faltan))
        for (const [id, nombre] of nuevos) nombres.set(id, nombre)
      }
      const avisar = async (check: AnomaliaDeTarjeta['check'], id: string, venueId: string, detail: Record<string, unknown>) => {
        if (dryRun) return
        // info, no error: el 🚨 lo suena `recordGiftCardAnomaly` sólo con la fila NUEVA; aquí queda el inventario de cada noche.
        logger.info(`🎁 [tarjetas de regalo] revisión nocturna: ${check}`, {
          venueId,
          venueName: nombres.get(venueId) ?? null,
          id,
          ...detail,
        })
        await this.d.registrarAnomalia({ check, id, venueId, detail })
      }
      /**
       * r1 B-6: recorre TODAS las páginas de un barrido dentro de esta corrida (keyset por id, `LIMITE` por página). r1 M2: cada
       * hallazgo se procesa aislado —uno que truena suma a `fallidas` y sigue el siguiente: el cursor avanza pase lo que pase— y si la
       * búsqueda misma truena (ya con su reintento), suma a `fallidas`, sale en `logger.error` y siguen los demás barridos.
       */
      const recorrer = async <T extends { venueId: string }>(
        barrido: string,
        buscar: (despuesDe: string | null) => Promise<T[]>,
        idDe: (x: T) => string,
        procesar: (x: T) => Promise<void>,
      ): Promise<void> => {
        let despuesDe: string | null = null
        try {
          for (;;) {
            const cursor = despuesDe
            const pagina = await leer(barrido, () => buscar(cursor))
            if (!dryRun && pagina.length > 0) await conNombres(pagina.map(x => x.venueId))
            for (const x of pagina) {
              try {
                await procesar(x)
              } catch (error) {
                r.fallidas += 1
                logger.warn('🎁 [tarjetas de regalo] revisión nocturna: un hallazgo falló; siguen los demás', {
                  barrido,
                  id: idDe(x),
                  venueId: x.venueId,
                  error: (error as Error)?.message,
                })
              }
            }
            if (pagina.length < LIMITE) return
            despuesDe = idDe(pagina[pagina.length - 1])
          }
        } catch (error) {
          r.fallidas += 1
          logger.error('🎁 [tarjetas de regalo] revisión nocturna: un barrido falló; siguen los demás', {
            barrido,
            error: (error as Error)?.message,
          })
        }
      }

      // r1 M2: la única reparación va primero; que un barrido de sólo-aviso truene no la deja sin correr.
      await recorrer(
        'pagadas',
        despuesDe => this.d.buscarCuentasPagadasConPendientes({ antesDe: hace(GRACIA_MS), despuesDe, limite: LIMITE }),
        c => c.orderId,
        async c => {
          r.cuentasPagadasConPendientes += 1
          if (dryRun) return
          // Sin sobres activados: lo cobrado no cuadra con los sobres (o se devolvió dinero, r1 F8) y la activación ya dejó su
          // ACTIVATION_AMOUNT_MISMATCH. Con sobres activados, `PAID_WITH_PENDING` ya quedó escrita en su transacción (r1 M3).
          const { activated } = await this.d.activarCuenta(c)
          if (activated.length > 0) r.cuentasActivadas += 1
        },
      )
      await recorrer(
        'saldos',
        despuesDe => this.d.buscarSaldosDescuadrados({ despuesDe, limite: LIMITE }),
        s => s.giftCardId,
        async s => {
          r.saldosDescuadrados += 1
          await avisar('BALANCE_MISMATCH', s.giftCardId, s.venueId, { balance: s.balance, libreta: s.libreta })
        },
      )
      await recorrer(
        'cobros',
        despuesDe => this.d.buscarCobrosConSaldoSinCanje({ desde: hace(VENTANA_MS), despuesDe, limite: LIMITE }),
        c => c.paymentId,
        async c => {
          r.cobrosSinCanje += 1
          await avisar('TENDER_WITHOUT_REDEEM', c.paymentId, c.venueId, { orderId: c.orderId })
        },
      )
      await recorrer(
        'reembolsos',
        despuesDe => this.d.buscarReembolsosSinReverso({ desde: hace(VENTANA_MS), despuesDe, limite: LIMITE }),
        x => x.refundPaymentId,
        async x => {
          r.reembolsosSinReverso += 1
          await avisar('REFUND_WITHOUT_REVERSAL', x.refundPaymentId, x.venueId, { originalPaymentId: x.originalPaymentId })
        },
      )
      await recorrer(
        'cancelaciones',
        despuesDe => this.d.buscarCancelacionesAtoradas({ antesDe: hace(CANCELACION_ATORADA_MS), despuesDe, limite: LIMITE }),
        a => a.giftCardId,
        async a => {
          r.cancelacionesAtoradas += 1
          await avisar('CANCEL_STUCK', a.giftCardId, a.venueId, { bloqueadoEn: a.bloqueadoEn.toISOString() })
        },
      )
      // Nota 1: la MISMA llave que A6 (`PAID_WITH_DEACTIVATED` + orderId) y la MISMA medición: si el cobro ya avisó, no se duplica.
      await recorrer(
        'sin-respaldo',
        despuesDe => this.d.buscarCandidatasSinRespaldo({ movidasDesde: hace(VENTANA_MS), despuesDe, limite: LIMITE }),
        c => c.orderId,
        async c => {
          const h = await leer('sin-respaldo.medir', () => this.d.medirSinRespaldo(c))
          if (!h) return
          r.cuentasCanceladasConDinero += 1
          const { orderId, venueId, ...dinero } = h
          await avisar('PAID_WITH_DEACTIVATED', orderId, venueId, { motivo: 'REVISION_NOCTURNA', orderId, ...dinero })
        },
      )
      // Nota 2: sólo avisa; cerrar la cuenta mueve su estado y no le toca a la noche.
      await recorrer(
        'en-cero',
        despuesDe =>
          this.d.buscarCandidatasEnCero({
            movidasDesde: hace(VENTANA_MS),
            sinMovimientoDesde: hace(SIN_MOVIMIENTO_MS),
            despuesDe,
            limite: LIMITE,
          }),
        c => c.orderId,
        async c => {
          const h = await leer('en-cero.medir', () => this.d.medirEnCero(c))
          if (!h) return
          r.cuentasEnCeroAbiertas += 1
          const { orderId, venueId, ...dinero } = h
          await avisar('OPEN_AT_ZERO_WITH_PENDING', orderId, venueId, { motivo: 'REVISION_NOCTURNA', orderId, ...dinero })
        },
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
      // r1 M6: una corrida con fallas se ve aunque no haya hallazgos.
      if (r.fallidas > 0) logger.warn('🎁 [tarjetas de regalo] revisión nocturna', { ...r })
      else if (hallazgos > 0) logger.info('🎁 [tarjetas de regalo] revisión nocturna', { ...r })
      return r
    } finally {
      this.running = false
    }
  }
}

export const giftCardReconciliationJob = new GiftCardReconciliationJob()
