import { PaymentFundsFlow, type Prisma, type ExchangeCreditLink } from '@prisma/client'
import type { RefundMoneySemantics } from '../dashboard/refund.dashboard.service'
import { paymentCountsAsDrawerCash, paymentIsAvoqadoSettled } from '../shared/tenderSemantics'
import { seDevuelveEnTerminal } from '../tpv/terminalRefundTarget'
import { isGiftCardTenderKind } from '../giftCards/giftCardPredicados'
import { isExchangeCreditTenderKind } from './exchangePredicates'
import { ExchangeError } from './exchangeErrors'

export type ChainRefundRoot = Prisma.PaymentGetPayload<{ include: { tenderType: { select: { systemKind: true } } } }>
export type ChainRefundResolution =
  | { kind: 'INHERIT'; rootPaymentId: string; exchangeId: string; money: RefundMoneySemantics }
  | { kind: 'BLOCKED'; error: ExchangeError }

/** Regla única sin lecturas: admite tanto la carga individual como los vínculos y raíces leídos en lote. */
export function resolveChainRefund(
  link: Pick<ExchangeCreditLink, 'exchangeId'> | null | undefined,
  root: ChainRefundRoot | null | undefined,
): ChainRefundResolution {
  if (!link || !root || isExchangeCreditTenderKind(root.tenderType?.systemKind))
    throw new ExchangeError('EXCHANGE_SETTLEMENT_UNAVAILABLE', 'No se pudo comprobar el origen de este crédito de cambio.', 422)
  if (isGiftCardTenderKind(root.tenderType?.systemKind))
    return {
      kind: 'BLOCKED',
      error: new ExchangeError(
        'EXCHANGE_CHAIN_GIFT_CARD_PENDING',
        'Esto se pagó con un crédito que salió de una tarjeta de regalo; regresarlo al saldo todavía no está disponible.',
        422,
      ),
    }
  const processorRoot = !!root.merchantAccountId || !!root.ecommerceMerchantId || paymentIsAvoqadoSettled(root)
  if (seDevuelveEnTerminal(root) || processorRoot)
    return {
      kind: 'BLOCKED',
      error: new ExchangeError(
        'EXCHANGE_CHAIN_NEEDS_TERMINAL',
        'Esto se pagó con un crédito que salió de una tarjeta: se devuelve a esa tarjeta en la terminal, y eso todavía no está disponible.',
        422,
        processorRoot ? { reason: 'PROCESSOR_ROOT' } : undefined,
      ),
    }
  return {
    kind: 'INHERIT',
    rootPaymentId: root.id,
    exchangeId: link.exchangeId,
    money: {
      method: root.method,
      fundsFlow: root.fundsFlow ?? (paymentCountsAsDrawerCash(root) ? PaymentFundsFlow.CASH_DRAWER : PaymentFundsFlow.EXTERNAL_RECORDED),
      merchantAccountId: null,
      source: root.source,
      tenderTypeId: root.tenderTypeId,
      tenderRevision: root.tenderRevision,
      tenderLabel: root.tenderLabel,
      tenderCountsAsCash: root.tenderCountsAsCash,
      tenderCaptureTip: root.tenderCaptureTip,
      tenderSatFormaPago: root.tenderSatFormaPago,
    },
  }
}
