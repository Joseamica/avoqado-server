/**
 * Generic contract every banking/fintech balance integration implements.
 * `accountId` is opaque here — each provider defines what it actually means
 * (e.g. the "external" provider's is a QPay `idNegocio`).
 */

export interface BalanceResult {
  accountId: string
  label: string | null
  /** Bank account reference shown to the merchant, e.g. a CLABE. */
  externalReference: string | null
  balance: number | null
  active: boolean | null
  fetchedAt: string
}

export interface BalanceProviderClient {
  getBalance(accountId: string, opts?: { forceRefresh?: boolean }): Promise<BalanceResult>
  /**
   * Optional: confirm `accountId` actually exists for this provider before
   * persisting it on a MerchantAccount. Throws (e.g. BadRequestError) if not.
   * Providers that can't cheaply validate may omit this.
   */
  validateAccountId?(accountId: string): Promise<void>
}
