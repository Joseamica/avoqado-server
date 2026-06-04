/**
 * Fiscal Config Service — emisor metadata + per-merchant facturación toggles.
 *
 * Pure DB — NO facturapi calls (org provisioning + CSD upload is a separate founder step).
 * DI pattern mirrors cfdi.service.ts: callers inject deps; defaultDeps uses Prisma directly.
 *
 * Tenant safety guarantee:
 *   - upsertEmisor (update): verifies the stored emisor.venueId === input.venueId.
 *   - upsertMerchantFiscalConfig: verifies BOTH the merchant's venue AND the emisor's venue
 *     match the caller's venueId before any write. Mismatch → throw "…not found" → 404.
 *   - MerchantAccount has NO direct venueId; the link goes through VenuePaymentConfig
 *     (primary/secondary/tertiary slots). findMerchantVenue queries that table.
 *   - EcommerceMerchant HAS a direct venueId — simpler path.
 *
 * @see docs/superpowers/plans/2026-06-03-facturacion-phase2-fiscal-config.md
 */

import { GlobalPeriodicity } from '@prisma/client'
import prisma from '../../utils/prismaClient'

// ─── Input shapes ─────────────────────────────────────────────────────────────

export interface EmisorInput {
  venueId: string
  /** Present → update; absent → create */
  emisorId?: string
  rfc: string
  legalName: string
  regimenFiscal: string
  lugarExpedicion: string
  serie?: string
  defaultUsoCfdi?: string
  globalPeriodicity?: GlobalPeriodicity
}

export interface MerchantFiscalConfigInput {
  venueId: string
  /** Exactly one of merchantAccountId / ecommerceMerchantId must be set (XOR). */
  merchantAccountId?: string
  ecommerceMerchantId?: string
  fiscalEmisorId: string
  facturacionEnabled: boolean
  autofacturaEnabled: boolean
  includeInGlobal: boolean
}

// ─── DI interface ─────────────────────────────────────────────────────────────

