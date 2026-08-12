/**
 * Billing tax profile service — the receptor (Avoqado's customer) fiscal data.
 *
 * A receptor can be an ORGANIZATION, a VENUE, or a STANDALONE external buyer
 * (e.g. someone who bought a TPV but isn't a registered venue). Superadmin can
 * capture the data by hand — it does NOT depend on the client having self-served
 * a constancia. The constancia PDF is optional (stored as a URL for reference).
 */
import prisma from '@/utils/prismaClient'
import type { BillingTaxProfile } from '@prisma/client'
import logger from '@/config/logger'
import { buildStoragePath, deleteFileFromStorage, uploadFileToStorage } from '@/services/storage.service'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import type { SatValidationResult } from '@/services/fiscal/providers/fiscal-provider.interface'
import { getActivePlatformEmisor, PlatformBillingError } from './platformEmisor.service'
import type { BillingCustomerKind, TaxProfileWithValidation, UpsertTaxProfileInput } from './types'

const CONSTANCIA_EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' }

export async function getBillingTaxProfileById(id: string): Promise<BillingTaxProfile | null> {
  return prisma.billingTaxProfile.findUnique({ where: { id } })
}

/** Resolve the existing profile for an org/venue customer (STANDALONE has no stable external id). */
export async function getBillingTaxProfileForCustomer(customerType: BillingCustomerKind, id?: string): Promise<BillingTaxProfile | null> {
  if (customerType === 'ORGANIZATION' && id) return prisma.billingTaxProfile.findUnique({ where: { organizationId: id } })
  if (customerType === 'VENUE' && id) return prisma.billingTaxProfile.findUnique({ where: { venueId: id } })
  return null
}

/** Create or update a receptor's fiscal profile. Handles org/venue (1 per entity) + standalone (dedupe by RFC). */
export async function upsertBillingTaxProfile(input: UpsertTaxProfileInput): Promise<BillingTaxProfile> {
  const common = {
    rfc: input.rfc.toUpperCase().trim(),
    razonSocial: input.razonSocial,
    regimenFiscal: input.regimenFiscal,
    codigoPostal: input.codigoPostal,
    defaultUsoCfdi: input.defaultUsoCfdi ?? 'G03',
    email: input.email ?? null,
  }

  if (input.customerType === 'ORGANIZATION') {
    if (!input.organizationId) throw new PlatformBillingError('organizationId es requerido para receptor de organización', 'VALIDATION')
    return prisma.billingTaxProfile.upsert({
      where: { organizationId: input.organizationId },
      create: { customerType: 'ORGANIZATION', organizationId: input.organizationId, ...common, createdById: input.performedById ?? null },
      update: { ...common },
    })
  }

  if (input.customerType === 'VENUE') {
    if (!input.venueId) throw new PlatformBillingError('venueId es requerido para receptor de venue', 'VALIDATION')
    return prisma.billingTaxProfile.upsert({
      where: { venueId: input.venueId },
      create: { customerType: 'VENUE', venueId: input.venueId, ...common, createdById: input.performedById ?? null },
      update: { ...common },
    })
  }

  // STANDALONE — no FK; dedupe by RFC so we reuse one profile per external buyer.
  const existing = await prisma.billingTaxProfile.findFirst({ where: { customerType: 'STANDALONE', rfc: common.rfc } })
  if (existing) {
    return prisma.billingTaxProfile.update({
      where: { id: existing.id },
      data: { ...common, displayName: input.displayName ?? existing.displayName },
    })
  }
  return prisma.billingTaxProfile.create({
    data: { customerType: 'STANDALONE', displayName: input.displayName ?? null, ...common, createdById: input.performedById ?? null },
  })
}

/**
 * Valida los datos fiscales del receptor contra el padrón del SAT vía el PAC, sin gastar timbre.
 *
 * BEST-EFFORT A PROPÓSITO: si no hay emisor, el CSD no sirve, o el PAC está caído, devuelve
 * `validation: null` y deja `validationStatus` como estaba. Una caída del PAC no puede dejar
 * al operador sin poder capturar ni corregir datos fiscales.
 */
