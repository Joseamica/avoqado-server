import AppError from '@/errors/AppError'
import type { LineBlockReason } from './exchangePredicates'

export type ExchangeErrorCode =
  | 'EXCHANGE_DIFFERENCE_CHANGED'
  | 'EXCHANGE_ITEM_NOT_RETURNABLE'
  | 'EXCHANGE_SETTLEMENT_UNAVAILABLE'
  | 'EXCHANGE_TAKEN_NOT_SELLABLE'
  | 'EXCHANGES_DISABLED'
  | 'EXCHANGE_CHAIN_NEEDS_TERMINAL'
  | 'EXCHANGE_CHAIN_GIFT_CARD_PENDING'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'ACTOR_MISMATCH'
  | 'EXCHANGE_CHARGE_UNRESOLVED'
  | 'EXCHANGE_NOT_CHARGED'
  | 'EXCHANGE_CHARGE_EXISTS'
  | 'EXCHANGE_ALREADY_SETTLED'
  | 'EXCHANGE_RETRY_CONFLICT'
  | 'EXCHANGE_NOT_FOR_ONLINE_CARD'

export class ExchangeError extends AppError {
  constructor(code: ExchangeErrorCode, message: string, status: 400 | 409 | 422, details?: Record<string, unknown>) {
    super(message, status, true, code, details)
  }
}

/** El motivo del servidor también explica a la cajera qué puede hacer. */
export function itemNotReturnable(reason: LineBlockReason, orderItemId: string | null = null, remaining = 0): never {
  const messages: Record<LineBlockReason, string> = {
    ALREADY_RETURNED:
      remaining > 0 ? `De este artículo sólo quedan ${remaining} por devolver.` : 'Ya se devolvió todo lo de este artículo.',
    PROMOTION_PARTIAL: 'Una promoción se cambia completa: incluye todos sus artículos.',
    NOT_MERCHANDISE: 'Las citas, clases, eventos y productos digitales no se cambian.',
    GIFT_CARD_SALE: 'Las tarjetas de regalo no se cambian; se cancelan desde su propia opción.',
    DELIVERY_PLATFORM: 'Los pedidos de plataformas se cambian en la plataforma.',
    NOT_ATTRIBUTABLE: 'No se puede saber cuánto se cobró por este artículo; haz una devolución por importe.',
    SOLD_BY_WEIGHT: 'Los productos por peso no se cambian.',
    NOT_PAID: 'Esta venta no está cobrada.',
    NOTHING_LEFT_TO_REFUND: 'De esta venta ya no queda dinero por devolver para estos artículos.',
    SERIALIZED_ITEM: 'Los artículos con número de serie no se cambian.',
    ONLINE_CARD:
      'Este pedido se pagó con tarjeta en línea y no admite Cambio. Para regresarle su dinero a la clienta, usa la devolución del pedido.',
  }
  // D661: el dinero de un pedido «Nadie» pagado con tarjeta en línea sólo regresa por la devolución del pedido; no es un renglón: 409.
  if (reason === 'ONLINE_CARD') throw new ExchangeError('EXCHANGE_NOT_FOR_ONLINE_CARD', messages[reason], 409, { orderItemId, reason })
  throw new ExchangeError('EXCHANGE_ITEM_NOT_RETURNABLE', messages[reason], 422, { orderItemId, reason })
}
