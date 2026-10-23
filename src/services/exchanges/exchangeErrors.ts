import AppError from '@/errors/AppError'

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

export class ExchangeError extends AppError {
  constructor(code: ExchangeErrorCode, message: string, status: 400 | 409 | 422, details?: Record<string, unknown>) {
    super(message, status, true, code, details)
  }
}
