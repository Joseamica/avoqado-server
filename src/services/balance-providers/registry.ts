/**
 * Maps `BalanceProvider.code` → its concrete client implementation. Adding a
 * second provider later is: a new `BalanceProvider` row (via
 * scripts/seed-balance-providers.ts) + a new client here — no schema change.
 */
import { externalBankBalanceProviderClient } from './externalBank.client'
import type { BalanceProviderClient } from './types'

export const BALANCE_PROVIDER_CLIENTS: Record<string, BalanceProviderClient> = {
  EXTERNAL_BANK: externalBankBalanceProviderClient,
}

export function getBalanceProviderClient(code: string): BalanceProviderClient | undefined {
  return BALANCE_PROVIDER_CLIENTS[code]
}
