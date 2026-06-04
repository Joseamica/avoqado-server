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
      const key = emisor.providerKeyEnc
        ? decryptProviderKey(emisor.providerKeyEnc)
        : opts.sandbox
          ? process.env.FACTURAPI_TEST_KEY
          : undefined
      if (!key) throw new Error('No facturapi key available for emisor (no providerKeyEnc and no FACTURAPI_TEST_KEY in sandbox)')
      return new FacturapiProvider(key)
    }
    // FACTURAMA / ALEGRA adapters land in future plans (spec §7.5)
    default:
      throw new Error(`Unsupported fiscal provider: ${emisor.provider}`)
  }
}
