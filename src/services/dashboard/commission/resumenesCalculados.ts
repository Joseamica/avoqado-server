/**
 * «Resumen de Comisiones» (dashboard › Comisiones, y el historial de la persona en Equipo): lo CALCULADO por persona y periodo.
 *
 * E6a-fix2 C6 (full-testing): la tabla leía los montos que GUARDA el job diario en `CommissionSummary`, y contradecía al recibo
 * de Pago al personal y al KPI «Calculado». Medido en la base de QA (8-oct), cada diferencia tenía su causa:
 *   - el incremento del job no es idempotente: una comisión de $7.62 quedó sumada DOS veces ($230.00 contra $222.38);
 *   - un resumen guardó la suma SIN redondear y el recibo suma renglones redondeados ($103.56 contra $103.57);
 *   - el job sólo agrega el periodo EN CURSO: lo calculado después de su última pasada del mes nunca tiene resumen
 *     ($75.00 de septiembre que la tabla no mostraba), y lo de hoy (un reverso de −$5.00) todavía no entra.
 *
 * Ahora los montos salen de la MISMA fuente que el KPI «Calculado» (`getVenueCommissionStats`): las comisiones vivas
 * (`CommissionCalculation` sin anuladas, con sus reversos), sumadas en la base al centavo. Se agrupan por persona y por el
 * periodo de agregación de la sede (el del job: `periodoDeAgregacion`), en su zona. El resumen guardado, si existe para esa
 * persona y periodo, sólo aporta su identidad (id, estado, aprobación, pagos viejos), nunca sus montos.
 *
 * La forma de la respuesta no cambia (los campos de `CommissionSummary` + `staff`, `approvedBy` y `_count`). Los bonos de
 * hitos no son parte de lo calculado (tampoco del KPI ni del recibo): `totalBonuses` y las deducciones van en 0.
 */
import { CommissionSummaryStatus, Prisma, TierPeriod } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError } from '../../../errors/AppError'
import { localWallClock, utcTs } from '../../../utils/sqlDates'
import { getVenueTimezone } from './commission-utils'

export interface FiltrosDeResumen {
  staffId?: string
  status?: CommissionSummaryStatus
  periodStart?: Date
  periodEnd?: Date
  /** Cuántas filas como máximo (se acota a `TOPE_RESUMENES`). */
  limite?: number
}

/**
 * Un renglón por persona y periodo (no por cobro). Medido: el máximo de la QA son 9; 500 son, en mensual, 40 personas por un
 * año. La respuesta trae el total verdadero, para que un recorte nunca sea silencioso.
 */
export const TOPE_RESUMENES = 500

/** El periodo con el que el job diario agrupa la sede: el de su esquema activo de mayor prioridad; sin esquema, mensual. */
export async function periodoDeAgregacion(venueId: string): Promise<TierPeriod> {
  const activo = await prisma.commissionConfig.findFirst({
    where: { venueId, active: true, deletedAt: null },
    orderBy: { priority: 'desc' },
    select: { aggregationPeriod: true },
  })
  return activo?.aggregationPeriod ?? TierPeriod.MONTHLY
}

/** Inicio del periodo (reloj de pared de la sede) de un instante; idéntico a `getPeriodDateRange` del job. */
function inicioDelPeriodo(periodo: TierPeriod, pared: Prisma.Sql): Prisma.Sql {
  switch (periodo) {
    case TierPeriod.DAILY:
      return Prisma.sql`date_trunc('day', ${pared})`
    case TierPeriod.WEEKLY: // lunes, como `startOfWeek(…, { weekStartsOn: 1 })`
      return Prisma.sql`date_trunc('week', ${pared})`
    case TierPeriod.BIWEEKLY: // bloques de 14 días contados desde el 1 de enero
      return Prisma.sql`(date_trunc('year', ${pared}) + floor(extract(epoch FROM (${pared} - date_trunc('year', ${pared}))) / 1209600) * interval '14 days')`
    case TierPeriod.QUARTERLY:
      return Prisma.sql`date_trunc('quarter', ${pared})`
    case TierPeriod.YEARLY:
      return Prisma.sql`date_trunc('year', ${pared})`
    default:
      return Prisma.sql`date_trunc('month', ${pared})`
  }
}

const PASO: Record<TierPeriod, string> = {
  DAILY: '1 day',
  WEEKLY: '7 days',
  BIWEEKLY: '14 days',
  MONTHLY: '1 month',
  QUARTERLY: '3 months',
  YEARLY: '1 year',
}

interface Fila {
  staffId: string
  periodStart: Date
  periodEnd: Date
  comisiones: Prisma.Decimal
  ventas: Prisma.Decimal
  n: number
  ordenes: number
  primera: Date
  ultima: Date
  firstName: string
  lastName: string
  email: string
  staffVenueId: string | null
  summaryId: string | null
  summaryStatus: CommissionSummaryStatus | null
  version: number | null
  approvedAt: Date | null
  approvedById: string | null
  disputedAt: Date | null
  disputeReason: string | null
  disputeResolvedAt: Date | null
  notes: string | null
  summaryCreatedAt: Date | null
  summaryUpdatedAt: Date | null
  approverFirstName: string | null
  approverLastName: string | null
  payouts: number
  total: number
}

function validar(f: FiltrosDeResumen): void {
  if (f.status !== undefined && !Object.values(CommissionSummaryStatus).includes(f.status))
    throw new BadRequestError('Estado de resumen inválido')
  for (const d of [f.periodStart, f.periodEnd])
    if (d !== undefined && Number.isNaN(d.getTime())) throw new BadRequestError('Fecha inválida')
}

