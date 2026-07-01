/**
 * Manual smoke test for the external bank balance provider integration.
 *
 * Run this once after setting EXTERNAL_BANK_EMAIL / EXTERNAL_BANK_PASSWORD
 * (and optionally EXTERNAL_BANK_API_BASE / EXTERNAL_BANK_MG_PLATFORM) in your
 * .env, to confirm login + balance lookup work BEFORE wiring anything in the UI.
 *
 * Usage:
 *   npx tsx -r tsconfig-paths/register scripts/test-external-bank-balance.ts
 *   npx tsx -r tsconfig-paths/register scripts/test-external-bank-balance.ts <idNegocio>
 *
 * Without an idNegocio it just lists every negocio (sucursal) the broker
 * account can see — copy one of those into a MerchantAccount.balanceProviderAccountId.
 */

import 'dotenv/config'
import { externalBankApiService } from '../src/services/externalBank/externalBankApi.service'

async function main() {
  const idNegocio = process.argv[2]

  console.log('External bank provider: authenticating + fetching negocios...\n')
  const me = await externalBankApiService.getMe({ forceRefresh: true })
  const negocios = me.negocios ?? []

  console.log(`Cuenta ve ${negocios.length} negocio(s):\n`)
  for (const n of negocios) {
    console.log(`  - ${n.nombre ?? '(sin nombre)'}  idNegocio=${n.idNegocio}  saldo=${n.cuentaDispersion?.saldo ?? '—'}`)
  }

  if (idNegocio) {
    console.log(`\nBalance puntual para idNegocio=${idNegocio}:`)
    const balance = await externalBankApiService.getBalanceByIdNegocio(idNegocio, { forceRefresh: true })
    console.log(balance)
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\nFalló:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
