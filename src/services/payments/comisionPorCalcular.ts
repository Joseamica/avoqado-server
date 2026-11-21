/**
 * D24 (21-nov-2026): ¿la comisión de este pago todavía se está calculando? Lo preguntan los que guardan una FOTO del dinero —la
 * póliza contable (`autoPosting.service.ts`) y la conciliación bancaria (`bankReconciliation.service.ts`)—, que no pueden tomarla
 * con la comisión provisional: un cobro con el costo diferido vive con comisión 0 y neto = bruto, y una devolución con tarjeta NACE
 * con comisión 0 y neto = −bruto hasta que llega su costo negativo (R13-5). Guardar esa foto dejaba la póliza sin el renglón de
 * comisión para siempre (su llave no se rehace) y un depósito «sin conciliar» por la comisión que faltaba.
 *
 * Sólo con lo que ya existe (ningún dato nuevo):
 *  1. la obligación vive en el COBRO: su marca `processorData.costPending` («la obligación no ha convergido»,
 *     `deferredTransactionCost.service.ts`). El dueño de una devolución es su `processorData.originalPaymentId`;
 *  2. y aun con la marca puesta, la comisión de ESTE pago ya es la final si tiene su `TransactionCost` y su comisión y neto son los
 *     que ese costo dicta con la regla de siempre (`proyectarComisionYNeto`). Así la venta original no espera por la devolución que
 *     reabrió su obligación (la marca vuelve a `true` al reembolsar un cobro ya cerrado).
 * Una obligación en DEAD_LETTER (agotó sus intentos) también está por calcular —la marca nunca baja sin converger— y se reporta
 * aparte: la cola no la va a reintentar sola, la tiene que revisar una persona.
 */
import { PaymentType, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { proyectarComisionYNeto } from './proyeccionMonetaria'

export type ComisionPorCalcular = 'PENDIENTE' | 'SIN_CALCULAR'

export interface PagoParaComision {
  id: string
  type: PaymentType | null
  amount: Prisma.Decimal | number | string
  feeAmount: Prisma.Decimal | number | string
  netAmount?: Prisma.Decimal | number | string | null
  processorData?: unknown
}

const objeto = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const a2 = (v: unknown): string => new Prisma.Decimal(String(v ?? 0)).toDecimalPlaces(2).toFixed(2)

/** La misma regla que usan la póliza y la conciliación para «es una devolución»: tipo REFUND o importe negativo. */
export const esDevolucionContable = (p: { type: PaymentType | null; amount: Prisma.Decimal | number | string }): boolean =>
  p.type === PaymentType.REFUND || new Prisma.Decimal(String(p.amount)).isNegative()

/**
 * De estos pagos (del mismo negocio), los que tienen la comisión por calcular. Mapa vacío = ninguno, sin consultas si ninguno tiene
 * dueño con obligación posible. Consultas acotadas por los ids recibidos.
 */
export async function comisionesPorCalcular(venueId: string, pagos: PagoParaComision[]): Promise<Map<string, ComisionPorCalcular>> {
  const duenoDe = new Map<string, string>()
  const originales = new Set<string>()
  for (const p of pagos) {
    if (esDevolucionContable(p)) {
      const original = objeto(p.processorData).originalPaymentId
      if (typeof original === 'string' && original) {
        duenoDe.set(p.id, original)
        originales.add(original)
      }
    } else if (objeto(p.processorData).costPending === true) {
      duenoDe.set(p.id, p.id)
    }
  }
  if (duenoDe.size === 0) return new Map()

  const duenosConMarca = new Set(pagos.filter(p => duenoDe.get(p.id) === p.id).map(p => p.id))
  if (originales.size > 0) {
    const ids = [...originales]
    const marcados = await prisma.payment.findMany({
      where: { venueId, id: { in: ids }, processorData: { path: ['costPending'], equals: true } },
      select: { id: true },
      take: ids.length,
      orderBy: { id: 'asc' },
    })
    for (const m of marcados) duenosConMarca.add(m.id)
  }
  const candidatos = pagos.filter(p => duenosConMarca.has(duenoDe.get(p.id) ?? ''))
  if (candidatos.length === 0) return new Map()

  const costos = await prisma.transactionCost.findMany({
    where: { paymentId: { in: candidatos.map(p => p.id) } },
    select: { paymentId: true, amount: true, venueChargeAmount: true, venueFixedFee: true },
    take: candidatos.length,
    orderBy: { paymentId: 'asc' },
  })
  const costoDe = new Map(costos.map(c => [c.paymentId, c]))
  const pendientes = candidatos.filter(p => {
    const costo = costoDe.get(p.id)
    if (!costo) return true
    const { fee, net } = proyectarComisionYNeto(costo.amount, costo.venueChargeAmount, costo.venueFixedFee)
    return a2(p.feeAmount) !== a2(fee) || a2(p.netAmount) !== a2(net)
  })
  if (pendientes.length === 0) return new Map()

  const duenosPendientes = [...new Set(pendientes.map(p => duenoDe.get(p.id)!))]
  const muertas = await prisma.paymentEffect.findMany({
    where: { paymentId: { in: duenosPendientes }, kind: 'TRANSACTION_COST', status: 'DEAD_LETTER' },
    select: { paymentId: true },
    take: duenosPendientes.length,
    orderBy: { paymentId: 'asc' },
  })
  const sinCalcular = new Set(muertas.map(m => m.paymentId))
  return new Map(pendientes.map(p => [p.id, sinCalcular.has(duenoDe.get(p.id)!) ? 'SIN_CALCULAR' : 'PENDIENTE']))
}
