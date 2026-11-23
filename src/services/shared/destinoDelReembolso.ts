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
 * F10 (Codex servidor r4): lo pagado con SALDO (tarjeta de regalo o saldo a favor) sólo regresa a ese mismo saldo —así lo escribe el
 * escritor—, así que escoger cualquier medio es «no admitido» ANTES de pedir permiso (antes la cajera recibía el 403 de
 * `refund-to-cash` para acabar en el rechazo del escritor). Y el MCP sólo recibe efectivo o transferencia: otro medio no se admite ahí.
 *
 * H7 (Codex servidor r5): «¿lo admite esta entrada?» sale de las MISMAS funciones de ruteo que usan los escritores, con el cobro tal
 * cual (`cobro`): el MCP no devuelve una tarjeta de la terminal (`seDevuelveEnTerminal`, su escritor manda a la TPV), escoger un medio
 * donde el escritor no deja escoger no se admite (`devolverConEfectivo` + `sePuedeEscogerComoDevolver`), y en el MCP «Efectivo» sobre
 * dinero que YA entró a la gaveta es el mismo medio: el permiso especial sólo cuando sale de la gaveta dinero que nunca entró a ella.
 * La terminal no devuelve a un saldo (su escritor lo rechaza): esa fila de la matriz se corrigió para decirlo.
 *
 * La matriz completa (origen × crédito de Cambio × entrada × medio) está en `tests/__helpers__/matrizDelReembolso.ts`.
 */
import type { Prisma } from '@prisma/client'

import AppError, { BadRequestError } from '../../errors/AppError'
import { isExchangeCreditTenderKind } from '../exchanges/exchangePredicates'
import { isGiftCardTenderKind } from '../giftCards/giftCardPredicados'
import {
  devolverConEfectivo,
  sePuedeEscogerComoDevolver,
  seDevuelveEnTerminal,
  sinSaldoAFavorPorque,
  type CobroParaDevolver,
} from '../tpv/terminalRefundTarget'

/** El tender de sistema de un SALDO: la tarjeta de regalo o el saldo a favor (lo que el escritor sólo devuelve a ese saldo). */
export const esTenderDeSaldo = (systemKind: string | null | undefined): boolean =>
  isGiftCardTenderKind(systemKind) || systemKind === 'STORE_CREDIT'

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
export type DondeIr = 'POS' | 'PANEL' | 'TPV' | 'MISMO_MEDIO' | 'SALDO_A_FAVOR'
export interface DestinoDelReembolso {
  admitido: true
  destinoEfectivo: DestinoEfectivo
  permisoRequerido: PermisoDeReembolso
}
export interface ReembolsoNoAdmitido {
  admitido: false
  /** `STORE_CREDIT_NOT_ALLOWED` (422) sólo para saldo a favor sobre lo pagado con saldo: es lo que ya contestaba el escritor y lo que
   * las apps viejas (ANDROID/WINDOWS 2.25.32, iOS 1.15.12) reconocen para borrar el pendiente (revisión de apps viejas, 22-nov). */
  codigo: 'NO_ADMITIDO_EN_ESTA_ENTRADA' | 'STORE_CREDIT_NOT_ALLOWED'
  mensaje: string
  dondeIr: DondeIr[]
  estado?: 422
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
  /** Lo pagó un saldo (el tender de sistema de tarjeta de regalo o de saldo a favor): sólo regresa a ese saldo. */
  esSaldo?: boolean
  /** H7: el cobro tal cual (lo que leen los escritores). Con él, lo admitido sale de SUS funciones de ruteo; sin él, como antes. */
  cobro?: CobroParaDevolver | null
}): DecisionDelReembolso {
  // Revisión de apps viejas (22-nov): a saldo a favor se contesta con el código de siempre del escritor (422 STORE_CREDIT_NOT_ALLOWED),
  // con el mismo motivo; sólo cambia que ahora sale antes y trae `dondeIr`.
  if (p.esSaldo && p.medio === 'STORE_CREDIT')
    return {
      admitido: false,
      codigo: 'STORE_CREDIT_NOT_ALLOWED',
      estado: 422,
      mensaje: (p.cobro && sinSaldoAFavorPorque(p.cobro)) || MENSAJE_SALDO_AL_MISMO_SALDO,
      dondeIr: ['MISMO_MEDIO'],
    }
  if (p.esSaldo && p.medio != null) return noAdmitido(MENSAJE_SALDO_AL_MISMO_SALDO, ['MISMO_MEDIO'])
  // H7: la terminal nunca devuelve a un saldo (su escritor lo rechaza): se devuelve desde el POS o el panel.
  if (p.esSaldo && p.entrada === 'TPV') return noAdmitido(MENSAJE_SALDO_EN_TPV, ['POS', 'PANEL'])
  if (p.entrada === 'MCP' && p.medio != null && p.medio !== 'CASH' && p.medio !== 'BANK_TRANSFER')
    return noAdmitido(
      'Por el MCP sólo se devuelve por el mismo medio, en efectivo o por transferencia; el saldo a favor se da desde el POS.',
      ['POS'],
    )
  // H7: el MCP no devuelve un cobro con tarjeta de nuestra terminal: su escritor lo manda a la terminal, con la tarjeta presente.
  if (p.entrada === 'MCP' && p.cobro && seDevuelveEnTerminal(p.cobro)) return noAdmitido(MENSAJE_TARJETA_EN_TPV, ['TPV'])
  // El crédito no acredita un reembolso del SDK: sólo el POS o el panel resuelven el origen de la cadena.
  if (p.esCreditoDeCambio && p.entrada === 'TPV')
    return noAdmitido('Lo pagado con crédito de cambio se devuelve desde el POS o el panel, por el medio de su origen.', ['POS', 'PANEL'])
  // Sale por el medio de su cobro RAÍZ (o a saldo a favor), nunca por uno escogido (spec 2026-10-20 §6.7).
  if (p.esCreditoDeCambio && (p.medio === 'CASH' || p.medio === 'BANK_TRANSFER'))
    return noAdmitido('Este cobro sólo se devuelve por el mismo medio con que se pagó.', ['MISMO_MEDIO', 'SALDO_A_FAVOR'])
  // H7: escoger efectivo o transferencia donde el escritor no deja escoger (tarjeta, procesador, reparto): la MISMA regla que el escritor
  // aplica después (`writeRefundInTx`, el MCP), contestada antes de pedir el permiso especial.
  if (
    p.cobro &&
    (p.medio === 'CASH' || p.medio === 'BANK_TRANSFER') &&
    devolverConEfectivo(p.cobro, p.medio) !== undefined &&
    !sePuedeEscogerComoDevolver(p.cobro)
  )
    return noAdmitido('Este cobro sólo se devuelve por el mismo medio con que se pagó.', ['MISMO_MEDIO'])
  if (p.medio === 'STORE_CREDIT') return admitido('SALDO_A_FAVOR', 'payments:refund')
  if (p.medio === 'BANK_TRANSFER') return admitido('TRANSFERENCIA', 'payments:refund')
  if (p.origen !== 'ORDINARIO') return admitido('GAVETA', 'payments:refund-to-cash')
  // H7 (r6-7): en el MCP, «Efectivo» sobre dinero que YA entró a la gaveta es el mismo medio (así lo normaliza el escritor): basta
  // `payments:refund`. Las apps conservan su regla de 1-oct (escoger «Efectivo» pide su permiso).
  if (p.medio === 'CASH' && p.entrada === 'MCP' && p.cobro && devolverConEfectivo(p.cobro, 'CASH') === undefined)
    return admitido('MISMO_MEDIO', 'payments:refund')
  if (p.medio === 'CASH') return admitido('EFECTIVO_ESCOGIDO', 'payments:refund-to-cash')
  return admitido('MISMO_MEDIO', 'payments:refund')
}

