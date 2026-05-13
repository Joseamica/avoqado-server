/**
 * Payment Link Settings Service
 *
 * Per-venue defaults applied to NEW payment links and admin notification
 * preferences when a link is paid. Backs the "Ajustes generales" page
 * under "Ligas de Pago" in the dashboard.
 *
 * Per-link config (tippingConfig, customFields) still lives on PaymentLink
 * itself for cases where the creator overrides venue defaults at creation
 * time. This service stores the venue-wide DEFAULTS plus a few cross-link
 * toggles (notifyOnPaid, merchantPolicies) that don't need per-link copies.
 */

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'

export interface TippingConfig {
  presets: number[]
  allowCustom: boolean
}

export interface CustomFieldDefinition {
  id: string
  type: 'TEXT' | 'SELECT'
  label: string
  required: boolean
  options?: string[]
}

export interface PaymentLinkSettings {
  notifyOnPaid: boolean
  defaultTippingConfig: TippingConfig | null
  defaultCustomFields: CustomFieldDefinition[] | null
  customerNotesEnabled: boolean
  merchantPolicies: string | null
}

/**
 * Shape served to the dashboard and consumed by createPaymentLink to seed
 * defaults. Always returns a value — venues without a row in the table get
 * the same defaults Prisma would use on insert.
 */
const DEFAULT_SETTINGS: PaymentLinkSettings = {
  notifyOnPaid: false,
  defaultTippingConfig: null,
  defaultCustomFields: null,
  customerNotesEnabled: false,
  merchantPolicies: null,
}

export async function getPaymentLinkSettings(venueId: string): Promise<PaymentLinkSettings> {
  const row = await prisma.venuePaymentLinkSettings.findUnique({ where: { venueId } })
  if (!row) return { ...DEFAULT_SETTINGS }
  return {
    notifyOnPaid: row.notifyOnPaid,
    defaultTippingConfig: (row.defaultTippingConfig as unknown as TippingConfig | null) ?? null,
    defaultCustomFields: (row.defaultCustomFields as unknown as CustomFieldDefinition[] | null) ?? null,
    customerNotesEnabled: row.customerNotesEnabled,
    merchantPolicies: row.merchantPolicies,
  }
}

export interface UpdatePaymentLinkSettingsInput {
  notifyOnPaid?: boolean
  defaultTippingConfig?: TippingConfig | null
  defaultCustomFields?: CustomFieldDefinition[] | null
  customerNotesEnabled?: boolean
  merchantPolicies?: string | null
}

/**
 * Upsert pattern — venues edit settings before a row exists, so we create
 * on first save and patch thereafter. JSON fields use Prisma.JsonNull
 * sentinel when the caller explicitly clears them.
 */
export async function upsertPaymentLinkSettings(venueId: string, data: UpdatePaymentLinkSettingsInput): Promise<PaymentLinkSettings> {
  const writeData: Prisma.VenuePaymentLinkSettingsUpdateInput = {}

  if (data.notifyOnPaid !== undefined) writeData.notifyOnPaid = data.notifyOnPaid
  if (data.customerNotesEnabled !== undefined) writeData.customerNotesEnabled = data.customerNotesEnabled
  if (data.merchantPolicies !== undefined) writeData.merchantPolicies = data.merchantPolicies
  if (data.defaultTippingConfig !== undefined) {
    writeData.defaultTippingConfig =
      data.defaultTippingConfig === null ? Prisma.JsonNull : (data.defaultTippingConfig as unknown as Prisma.InputJsonValue)
  }
  if (data.defaultCustomFields !== undefined) {
    writeData.defaultCustomFields =
      data.defaultCustomFields === null ? Prisma.JsonNull : (data.defaultCustomFields as unknown as Prisma.InputJsonValue)
  }

  const row = await prisma.venuePaymentLinkSettings.upsert({
    where: { venueId },
    update: writeData,
    create: {
      venueId,
      notifyOnPaid: data.notifyOnPaid ?? DEFAULT_SETTINGS.notifyOnPaid,
      customerNotesEnabled: data.customerNotesEnabled ?? DEFAULT_SETTINGS.customerNotesEnabled,
      merchantPolicies: data.merchantPolicies ?? null,
      defaultTippingConfig:
        data.defaultTippingConfig != null ? (data.defaultTippingConfig as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      defaultCustomFields:
        data.defaultCustomFields != null ? (data.defaultCustomFields as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
    },
  })

  return {
    notifyOnPaid: row.notifyOnPaid,
    defaultTippingConfig: (row.defaultTippingConfig as unknown as TippingConfig | null) ?? null,
    defaultCustomFields: (row.defaultCustomFields as unknown as CustomFieldDefinition[] | null) ?? null,
    customerNotesEnabled: row.customerNotesEnabled,
    merchantPolicies: row.merchantPolicies,
  }
}
