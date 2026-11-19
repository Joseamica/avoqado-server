/**
 * «¿Entró un cobro de $X?»: los cobros de UNA sucursal cuyo importe, o importe + propina, es exactamente un monto, dentro de una o dos
 * ventanas de hora. Lo usan la B del soporte por WhatsApp (C2 «buscar un cobro por su monto», C7 «si la venta de ese cobro tiene
 * factura») y la tool del MCP (Task 12).
 *
 * El filtro base es el del listado de Pagos del panel (`buildPaymentsWhereClause`), por su espejo en SQL `paymentsSqlScope`, que
 * `tests/integration/dashboard/listSummary-sql-parity.integration.test.ts` prueba contra Prisma: la sucursal, sin `PENDING`, y el rango
 * con `>=` y `<=`. Prisma no puede expresar `amount + tipAmount = X`, por eso va en SQL crudo, con fechas por `utcTs`.
 * Índice: `Payment @@index([venueId, createdAt])`. No lee el puente de QR del sistema anterior (quien llama lo dice).
 */
import type { CardBrand, PaymentMethod, TenderSystemKind, TransactionStatus } from '@prisma/client'
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { utcTs } from '../../utils/sqlDates'
import {
  CAMPOS_DE_LA_REGLA,
  estadoDeFacturaDeLaVenta,
  FACTURAS_QUE_CUENTAN_DE_LA_VENTA,
  type EstadoDeFacturaDeLaVenta,
} from '../fiscal/facturaDeLaVenta'
import type { TimeWindow } from '../support/data/params'
import { orAny } from './listSummary.shared'
import { paymentsSqlScope } from './paymentSummary.dashboard.service'

export interface PaymentByAmountRow {
  createdAt: Date
  amount: Prisma.Decimal
  tipAmount: Prisma.Decimal
  method: PaymentMethod
  cardBrand: CardBrand | null
  last4: string | null
  tenderSystemKind: TenderSystemKind | null // el tipo de pago de sistema (`STORE_CREDIT`…), el `tenderSystemKind` que lee Pagos; null sin él
  status: TransactionStatus
  orderId: string | null // por dentro, para la factura de su venta (C7 y Task 12); ninguna plantilla lo imprime
}

/** Tope de renglones, pida lo que pida quien llama (la B pide `SUPPORT_DATA_ROWS`, a lo más 5). El total sale aparte. */
const MAX_TAKE = 50

/**
 * La consulta: la usan `findPaymentsByAmount` y la tool del MCP (Task 12), y la prueba lee su plan (`EXPLAIN`) sobre exactamente lo
 * mismo. Sin ventanas no casa nada (`orAny([])` es FALSE) y no hay rango que calcular: el mínimo de nada sería `Infinity`.
 */
export function paymentsByAmountSql(venueId: string, input: { amount: Prisma.Decimal; windows: TimeWindow[]; take: number }): Prisma.Sql {
  const { windows } = input
  const range = windows.length
    ? {
        startDate: new Date(Math.min(...windows.map(w => w.from.getTime()))).toISOString(),
        endDate: new Date(Math.max(...windows.map(w => w.to.getTime()))).toISOString(),
      }
    : undefined
  // El monto como texto y `::numeric`: un número de JS llega con 16 dígitos y nunca casaría al centavo (listSummary.shared, decimalBind)
  const amount = Prisma.sql`(${input.amount.toFixed(2)})::numeric`
  const take = Math.min(Math.max(Math.trunc(input.take) || 1, 1), MAX_TAKE)
  return Prisma.sql`
    SELECT p."createdAt", p."amount", p."tipAmount", p."method"::text AS "method", p."cardBrand"::text AS "cardBrand",
           substring(p."maskedPan" from '[0-9]{4}$') AS "last4", t."systemKind"::text AS "tenderSystemKind",
           p."status"::text AS "status", p."orderId", (COUNT(*) OVER ())::int AS "total"
    FROM "Payment" p
    LEFT JOIN "VenueTenderType" t ON t."venueId" = p."venueId" AND t."id" = p."tenderTypeId"
    WHERE ${paymentsSqlScope(venueId, range)}
      AND ${orAny(windows.map(w => Prisma.sql`p."createdAt" >= ${utcTs(w.from)} AND p."createdAt" <= ${utcTs(w.to)}`))}
      AND (p."amount" = ${amount} OR p."amount" + p."tipAmount" = ${amount})
    ORDER BY p."createdAt" DESC, p."id" DESC
    LIMIT ${take}
  `
}

/** Cobros de la sucursal cuyo importe, o importe + propina, es exactamente `amount`, dentro de 1 o 2 ventanas. Nunca regresa el id del cobro, folio, referencia ni la tarjeta enmascarada. */
export async function findPaymentsByAmount(
  venueId: string,
  input: { amount: Prisma.Decimal; windows: TimeWindow[]; take: number },
): Promise<{ total: number; rows: PaymentByAmountRow[] }> {
  const found = await prisma.$queryRaw<(PaymentByAmountRow & { total: number })[]>(paymentsByAmountSql(venueId, input))
  return { total: found[0]?.total ?? 0, rows: found.map(({ total: _total, ...row }) => row) }
}

/** Las ventas que se piden de un golpe: la B lista hasta 5 cobros (C7). */
const MAX_SALES = 5

/**
 * El estado de la factura de hasta 5 ventas de la sucursal, con la regla del listado de ventas del panel («Nueva factura»,
 * `order.dashboard.service.ts` con `conFactura`): las facturas que cuentan (`FACTURAS_QUE_CUENTAN_DE_LA_VENTA`: individual, de ingreso,
 * timbrada o en cancelación) pasadas por `estadoDeFacturaDeLaVenta`. Una global no cuenta: el panel tampoco marca «Ya facturada» una
 * venta que sólo cubre una global (y deja facturarla aparte). Cada venta pedida sale en el mapa; `null` = sin factura que cuente.
 * UNA consulta, con la sucursal como última llave (una factura de otra sucursal nunca cuenta, aunque apunte a la venta): índice
 * `Cfdi @@index([orderId])`, take 50. Sólo lee los campos de la regla: nunca el UUID, el folio, el RFC, el receptor ni las ligas.
 * Con más de 5 lanza: quien llama ya cortó antes.
 */
export async function invoiceStateOfOrders(venueId: string, orderIds: string[]): Promise<Map<string, EstadoDeFacturaDeLaVenta | null>> {
  if (orderIds.length > MAX_SALES) throw new Error(`invoiceStateOfOrders: at most ${MAX_SALES} sales at once`)
  if (!orderIds.length) return new Map()
  const facturas = await prisma.cfdi.findMany({
    where: { ...FACTURAS_QUE_CUENTAN_DE_LA_VENTA, orderId: { in: orderIds }, venueId },
    select: { orderId: true, ...CAMPOS_DE_LA_REGLA },
    take: 50,
  })
  return new Map(orderIds.map(id => [id, estadoDeFacturaDeLaVenta(facturas.filter(f => f.orderId === id))]))
}
