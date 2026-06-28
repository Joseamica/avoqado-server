/**
 * Platform emisor service — Avoqado as the CFDI issuer.
 *
 * Reuses the existing fiscal engine at the service layer:
 *  - FacturapiProvider (account-level key) to create the Facturapi org + upload CSD
 *  - fiscalKey.service to encrypt the per-emisor live key at rest
 *
 * The emisor is ~singleton (one active PlatformEmisor), but modeled as a table so
 * a second platform RFC can be added later without a migration.
 */
import prisma from '@/utils/prismaClient'
import { env } from '@/config/env'
import { FacturapiProvider } from '@/services/fiscal/providers/facturapi.provider'
import { encryptProviderKey } from '@/services/fiscal/fiscalKey.service'
import type { PlatformEmisor } from '@prisma/client'
import type { UpsertEmisorInput } from './types'

export type PlatformBillingErrorCode = 'NO_EMISOR' | 'NO_PROFILE' | 'NO_CFDI' | 'CSD_INACTIVE' | 'VALIDATION' | 'PROVIDER'

/** Typed error so the controller can map to HTTP status codes (422 vs 502 vs 404). */
export class PlatformBillingError extends Error {
  constructor(
    message: string,
    public readonly code: PlatformBillingErrorCode = 'VALIDATION',
  ) {
    super(message)
    this.name = 'PlatformBillingError'
  }
}

/** Account-level Facturapi provider (provisions orgs + uploads CSDs). Prod-only key. */
function accountProvider(): FacturapiProvider {
  return new FacturapiProvider(env.FACTURAPI_USER_KEY ?? '')
}

/** The active Avoqado platform emisor (≈ singleton), or null if not configured. */
export async function getActivePlatformEmisor(): Promise<PlatformEmisor | null> {
  return prisma.platformEmisor.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'desc' } })
}

/** Create or update the platform emisor's legal data (DB only; provisioning is separate). */
export async function upsertPlatformEmisorLegal(input: UpsertEmisorInput, performedById?: string | null): Promise<PlatformEmisor> {
  const existing = await getActivePlatformEmisor()
  if (existing) {
    return prisma.platformEmisor.update({
      where: { id: existing.id },
      data: {
        rfc: input.rfc,
        legalName: input.legalName,
        regimenFiscal: input.regimenFiscal,
        lugarExpedicion: input.lugarExpedicion,
        serie: input.serie ?? existing.serie,
        defaultUsoCfdi: input.defaultUsoCfdi ?? existing.defaultUsoCfdi,
      },
    })
  }
  return prisma.platformEmisor.create({
    data: {
      rfc: input.rfc,
      legalName: input.legalName,
      regimenFiscal: input.regimenFiscal,
      lugarExpedicion: input.lugarExpedicion,
      serie: input.serie ?? 'A',
      defaultUsoCfdi: input.defaultUsoCfdi ?? null,
      createdById: performedById ?? null,
    },
  })
}

/** Provision the emisor in Facturapi: create org + set legal, store encrypted live key. */
export async function provisionPlatformEmisor(emisorId: string, provider: FacturapiProvider = accountProvider()): Promise<PlatformEmisor> {
  const emisor = await prisma.platformEmisor.findUnique({ where: { id: emisorId } })
  if (!emisor) throw new PlatformBillingError('Emisor no encontrado', 'NO_EMISOR')

  const org = await provider.createOrganization({ legalName: emisor.legalName, email: 'facturacion@avoqado.io' })
  await provider.updateOrgLegal({
    providerOrgId: org.providerOrgId,
    legalName: emisor.legalName,
    taxSystem: emisor.regimenFiscal,
    zip: emisor.lugarExpedicion,
  })

  return prisma.platformEmisor.update({
    where: { id: emisor.id },
    data: { providerOrgId: org.providerOrgId, providerKeyEnc: encryptProviderKey(org.liveKey) },
  })
}

/** Manual path: bind an existing Facturapi org id + live key created directly in the panel. */
export async function setPlatformEmisorProviderManual(emisorId: string, providerOrgId: string, liveKey: string): Promise<PlatformEmisor> {
  const emisor = await prisma.platformEmisor.findUnique({ where: { id: emisorId } })
  if (!emisor) throw new PlatformBillingError('Emisor no encontrado', 'NO_EMISOR')
  return prisma.platformEmisor.update({
    where: { id: emisor.id },
    data: { providerOrgId, providerKeyEnc: encryptProviderKey(liveKey) },
  })
}

/** Upload the CSD (.cer/.key/password) to Facturapi for this emisor. */
export async function uploadPlatformEmisorCsd(
  emisorId: string,
  csd: { cerBase64: string; keyBase64: string; csdPassword: string },
  provider: FacturapiProvider = accountProvider(),
): Promise<PlatformEmisor> {
  const emisor = await prisma.platformEmisor.findUnique({ where: { id: emisorId } })
  if (!emisor) throw new PlatformBillingError('Emisor no encontrado', 'NO_EMISOR')
  if (!emisor.providerOrgId) throw new PlatformBillingError('El emisor debe provisionarse antes de subir el CSD', 'VALIDATION')

  const result = await provider.uploadCsd({
    providerOrgId: emisor.providerOrgId,
    cerBase64: csd.cerBase64,
    keyBase64: csd.keyBase64,
    csdPassword: csd.csdPassword,
  })

  return prisma.platformEmisor.update({
    where: { id: emisor.id },
    data: { csdStatus: 'ACTIVE', csdExpiresAt: result.csdExpiresAt, csdLastCheckedAt: new Date() },
  })
}
