/**
 * Invariantes de dinero de un pedido de delivery. Módulo PURO: sin Prisma, sin env.
 *
 * 🔴 Si el reparto no cuadra al centavo, RECHAZA. Nunca estima ni redondea a favor:
 * un pedido mal repartido produce un cobro incorrecto que nadie detecta hasta el corte.
 */
import { Prisma } from '@prisma/client'
import type { NormalizedDeliveryItem, NormalizedDeliveryPayment } from './types'

export class DeliveryMoneyMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeliveryMoneyMismatchError'
  }
}

const D = (v: string) => new Prisma.Decimal(v)
const q = (d: Prisma.Decimal) => d.toDecimalPlaces(2)

/**
 * 🔴 HALLAZGO 2 (auditoría externa, 2026-08-20): las verificaciones de abajo sólo prueban que
 * el reparto (externallyPaid* + cashDue*) cuadra CONSIGO MISMO — nunca contra los renglones
 * reales. Un pedido con `saleAmount` de $90 y renglones que suman $110 pasaba sin queja: el
 * ticket, los reportes y el pago dirían cosas distintas. Por eso esta función ahora exige
 * también `items` (antes sólo recibía `payment`) — actualiza a sus 2 llamadores si cambias la
 * firma otra vez: `core/deliveryOrderIngestion.service.ts` y sus tests.
 */
export function assertDeliveryMoneyInvariants(p: NormalizedDeliveryPayment, items: NormalizedDeliveryItem[]): void {
  if (p.currency !== 'MXN') {
    throw new DeliveryMoneyMismatchError(`Moneda no soportada: "${p.currency}". Sólo MXN.`)
  }

  const campos: Array<[string, string]> = [
    ['saleAmount', p.saleAmount],
    ['merchantFees', p.merchantFees],
    ['discountAmount', p.discountAmount ?? '0.00'],
    ['tipAmount', p.tipAmount],
    ['externallyPaidSale', p.externallyPaidSale],
    ['externallyPaidTip', p.externallyPaidTip],
    ['cashDueSale', p.cashDueSale],
    ['cashDueTip', p.cashDueTip],
  ]
  for (const [nombre, valor] of campos) {
    let d: Prisma.Decimal
    try {
      d = D(valor)
    } catch {
      throw new DeliveryMoneyMismatchError(`El monto "${nombre}" no es un decimal válido: ${JSON.stringify(valor)}`)
    }
    if (d.isNegative()) throw new DeliveryMoneyMismatchError(`El monto "${nombre}" es negativo: ${valor}`)
  }

  // El descuento RESTA de lo que se cobra: bruto + cargos − descuento = lo que entra, ya sea
  // liquidado por la plataforma o cobrado en efectivo. Sin este término, una promoción hacía
  // que la venta declarada y el dinero recibido dejaran de cuadrar — y como el mapper la
  // aplastaba a cero, el invariante no lo notaba.
  const descuento = q(D(p.discountAmount ?? '0.00'))
  const ventaTotal = q(D(p.saleAmount).plus(D(p.merchantFees)).minus(descuento))
  const ventaSplit = q(D(p.externallyPaidSale).plus(D(p.cashDueSale)))
  if (!ventaTotal.equals(ventaSplit)) {
    throw new DeliveryMoneyMismatchError(
      `La venta no cuadra: saleAmount + merchantFees − discountAmount = ${ventaTotal.toFixed(2)}, ` +
        `pero externallyPaidSale + cashDueSale = ${ventaSplit.toFixed(2)}.`,
    )
  }
  if (descuento.greaterThan(q(D(p.saleAmount).plus(D(p.merchantFees))))) {
    throw new DeliveryMoneyMismatchError(`El descuento (${descuento.toFixed(2)}) excede la venta: no se ingiere para no invertir el signo.`)
  }

  const propina = q(D(p.tipAmount))
  const propinaSplit = q(D(p.externallyPaidTip).plus(D(p.cashDueTip)))
  if (!propina.equals(propinaSplit)) {
    throw new DeliveryMoneyMismatchError(
      `La propina no cuadra: tipAmount = ${propina.toFixed(2)}, ` + `pero externallyPaidTip + cashDueTip = ${propinaSplit.toFixed(2)}.`,
    )
  }

  // 🔴 HALLAZGO 2: saleAmount ("artículos, IVA incluido") debe cuadrar EXACTO contra la suma
  // de los renglones — merchantFees son cargos aparte (bolsa, envío), no artículos. Tolerancia
  // CERO: cuadra al centavo o rechaza, nunca estima ni redondea a favor.
  let itemsTotal = new Prisma.Decimal(0)
  for (const item of items) {
    let d: Prisma.Decimal
    try {
      d = D(item.total)
    } catch {
      throw new DeliveryMoneyMismatchError(`El total del item "${item.name}" no es un decimal válido: ${JSON.stringify(item.total)}`)
    }
    if (d.isNegative()) throw new DeliveryMoneyMismatchError(`El total del item "${item.name}" es negativo: ${item.total}`)
    itemsTotal = itemsTotal.plus(d)
  }
  const itemsTotalQ = q(itemsTotal)
  const ventaDeclarada = q(D(p.saleAmount))
  if (!itemsTotalQ.equals(ventaDeclarada)) {
    throw new DeliveryMoneyMismatchError(
      `Los renglones no cuadran contra la venta: los items suman ${itemsTotalQ.toFixed(2)}, ` +
        `pero saleAmount = ${ventaDeclarada.toFixed(2)}.`,
    )
  }
}
