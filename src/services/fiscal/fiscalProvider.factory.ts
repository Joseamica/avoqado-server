import { FiscalEmisor } from '@prisma/client'
import { FiscalProvider } from './providers/fiscal-provider.interface'
import { FacturapiProvider } from './providers/facturapi.provider'
import { decryptProviderKey } from './fiscalKey.service'

type EmisorKeyFields = Pick<FiscalEmisor, 'provider' | 'providerKeyEnc'>

/**
 * Resolve the FiscalProvider adapter (with the right API key) for an emisor.
 * sandbox=true → use FACTURAPI_TEST_KEY (non-billed test stamps) when the emisor has no stored key.
 */
export function resolveFiscalProvider(emisor: EmisorKeyFields, opts: { sandbox: boolean }): FiscalProvider {
  switch (emisor.provider) {
    case 'FACTURAPI': {
      const key = resolveFacturapiKey(emisor, opts)
      if (!key) throw new Error('No facturapi key available for emisor (no providerKeyEnc and no FACTURAPI_TEST_KEY in sandbox)')
      return new FacturapiProvider(key)
    }
    // FACTURAMA / ALEGRA adapters land in future plans (spec §7.5)
    default:
      throw new Error(`Unsupported fiscal provider: ${emisor.provider}`)
  }
}

/**
 * La llave de Facturapi con la que timbra este emisor — la MISMA regla que `resolveFiscalProvider`, para que
 * todo lo que se haga en su organización (timbrar, cancelar, dar de alta el webhook) vaya a la misma.
 * `null` si el emisor no es de Facturapi o no hay llave.
 */
export function resolveFacturapiKey(emisor: EmisorKeyFields, opts: { sandbox: boolean }): string | null {
  if (emisor.provider !== 'FACTURAPI') return null
  if (emisor.providerKeyEnc) return decryptProviderKey(emisor.providerKeyEnc)
  return opts.sandbox ? (process.env.FACTURAPI_TEST_KEY ?? null) : null
}
