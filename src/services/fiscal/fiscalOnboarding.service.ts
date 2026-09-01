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
   * Only createOrganization, updateOrgLegal, uploadCsd and getOrganizationStatus are used here.
   */
  accountProvider: Pick<FiscalProvider, 'createOrganization' | 'updateOrgLegal' | 'uploadCsd' | 'getOrganizationStatus'>
  /** Persist changes to a FiscalEmisor row. */
  updateEmisor: (emisorId: string, data: Record<string, any>) => Promise<any>
  /** Encrypt a provider key before DB storage. Injected so tests can assert without real crypto. */
  encryptKey: (plaintext: string) => string
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Provision a FiscalEmisor: create the facturapi organization, store the
 * providerOrgId + encrypted live key in our DB IMMEDIATELY, then set the org's
 * legal info. Persisting first makes the call resumable: a legal-info failure
 * can't orphan the org, and a retry (providerOrgId already set) skips the
 * create and only re-runs the legal update on the same org.
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

  let provisioned = emisor
  if (!emisor.providerOrgId) {
    // Create the org in facturapi using the account-level key.
    const org = await deps.accountProvider.createOrganization({
      legalName: emisor.legalName,
      email: 'facturacion@avoqado.io',
    })

    // Persist providerOrgId + ENCRYPTED live key BEFORE any further provider call:
    // if updateOrgLegal fails, the org id survives and the retry reuses the SAME
    // org instead of orphaning one per attempt (prod, 2026-09-01). The plaintext
    // liveKey is never stored.
    provisioned = await deps.updateEmisor(emisor.id, {
      providerOrgId: org.providerOrgId,
      providerKeyEnc: deps.encryptKey(org.liveKey),
      // csdStatus stays NONE — CSD upload is the next step
    })
  }

  // Set the org's legal information (required before it can issue CFDIs).
  await deps.accountProvider.updateOrgLegal({
    providerOrgId: provisioned.providerOrgId,
    legalName: emisor.legalName,
    taxSystem: emisor.regimenFiscal,
    zip: emisor.lugarExpedicion,
  })

  return provisioned
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

/**
 * Estado del onboarding del emisor en el PAC — qué pasos le faltan para poder
 * timbrar en Live (hoy el que importa: la Carta Manifiesto).
 *
 * Un emisor sin provisionar responde `provisioned: false` sin tocar la red:
 * antes de conectar no hay organización que consultar.
 *
 * @throws {Error} "Emisor {id} not found" on tenant mismatch → 404.
 */
export async function getEmisorProviderStatus(
  params: { emisorId: string; expectedVenueId: string },
  deps: EmisorOnboardingDeps = defaultDeps(),
): Promise<{ provisioned: boolean; isProductionReady: boolean; pendingSteps: string[] }> {
  const emisor = await deps.findEmisor(params.emisorId)
  if (!emisor || emisor.venueId !== params.expectedVenueId) {
    throw new Error(`Emisor ${params.emisorId} not found`) // tenant guard → 404
  }
  if (!emisor.providerOrgId) {
    return { provisioned: false, isProductionReady: false, pendingSteps: [] }
  }
  const status = await deps.accountProvider.getOrganizationStatus(emisor.providerOrgId)
  return { provisioned: true, ...status }
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
