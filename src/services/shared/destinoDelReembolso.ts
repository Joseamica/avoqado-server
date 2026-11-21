// src/services/shared/destinoDelReembolso.ts

/**
 * 🔴 Máquina de efectivo · Codex servidor r2, familia B: «¿a dónde sale el dinero de un reembolso y qué permiso pide?». Dos rondas
 * parcharon esta pregunta entrada por entrada (r1 #14, r2 #2, #3): la autorización miraba una cosa y el escritor hacía otra. Aquí vive
 * la ÚNICA respuesta. La usan la autorización (el middleware del POS, del panel y de la TPV; la herramienta MCP `issue_refund`; el
 * Cambio) y el escritor (`writeRefundInTx`, la TPV y la salida de gaveta del Cambio): el escritor nunca escoge un destino distinto del
 * que se autorizó, y si lo hiciera, el permiso concedido no alcanza y no se escribe nada (403).
 *
 * La regla (decisión c del founder): siempre que el escritor vaya a sacar billetes de la GAVETA por dinero que nunca entró a ella (una
 * venta de la QuickPay, directa o por la cadena de un Cambio), se pide `payments:refund-to-cash`. Lo demás queda como siempre: en las
 * apps, escoger «Efectivo» pide ese mismo permiso; el mismo medio, la transferencia y el saldo a favor piden `payments:refund`.
 *
 * D5 (Codex servidor r3 #12, r6 caso 7): lo que una entrada nunca va a escribir se dice AQUÍ, como `NO_ADMITIDO_EN_ESTA_ENTRADA` con a
 * dónde ir, y la autorización lo contesta ANTES de pedir el permiso especial (antes la TPV pedía el PIN del gerente para acabar en el
 * mismo 400 del escritor). Lo pagado con el crédito de un Cambio no se devuelve en la terminal, ni con «Efectivo» o transferencia
 * escogidos: sale por el medio de su origen o a saldo a favor.
 *
 * La matriz completa (origen × crédito de Cambio × entrada × medio) está en `tests/__helpers__/matrizDelReembolso.ts`.
 */
import type { Prisma } from '@prisma/client'

import { BadRequestError } from '../../errors/AppError'
import { isExchangeCreditTenderKind } from '../exchanges/exchangePredicates'

/**
 * De dónde viene el dinero que se devuelve:
 *  · `MAQUINA`: el cobro lo hizo la QuickPay (`cashMachineRef`);
 *  · `CADENA_DE_MAQUINA`: el cobro se pagó con el crédito de un Cambio cuya raíz es una venta de la QuickPay (r2 #2);
 *  · `ORDINARIO`: cualquier otro.
 */
export type OrigenDelDinero = 'MAQUINA' | 'CADENA_DE_MAQUINA' | 'ORDINARIO'
export type EntradaDelReembolso = 'POS' | 'PANEL' | 'TPV' | 'MCP'
export type DestinoEfectivo = 'GAVETA' | 'EFECTIVO_ESCOGIDO' | 'TRANSFERENCIA' | 'SALDO_A_FAVOR' | 'MISMO_MEDIO'
export type PermisoDeReembolso = 'payments:refund' | 'payments:refund-to-cash'
/** A dónde mandar a quien pidió lo que esta entrada no admite: otra entrada, o el medio que sí se puede escoger. */
export type DondeIr = 'POS' | 'PANEL' | 'MISMO_MEDIO' | 'SALDO_A_FAVOR'
export interface DestinoDelReembolso {
  admitido: true
  destinoEfectivo: DestinoEfectivo
  permisoRequerido: PermisoDeReembolso
}
export interface ReembolsoNoAdmitido {
  admitido: false
  codigo: 'NO_ADMITIDO_EN_ESTA_ENTRADA'
  mensaje: string
  dondeIr: DondeIr[]
}
export type DecisionDelReembolso = DestinoDelReembolso | ReembolsoNoAdmitido

/**
 * Lo que de verdad le llega al escritor desde cada entrada (r2 #3): el panel y la TPV NO escogen medio —su controlador descarta el
 * `refundMethod` del cuerpo y el escritor devuelve por el mismo medio—, así que autorizarlos con lo que diga el cuerpo autorizaba un
 * destino y registraba otro. El POS y el MCP sí lo pasan.
 */
export function medioQueLlegaAlEscritor(entrada: EntradaDelReembolso, declarado: unknown): unknown {
  return entrada === 'PANEL' || entrada === 'TPV' ? undefined : declarado
}

