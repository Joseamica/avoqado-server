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
import logger from '../../config/logger'
import { env } from '../../config/env'
import { FacturapiProvider } from './providers/facturapi.provider'
import { FiscalProvider } from './providers/fiscal-provider.interface'
import { encryptProviderKey } from './fiscalKey.service'
import { fetchStorageObject } from '../storage.service'

// ─── DI interface ─────────────────────────────────────────────────────────────

export interface EmisorOnboardingDeps {
  /** Load a FiscalEmisor by id (full row — needs legal fields + providerOrgId + venueId). */
  findEmisor: (emisorId: string) => Promise<any | null>
  /**
   * Account-level provider (built from FACTURAPI_USER_KEY).
   * Only createOrganization, updateOrgLegal, uploadCsd and getOrganizationStatus are used here.
   */
  accountProvider: Pick<FiscalProvider, 'createOrganization' | 'updateOrgLegal' | 'uploadCsd' | 'getOrganizationStatus' | 'uploadLogo'>
  /** Persist changes to a FiscalEmisor row. */
  updateEmisor: (emisorId: string, data: Record<string, any>) => Promise<any>
  /** Encrypt a provider key before DB storage. Injected so tests can assert without real crypto. */
  encryptKey: (plaintext: string) => string
  /** URL del logo del venue (`Venue.logo`), o null si no ha subido uno. */
  findVenueLogo: (venueId: string) => Promise<string | null>
  /** Descarga bytes de una URL (el logo vive en Storage; el PAC quiere el archivo, no la liga). */
  fetchBytes: (url: string) => Promise<Buffer>
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

  // El logo va en el mismo paso (es lo que imprime en el PDF de cada factura), pero un fallo del
  // logo NUNCA tumba el provisioning: el emisor queda listo y el logo se reintenta desde el botón.
  try {
    await syncEmisorLogo({ emisorId: emisor.id, expectedVenueId: params.expectedVenueId }, { ...deps, findEmisor: async () => provisioned })
  } catch (err: unknown) {
    logger.warn(`[fiscal] logo no sincronizado al provisionar emisor ${emisor.id}: ${err instanceof Error ? err.message : String(err)}`)
  }

  return provisioned
}

/**
 * Sube el logo del venue (`Venue.logo`) a la organización del PAC, que es lo que aparece en el PDF
 * de cada factura. Sin esto el PDF sale con el nombre en texto plano (Testarudo, 21-sep-2026).
 * Idempotente: subirlo dos veces sólo lo reemplaza.
 *
 * @throws {Error} "Emisor {id} not found" on tenant mismatch → 404.
 */
export async function syncEmisorLogo(
  params: { emisorId: string; expectedVenueId: string; timeoutMs?: number },
  deps: EmisorOnboardingDeps = defaultDeps(),
): Promise<{ synced: true } | { synced: false; reason: 'NO_LOGO' | 'NOT_PROVISIONED' }> {
  const emisor = await deps.findEmisor(params.emisorId)
  if (!emisor || emisor.venueId !== params.expectedVenueId) {
    throw new Error(`Emisor ${params.emisorId} not found`) // tenant guard → 404
  }
  if (!emisor.providerOrgId) return { synced: false, reason: 'NOT_PROVISIONED' }
  const logoUrl = await deps.findVenueLogo(emisor.venueId)
  if (!logoUrl) return { synced: false, reason: 'NO_LOGO' }
  const bytes = await deps.fetchBytes(logoUrl)
  // El SDK del PAC no acota la subida: sin esto, un socket colgado dejaba el provisioning esperando.
  await conTiempoLimite(
    deps.accountProvider.uploadLogo(emisor.providerOrgId, bytes),
    params.timeoutMs ?? 10_000,
    'la subida del logo al PAC',
  )
  return { synced: true }
}

function conTiempoLimite<T>(promise: Promise<T>, ms: number, que: string): Promise<T> {
  let timer: NodeJS.Timeout
  const limite = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Se agotó el tiempo de espera de ${que} (${ms} ms)`)), ms)
  })
  return Promise.race([promise, limite]).finally(() => clearTimeout(timer))
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
    findVenueLogo: async venueId => (await prisma.venue.findUnique({ where: { id: venueId }, select: { logo: true } }))?.logo ?? null,
    // Sólo desde nuestro Storage, imagen, ≤ 5 MB, 10 s: `Venue.logo` es editable por el cliente.
    fetchBytes: url => fetchStorageObject(url, { maxBytes: 5 * 1024 * 1024, timeoutMs: 10_000, contentTypePrefix: 'image/' }),
  }
}