/** Los renglones de la tabla y cuántos hay en total (antes del tope). */
export async function resumenesCalculados(venueId: string, f: FiltrosDeResumen = {}): Promise<{ filas: any[]; total: number }> {
  validar(f)
  const [tz, periodo] = await Promise.all([getVenueTimezone(venueId), periodoDeAgregacion(venueId)])
  const limite = Math.min(Math.max(Math.trunc(f.limite ?? TOPE_RESUMENES), 1), TOPE_RESUMENES)
  const inicio = inicioDelPeriodo(periodo, localWallClock(tz, Prisma.raw('cc."calculatedAt"')))
  const deLaPersona = f.staffId ? Prisma.sql`AND cc."staffId" = ${f.staffId}` : Prisma.empty
  const desde = f.periodStart ? Prisma.sql`AND p."periodStart" >= ${utcTs(f.periodStart)}` : Prisma.empty
  const hasta = f.periodEnd ? Prisma.sql`AND p."periodEnd" <= ${utcTs(f.periodEnd)}` : Prisma.empty
  const estado = f.status
    ? Prisma.sql`AND coalesce(cs.status, 'CALCULATED'::"CommissionSummaryStatus") = ${f.status}::"CommissionSummaryStatus"`
    : Prisma.empty
  const filas = await prisma.$queryRaw<Fila[]>(Prisma.sql`
    WITH vivas AS (
      SELECT cc."staffId", ${inicio} AS b, cc."netCommission", cc."baseAmount", cc."orderId", cc."calculatedAt"
      FROM "CommissionCalculation" cc
      WHERE cc."venueId" = ${venueId} AND cc.status <> 'VOIDED'::"CommissionCalcStatus" ${deLaPersona}
    ),
    grupos AS (
      SELECT "staffId", b, sum("netCommission") AS comisiones, sum("baseAmount") AS ventas, count(*)::int AS n,
             count(DISTINCT "orderId")::int AS ordenes, min("calculatedAt") AS primera, max("calculatedAt") AS ultima
      FROM vivas GROUP BY "staffId", b
    ),
    p AS (
      SELECT g.*, ((g.b AT TIME ZONE ${tz}) AT TIME ZONE 'UTC') AS "periodStart",
             (((g.b + ${PASO[periodo]}::interval - interval '1 millisecond') AT TIME ZONE ${tz}) AT TIME ZONE 'UTC') AS "periodEnd"
      FROM grupos g
    )
    SELECT p."staffId", p."periodStart", p."periodEnd", p.comisiones, p.ventas, p.n, p.ordenes, p.primera, p.ultima,
           s."firstName", s."lastName", s.email,
           (SELECT sv.id FROM "StaffVenue" sv WHERE sv."staffId" = p."staffId" AND sv."venueId" = ${venueId} LIMIT 1) AS "staffVenueId",
           cs.id AS "summaryId", cs.status AS "summaryStatus", cs.version, cs."approvedAt", cs."approvedById", cs."disputedAt",
           cs."disputeReason", cs."disputeResolvedAt", cs.notes, cs."createdAt" AS "summaryCreatedAt", cs."updatedAt" AS "summaryUpdatedAt",
           ab."firstName" AS "approverFirstName", ab."lastName" AS "approverLastName",
           (SELECT count(*)::int FROM "CommissionPayout" cp WHERE cp."summaryId" = cs.id) AS payouts,
           count(*) OVER ()::int AS total
    FROM p
    JOIN "Staff" s ON s.id = p."staffId"
    LEFT JOIN "CommissionSummary" cs ON cs."venueId" = ${venueId} AND cs."staffId" = p."staffId"
      AND cs."periodType" = ${periodo}::"TierPeriod" AND cs."periodStart" = p."periodStart"
    LEFT JOIN "Staff" ab ON ab.id = cs."approvedById"
    WHERE TRUE ${desde} ${hasta} ${estado}
    ORDER BY p."periodStart" DESC, s."lastName" ASC, s."firstName" ASC, p."staffId" ASC
    LIMIT ${limite}
  `)
  return { filas: filas.map(r => aRenglon(venueId, periodo, r)), total: filas[0]?.total ?? 0 }
}

const cero = () => new Prisma.Decimal(0)

/** La forma de siempre: los campos de `CommissionSummary` + `staff`, `approvedBy` y `_count`. */
function aRenglon(venueId: string, periodo: TierPeriod, r: Fila) {
  return {
    id: r.summaryId ?? `calculado-${r.staffId}-${r.periodStart.toISOString()}`,
    venueId,
    staffId: r.staffId,
    periodType: periodo,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    totalSales: r.ventas,
    totalTips: cero(),
    totalCommissions: r.comisiones,
    totalBonuses: cero(),
    totalClawbacks: cero(),
    grandTotal: r.comisiones,
    grossAmount: r.comisiones,
    deductionAmount: cero(),
    netAmount: r.comisiones,
    orderCount: r.ordenes,
    paymentCount: r.n,
    status: r.summaryStatus ?? CommissionSummaryStatus.CALCULATED,
    version: r.version ?? 0,
    approvedAt: r.approvedAt,
    approvedById: r.approvedById,
    disputedAt: r.disputedAt,
    disputeReason: r.disputeReason,
    disputeResolvedAt: r.disputeResolvedAt,
    notes: r.notes,
    createdAt: r.summaryCreatedAt ?? r.primera,
    updatedAt: r.summaryUpdatedAt ?? r.ultima,
    staff: { id: r.staffId, firstName: r.firstName, lastName: r.lastName, email: r.email, staffVenueId: r.staffVenueId },
    approvedBy: r.approvedById ? { id: r.approvedById, firstName: r.approverFirstName, lastName: r.approverLastName } : null,
    _count: { calculations: r.n, payouts: r.payouts },
  }
}
