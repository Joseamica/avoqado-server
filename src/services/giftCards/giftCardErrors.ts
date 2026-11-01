// src/services/giftCards/giftCardErrors.ts
/**
 * Errores de negocio de tarjetas de regalo (spec 2026-10-14). Extiende AppError; el manejador global los responde con
 * la rama que agrega C3 (índice, «Adiciones» § 1): `{ ...details, message, code, details? }`. El texto va en español y se puede
 * mostrar tal cual en el POS; `code` es estable (el reducer sin red lo usa para poner en cuarentena, nunca reintentar).
 */
import AppError from '@/errors/AppError'

export type GiftCardErrorCode =
  | 'GIFT_CARDS_DISABLED'
  | 'GIFT_CARDS_NOT_IN_PLAN'
  | 'GIFT_CARD_NOT_FOUND'
  | 'GIFT_CARD_INSUFFICIENT_BALANCE'
  | 'GIFT_CARD_BLOCKED'
  | 'GIFT_CARD_EXPIRED'
  | 'GIFT_CARD_ORDER_IMMUTABLE'
  | 'GIFT_CARD_AMOUNT_OUT_OF_RANGE'
  | 'GIFT_CARD_OPERATION_LIMIT'
  | 'GIFT_CARD_TENDER_NOT_ALLOWED'
  | 'GIFT_CARD_REFUND_TO_BALANCE_ONLY'
  | 'GIFT_CARD_ALREADY_USED'
  | 'GIFT_CARD_CANCEL_NOT_STARTED'
  | 'GIFT_CARD_CANCEL_WINDOW_CLOSED'
  | 'GIFT_CARD_KEYS_MISSING'
  | 'IDEMPOTENCY_KEY_REUSED'
  // Conciliación 14-oct: códigos que usan B2 (cancelar la venta) y C3 (reponer el código con el folio de compra, spec § 5.7).
  | 'GIFT_CARD_SALE_NOT_PAID'
  | 'GIFT_CARD_SALE_ALREADY_CANCELLED'
  | 'GIFT_CARD_FOLIO_MISMATCH'
  // Lote ⭐ r1 (M2): repetir un bloqueo o un desbloqueo del panel con su llave cuando la tarjeta ya cambió después (aditivo).
  | 'GIFT_CARD_STATE_CHANGED'
  // Cierre (A1): con la cancelación de la venta en curso, el panel sólo devuelve el cobro COMPLETO (aditivo).
  | 'GIFT_CARD_SALE_REFUND_MUST_BE_FULL'
  // Pendientes 1a (T3): la devolución SIN venta se rechaza en un negocio que ya cobró tarjetas (aditivo).
  | 'GIFT_CARD_UNLINKED_REFUND_BLOCKED'
  // 1b S2b (Q60): en la venta nueva cobrada con saldo, un premio de sellos que ya no aplica rechaza TODO (nada se crea).
  | 'GIFT_CARD_STAMP_REWARD_NOT_APPLIED'
  // 1b S2b (revisión): `pay-new-order` rechaza con 400 la mesa, `externalId` e `isOfflineReplay: true` (no los ignora).
  | 'GIFT_CARD_NEW_ORDER_FIELD_NOT_ALLOWED'
  // 1b S4/S5 (índice, «Códigos nuevos»). `GIFT_CARD_RESEND_NOT_ALLOWED` no existe (Q16: lo de gerente va en su ruta).
  | 'GIFT_CARD_REVEAL_NOT_ALLOWED'
  | 'GIFT_CARD_NOT_DELIVERABLE'
  | 'GIFT_CARD_PHONE_RATE_LIMITED'
  | 'GIFT_CARD_PHONE_CODE_INVALID'
  | 'GIFT_CARD_PHONE_PROOF_INVALID'
  // Cierre A (C4): el 429 del límite de reenvíos por tarjeta (`resend` y `change-destination`, POS y panel). Lo responde el
  // limitador de ruta (`gift-card-lookup-rate-limit.middleware.ts`), no un `GiftCardError`.
  | 'GIFT_CARD_RESEND_RATE_LIMITED'

export class GiftCardError extends AppError {
  constructor(code: GiftCardErrorCode, mensaje: string, status: 400 | 403 | 404 | 409 | 422 | 429, extra?: Record<string, unknown>) {
    super(mensaje, status, true, code, extra)
    this.name = 'GiftCardError'
  }
}
