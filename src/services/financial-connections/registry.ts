import type { FinancialProviderClient } from './types'
import { externalBankClient } from './externalBank.client'

export const FINANCIAL_PROVIDER_CLIENTS: Record<string, FinancialProviderClient> = {
  EXTERNAL_BANK: externalBankClient,
}

export function getFinancialProviderClient(code: string): FinancialProviderClient | undefined {
  return FINANCIAL_PROVIDER_CLIENTS[code]
}
