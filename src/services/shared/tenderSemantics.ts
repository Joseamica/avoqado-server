// src/services/shared/tenderSemantics.ts

/**
 * THE single source of truth for two money questions every closeout/settlement
 * path keeps re-answering inconsistently (audit v3/v4 findings — "three expected
 * cash definitions", "externalSource is not financial authority"):
 *
 *   1. Does this payment's money physically sit in the venue's CASH DRAWER?
 *   2. Is this money settled/deposited BY AVOQADO (available balance material)?
 *
 * Every consumer (cash closeout, shift expected cash, drawer derivation,
 * availableBalance readers, VenueTransaction writers) must answer through these
 * predicates — never with a local `method === 'CASH'` / `method !== 'CASH'`.
 *
 * Precedence inside each predicate:
 *   fundsFlow (server-stamped at the entry point — the authority for NEW rows)
 *   → tender snapshot (tenderCountsAsCash, frozen at charge time)
 *   → legacy inference that reproduces the historical behavior EXACTLY, so rows
 *     created before fundsFlow existed never change their classification.
 */

import { PaymentFundsFlow, PaymentMethod } from '@prisma/client'

/** The minimal projection a caller must select to answer both questions. */
export interface TenderSemanticsPayment {
  method: PaymentMethod | string
  fundsFlow?: PaymentFundsFlow | string | null
  tenderTypeId?: string | null
  tenderCountsAsCash?: boolean | null
}

/** Prisma `select` fragment so callers can't forget a field the predicates need. */
export const TENDER_SEMANTICS_SELECT = {
  method: true,
  fundsFlow: true,
  tenderTypeId: true,
  tenderCountsAsCash: true,
} as const

/**
 * ¿El dinero de este pago está físicamente en el cajón?
 * Cash → yes. A custom tender with countsAsPhysicalCash (vale de despensa) → yes.
 * Uber Eats / cards / transfers → no.
 */
export function paymentCountsAsDrawerCash(payment: TenderSemanticsPayment): boolean {
  if (payment.fundsFlow != null) return payment.fundsFlow === PaymentFundsFlow.CASH_DRAWER
  if (payment.tenderCountsAsCash != null) return payment.tenderCountsAsCash
  return payment.method === PaymentMethod.CASH
}

/**
 * ¿Este dinero lo liquida/deposita AVOQADO? (available balance + VenueTransaction
 * material). Custom tenders and externally-recorded payments are NEVER ours to
 * deposit, no matter what `method` says.
 *
 * ⚠️ Legacy fallback (`method !== CASH`) reproduces the historical availableBalance
 * inclusion EXACTLY — including its known falsehood (manual BANK_TRANSFER counted
 * as depositable). That falsehood is fixed FORWARD by stamping `fundsFlow` at every
 * entry point; reinterpreting pre-fundsFlow rows is a separate, founder-gated fix.
 */
export function paymentIsAvoqadoSettled(payment: TenderSemanticsPayment): boolean {
  if (payment.fundsFlow != null) return payment.fundsFlow === PaymentFundsFlow.AVOQADO_PROCESSED
  // A custom tender always records method=OTHER + tenderTypeId (server-resolved):
  // external by definition even before fundsFlow stamping reached its writer.
  if (payment.tenderTypeId != null && payment.method === PaymentMethod.OTHER) return false
  return payment.method !== PaymentMethod.CASH
}
