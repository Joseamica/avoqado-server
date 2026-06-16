import { OrderStatus, PaymentType, TransactionStatus } from '@prisma/client'

import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { parseDbDateRange } from '../../utils/datetime'
import { splitIvaIncluded } from '../fiscal/ivaMath'

/**
 * Accounting — Capa A (gerencial, read-model)
 *
 * Estado de resultados de INGRESOS de un local en un periodo. NO es contabilidad fiscal:
 * corre sobre los pagos que el sistema ya tiene, sin capturar nada. Incluido para todos
 * los venues (gateado por permiso `accounting:read`, sin paywall).
 *
 * Convención de dinero: precios IVA-INCLUIDO (en México el precio al público ya trae el IVA).
 *   neto (base) = monto / (1 + tasa) · IVA trasladado = monto − neto
 * Todo se reporta en CENTAVOS enteros para exactitud contable. Las propinas NO son ingreso
 * (se reportan aparte, informativas). Las devoluciones (type=REFUND, monto negativo) se
 * restan del ingreso.
 *
 * Limitación conocida (v1): no hay costo de venta capturado para retail (QUANTITY) ni
 * serializado, por eso este read-model reporta INGRESOS, no utilidad bruta. La tasa de IVA
 * se asume 0.16 a nivel venue (`taxRateAssumed`) — el desglose exacto por producto es una
 * iteración posterior.
 */

const DEFAULT_IVA_RATE = 0.16

export interface IncomeStatementFilters {
  /** Fecha inicial en zona horaria del local, formato 'YYYY-MM-DD'. */
  from: string
  /** Fecha final en zona horaria del local, formato 'YYYY-MM-DD'. */
  to: string
}

export interface IncomeStatement {
  venueId: string
  venueName: string
  currency: 'MXN'
  timezone: string
  period: { from: string; to: string }
  /** Tasa de IVA asumida para el desglose a nivel venue (v1: 0.16). */
  taxRateAssumed: number
  revenue: {
    /** Ventas brutas (IVA-incluido, sin propina), antes de devoluciones. */
    grossSalesCents: number
    /** Devoluciones del periodo (magnitud positiva). */
    refundsCents: number
    /** Ingreso real cobrado = ventas brutas − devoluciones (IVA-incluido). */
    netRevenueCents: number
    /** Base gravable: ingreso neto sin IVA. */
    taxableBaseCents: number
    /** IVA trasladado embebido en el ingreso neto. */
    ivaCents: number
  }
  /** Propinas (informativas, NO forman parte del ingreso). */
  tips: { totalCents: number }
  metrics: { salesCount: number; refundCount: number; averageTicketCents: number }
}

/** Convierte un Decimal/number de pesos a centavos enteros. */
const toCents = (d: { toString(): string } | number | null): number => (d == null ? 0 : Math.round(Number(d) * 100))

/**
 * Calcula el estado de resultados (ingresos) de un local para [from, to].
 *
 * @param venueId  Local (tenant). Toda query se aísla por este id.
 * @param filters  Rango de fechas en zona horaria del local.
 */
export async function getIncomeStatement(venueId: string, filters: IncomeStatementFilters): Promise<IncomeStatement> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { name: true, timezone: true },
  })
  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  const timezone = venue.timezone || 'America/Mexico_City'
  // Payment es data creada por Prisma → UTC real. parseDbDateRange convierte los límites
  // del día en zona del local a UTC real (fromZonedTime), NO "fake UTC".
  const { from, to } = parseDbDateRange(filters.from, filters.to, timezone)

  const rows = await prisma.payment.findMany({
    where: {
      venueId,
      status: TransactionStatus.COMPLETED,
      createdAt: { gte: from, lte: to },
      order: { status: { not: OrderStatus.CANCELLED } },
    },
    select: { amount: true, tipAmount: true, type: true },
  })

  let grossSalesCents = 0
  let refundsCents = 0
  let tipsCents = 0
  let salesCount = 0
  let refundCount = 0

  for (const r of rows) {
    // Pagos de prueba del superadmin no son ingreso.
    if (r.type === PaymentType.TEST) continue

    const amountCents = toCents(r.amount) // con signo: las devoluciones ya vienen negativas

    if (r.type === PaymentType.REFUND) {
      refundsCents += Math.abs(amountCents)
      refundCount += 1
      continue
    }

    // REGULAR / FAST / ADJUSTMENT / null (legacy) → venta real
    grossSalesCents += amountCents
    tipsCents += toCents(r.tipAmount)
    salesCount += 1
  }

  const netRevenueCents = grossSalesCents - refundsCents
  const { netCents: taxableBaseCents, taxCents: ivaCents } = splitIvaIncluded(netRevenueCents, DEFAULT_IVA_RATE)
  const averageTicketCents = salesCount > 0 ? Math.round(grossSalesCents / salesCount) : 0

  return {
    venueId,
    venueName: venue.name,
    currency: 'MXN',
    timezone,
    period: { from: filters.from, to: filters.to },
    taxRateAssumed: DEFAULT_IVA_RATE,
    revenue: { grossSalesCents, refundsCents, netRevenueCents, taxableBaseCents, ivaCents },
    tips: { totalCents: tipsCents },
    metrics: { salesCount, refundCount, averageTicketCents },
  }
}