export async function validateBillingTaxProfile(profileId: string): Promise<TaxProfileWithValidation> {
  const profile = await prisma.billingTaxProfile.findUnique({ where: { id: profileId } })
  if (!profile) throw new PlatformBillingError('Perfil fiscal del receptor no encontrado', 'NO_PROFILE')

  const emisor = await getActivePlatformEmisor()
  if (!emisor) return { profile, validation: null }

  // Sólo la llamada al PAC es best-effort: un PAC caído o una llave rechazada no es un
  // veredicto sobre los datos del receptor, así que se deja el status previo y se reporta
  // "no validado" sin reventar.
  let customerId: string
  let validation: SatValidationResult
  try {
    const provider = resolveFiscalProvider({ provider: emisor.provider, providerKeyEnc: emisor.providerKeyEnc }, { sandbox: false })
    customerId = await provider.upsertCustomer({
      rfc: profile.rfc,
      razonSocial: profile.razonSocial,
      regimenFiscal: profile.regimenFiscal,
      codigoPostal: profile.codigoPostal,
      email: profile.email ?? undefined,
      existingCustomerId: profile.facturapiCustomerId,
    })
    validation = await provider.validateCustomerTaxInfo(customerId)
  } catch (err) {
    logger.warn(`[platform-billing] no se pudo validar el perfil ${profile.id}: ${err instanceof Error ? err.message : String(err)}`)
    return { profile, validation: null }
  }

  // El PAC SÍ respondió — ya tenemos un veredicto real del SAT. La escritura local queda
  // FUERA del catch de arriba a propósito: si esta falla es un bug nuestro (dato mal
  // formado, conexión a la BD, constraint), no una caída del proveedor, y el veredicto
  // que YA obtuvimos no debe perderse ni confundirse con "PAC caído".
  try {
    const updated = await prisma.billingTaxProfile.update({
      where: { id: profile.id },
      data: {
        facturapiCustomerId: customerId,
        validationStatus: validation.valid ? 'VALID' : 'INVALID',
        validatedAt: new Date(),
      },
    })
    return { profile: updated, validation }
  } catch (err) {
    logger.error(
      `[platform-billing] el SAT validó el perfil ${profile.id} pero no se pudo persistir el resultado: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { profile, validation }
  }
}

/**
 * Upload the receptor's constancia (PDF/imagen) to Firebase Storage and store its URL on the
 * profile. Overwrites the prior file (best-effort delete) so a profile keeps one constancia.
 */
export async function uploadConstancia(profileId: string, fileBase64: string, contentType = 'application/pdf'): Promise<BillingTaxProfile> {
  const profile = await prisma.billingTaxProfile.findUnique({ where: { id: profileId } })
  if (!profile) throw new PlatformBillingError('Perfil fiscal no encontrado', 'NO_PROFILE')

  const buffer = Buffer.from(fileBase64, 'base64')
  if (buffer.length === 0) throw new PlatformBillingError('El archivo de la constancia está vacío', 'VALIDATION')

  const ext = CONSTANCIA_EXT[contentType] ?? 'pdf'
  const path = buildStoragePath(`platform-billing/tax-profiles/${profileId}/constancia.${ext}`)

  if (profile.constanciaUrl) void deleteFileFromStorage(profile.constanciaUrl) // best-effort, replace
  const url = await uploadFileToStorage(buffer, path, contentType)

  return prisma.billingTaxProfile.update({ where: { id: profileId }, data: { constanciaUrl: url } })
}

export interface CustomerSearchRow {
  type: BillingCustomerKind
  /** organizationId / venueId, or the BillingTaxProfile id for STANDALONE. */
  id: string
  name: string
  rfc?: string | null
  hasProfile: boolean
}

/** Search billable customers (orgs, venues, or standalone receptors) for the "Nueva factura" picker. */
export async function searchBillingCustomers(type: BillingCustomerKind | undefined, q: string | undefined): Promise<CustomerSearchRow[]> {
  const term = (q ?? '').trim()
  const rows: CustomerSearchRow[] = []

  if (!type || type === 'ORGANIZATION') {
    const orgs = await prisma.organization.findMany({
      where: term ? { name: { contains: term, mode: 'insensitive' } } : {},
      take: 20,
      select: { id: true, name: true },
    })
    const profiles = await prisma.billingTaxProfile.findMany({
      where: { organizationId: { in: orgs.map(o => o.id) } },
      select: { organizationId: true },
    })
    const withProfile = new Set(profiles.map(p => p.organizationId))
    rows.push(...orgs.map(o => ({ type: 'ORGANIZATION' as const, id: o.id, name: o.name, hasProfile: withProfile.has(o.id) })))
  }

  if (!type || type === 'VENUE') {
    const venues = await prisma.venue.findMany({
      where: term ? { name: { contains: term, mode: 'insensitive' } } : {},
      take: 20,
      select: { id: true, name: true },
    })
    const profiles = await prisma.billingTaxProfile.findMany({
      where: { venueId: { in: venues.map(v => v.id) } },
      select: { venueId: true },
    })
    const withProfile = new Set(profiles.map(p => p.venueId))
    rows.push(...venues.map(v => ({ type: 'VENUE' as const, id: v.id, name: v.name, hasProfile: withProfile.has(v.id) })))
  }

  if (!type || type === 'STANDALONE') {
    const standalone = await prisma.billingTaxProfile.findMany({
      where: {
        customerType: 'STANDALONE',
        ...(term
          ? { OR: [{ rfc: { contains: term, mode: 'insensitive' } }, { displayName: { contains: term, mode: 'insensitive' } }] }
          : {}),
      },
      take: 20,
    })
    rows.push(
      ...standalone.map(p => ({
        type: 'STANDALONE' as const,
        id: p.id,
        name: p.displayName ?? p.razonSocial,
        rfc: p.rfc,
        hasProfile: true,
      })),
    )
  }

  return rows
}
