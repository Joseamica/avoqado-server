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
 * La matriz completa (origen × entrada × medio) está en `tests/unit/services/shared/destinoDelReembolso.refund.test.ts`.
 */
import type { Prisma } from '@prisma/client'

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
export interface DestinoDelReembolso {
  destinoEfectivo: DestinoEfectivo
  permisoRequerido: PermisoDeReembolso
}

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
 * Con un origen de la máquina, todo lo que no sea transferencia ni saldo a favor sale de la gaveta (también un valor desconocido: se
 * pide el permiso más alto, nunca el más bajo).
 */
export function decidirDestinoDelReembolso(p: { origen: OrigenDelDinero; medio: unknown }): DestinoDelReembolso {
  if (p.medio === 'STORE_CREDIT') return { destinoEfectivo: 'SALDO_A_FAVOR', permisoRequerido: 'payments:refund' }
  if (p.medio === 'BANK_TRANSFER') return { destinoEfectivo: 'TRANSFERENCIA', permisoRequerido: 'payments:refund' }
  if (p.origen !== 'ORDINARIO') return { destinoEfectivo: 'GAVETA', permisoRequerido: 'payments:refund-to-cash' }
  if (p.medio === 'CASH') return { destinoEfectivo: 'EFECTIVO_ESCOGIDO', permisoRequerido: 'payments:refund-to-cash' }
  return { destinoEfectivo: 'MISMO_MEDIO', permisoRequerido: 'payments:refund' }
}

/**
 * El origen del dinero de un cobro, leído de la base ANTES de autorizar (el escritor lo vuelve a obtener bajo sus candados con las mismas
 * filas: el folio de un cobro y el vínculo de un crédito de cambio no cambian una vez escritos). Un id ausente es `ORDINARIO`: no hay
 * cobro que devolver y el servicio contesta 404.
 */
export async function origenDelDinero(
  db: Pick<Prisma.TransactionClient, 'payment' | 'exchangeCreditLink'>,
  venueId: string | undefined,
  paymentId: unknown,
): Promise<OrigenDelDinero> {
  if (!venueId || typeof paymentId !== 'string' || !paymentId) return 'ORDINARIO'
  const cobro = await db.payment.findFirst({
    where: { id: paymentId, venueId },
    select: { cashMachineRef: true, tenderType: { select: { systemKind: true } } },
  })
  if (!cobro) return 'ORDINARIO'
  if (cobro.cashMachineRef) return 'MAQUINA'
  if (!isExchangeCreditTenderKind(cobro.tenderType?.systemKind)) return 'ORDINARIO'
  const vinculo = await db.exchangeCreditLink.findFirst({
    where: { venueId, creditPaymentId: paymentId },
    select: { originPaymentId: true },
  })
  const raiz = vinculo
    ? await db.payment.findFirst({ where: { id: vinculo.originPaymentId, venueId }, select: { cashMachineRef: true } })
    : null
  return raiz?.cashMachineRef ? 'CADENA_DE_MAQUINA' : 'ORDINARIO'
}