export interface FiscalConfigDeps {
  /** Create or update a FiscalEmisor row. Pass emisorId to update. */
  upsertEmisorRow: (data: Record<string, unknown>, emisorId?: string) => Promise<any>
  /** Load a FiscalEmisor for tenant-guard checks (id + venueId only). */
  findEmisor: (emisorId: string) => Promise<{ id: string; venueId: string } | null>
  /**
   * Confirm that a merchant belongs to the caller's venue.
   * Scoped to venueId — never returns a different venue's id.
   * Returns the caller's venueId when confirmed, null otherwise.
   *
   * Accepts either merchantAccountId (→ VenuePaymentConfig path) or
   * ecommerceMerchantId (→ direct venueId path).
   */
  findMerchantVenue: (venueId: string, merchantAccountId?: string, ecommerceMerchantId?: string) => Promise<string | null>
  /** Create-or-update a MerchantFiscalConfig row. */
  upsertMerchantConfigRow: (data: Record<string, unknown>) => Promise<any>
  /** List all emisores for a venue. */
  listEmisores: (venueId: string) => Promise<any[]>
  /** List all merchant fiscal configs whose emisor belongs to the venue. */
  listMerchantConfigs: (venueId: string) => Promise<any[]>
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Create or update a FiscalEmisor for a venue.
 *
 * Create: no tenant guard needed (the venueId is set from the caller's authContext).
 * Update (emisorId present): fetches the stored row and asserts venueId matches → 404
 * on mismatch to prevent cross-tenant writes.
 *
 * A new emisor starts with csdStatus=NONE — the CSD upload step (founder-involved,
 * separate phase) is what advances it to ACTIVE.
 */
export async function upsertEmisor(input: EmisorInput, deps: FiscalConfigDeps = defaultDeps): Promise<any> {
  if (input.emisorId) {
    const existing = await deps.findEmisor(input.emisorId)
    if (!existing || existing.venueId !== input.venueId) {
      throw new Error(`Emisor ${input.emisorId} not found`) // tenant guard → 404
    }
  }

  const data: Record<string, unknown> = {
    venueId: input.venueId,
    rfc: input.rfc,
    legalName: input.legalName,
    regimenFiscal: input.regimenFiscal,
    lugarExpedicion: input.lugarExpedicion,
    serie: input.serie ?? null,
    defaultUsoCfdi: input.defaultUsoCfdi ?? 'G03',
    globalPeriodicity: input.globalPeriodicity ?? 'MENSUAL',
  }

  return deps.upsertEmisorRow(data, input.emisorId)
}

/**
 * Create or update the MerchantFiscalConfig for one merchant.
 *
 * Enforces XOR: exactly one of merchantAccountId / ecommerceMerchantId must be set.
 * Cross-field business rules stay in the service (Zod is shape-only per critical-warnings).
 *
 * Tenant guards (both must pass before any write):
 *   1. merchant's venueId === input.venueId  (via VenuePaymentConfig for MerchantAccount)
 *   2. emisor's venueId   === input.venueId
 */
export async function upsertMerchantFiscalConfig(input: MerchantFiscalConfigInput, deps: FiscalConfigDeps = defaultDeps): Promise<any> {
  const hasAcct = !!input.merchantAccountId
  const hasEcom = !!input.ecommerceMerchantId
  if (hasAcct === hasEcom) {
    throw new Error('Debe especificar exactamente un merchant (merchantAccountId o ecommerceMerchantId)')
  }

  // Guard 1: merchant belongs to the caller's venue (scoped query — no cross-venue leak)
  const merchantVenue = await deps.findMerchantVenue(input.venueId, input.merchantAccountId, input.ecommerceMerchantId)
  if (merchantVenue !== input.venueId) {
    throw new Error('Merchant not found') // tenant guard → 404
  }

  // Guard 2: emisor belongs to the caller's venue
  const emisor = await deps.findEmisor(input.fiscalEmisorId)
  if (!emisor || emisor.venueId !== input.venueId) {
    throw new Error(`Emisor ${input.fiscalEmisorId} not found`) // tenant guard → 404
  }

  return deps.upsertMerchantConfigRow({
    merchantAccountId: input.merchantAccountId ?? null,
    ecommerceMerchantId: input.ecommerceMerchantId ?? null,
    fiscalEmisorId: input.fiscalEmisorId,
    facturacionEnabled: input.facturacionEnabled,
    autofacturaEnabled: input.autofacturaEnabled,
    includeInGlobal: input.includeInGlobal,
  })
}

/**
 * Return all emisores + merchant fiscal configs for a venue.
 * Read-only — no tenant guard beyond the venueId filter in each query.
 */
export async function getFiscalConfig(
  input: { venueId: string },
  deps: FiscalConfigDeps = defaultDeps,
): Promise<{ emisores: any[]; merchantConfigs: any[] }> {
  const [emisores, merchantConfigs] = await Promise.all([deps.listEmisores(input.venueId), deps.listMerchantConfigs(input.venueId)])
  return { emisores, merchantConfigs }
}

// ─── Real default deps (tenant-filtered Prisma) ───────────────────────────────

const defaultDeps: FiscalConfigDeps = {
  upsertEmisorRow: (data, emisorId) =>
    emisorId
      ? prisma.fiscalEmisor.update({ where: { id: emisorId }, data: data as any })
      : prisma.fiscalEmisor.create({ data: data as any }),

  findEmisor: id =>
    prisma.fiscalEmisor.findUnique({
      where: { id },
      select: { id: true, venueId: true },
    }),

  /**
   * Resolve venueId for a merchant.
   *
   * MerchantAccount path:
   *   MerchantAccount has NO direct venueId. It links to a venue via VenuePaymentConfig
   *   in one of three slots (primaryAccountId / secondaryAccountId / tertiaryAccountId).
   *   We query VenuePaymentConfig with an OR across those three FK columns. The first
   *   matching row's venueId is the owner. If no VenuePaymentConfig references this
   *   MerchantAccount, the merchant is unattached → return null.
   *
   * EcommerceMerchant path:
   *   Has a direct venueId column — simple findUnique select.
   */
  findMerchantVenue: async (merchantAccountId?: string, ecommerceMerchantId?: string) => {
    if (merchantAccountId) {
      const config = await prisma.venuePaymentConfig.findFirst({
        where: {
          OR: [
            { primaryAccountId: merchantAccountId },
            { secondaryAccountId: merchantAccountId },
            { tertiaryAccountId: merchantAccountId },
          ],
        },
        select: { venueId: true },
      })
      return config?.venueId ?? null
    }
    if (ecommerceMerchantId) {
      const merchant = await prisma.ecommerceMerchant.findUnique({
        where: { id: ecommerceMerchantId },
        select: { venueId: true },
      })
      return merchant?.venueId ?? null
    }
    return null
  },

  upsertMerchantConfigRow: data => {
    const merchantAccountId = data.merchantAccountId as string | null
    const ecommerceMerchantId = data.ecommerceMerchantId as string | null
    const where = merchantAccountId ? { merchantAccountId } : ({ ecommerceMerchantId: ecommerceMerchantId! } as any)
    return prisma.merchantFiscalConfig.upsert({
      where,
      create: data as any,
      update: data as any,
    })
  },

  listEmisores: venueId => prisma.fiscalEmisor.findMany({ where: { venueId } }),

  listMerchantConfigs: venueId =>
    prisma.merchantFiscalConfig.findMany({
      where: { fiscalEmisor: { venueId } },
      include: {
        merchantAccount: { select: { id: true, alias: true, displayName: true } },
        ecommerceMerchant: { select: { id: true, channelName: true } },
      },
    }),
}
