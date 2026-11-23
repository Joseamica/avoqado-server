/**
 * C6 · «lo que cae en el banco esta semana» (la B del soporte por WhatsApp): lo mismo que «Saldo Disponible» del panel enseña para una
 * semana (`getSettlementsLandingInWeek`, que sigue sirviendo al panel y es la vara de la paridad), pero sumado por GRUPOS en la base:
 * al servidor viajan grupos, nunca los cobros.
 *
 * Por qué cuadra con el panel. El filtro es el suyo (la sucursal, COMPLETED, con comercio, sin efectivo, `createdAt` de `weekStart`
 * − 21 días a `weekEnd`), y cada cobro se une a su costo y a SU regla vigente a la hora del cobro (la de `encontrarReglaActiva`:
 * comercio, tipo de tarjeta, vigencia; la de `effectiveFrom` más reciente). Sin costo o sin regla no entra, como en el panel. Un grupo
 * junta los cobros de UNA regla, UN día de la zona del corte, el mismo lado de la hora de corte y UN día de la sucursal: dentro de un
 * grupo el día del depósito sólo puede crecer con la hora del cobro, así que si el primero y el último caen el mismo día (con las
 * funciones del panel, `calculateSettlementDate` y `formatInTimeZone`), todos caen ahí. Si no, o si una de las dos zonas cambia de
 * horario entre el cobro y el depósito, el grupo no se puede repartir y la B no da la cifra (UNEVEN_GROUP): nunca una cifra que no sea
 * la del panel. Un grupo que cae entero fuera de la semana se deja fuera, como el panel deja fuera sus cobros.
 * El dinero: la base suma importe + propina y la comisión redondeada a 2 decimales por cobro (`ROUND`, la mitad lejos del cero, como
 * `proyectarComisionYNeto`); aquí se pasa a centavos exactos y se suma con `sumaExactaDeDinero` (Task P1), como el panel. Una suma que
 * no se lee (no es un número finito) lanza: la B nunca dice $0 por algo que no pudo leer (C6 r1).
 *
 * La lectura es UNA transacción con `SET LOCAL statement_timeout` (si la base la corta, el error sube: nunca una suma a medias) y UNA
 * consulta agrupada con tope (`caps.groups`); las reglas se cargan después por los ids de los grupos que salieron.
 * Índices: `Payment @@index([venueId, status, createdAt])`; `TransactionCost.paymentId @unique`;
 * `SettlementConfiguration @@unique([merchantAccountId, cardType, effectiveFrom])`.
 */
import { Prisma } from '@prisma/client'
import { formatInTimeZone, getTimezoneOffset } from 'date-fns-tz'
import { calculateSettlementDate } from '@/services/payments/settlementCalculation.service'
import { aCentavosEstricto, aPesos, nuevaSuma, sumar, type SumaDeDinero } from '@/services/payments/sumaExactaDeDinero'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import type { ActiveConfig } from './settlementCalendar.dashboard.service'

export interface SettlementGroup {
  configId: string
  gross: string // decimal exacto de la base: SUM(amount + tipAmount)
  commission: string // decimal exacto de la base: SUM(ROUND(venueChargeAmount + venueFixedFee, 2))
  count: number
  first: Date
  last: Date
}
export type SettlementWeekByGroups =
  | { ok: true; days: { date: string; net: number }[]; total: { gross: number; commission: number; net: number; count: number } } // date: yyyy-MM-dd en la zona de la sucursal
  | { ok: false; reason: 'UNEVEN_GROUP' | 'TOO_MANY_GROUPS' }

/** El mismo margen que el panel: un cobro de hasta 21 días antes de la semana todavía puede caer en ella. */
const LOOKBACK_MS = 21 * 24 * 60 * 60 * 1000

/**
 * La consulta agrupada. Exportada para que la prueba lea su plan (`EXPLAIN`) sobre exactamente lo mismo. `limit` es el tope de
 * renglones que pide quien llama (el tope de grupos + 1, para saber si se pasó).
 */
