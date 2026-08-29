/**
 * Which AngelPay login does THIS terminal get?
 *
 * A venue can hold several AngelPay user accounts, and every AngelPay merchant
 * hangs off exactly one of them. The NEXGO SDK can only charge the merchants of
 * the account it authenticated with, so the credential we hand a terminal has to
 * be the one that owns the merchant that terminal is assigned — not just the
 * venue's oldest account.
 *
 * Handing over the wrong one is silent and expensive. Measured in prod on
 * 2026-08-29: terminal AVQD-N860W173080 (venue Alberto Dominguez) authenticated
 * as account A while its only assigned merchant belonged to account B, so the
 * TPV's config validator found an empty intersection and hard-blocked EVERY
 * charge.
 *
 * Two pure functions, on purpose: they are the single definition of "which
 * merchant is first" and "which account leads", shared by the terminal-config
 * endpoint and by any script that needs to answer the question against real
 * data without re-deriving the rule. A script that re-implemented the rule
 * would fail in the same direction as the endpoint and prove nothing.
 */

/** Minimal shape of an AngelPay credential payload — only the id is read. */
export interface AngelPayAccountRef {
  accountId: string
}

/** Minimal shape of a merchant already resolved for a terminal. */
export interface TerminalMerchantRef {
  id: string
  providerCode: string
  angelpayUserAccountId?: string | null
}

/**
 * Restores the OPERATOR'S order over merchants fetched with `id IN (...)`.
 *
 * `findMany({ where: { id: { in } } })` carries no ORDER BY, so Postgres returns
 * rows in whatever order it likes — while the id list (the terminal's
 * `assignedMerchantIds`, or the venue's primary/secondary/tertiary slots)
 * encodes intent. It matters because slots are shared across providers and
 * terminals: a Blumon/PAX merchant can occupy slot 1, pushing an AngelPay
 * merchant to slot 3, and a single NEXGO can carry TWO AngelPay merchants owned
 * by two different logins (Amaena, prod). "The terminal's first AngelPay
 * merchant" then decides which credential it authenticates with — a decision
 * that must never depend on row order.
 *
 * Ids not present in `orderedIds` keep their relative order after the known
 * ones. Never filters.
 */
export function orderMerchantsBySlot<T extends { id: string }>(merchants: T[], orderedIds: string[]): T[] {
  // First occurrence wins: a duplicated id in the slot list must keep its
  // EARLIEST slot, or a merchant listed as [legacy, new, legacy] would sort
  // after `new` and hand the terminal slot 2's login instead of slot 1's.
  const position = new Map<string, number>()
  orderedIds.forEach((id, i) => {
    if (!position.has(id)) position.set(id, i)
  })
  const unknown = orderedIds.length
  return [...merchants].sort((a, b) => (position.get(a.id) ?? unknown) - (position.get(b.id) ?? unknown))
}

/**
 * Returns `accounts` reordered so the account owning the terminal's FIRST
 * AngelPay merchant comes first. Clients read index 0 as the primary credential.
 *
 * Only the first AngelPay merchant (in slot order) is consulted. If it carries
 * no `angelpayUserAccountId` (legacy row) or names an account that is not
 * among the venue's ACTIVE ones, the incoming order is returned untouched —
 * the terminal keeps exactly the credential it received before this rule
 * existed. Skipping ahead to a LATER merchant would silently override the
 * operator's slot 1 with slot 2's login.
 *
 * Ordering only — never filters. Every account stays in the list so the TPV's
 * `switchAccount()` can still reach any of them.
 */
export function orderAngelPayAccountsForTerminal<T extends AngelPayAccountRef>(
  accounts: T[],
  merchantsInSlotOrder: TerminalMerchantRef[],
): T[] {
  const firstAngelPay = merchantsInSlotOrder.find(m => m.providerCode === 'ANGELPAY')
  const assignedAccountId = firstAngelPay?.angelpayUserAccountId
  if (!assignedAccountId) return accounts
  if (!accounts.some(a => a.accountId === assignedAccountId)) return accounts

  return [...accounts.filter(a => a.accountId === assignedAccountId), ...accounts.filter(a => a.accountId !== assignedAccountId)]
}
