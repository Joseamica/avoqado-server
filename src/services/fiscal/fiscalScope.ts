// src/services/fiscal/fiscalScope.ts
//
// Single source of truth for "does this payment count in the FISCAL books?" — the pólizas
// (auto-posting), IVA en flujo, ISR and reportes contables all use this predicate so a venue's
// configured accounting scope is honored identically everywhere.
//
// Two configurable axes (both defaulted so the operator owns the fiscal decision, and the gerencial
// "¿cuánto gané?" view ALWAYS shows the full total regardless — nothing is hidden):
//   · Per-merchant  — `MerchantFiscalConfig.includeInAccounting` (default true, opt-out): exclude a
//     whole merchant account from the books (multi-merchant venues that don't want it in contabilidad).
//   · Per-method    — `FiscalEmisor.includeCashInAccounting` (default false, opt-in): whether CASH-paid
//     sales reach the fiscal numbers at all (cash has no merchant, so it's governed here, not per-merchant).

/**
 * Whether a payment is inside the venue's fiscal accounting scope.
 *
 * @param method                       Payment.method ('CASH', 'CREDIT_CARD', …)
 * @param merchantIncludeInAccounting  the settling merchant's `includeInAccounting` flag, or null when
 *                                     the payment carries no merchant (e.g. cash) or the merchant has no
 *                                     fiscal config — null/undefined is treated as "in" (default true).
 * @param includeCashInAccounting      the emisor's opt-in for cash counting in the fiscal books.
 */
export function paymentInFiscalScope(
  method: string | null | undefined,
  merchantIncludeInAccounting: boolean | null | undefined,
  includeCashInAccounting: boolean,
): boolean {
  // Cash has no merchant → governed purely by the emisor's cash opt-in.
  if (method === 'CASH') return includeCashInAccounting
  // Card / electronic → excluded only if its merchant was explicitly turned off.
  if (merchantIncludeInAccounting === false) return false
  return true
}
