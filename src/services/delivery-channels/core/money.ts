/**
 * Invariantes de dinero de un pedido de delivery. Módulo PURO: sin Prisma, sin env.
 *
 * 🔴 Si el reparto no cuadra al centavo, RECHAZA. Nunca estima ni redondea a favor:
 * un pedido mal repartido produce un cobro incorrecto que nadie detecta hasta el corte.
 */
import { Prisma } from '@prisma/client'
import type { NormalizedDeliveryPayment } from './types'

export class DeliveryMoneyMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeliveryMoneyMismatchError'
  }
}

const D = (v: string) => new Prisma.Decimal(v)
const q = (d: Prisma.Decimal) => d.toDecimalPlaces(2)

export function assertDeliveryMoneyInvariants(p: NormalizedDeliveryPayment): void {
  if (p.currency !== 'MXN') {
    throw new DeliveryMoneyMismatchError(`Moneda no soportada: "${p.currency}". Sólo MXN.`)
  }

  const campos: Array<[string, string]> = [
    ['saleAmount', p.saleAmount],
    ['merchantFees', p.merchantFees],
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

  const ventaTotal = q(D(p.saleAmount).plus(D(p.merchantFees)))
  const ventaSplit = q(D(p.externallyPaidSale).plus(D(p.cashDueSale)))
  if (!ventaTotal.equals(ventaSplit)) {
    throw new DeliveryMoneyMismatchError(
      `La venta no cuadra: saleAmount + merchantFees = ${ventaTotal.toFixed(2)}, ` +
        `pero externallyPaidSale + cashDueSale = ${ventaSplit.toFixed(2)}.`,
    )
  }

  const propina = q(D(p.tipAmount))
  const propinaSplit = q(D(p.externallyPaidTip).plus(D(p.cashDueTip)))
  if (!propina.equals(propinaSplit)) {
    throw new DeliveryMoneyMismatchError(
      `La propina no cuadra: tipAmount = ${propina.toFixed(2)}, ` + `pero externallyPaidTip + cashDueTip = ${propinaSplit.toFixed(2)}.`,
    )
  }
}