export function settlementGroupsSql(venueId: string, weekStart: Date, weekEnd: Date, venueTimezone: string, limit: number): Prisma.Sql {
  const from = new Date(weekStart.getTime() - LOOKBACK_MS)
  // La hora del cobro en la zona del corte de SU regla, con minutos: «después del corte» compara horas y minutos, como isAfterCutoff
  const cutoffClock = Prisma.sql`((p."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE r."cutoffTimezone")`
  return Prisma.sql`
    SELECT r."id" AS "configId",
           SUM(p."amount" + p."tipAmount")::text AS "gross",
           SUM(ROUND(tc."venueChargeAmount" + tc."venueFixedFee", 2))::text AS "commission",
           COUNT(*)::int AS "count",
           MIN(p."createdAt") AS "first",
           MAX(p."createdAt") AS "last"
    FROM "Payment" p
    JOIN "TransactionCost" tc ON tc."paymentId" = p."id"
    JOIN LATERAL (
      SELECT sc."id", sc."cutoffTime", sc."cutoffTimezone"
      FROM "SettlementConfiguration" sc
      WHERE sc."merchantAccountId" = p."merchantAccountId"
        AND sc."cardType" = tc."transactionType"
        AND sc."effectiveFrom" <= p."createdAt"
        AND (sc."effectiveTo" IS NULL OR sc."effectiveTo" >= p."createdAt")
      ORDER BY sc."effectiveFrom" DESC
      LIMIT 1
    ) r ON TRUE
    WHERE p."venueId" = ${venueId}
      AND p."status" = 'COMPLETED'
      AND p."merchantAccountId" IS NOT NULL
      AND p."method" <> 'CASH'
      AND p."createdAt" >= ${utcTs(from)}
      AND p."createdAt" <= ${utcTs(weekEnd)}
    GROUP BY r."id",
             (${cutoffClock})::date,
             date_trunc('minute', ${cutoffClock})::time > r."cutoffTime"::time,
             ((p."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${venueTimezone})::date
    LIMIT ${limit}
  `
}

/** Puro: el día de cada grupo con las funciones del panel, y la suma exacta por día. Un grupo cuya regla no llegó lanza. */
export function foldSettlementGroups(
  groups: SettlementGroup[],
  configs: (ActiveConfig & { id: string })[],
  weekStart: Date,
  weekEnd: Date,
  venueTimezone: string,
): SettlementWeekByGroups {
  const startKey = formatInTimeZone(weekStart, venueTimezone, 'yyyy-MM-dd')
  const endKey = formatInTimeZone(weekEnd, venueTimezone, 'yyyy-MM-dd')
  const byDay = new Map<string, SumaDeDinero>()
  const total = nuevaSuma()
  for (const group of groups) {
    const rule = configs.find(c => c.id === group.configId)
    if (!rule) throw new Error('Settlement week: the rule of a group was not loaded')
    const land = (at: Date) => {
      const deposit = calculateSettlementDate(at, rule)
      return {
        day: formatInTimeZone(deposit, venueTimezone, 'yyyy-MM-dd'),
        shifted: [rule.cutoffTimezone, venueTimezone].some(tz => getTimezoneOffset(tz, at) !== getTimezoneOffset(tz, deposit)),
      }
    }
    const first = land(group.first)
    const last = land(group.last)
    // Todo el grupo cae antes o después de la semana: el panel tampoco cuenta ninguno de sus cobros
    if (last.day < startKey || first.day > endKey) continue
    if (first.day !== last.day || first.shifted || last.shifted) return { ok: false, reason: 'UNEVEN_GROUP' }
    // Estricto (C6 r1): una suma que no se puede leer lanza (QUERY_FAILED), nunca cuenta $0
    const gross = aCentavosEstricto(group.gross)
    const commission = aCentavosEstricto(group.commission)
    const amounts = { gross, commission, net: gross - commission, count: group.count }
    const day = byDay.get(first.day) ?? nuevaSuma()
    sumar(day, amounts)
    byDay.set(first.day, day)
    sumar(total, amounts)
  }
  const days = Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, sum]) => ({ date, net: aPesos(sum).net }))
  return { ok: true, days, total: aPesos(total) }
}

const RULE_SELECT = {
  id: true,
  merchantAccountId: true,
  cardType: true,
  settlementDays: true,
  settlementDayType: true,
  cutoffTime: true,
  cutoffTimezone: true,
  effectiveFrom: true,
  effectiveTo: true,
} as const

/** Lo que cae en el banco en [weekStart, weekEnd] (de la sucursal), sumado por grupos en la base. Ver la cabecera. */
export async function getSettlementWeekByGroups(
  venueId: string,
  weekStart: Date,
  weekEnd: Date,
  venueTimezone: string,
  caps: { groups: number; timeoutMs: number },
): Promise<SettlementWeekByGroups> {
  const maxGroups = Math.max(1, Math.trunc(caps.groups) || 1)
  const timeoutMs = Math.max(1, Math.trunc(caps.timeoutMs) || 1)
  const read = await prisma.$transaction(
    async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`)
      const groups = await tx.$queryRaw<SettlementGroup[]>(settlementGroupsSql(venueId, weekStart, weekEnd, venueTimezone, maxGroups + 1))
      if (groups.length > maxGroups) return null
      const ids = [...new Set(groups.map(g => g.configId))]
      const configs = ids.length
        ? await tx.settlementConfiguration.findMany({ where: { id: { in: ids } }, select: RULE_SELECT, take: maxGroups })
        : []
      return { groups, configs }
    },
    // Las dos lecturas sobre la misma foto; la espera de Prisma, por arriba del tope de la base (que es el que corta)
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: timeoutMs + 2_000 },
  )
  if (!read) return { ok: false, reason: 'TOO_MANY_GROUPS' }
  return foldSettlementGroups(read.groups, read.configs, weekStart, weekEnd, venueTimezone)
}
