/**
 * PlatformSettings service — singleton global config.
 *
 * Single source of truth for Avoqado-wide knobs. Today: only the default
 * ecommerce platform fee (applied to newly-created EcommerceMerchant rows).
 *
 * Always operates on the fixed singleton row id = 'default'. Helpers ensure
 * the row exists (idempotent upsert) so callers never have to handle missing-
 * row cases.
 *
 * @module services/superadmin/platformSettings
 */

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { Prisma } from '@prisma/client'

const SINGLETON_ID = 'default'

export async function getPlatformSettings() {
  const existing = await prisma.platformSettings.findUnique({ where: { id: SINGLETON_ID } })
  if (existing) return existing
  // Bootstrap (idempotent): if the migration seed didn't run, create the row.
  return prisma.platformSettings.create({ data: { id: SINGLETON_ID } })
}

/**
 * Get the default platformFeeBps for new ecommerce merchants. Always returns
 * a number (falls back to 100 = 1.00% if the row somehow can't be loaded).
 */
export async function getEcommercePlatformFeeBpsDefault(): Promise<number> {
  try {
    const settings = await getPlatformSettings()
    return settings.ecommercePlatformFeeBpsDefault
  } catch (err: any) {
    logger.warn('Failed to load PlatformSettings, falling back to 100 bps default', { error: err?.message })
    return 100
  }
}

/**
 * Get the VAT (IVA) rate applied to platform fees. 1600 bps (16%) for MX.
 * Always returns a number; falls back to 1600 if the row is unreachable so
 * we still bill correctly to MX merchants in degraded states.
 */
export async function getVatRateBps(): Promise<number> {
  try {
    const settings = await getPlatformSettings()
    return settings.vatRateBps
  } catch (err: any) {
    logger.warn('Failed to load PlatformSettings, falling back to 1600 bps (16% IVA)', { error: err?.message })
    return 1600
  }
}

export interface UpdatePlatformSettingsInput {
  ecommercePlatformFeeBpsDefault?: number
  vatRateBps?: number
}

export async function updatePlatformSettings(input: UpdatePlatformSettingsInput, updatedById?: string) {
  // Snapshot before so the audit row can diff what actually changed —
  // important because an idempotent upsert with same values isn't really an
  // edit but we want to log the genuine deltas explicitly.
  const before = await getPlatformSettings()

  // Range validation lives in the controller so callers can fail fast with a
  // typed HTTP response; the service trusts the caller for value validity.
  const updated = await prisma.platformSettings.upsert({
    where: { id: SINGLETON_ID },
    create: {
      id: SINGLETON_ID,
      ...input,
      updatedById,
    },
    update: {
      ...input,
      updatedById,
    },
  })
  logger.info('PlatformSettings updated', { input, updatedById })

  // Audit trail — record only fields that actually changed so the log is
  // useful for forensic queries ("when did the IVA rate move?").
  const changes: Record<string, { from: number; to: number }> = {}
  if (
    input.ecommercePlatformFeeBpsDefault !== undefined &&
    input.ecommercePlatformFeeBpsDefault !== before.ecommercePlatformFeeBpsDefault
  ) {
    changes.ecommercePlatformFeeBpsDefault = {
      from: before.ecommercePlatformFeeBpsDefault,
      to: input.ecommercePlatformFeeBpsDefault,
    }
  }
  if (input.vatRateBps !== undefined && input.vatRateBps !== before.vatRateBps) {
    changes.vatRateBps = { from: before.vatRateBps, to: input.vatRateBps }
  }

  if (Object.keys(changes).length > 0) {
    logAction({
      staffId: updatedById,
      action: 'PLATFORM_SETTINGS_UPDATED',
      entity: 'PlatformSettings',
      entityId: SINGLETON_ID,
      data: { changes } as Prisma.InputJsonValue,
    })
  }

  return updated
}
