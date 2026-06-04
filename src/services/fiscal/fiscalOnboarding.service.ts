/**
 * Fiscal Onboarding Service
 *
 * Provisions a FiscalEmisor in facturapi (createOrganization → updateOrgLegal → store
 * providerOrgId + encrypted live key) and uploads its CSD (.cer/.key/password).
 *
 * Security: The CSD files and password are forwarded straight to facturapi and NEVER
 * persisted by us or written to any log. Only providerOrgId + the encrypted live key
 * are stored in the DB.
 *
 * DI pattern mirrors fiscalConfig.service.ts. callers may inject deps for unit testing;
 * production code uses defaultDeps() which builds an account-level provider from
 * FACTURAPI_USER_KEY (org provisioning + CSD upload are account-level operations).
 *
 * Tenant safety: emisor.venueId must equal the caller's expectedVenueId → throws
 * "not found" on mismatch so the controller returns 404 (no cross-tenant leak).
 *
 * @see docs/superpowers/plans/2026-06-03-facturacion-phase3-emisor-onboarding.md — spec §7.2
 */

import prisma from '../../utils/prismaClient'
import { env } from '../../config/env'
import { FacturapiProvider } from './providers/facturapi.provider'
import { FiscalProvider } from './providers/fiscal-provider.interface'
import { encryptProviderKey } from './fiscalKey.service'

// ─── DI interface ─────────────────────────────────────────────────────────────

export interface EmisorOnboardingDeps {
  /** Load a FiscalEmisor by id (full row — needs legal fields + providerOrgId + venueId). */
  findEmisor: (emisorId: string) => Promise<any | null>
  /**
   * Account-level provider (built from FACTURAPI_USER_KEY).
   * Only createOrganization, updateOrgLegal, and uploadCsd are used here.
   */
  accountProvider: Pick<FiscalProvider, 'createOrganization' | 'updateOrgLegal' | 'uploadCsd'>
  /** Persist changes to a FiscalEmisor row. */
  updateEmisor: (emisorId: string, data: Record<string, any>) => Promise<any>
  /** Encrypt a provider key before DB storage. Injected so tests can assert without real crypto. */
  encryptKey: (plaintext: string) => string
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Provision a FiscalEmisor: create the facturapi organization, set its legal info,
 * then store the providerOrgId + encrypted live key in our DB.
 *
 * After this call the emisor's csdStatus remains NONE — the CSD upload step
 * (uploadEmisorCsd) is what advances it to ACTIVE.
 *
 * @throws {Error} "Emisor {id} not found" when the emisor doesn't exist or belongs to
 *   a different venue (tenant guard → 404 at the controller layer).
 */
export async function provisionEmisor(
  params: { emisorId: string; expectedVenueId: string },
  deps: EmisorOnboardingDeps = defaultDeps(),
): Promise<any> {
  const emisor = await deps.findEmisor(params.emisorId)
  if (!emisor || emisor.venueId !== params.expectedVenueId) {
    throw new Error(`Emisor ${params.emisorId} not found`) // tenant guard → 404
  }

  // Create the org in facturapi using the account-level key.
  const org = await deps.accountProvider.createOrganization({
    legalName: emisor.legalName,
    email: 'facturacion@avoqado.io',
  })

  // Set the org's legal information (required before it can issue CFDIs).
  await deps.accountProvider.updateOrgLegal({
    providerOrgId: org.providerOrgId,
    legalName: emisor.legalName,
    taxSystem: emisor.regimenFiscal,
    zip: emisor.lugarExpedicion,
  })

  // Persist providerOrgId + ENCRYPTED live key only. The plaintext liveKey is never stored.
  return deps.updateEmisor(emisor.id, {
    providerOrgId: org.providerOrgId,
    providerKeyEnc: deps.encryptKey(org.liveKey),
    // csdStatus stays NONE — CSD upload is the next step
  })
}

/**
 * Upload a CSD (.cer/.key/password) for an already-provisioned FiscalEmisor.
 *
 * The CSD files and password are sent straight to facturapi and NEVER written to
 * our DB or any log line. On success, csdStatus advances to ACTIVE and the expiry date
 * is stored.
 *
 * @throws {Error} "Emisor {id} not found" on tenant mismatch → 404.
 * @throws {Error} matching /provision/i when providerOrgId is null → 409 at controller.
 */
export async function uploadEmisorCsd(
  params: {
    emisorId: string
    cerBase64: string
    keyBase64: string
    csdPassword: string
    expectedVenueId: string
  },
  deps: EmisorOnboardingDeps = defaultDeps(),
): Promise<any> {
  const emisor = await deps.findEmisor(params.emisorId)
  if (!emisor || emisor.venueId !== params.expectedVenueId) {
    throw new Error(`Emisor ${params.emisorId} not found`) // tenant guard → 404
  }
  if (!emisor.providerOrgId) {
    throw new Error('El emisor debe provisionarse antes de subir el CSD') // matches /provision/i → 409
  }

  // CSD bytes + password flow straight to facturapi — NEVER persisted or logged by us.
  const result = await deps.accountProvider.uploadCsd({
    providerOrgId: emisor.providerOrgId,
    cerBase64: params.cerBase64,
    keyBase64: params.keyBase64,
    csdPassword: params.csdPassword,
  })

  // Store only the status + expiry (no CSD material).
  return deps.updateEmisor(emisor.id, {
    csdStatus: 'ACTIVE',
    csdExpiresAt: result.csdExpiresAt,
    csdLastCheckedAt: new Date(),
  })
}

// ─── Default deps (production) ────────────────────────────────────────────────

function defaultDeps(): EmisorOnboardingDeps {
  // Org provisioning + CSD upload are ACCOUNT-level operations → use the account User Key.
  // FacturapiProvider throws clearly if FACTURAPI_USER_KEY is empty (constructor guard).
  const accountProvider = new FacturapiProvider(env.FACTURAPI_USER_KEY ?? '')
  return {
    findEmisor: id => prisma.fiscalEmisor.findUnique({ where: { id } }),
    accountProvider,
    updateEmisor: (id, data) => prisma.fiscalEmisor.update({ where: { id }, data }),
    encryptKey: encryptProviderKey,
  }
}