const MENSAJE_SALDO_AL_MISMO_SALDO = 'Lo pagado con saldo (tarjeta de regalo o saldo a favor) sólo regresa a ese mismo saldo.'

export const MENSAJE_SALDO_EN_TPV =
  'Lo pagado con saldo (tarjeta de regalo o saldo a favor) no se devuelve en la terminal: devuélvelo desde el POS o el panel y regresa a ese mismo saldo.'
export const MENSAJE_TARJETA_EN_TPV =
  'Los cobros con tarjeta de la terminal se devuelven en la terminal, con la tarjeta presente: ábrela con «refund_card_on_terminal».'

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
export function errorDeNoAdmitido(d: ReembolsoNoAdmitido): AppError {
  if (d.estado === 422) return new AppError(d.mensaje, 422, true, d.codigo, { dondeIr: d.dondeIr })
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
): Promise<{ origen: OrigenDelDinero; esCreditoDeCambio: boolean; esSaldo?: true; cobro?: CobroParaDevolver }> {
  if (!venueId || typeof paymentId !== 'string' || !paymentId) return { origen: 'ORDINARIO', esCreditoDeCambio: false }
  const fila = await db.payment.findFirst({
    where: { id: paymentId, venueId },
    // H7: también lo que leen las funciones de ruteo de los escritores (el cobro de un id no cambia una vez escrito).
    select: {
      cashMachineRef: true,
      tenderType: { select: { systemKind: true } },
      method: true,
      source: true,
      externalSource: true,
      tenderSatFormaPago: true,
      fundsFlow: true,
      tenderTypeId: true,
      tenderCountsAsCash: true,
    },
  })
  if (!fila) return { origen: 'ORDINARIO', esCreditoDeCambio: false }
  const cobro: CobroParaDevolver = {
    method: fila.method,
    source: fila.source ?? null,
    externalSource: fila.externalSource ?? null,
    tenderSatFormaPago: fila.tenderSatFormaPago ?? null,
    fundsFlow: fila.fundsFlow ?? null,
    tenderTypeId: fila.tenderTypeId ?? null,
    tenderCountsAsCash: fila.tenderCountsAsCash ?? null,
    tenderSystemKind: fila.tenderType?.systemKind ?? null,
    cashMachineRef: fila.cashMachineRef ?? null,
  }
  const ordinario = { origen: 'ORDINARIO' as const, esCreditoDeCambio: false, cobro }
  if (fila.cashMachineRef) return { origen: 'MAQUINA', esCreditoDeCambio: false, cobro }
  if (esTenderDeSaldo(fila.tenderType?.systemKind)) return { ...ordinario, esSaldo: true }
  if (!isExchangeCreditTenderKind(fila.tenderType?.systemKind)) return ordinario
  const vinculo = await db.exchangeCreditLink.findFirst({
    where: { venueId, creditPaymentId: paymentId },
    select: { originPaymentId: true },
  })
  const raiz = vinculo
    ? await db.payment.findFirst({ where: { id: vinculo.originPaymentId, venueId }, select: { cashMachineRef: true } })
    : null
  return { origen: raiz?.cashMachineRef ? 'CADENA_DE_MAQUINA' : 'ORDINARIO', esCreditoDeCambio: true, cobro }
}
