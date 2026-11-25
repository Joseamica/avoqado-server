/**
 * D27 (25-nov-2026): los puntos de lealtad vencen de verdad cuando el negocio prende la expiración. Promesa y mapa de entradas:
 * Avoqado/docs/audit/2026-11-25-defectos-lealtad-referidos/lealtad/promesa.md.
 *
 * La regla es por INACTIVIDAD: si un cliente pasa N días sin mover sus puntos, vence TODO su saldo. Square vence por lote (cada compra a los
 * N meses, lo más viejo primero), pero con este modelo eso no cuadra: las reversas de reembolso quitan los puntos de UNA venta y los canjes
 * no dicen de cuál (Codex r1 y r2: 11 bloqueantes cada una, misma familia). Por inactividad es exacto: un vencimiento se lleva todo, así
 * que cualquier venta anterior a él ya no tiene puntos en el saldo (lo usa `reversaEnTx` para no cobrarlos dos veces).
 *
 *  · Actividad = el último movimiento del cliente que no sea un vencimiento ni una reversa de reembolso (`refundPaymentId`).
 *  · Fecha que cuenta = la mayor entre esa actividad y `LoyaltyConfig.pointsExpireSince` (el ancla: nada vence de golpe al desplegar,
 *    prender, reactivar o acortar). Sin movimientos (un saldo sembrado), cuenta el ancla.
 *  · Actividad el día local d ⇒ vence al empezar el día d + N, en la zona del negocio.
 *  · Idempotente: tras vencer, el saldo es 0 y la vuelta siguiente no hace nada.
 */
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { LoyaltyTransactionType } from '@prisma/client'
import logger from '@/config/logger'
import { NON_OPERATIONAL_VENUE_STATUSES } from '@/lib/venueStatus.constants'
import prisma from '@/utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'
import { zonaDelCalculo } from '@/utils/sanitizeTimezone'
import { withDeadlockRetry } from '@/utils/serializableRetry'
import { venueHasFeatureAccess } from '../access/basePlan.service'
import { logAction } from '../dashboard/activity-log.service'
import { conNegocio } from '../demo/candadoDemo'

const DIA_MS = 86_400_000
/** Cien años: más que eso es «nunca» en la práctica y evita fechas fuera de rango (un `pointsExpireDays` de 2,147,483,647). */
const MAX_DIAS = 36_500
const PAGINA = 100
/** El mismo presupuesto que la escritura de puntos de una venta (`PRESUPUESTO_DE_LA_LEALTAD_DE_LA_VENTA`): dos lecturas por índice y tres escrituras. */
const PRESUPUESTO = { maxWait: 10_000, timeout: 15_000 } as const

type Reloj = () => Date
const relojReal: Reloj = () => new Date()

/** Inicio (UTC real) del día local de `hoy − (dias − 1)` en `timezone`: vence quien no tiene actividad desde antes de esto. */
export function limiteDeVencimiento(now: Date, timezone: string, dias: number): Date {
  if (!Number.isInteger(dias) || dias < 1) throw new Error(`Días de vencimiento inválidos: ${dias}`)
  const n = Math.min(dias, MAX_DIAS)
  // Por calendario, sin que el proceso lea una fecha suelta (producción corre en UTC; ver critical-warnings.md).
  const [y, m, d] = formatInTimeZone(now, timezone, 'yyyy-MM-dd').split('-').map(Number)
  const fecha = new Date(Date.UTC(y, m - 1, d) - (n - 1) * DIA_MS).toISOString().slice(0, 10)
  let limite = fromZonedTime(`${fecha}T00:00:00.000`, timezone)
  // Un día que empieza a la 01:00 (cambio de horario a medianoche, p. ej. America/Santiago): esa medianoche no existe y lo de arriba cae
  // en el día anterior. Se avanza hasta el primer instante real del día (los cambios de horario son en punto o a la media hora).
  for (let i = 0; i < 8 && formatInTimeZone(limite, timezone, 'yyyy-MM-dd') < fecha; i++) limite = new Date(limite.getTime() + 15 * 60_000)
  return limite
}

