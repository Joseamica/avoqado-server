/**
 * Adapts `ExternalBankApiService` (the concrete QPay implementation under
 * `src/services/externalBank/`) to the generic `BalanceProviderClient` shape.
 * Registered under `BalanceProvider.code = 'EXTERNAL_BANK'`.
 */
import { BadRequestError } from '@/errors/AppError'
import { externalBankApiService } from '../externalBank/externalBankApi.service'
import type { BalanceProviderClient, BalanceResult } from './types'

export const externalBankBalanceProviderClient: BalanceProviderClient = {
  async getBalance(accountId, opts) {
    const b = await externalBankApiService.getBalanceByIdNegocio(accountId, opts)
    const result: BalanceResult = {
      accountId: b.idNegocio,
      label: b.nombre,
      externalReference: b.cuentaClabe,
      balance: b.saldo,
      active: b.activo,
      fetchedAt: b.fetchedAt,
    }
    return result
  },

  async validateAccountId(accountId) {
    const me = await externalBankApiService.getMe()
    const exists = (me.negocios ?? []).some(n => n.idNegocio === accountId)
    if (!exists) {
      throw new BadRequestError(
        `accountId ${accountId} no existe entre los negocios visibles para la cuenta del proveedor bancario externo ` +
          'configurada (EXTERNAL_BANK_EMAIL). Revisa que no tenga un typo.',
      )
    }
  },
}
