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
 * account can see — use one of those `idNegocio` values to link a merchant
 * via the financial-connections `selectAccount` flow.
 */

import 'dotenv/config'
import { externalBankClient } from '../src/services/financial-connections/externalBank.client'
import { env } from '../src/config/env'

async function main() {
  const idNegocio = process.argv[2]
  const email = env.EXTERNAL_BANK_EMAIL
  const password = env.EXTERNAL_BANK_PASSWORD
  if (!email || !password) throw new Error('Faltan EXTERNAL_BANK_EMAIL / EXTERNAL_BANK_PASSWORD en .env')

  console.log('External bank provider: authenticating + fetching negocios...\n')
  const r = await externalBankClient.connect({ email, password, deviceIdentifier: 'avoqado-server-moneygiver-balance-lookup' })
  if (r.kind === 'need_device_validation') {
    throw new Error('Dispositivo requiere validación OTP — ya debería estar confiable desde el setup previo.')
  }

  console.log(`Cuenta ve ${r.accounts.length} negocio(s):\n`)
  for (const a of r.accounts) {
    console.log(`  - ${a.label ?? '(sin nombre)'}  idNegocio=${a.externalId}  saldo=${a.balance ?? '—'}`)
  }

  if (idNegocio) {
    const ctx = await externalBankClient.refresh(r.grant, 'avoqado-server-moneygiver-balance-lookup')
    const balance = await externalBankClient.getBalance(ctx.ctx, idNegocio)
    console.log(`\nBalance puntual para idNegocio=${idNegocio}:`, balance)
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\nFalló:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