const fechaCorta = (instante: Date, timezone: string) => formatInTimeZone(instante, timezone, 'dd/MM/yyyy')

export interface VencimientoDelCliente {
  vencidos: number
}
const NADA: VencimientoDelCliente = { vencidos: 0 }

/**
 * Vence el saldo de UN cliente si ya le toca. Todo se relee bajo sus candados, en este orden (promesa, «Mapa de entradas»):
 * advisory (venue, cliente) — el de `earnPoints` y `grantStamp` — → fila Customer → LoyaltyConfig FOR SHARE (un guardado de la config
 * espera a esto, y esto a él). Customer antes que LoyaltyConfig, como la limpieza demo → real; nunca toca filas de movimientos ni la del
 * negocio.
 * El EXPIRE, el saldo en 0 y el ActivityLog van en la MISMA transacción: o quedan los tres o ninguno.
 */
export async function vencerPuntosDelCliente(
  venueId: string,
  customerId: string,
  reloj: Reloj = relojReal,
): Promise<VencimientoDelCliente> {
  return withDeadlockRetry(
    async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${venueId}), hashtext(${customerId}))`
      const [cliente] = await tx.$queryRaw<Array<{ loyaltyPoints: number }>>`
        SELECT "loyaltyPoints" FROM "Customer" WHERE id = ${customerId} AND "venueId" = ${venueId} FOR UPDATE`
      if (!cliente || cliente.loyaltyPoints <= 0) return NADA
      await tx.$queryRaw`SELECT id FROM "LoyaltyConfig" WHERE "venueId" = ${venueId} FOR SHARE`
      const config = await tx.loyaltyConfig.findUnique({
        where: { venueId },
        select: { active: true, pointsExpireDays: true, pointsExpireSince: true },
      })
      if (!config?.active || !config.pointsExpireDays || config.pointsExpireDays < 1 || !config.pointsExpireSince) return NADA
      // Zona y estado releídos aquí (Codex r2 #10 y #14). Sin candado de la fila del negocio a propósito: la limpieza demo → real y el borrado
      // de un negocio toman esa fila ANTES que la del cliente, y tomarla aquí después cerraba un ciclo (Codex r4 #1). Una suspensión o un
      // cambio de zona en el mismo instante puede no alcanzar a ESTE cliente: límite declarado en la promesa.
      const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { timezone: true, status: true } })
      if (!venue || NON_OPERATIONAL_VENUE_STATUSES.includes(venue.status)) return NADA

      const ahora = reloj()
      // Una zona vieja («GMT-6») no tumba el cálculo: la misma normalización que los reportes (Codex r3 #4).
      const zona = zonaDelCalculo(venue.timezone)
      const limite = limiteDeVencimiento(ahora, zona, config.pointsExpireDays)
      const ultimo = await tx.loyaltyTransaction.findFirst({
        where: { customerId, type: { not: LoyaltyTransactionType.EXPIRE }, refundPaymentId: null },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })
      const desde = ultimo && ultimo.createdAt > config.pointsExpireSince ? ultimo.createdAt : config.pointsExpireSince
      if (desde >= limite) return NADA

      const saldo = cliente.loyaltyPoints
      const dias = config.pointsExpireDays
      const reason = `Vencieron ${saldo} puntos: ${dias} días sin movimientos de puntos (desde el ${fechaCorta(desde, zona)})`
      const movimiento = await tx.loyaltyTransaction.create({
        // `wholeBalance`: este vencimiento se llevó TODO el saldo; `reversaEnTx` sólo confía en estos (los EXPIRE de antes eran parciales).
        data: { customerId, type: LoyaltyTransactionType.EXPIRE, points: -saldo, reason, wholeBalance: true },
        select: { id: true },
      })
      await tx.customer.update({ where: { id: customerId }, data: { loyaltyPoints: { decrement: saldo } } })
      // `tx.activityLog.create` y no `logAction`: `logAction` abre su propia conexión y, si el proceso muriera después del commit, el dueño
      // vería el vencimiento en el historial del cliente pero no en su registro (Codex r1 #6).
      await tx.activityLog.create({
        data: {
          venueId,
          staffId: null,
          action: 'LOYALTY_POINTS_EXPIRED',
          entity: 'Customer',
          entityId: customerId,
          data: {
            points: saldo,
            newBalance: 0,
            pointsExpireDays: dias,
            inactiveSince: desde.toISOString(),
            loyaltyTransactionId: movimiento.id,
          },
        },
      })
      return { vencidos: saldo }
    },
    { etiqueta: 'vencerPuntosDelCliente', ...PRESUPUESTO },
  )
}

export interface VencimientoDelNegocio {
  customersAffected: number
  pointsExpired: number
  /** Clientes que tronaron: se saltaron y salen en la siguiente vuelta. */
  fallidos: number
  /** La primera vez que se ve el negocio sólo se arranca su reloj (ancla) y no vence nada. */
  anclaFijada: boolean
  /** El negocio no tiene el plan de lealtad (o lo perdió a media tanda): no se tocó a nadie (más). */
  sinPlan: boolean
}

/**
 * Vence lo que toca en UN negocio, de punta a punta. La usan el job (cada hora) y `POST /loyalty/expire-old-points` (a mano). Un cliente
 * que truena se salta (paginación por id) y se reintenta en la siguiente vuelta.
 */
export async function vencerPuntosDelNegocio(venueId: string, reloj: Reloj = relojReal): Promise<VencimientoDelNegocio> {
  const resultado: VencimientoDelNegocio = { customersAffected: 0, pointsExpired: 0, fallidos: 0, anclaFijada: false, sinPlan: false }
  const config = await prisma.loyaltyConfig.findUnique({
    where: { venueId },
    select: { active: true, pointsExpireDays: true, pointsExpireSince: true },
  })
  if (!config?.active || !config.pointsExpireDays || config.pointsExpireDays < 1) return resultado
  // Sin el plan, los puntos no se pueden canjear y el dueño ni puede abrir Lealtad para apagar la expiración: no vence nada.
  if (!(await venueHasFeatureAccess(venueId, 'LOYALTY_PROGRAM'))) return { ...resultado, sinPlan: true }
  // Suspendido o cerrado: no vence nada (si lo reactivan, la siguiente vuelta lo revisa).
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true, status: true } })
  if (!venue || NON_OPERATIONAL_VENUE_STATUSES.includes(venue.status)) return resultado
  const zona = zonaDelCalculo(venue.timezone)

  if (!config.pointsExpireSince) {
    // Ancla perezosa (Codex r1 #4): el reloj arranca cuando este código corre, no cuando corrió la migración. Sólo si sigue nula: un
    // guardado del dueño que la fijó mientras tanto manda (Codex r2 #4).
    const ahora = reloj()
    const fijada = await prisma.loyaltyConfig.updateMany({
      where: { venueId, pointsExpireSince: null },
      data: { pointsExpireSince: ahora },
    })
    if (fijada.count === 1) {
      void logAction({
        venueId,
        action: 'LOYALTY_EXPIRATION_CLOCK_STARTED',
        entity: 'LoyaltyConfig',
        entityId: venueId,
        data: {
          pointsExpireSince: ahora.toISOString(),
          pointsExpireDays: config.pointsExpireDays,
          motivo: 'primer día con vencimiento automático',
        },
      })
    }
    // Recién arrancado el reloj, nada puede vencer antes de N días.
    return { ...resultado, anclaFijada: fijada.count === 1 }
  }

  const limite = limiteDeVencimiento(reloj(), zona, config.pointsExpireDays)
  // Todo cuenta a lo más desde el ancla: mientras no pase el límite, nadie puede vencer (los primeros N días tras el despliegue).
  if (config.pointsExpireSince >= limite) return resultado

  let cursor: string | null = null
  for (;;) {
    const pagina: Array<{ id: string }> = await prisma.customer.findMany({
      where: {
        venueId,
        loyaltyPoints: { gt: 0 },
        ...(cursor ? { id: { gt: cursor } } : {}),
        // Sin actividad desde el límite. Es sólo la lista de candidatos: el cliente se relee bajo sus candados.
        loyaltyTransactions: { none: { type: { not: LoyaltyTransactionType.EXPIRE }, refundPaymentId: null, createdAt: { gte: limite } } },
      },
      orderBy: { id: 'asc' },
      take: PAGINA,
      select: { id: true },
    })
    for (const { id } of pagina) {
      cursor = id
      try {
        // El plan, justo antes de cada cliente: como cualquier operación de lealtad, que lo revisa al empezar (Codex r1 #10).
        if (!(await venueHasFeatureAccess(venueId, 'LOYALTY_PROGRAM'))) return { ...resultado, sinPlan: true }
        const { vencidos } = await vencerPuntosDelCliente(venueId, id, reloj)
        if (vencidos > 0) {
          resultado.customersAffected += 1
          resultado.pointsExpired += vencidos
        }
      } catch (error) {
        resultado.fallidos += 1
        logger.error('🔴 [LEALTAD] No se pudieron vencer los puntos de un cliente; se reintenta en la siguiente vuelta', {
          venueId,
          customerId: id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (pagina.length < PAGINA) return resultado
  }
}

/**
 * La vuelta del job (cada hora): TODOS los negocios con la expiración prendida, cada uno de punta a punta. Sin memoria entre vueltas a
 * propósito: cada vuelta vuelve a preguntarle todo a la base, así que nada queda «dado por revisado» por error (Codex r3 #6, r4 #2–#4, r5
 * #1–#3: la memoria, el cursor y los presupuestos traían cada ronda un caso nuevo). Lo que tronó se reintenta en la siguiente vuelta; si una
 * vuelta tarda más de una hora, la siguiente empieza en la hora que sigue a su fin. El costo por negocio y por hora es una búsqueda de
 * candidatos por índice; durante los primeros N días después de arrancar el reloj, ni eso.
 */
export async function vencerPuntosVencidos(
  reloj: Reloj = relojReal,
): Promise<{ negocios: number; customersAffected: number; pointsExpired: number; fallidos: number }> {
  const total = { negocios: 0, customersAffected: 0, pointsExpired: 0, fallidos: 0 }
  let after: string | null = null
  for (;;) {
    const desde: string | null = after
    // Regla cron-jobs.md: la lectura de ENTRADA reintenta errores de conexión (estampida de la hora en punto).
    const pagina: Array<{ venueId: string }> = await retry(
      () =>
        prisma.loyaltyConfig.findMany({
          where: { active: true, pointsExpireDays: { gt: 0 }, ...(desde ? { venueId: { gt: desde } } : {}) },
          orderBy: { venueId: 'asc' },
          take: PAGINA_DE_NEGOCIOS,
          select: { venueId: true },
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'loyalty-points-expiry.configs' },
    )
    for (const { venueId } of pagina) {
      try {
        // Con el negocio en el contexto (candado demo, capa 3; y el log dice de quién es cada línea).
        const r = await conNegocio(venueId, () => vencerPuntosDelNegocio(venueId, reloj))
        total.negocios += 1
        total.customersAffected += r.customersAffected
        total.pointsExpired += r.pointsExpired
        total.fallidos += r.fallidos
      } catch (error) {
        total.fallidos += 1
        logger.error('🔴 [LEALTAD] Falló el vencimiento de puntos de un negocio; se reintenta en la siguiente hora', {
          venueId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (pagina.length < PAGINA_DE_NEGOCIOS) return total
    after = pagina[pagina.length - 1].venueId
  }
}

const PAGINA_DE_NEGOCIOS = 200
