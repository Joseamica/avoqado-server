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

/**
 * Método con que se decide el ALCANCE FISCAL de un pago. Una devolución sigue a su VENTA (30-sep-2026): si el
 * cajero devolvió por otro medio, la fila trae el real en `method` y el de la venta en `processorData.originalMethod`.
 * El resto de la póliza (caja o banco) sigue usando el método real.
 */
export function metodoParaAlcanceFiscal(method: string | null | undefined, processorData: unknown): string | null | undefined {
  const original = (processorData as { originalMethod?: unknown } | null | undefined)?.originalMethod
  return typeof original === 'string' ? original : method
}

/** El medio de sistema «Saldo a favor» (spec 2026-10-30-saldo-a-favor §5.3): el DESTINO de una devolución abonada al sobre. */
export function esMedioDeSaldoAFavor(systemKind: string | null | undefined): boolean {
  return systemKind === 'STORE_CREDIT'
}

/**
 * Una devolución cuyo destino es el saldo a favor de la clienta: el dinero no salió del banco ni de la caja, quedó en su sobre. Resta
 * la venta como cualquier devolución, pero su alcance fiscal (método y comercio) es el del cobro original o de su raíz: el método va en
 * `processorData.originalMethod` (`metodoParaAlcanceFiscal`) y el comercio lo resuelve el cargador de libros por ese cobro (la fila no
 * lleva comercio: los lectores de banco y procesador creerían que el banco devolvió). Lo usan el autoposteo y los libros. Acepta la
 * marca como la trae cada lector: `tenderSystemKind` (libros) o `tenderType.systemKind` (autoposteo).
 */
export function esDevolucionASaldoAFavor(p: {
  type?: string | null
  tenderSystemKind?: string | null
  tenderType?: { systemKind?: string | null } | null
}): boolean {
  return p.type === 'REFUND' && esMedioDeSaldoAFavor(p.tenderSystemKind ?? p.tenderType?.systemKind)
}
