// src/services/online-ordering/card/estadoPublico.ts
/**
 * D661: lo que la CLIENTA ve de su tarjeta y de su devolución, en UNA sola definición para el seguimiento público (`order.service.ts`) y
 * para «Mi cuenta» (`customerPortal.public.service.ts`, Ruling 55). Módulo puro: sin base ni efectos (así «Mi cuenta» no carga el
 * servicio de pedidos para leerlo).
 */
import { OnlineOrderCardRefundStatus, OnlineOrderChargeStatus, PaymentMethod, type Prisma } from '@prisma/client'

/**
 * Fase 2: lo que el comensal ve de su tarjeta. `CONFIRMING` = cobrando al aceptar. S4 (Codex plan r1 #3): `RELEASING` = la liberación
 * aún no termina (puede fallar o resultar cobrada a mano): nunca se dice «liberada» antes de tiempo.
 */
export type PublicCardStatus = 'AUTHORIZED' | 'CONFIRMING' | 'CAPTURED' | 'RELEASING' | 'RELEASED'
export const PUBLIC_CARD_STATUS: Partial<Record<OnlineOrderChargeStatus, PublicCardStatus>> = {
  AUTHORIZED: 'AUTHORIZED',
  CAPTURING: 'CONFIRMING',
  CAPTURED: 'CAPTURED',
  RELEASING: 'RELEASING',
  RELEASED: 'RELEASED',
}

/**
 * D661 (Task 4): lo que la clienta ve de su devolución. `PENDING` = en camino; `DONE` = hecha; `REVERSED` = el banco la regresó y
 * el negocio todavía se la debe. `medio`: por dónde le llegó (o le llegará) el dinero.
 */
export type DevolucionPublica = {
  status: 'PENDING' | 'DONE' | 'REVERSED'
  medio: 'TARJETA' | 'SALDO' | 'EFECTIVO' | 'TRANSFERENCIA'
}
const DEVOLUCION_PUBLICA: Partial<Record<OnlineOrderCardRefundStatus, DevolucionPublica['status']>> = {
  REQUESTED: 'PENDING',
  SENDING: 'PENDING',
  PENDING: 'PENDING',
  SUCCEEDED: 'DONE', // Stripe ya la devolvió; sólo falta su renglón del libro
  RECORDED: 'DONE',
  RESOLVED: 'DONE',
  REVERSED: 'REVERSED',
}
type FilaDeDevolucion = { status: OnlineOrderCardRefundStatus; reversal?: { resolvedMethod: PaymentMethod | null } | null }
/**
 * El medio que la fila REGISTRÓ, nunca deducido de `toStoreCredit`: un `RESOLVED` con reversa dice cómo la pagó el negocio (efectivo
 * o transferencia); uno sin reversa nació a saldo a favor (el único `RESOLVED` que no pasa por la reversa, Task 6). Las demás son a la
 * tarjeta (una de saldo nace `RESOLVED`).
 */
const medioDe = (f: FilaDeDevolucion): DevolucionPublica['medio'] =>
  f.status !== OnlineOrderCardRefundStatus.RESOLVED
    ? 'TARJETA'
    : f.reversal?.resolvedMethod === PaymentMethod.CASH
      ? 'EFECTIVO'
      : f.reversal?.resolvedMethod === PaymentMethod.BANK_TRANSFER
        ? 'TRANSFERENCIA'
        : 'SALDO'
/** Con varias filas (de la más reciente a la más vieja): una en camino gana; si no, una revertida (se debe); si no, una hecha. */
export function devolucionPublica(filas: FilaDeDevolucion[]): DevolucionPublica | undefined {
  for (const status of ['PENDING', 'REVERSED', 'DONE'] as const) {
    const f = filas.find(x => DEVOLUCION_PUBLICA[x.status] === status)
    if (f) return { status, medio: medioDe(f) }
  }
  return undefined
}

/** D661 (Task 4): las devoluciones que movieron (o mueven) dinero, de la más reciente a la más vieja; una real trae una o dos. */
export const DEVOLUCIONES_PUBLICAS = {
  where: { status: { notIn: [OnlineOrderCardRefundStatus.FAILED, OnlineOrderCardRefundStatus.CANCELED] } },
  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  take: 10,
  select: { status: true, reversal: { select: { resolvedMethod: true } } },
} satisfies Prisma.OnlineOrderCharge$cardRefundsArgs
