// src/services/shared/efectivoFisico.ts

/**
 * 🔴 VENTAS EN EFECTIVO no es lo mismo que EFECTIVO EN EL CAJÓN (máquina de efectivo, fase 1a, A5; Codex R1 #10).
 *
 * La máquina QuickPay Mini registra sus ventas como `method CASH` + `fundsFlow EXTERNAL_RECORDED`: son ventas en efectivo
 * (reportes, MCP, `Shift.totalCashPayments`), pero el billete se quedó en la máquina. Las fórmulas del turno que sumaban «todo lo
 * CASH» como cajón le firmaban al cajero un faltante del tamaño de lo que cobró la máquina.
 *
 * Este ayudante es el ÚNICO lugar donde las fórmulas del turno (cierre nuevo, cierre viejo y edición del corte) separan las dos
 * cifras. Qué está en el cajón lo contesta `paymentCountsAsDrawerCash` (`tenderSemantics`), nunca un `method === 'CASH'` local:
 * aquí `method` sólo decide qué es VENTA en efectivo, como siempre.
 *
 * Sólo mira cobros con método CASH. El tender que no es CASH pero cuenta como efectivo (vale de despensa) lo sigue llevando
 * `totalDrawerExtra` de `aggregateShiftPayments`. Con cobros sin `fundsFlow` (todo lo anterior a él), `alCajon` = ventas + propinas
 * en efectivo: la fórmula de siempre, centavo a centavo.
 */

import { PaymentMethod } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { paymentCountsAsDrawerCash, type TenderSemanticsPayment } from './tenderSemantics'

type Dinero = Decimal | number | string | null | undefined

/** Lo mínimo de un cobro (o de un grupo de cobros ya sumado) para separar ventas de cajón. */
export interface CobroConEfectivo extends TenderSemanticsPayment {
  amount: Dinero
  tipAmount: Dinero
}

export interface EfectivoFisico {
  /** VENTAS en efectivo (método CASH), también las de la máquina. Es `Shift.totalCashPayments`. */
  ventasEnEfectivo: Decimal
  /** Propina cobrada con método CASH, esté o no en el cajón. Es `Shift.totalCashTips`. */
  propinasEnEfectivo: Decimal
  /** Lo que está físicamente en el cajón: venta + propina de los cobros CASH que pasan `paymentCountsAsDrawerCash`. */
  alCajon: Decimal
  /** Sólo la venta (sin propina) de lo que está en el cajón: el respaldo y la discrepancia del cierre viejo nunca sumaron propina. */
  ventasAlCajon: Decimal
}

export function efectivoFisicoDeCobros(pagos: ReadonlyArray<CobroConEfectivo>): EfectivoFisico {
  let ventasEnEfectivo = new Decimal(0)
  let propinasEnEfectivo = new Decimal(0)
  let alCajon = new Decimal(0)
  let ventasAlCajon = new Decimal(0)

  for (const pago of pagos) {
    if (pago.method !== PaymentMethod.CASH) continue
    const venta = new Decimal(pago.amount || 0)
    const propina = new Decimal(pago.tipAmount || 0)
    ventasEnEfectivo = ventasEnEfectivo.add(venta)
    propinasEnEfectivo = propinasEnEfectivo.add(propina)
    if (paymentCountsAsDrawerCash(pago)) {
      alCajon = alCajon.add(venta).add(propina)
      ventasAlCajon = ventasAlCajon.add(venta)
    }
  }

  return { ventasEnEfectivo, propinasEnEfectivo, alCajon, ventasAlCajon }
}