/**
 * LA decisión. `medio` es lo que recibe el escritor: `undefined` (por el mismo medio), `'CASH'`, `'BANK_TRANSFER'` o `'STORE_CREDIT'`.
 * `esCreditoDeCambio`: el cobro se pagó con el crédito de un Cambio (su tender de sistema). Con un origen de la máquina, todo lo que no
 * sea transferencia ni saldo a favor sale de la gaveta (también un valor desconocido: se pide el permiso más alto, nunca el más bajo).
 */
export function decidirDestinoDelReembolso(p: {
  entrada: EntradaDelReembolso
  origen: OrigenDelDinero
  medio: unknown
  esCreditoDeCambio: boolean
}): DecisionDelReembolso {
  // El crédito no acredita un reembolso del SDK: sólo el POS o el panel resuelven el origen de la cadena.
  if (p.esCreditoDeCambio && p.entrada === 'TPV')
    return noAdmitido('Lo pagado con crédito de cambio se devuelve desde el POS o el panel, por el medio de su origen.', ['POS', 'PANEL'])
  // Sale por el medio de su cobro RAÍZ (o a saldo a favor), nunca por uno escogido (spec 2026-10-20 §6.7).
  if (p.esCreditoDeCambio && (p.medio === 'CASH' || p.medio === 'BANK_TRANSFER'))
    return noAdmitido('Este cobro sólo se devuelve por el mismo medio con que se pagó.', ['MISMO_MEDIO', 'SALDO_A_FAVOR'])
  if (p.medio === 'STORE_CREDIT') return admitido('SALDO_A_FAVOR', 'payments:refund')
  if (p.medio === 'BANK_TRANSFER') return admitido('TRANSFERENCIA', 'payments:refund')
  if (p.origen !== 'ORDINARIO') return admitido('GAVETA', 'payments:refund-to-cash')
  if (p.medio === 'CASH') return admitido('EFECTIVO_ESCOGIDO', 'payments:refund-to-cash')
  return admitido('MISMO_MEDIO', 'payments:refund')
}

const admitido = (destinoEfectivo: DestinoEfectivo, permisoRequerido: PermisoDeReembolso): DestinoDelReembolso => ({
  admitido: true,
  destinoEfectivo,
  permisoRequerido,
})
const noAdmitido = (mensaje: string, dondeIr: DondeIr[]): ReembolsoNoAdmitido => ({
  admitido: false,
  codigo: 'NO_ADMITIDO_EN_ESTA_ENTRADA',
  mensaje,
  dondeIr,
})

/** El rechazo de lo no admitido, igual en la autorización y en cada escritor: 400 con `details.dondeIr`. */
export function errorDeNoAdmitido(d: ReembolsoNoAdmitido): BadRequestError {
  return new BadRequestError(d.mensaje, d.codigo, { dondeIr: d.dondeIr })
}

/**
 * El origen del dinero de un cobro y si lo pagó un crédito de Cambio, leídos de la base ANTES de autorizar (el escritor los vuelve a
 * obtener bajo sus candados con las mismas filas: el folio, el tender y el vínculo de un crédito de cambio no cambian una vez escritos).
 * Un id ausente es `ORDINARIO`: no hay cobro que devolver y el servicio contesta 404.
 */
export async function origenDelDinero(
  db: Pick<Prisma.TransactionClient, 'payment' | 'exchangeCreditLink'>,
  venueId: string | undefined,
  paymentId: unknown,
): Promise<{ origen: OrigenDelDinero; esCreditoDeCambio: boolean }> {
  const ordinario = { origen: 'ORDINARIO' as const, esCreditoDeCambio: false }
  if (!venueId || typeof paymentId !== 'string' || !paymentId) return ordinario
  const cobro = await db.payment.findFirst({
    where: { id: paymentId, venueId },
    select: { cashMachineRef: true, tenderType: { select: { systemKind: true } } },
  })
  if (!cobro) return ordinario
  if (cobro.cashMachineRef) return { origen: 'MAQUINA', esCreditoDeCambio: false }
  if (!isExchangeCreditTenderKind(cobro.tenderType?.systemKind)) return ordinario
  const vinculo = await db.exchangeCreditLink.findFirst({
    where: { venueId, creditPaymentId: paymentId },
    select: { originPaymentId: true },
  })
  const raiz = vinculo
    ? await db.payment.findFirst({ where: { id: vinculo.originPaymentId, venueId }, select: { cashMachineRef: true } })
    : null
  return { origen: raiz?.cashMachineRef ? 'CADENA_DE_MAQUINA' : 'ORDINARIO', esCreditoDeCambio: true }
}
