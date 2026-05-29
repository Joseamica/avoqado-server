import { NextFunction, Request, Response } from 'express'

import { Prisma } from '@prisma/client'
import { getEffectivePaymentConfig } from '@/services/organization-payment-config.service'
import { computeOverrides, getOrgDefaultsForTerminal } from '@/services/dashboard/tpv.dashboard.service'
import { isProviderCompatibleWithBrand } from '@/lib/providerDeviceCompatibility'
import { decryptCredentials } from '@/services/superadmin/merchantAccount.service'
import { getAngelPayUserAccountForTerminal, getAngelPayUserAccountsForTerminal } from '@/services/superadmin/angelpayUserAccount.service'
import { moduleService, MODULE_CODES } from '@/services/modules/module.service'
import prisma from '@/utils/prismaClient'
import logger from '../../config/logger'
import { NotFoundError } from '../../errors/AppError'

/**
 * Terminal TPV Controller
 *
 * REST API endpoints for terminal configuration and merchant assignment retrieval.
 * Used by Android TPV app to fetch dynamic configuration on startup.
 */

/**
 * TPV Settings interface - Per-terminal configuration for payment flow
 */
interface TpvSettings {
  showReviewScreen: boolean
  showTipScreen: boolean
  showReceiptScreen: boolean
  defaultTipPercentage: number | null
  tipSuggestions: number[]
  requirePinLogin: boolean
  // Step 4: Sale Verification (for retail/telecomunicaciones venues)
  showVerificationScreen: boolean
  requireVerificationPhoto: boolean
  requireVerificationBarcode: boolean
  // Venue-level settings (from VenueSettings)
  enableShifts: boolean
  // Clock-in/out photo verification (anti-fraud, per-terminal settings from Terminal.config)
  requireClockInPhoto: boolean
  requireClockOutPhoto: boolean
  // Additional attendance evidence photos
  requireFacadePhoto: boolean // Panoramic store front photo at clock-in
  requireDepositPhoto: boolean // Bank deposit voucher photo at clock-out
  requireClockInToLogin: boolean
  // Kiosk Mode (self-service terminal mode)
  kioskModeEnabled: boolean
  kioskDefaultMerchantId: string | null
  // Home screen button visibility (controlled from dashboard)
  showQuickPayment: boolean // Show "Pago rápido" button on home screen
  showOrderManagement: boolean // Show "Órdenes" button on home screen
  showMessages: boolean // Show "Mensajes" button on home screen
  showTrainings: boolean // Show "Entrenamientos" button on home screen
  showCheckout: boolean // Show "Cobro" button on home screen
  // Crypto payment option (B4Bit integration)
  showCryptoOption: boolean
  // Cellular Failover (experimental — ConnectionViewModel reads these exact names)
  cellularFailoverMode: 'OFF' | 'MANUAL_TOGGLE' | 'AUTO_SHADOW' | 'AUTO_ENFORCED'
  cellularFailoverBadReadingsThreshold: number
  cellularFailoverCooldownSeconds: number
  cellularFailoverMinCellHoldSeconds: number
  // Card payment server-decoupling kill-switch.
  // true (default) = require api.avoqado.io reachable before allowing a card charge (legacy behavior).
  // false = allow the (always-online-to-Momentum) charge even when our backend heartbeat is down;
  //         recording falls to the TPV offline queue. Scoped on-device to orderId == null.
  requireAvoqadoServerForCardPayment: boolean
}

/**
 * Default TPV settings - Applied when no custom settings exist
 */
const DEFAULT_TPV_SETTINGS: TpvSettings = {
  showReviewScreen: true,
  showTipScreen: true,
  showReceiptScreen: true,
  defaultTipPercentage: null,
  tipSuggestions: [10, 15, 20],
  requirePinLogin: false,
  // Step 4: Verification disabled by default (only for retail/telecomunicaciones)
  showVerificationScreen: false,
  requireVerificationPhoto: false,
  requireVerificationBarcode: false,
  // Shift system enabled by default (can be disabled per-venue)
  enableShifts: true,
  // Clock-in/out photo disabled by default (anti-fraud feature, per-terminal)
  requireClockInPhoto: false,
  requireClockOutPhoto: false,
  // Additional attendance evidence photos disabled by default
  requireFacadePhoto: false,
  requireDepositPhoto: false,
  requireClockInToLogin: false,
  // Kiosk Mode disabled by default
  kioskModeEnabled: false,
  kioskDefaultMerchantId: null,
  // Home screen buttons enabled by default
  showQuickPayment: true,
  showOrderManagement: true,
  showMessages: true,
  showTrainings: true,
  showCheckout: true,
  // Crypto payment disabled by default
  showCryptoOption: false,
  // Cellular Failover — safe defaults: OFF, threshold 3, cooldown 60s, hold 120s
  cellularFailoverMode: 'OFF',
  cellularFailoverBadReadingsThreshold: 3,
  cellularFailoverCooldownSeconds: 60,
  cellularFailoverMinCellHoldSeconds: 120,
  // Card auth requires our backend by default (legacy behavior — no change until flipped per-venue).
  requireAvoqadoServerForCardPayment: true,
}

/**
 * Extract TPV settings from terminal config JSON
 * Merges saved settings with defaults for missing fields
 */
function getTpvSettingsFromConfig(config: unknown): TpvSettings {
  const savedSettings = (config as any)?.settings || {}
  return {
    ...DEFAULT_TPV_SETTINGS,
    ...savedSettings,
  }
}

/**
 * GET /api/v1/tpv/terminals/:serialNumber/config
 * Fetch terminal configuration with assigned merchant accounts
 *
 * **Business Use Case:**
 * Android TPV app calls this endpoint on startup to dynamically fetch:
 * - Terminal configuration (brand, model, serial)
 * - Assigned merchant accounts (for multi-merchant support)
 * - Blumon credentials for each merchant account
 *
 * **Flow:**
 * ```
 * Android App Startup
 *   ↓
 * GET /tpv/terminals/2841548417/config
 *   ↓
 * Backend returns terminal + merchant accounts
 *   ↓
 * Android stores in TerminalConfig object
 *   ↓
 * User can switch between merchants in payment screen
 * ```
 *
 * **Response:**
 * ```json
 * {
 *   "success": true,
 *   "data": {
 *     "terminal": {
 *       "id": "term_xxxxx",
 *       "serialNumber": "2841548417",
 *       "brand": "PAX",
 *       "model": "A910S",
 *       "status": "ACTIVE",
 *       "venueId": "venue_xxxxx",
 *       "venue": {
 *         "id": "venue_xxxxx",
 *         "name": "Restaurant Name"
 *       }
 *     },
 *     "merchantAccounts": [
 *       {
 *         "id": "ma_xxxxx",
 *         "displayName": "Main Account",
 *         "serialNumber": "2841548417",
 *         "posId": "376",
 *         "environment": "SANDBOX",
 *         "credentials": {...}
 *       }
 *     ],
 *     "tpvSettings": {
 *       "showReviewScreen": true,
 *       "showTipScreen": true,
 *       "showReceiptScreen": true,
 *       "defaultTipPercentage": null,
 *       "tipSuggestions": [15, 18, 20, 25],
 *       "requirePinLogin": false
 *     }
 *   }
 * }
 * ```
 *
 * **Security:**
 * - No authentication required (terminal needs config before login)
 * - Credentials are encrypted in database
 * - Only returns merchant accounts explicitly assigned to this terminal
 *
 * @param req.params.serialNumber - Terminal serial number (e.g., "2841548417")
 */
export async function getTerminalConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { serialNumber } = req.params

    logger.info('[Terminal Config] Fetching config for terminal', {
      serialNumber,
    })

    // Step 1: Find terminal by serial number
    const terminal = await prisma.terminal.findFirst({
      where: {
        serialNumber: serialNumber,
      },
      include: {
        venue: {
          select: {
            id: true,
            name: true,
            type: true,
            timezone: true,
          },
        },
      },
    })

    if (!terminal) {
      throw new NotFoundError(`Terminal not found with serial number: ${serialNumber}`)
    }

    logger.debug('[Terminal Config] Terminal found', {
      terminalId: terminal.id,
      serialNumber: terminal.serialNumber,
      venueId: terminal.venueId,
      assignedMerchantCount: terminal.assignedMerchantIds.length,
    })

    // Step 2: Fetch merchant accounts — use assignedMerchantIds if populated,
    // otherwise fall back to effective payment config (org→venue inheritance)
    const merchantSelect = {
      id: true,
      displayName: true,
      active: true,
      blumonSerialNumber: true,
      blumonPosId: true,
      blumonEnvironment: true,
      blumonMerchantId: true,
      credentialsEncrypted: true,
      providerConfig: true,
      // Task 13 / spec §6.4 — DTO extension (additive)
      externalMerchantId: true,
      angelpayAffiliation: true,
      angelpayMerchantName: true,
      // Multi-AngelPay per venue (2026-05-18) — links merchant to the
      // AngelPay user account it was discovered under. TPV uses this to
      // call `switchAccount(accountId)` when the cashier picks a merchant
      // owned by a different AngelPay login than the SDK currently has
      // authenticated. Null for legacy/un-backfilled rows.
      angelpayUserAccountId: true,
      // Eager-load the email so the TPV picker can disambiguate when two
      // MerchantAccount rows share the same `externalMerchantId` because two
      // AngelPayUserAccounts can both route to the same physical merchant
      // (e.g. ventas@avoqado.io + contacto@avoqado.io both have merchant 61
      // — without the email suffix the picker would show "Avoqado" twice
      // identically and the cashier couldn't tell which account they're
      // routing through). Multi-AngelPay accounts per venue (2026-05-19).
      angelpayUserAccount: { select: { email: true } },
      provider: { select: { code: true } }, // Include provider code for multi-processor routing
    }

    let merchantAccounts: any[]

    if (terminal.assignedMerchantIds.length > 0) {
      // Terminal has explicit assignments — use them (managed by wizard reconciliation)
      merchantAccounts = await prisma.merchantAccount.findMany({
        where: {
          id: { in: terminal.assignedMerchantIds },
          active: true,
        },
        select: merchantSelect,
      })
    } else {
      // No explicit assignments — fall back to venue/org inheritance
      const effective = await getEffectivePaymentConfig(terminal.venueId)
      if (effective) {
        const { config } = effective
        const accountIds = [config.primaryAccount?.id, config.secondaryAccount?.id, config.tertiaryAccount?.id].filter(Boolean) as string[]

        merchantAccounts =
          accountIds.length > 0
            ? await prisma.merchantAccount.findMany({
                where: { id: { in: accountIds }, active: true },
                select: merchantSelect,
              })
            : []

        logger.info('[Terminal Config] Used inheritance fallback for merchant accounts', {
          terminalId: terminal.id,
          venueId: terminal.venueId,
          source: effective.source,
          resolvedCount: merchantAccounts.length,
        })
      } else {
        merchantAccounts = []
        logger.warn('[Terminal Config] No merchant accounts: terminal has no assignments and no payment config', {
          terminalId: terminal.id,
          venueId: terminal.venueId,
        })
      }
    }

    logger.debug('[Terminal Config] Merchant accounts fetched', {
      count: merchantAccounts.length,
      accounts: merchantAccounts.map((ma: any) => ({
        id: ma.id,
        displayName: ma.displayName,
        blumonSerialNumber: ma.blumonSerialNumber,
      })),
    })

    // Task 13 / spec §4.4 — validation point #4 (runtime gate / defense in depth).
    // Filter merchants[] to only providers compatible with terminal.brand. Even if
    // validation points #1–#3 were bypassed by legacy/imported data, the TPV must
    // never receive a merchant assignment its hardware cannot route.
    const compatibleMerchants = merchantAccounts.filter((ma: any) =>
      isProviderCompatibleWithBrand(ma.provider?.code || 'BLUMON', terminal.brand),
    )

    if (compatibleMerchants.length !== merchantAccounts.length) {
      logger.warn('[Terminal Config] Filtered incompatible merchants for terminal brand', {
        terminalId: terminal.id,
        brand: terminal.brand,
        beforeCount: merchantAccounts.length,
        afterCount: compatibleMerchants.length,
        droppedIds: merchantAccounts
          .filter((ma: any) => !compatibleMerchants.find((c: any) => c.id === ma.id))
          .map((ma: any) => ({ id: ma.id, provider: ma.provider?.code })),
      })
    }

    // Multi-AngelPay accounts per venue (2026-05-19): when two MerchantAccount
    // rows share the same `externalMerchantId` (because the same AngelPay
    // merchant is exposed under multiple AngelPay logins), the TPV picker
    // would render identical "Avoqado" buttons and the cashier couldn't tell
    // them apart. Detect dupes here and append the AngelPay account email to
    // the `displayName` ONLY for the dupes — single-account rows keep their
    // clean label. Counts based on `externalMerchantId` so Blumon rows
    // (which have unique externalMerchantIds per affiliation) are never
    // suffixed.
    const externalIdCounts = compatibleMerchants.reduce((acc: Record<string, number>, ma: any) => {
      const key = ma.externalMerchantId ?? ''
      acc[key] = (acc[key] || 0) + 1
      return acc
    }, {})

    // Step 3: Transform merchant accounts for Android response (spec §6.4 — additive DTO)
    const transformedMerchants = compatibleMerchants.map((ma: any) => {
      const accountEmail = ma.angelpayUserAccount?.email as string | undefined
      const needsDisambiguation =
        ma.provider?.code === 'ANGELPAY' && accountEmail && (externalIdCounts[ma.externalMerchantId ?? ''] || 0) > 1
      const displayName = needsDisambiguation ? `${ma.displayName} (${accountEmail})` : ma.displayName

      return {
        id: ma.id,
        displayName,
        providerCode: ma.provider?.code || 'BLUMON', // BLUMON, ANGELPAY, MENTA, etc.
        serialNumber: ma.blumonSerialNumber,
        posId: ma.blumonPosId,
        environment: ma.blumonEnvironment,
        merchantId: ma.blumonMerchantId,
        credentials: ma.credentialsEncrypted, // Encrypted - Android will decrypt
        providerConfig: ma.providerConfig,
        // Task 13 / spec §6.4 — additive fields for AngelPay + provider-agnostic UI
        externalMerchantId: ma.externalMerchantId,
        isActive: ma.active,
        angelpayAffiliation: ma.angelpayAffiliation,
        angelpayMerchantName: ma.angelpayMerchantName,
        // Multi-AngelPay per venue (2026-05-18). Lets the TPV switch to the
        // correct AngelPay user account when this merchant is selected.
        angelpayUserAccountId: ma.angelpayUserAccountId ?? null,
      }
    })

    // Step 4: Extract TPV settings from terminal config
    const terminalTpvSettings = getTpvSettingsFromConfig(terminal.config)

    // Step 5: Fetch venue-level settings from VenueSettings (only enableShifts is venue-level)
    const venueSettings = await prisma.venueSettings.findUnique({
      where: { venueId: terminal.venueId },
      select: {
        enableShifts: true,
      },
    })

    // Merge terminal settings with venue-level settings
    // Note: requireClockInPhoto/requireClockOutPhoto are terminal-level settings (from Terminal.config)
    const tpvSettings: TpvSettings = {
      ...terminalTpvSettings,
      enableShifts: venueSettings?.enableShifts ?? DEFAULT_TPV_SETTINGS.enableShifts,
      // Card payment server-decoupling kill-switch: PER-TERMINAL (Terminal.config.settings),
      // default true (legacy). getTpvSettingsFromConfig already merges saved settings over
      // DEFAULT_TPV_SETTINGS, so this is the terminal's configured value when present, else true.
      requireAvoqadoServerForCardPayment: terminalTpvSettings.requireAvoqadoServerForCardPayment,
      // requireClockInPhoto and requireClockOutPhoto come from terminalTpvSettings (Terminal.config)
    }

    // Serialized-inventory venues operate without shifts (SIM kiosks have no cash-drawer
    // reconciliation). Force shifts OFF when the module is active, regardless of VenueSettings.
    const serializedInventoryActive = await moduleService.isModuleEnabled(terminal.venueId, MODULE_CODES.SERIALIZED_INVENTORY)
    if (serializedInventoryActive) {
      tpvSettings.enableShifts = false
      // SIM kiosks sell exclusively through the "Vender" (serialized sale) flow.
      // The generic restaurant/retail entry points (Pago rápido, Cobrar, Órdenes)
      // must NEVER appear here — they let an operator create empty $0 orders with
      // no SIM, polluting the org "Ventas" list. Defense-in-depth: even if the
      // TPV's simplified-mode gating doesn't kick in (e.g. module config not yet
      // loaded at home-screen render), forcing these OFF server-side guarantees
      // the buttons never show on a serialized-inventory venue.
      tpvSettings.showCheckout = false
      tpvSettings.showQuickPayment = false
      tpvSettings.showOrderManagement = false
    }

    // Task 13 / spec §4.5 + §4.5b — angelpayAuth payload.
    // ONLY emitted when terminal.brand === 'NEXGO' AND the venue has an ACTIVE
    // AngelPayUserAccount. PIN is decrypted server-side and travels over TLS
    // only to a terminal-token-authenticated endpoint. The TPV must never
    // persist or log the plaintext PIN (see spec §4.5b PIN handling rules).
    //
    // Multi-account (2026-05-18): we now ALSO emit `angelpayAccounts` (list)
    // with EVERY ACTIVE account so the TPV can `switchAccount(accountId)` when
    // the cashier picks a merchant owned by a different login than the SDK
    // currently has authenticated. The single `angelpayAuth` field is preserved
    // for backward compat — populated with the FIRST account.
    type AngelPayAuthPayload = {
      accountId: string
      email: string
      pin: string
      environment: string
    }
    let angelpayAuth: AngelPayAuthPayload | null = null
    let angelpayAccounts: AngelPayAuthPayload[] = []

    if (terminal.brand === 'NEXGO') {
      try {
        const accounts = await getAngelPayUserAccountsForTerminal(serialNumber)
        for (const account of accounts) {
          // Plaintext `pin` is the source of truth; fall back to decrypting the
          // legacy `pinEncrypted` for rows created before the plaintext switch.
          if (account.status === 'ACTIVE' && (account.pin || account.pinEncrypted)) {
            const payload: AngelPayAuthPayload = {
              accountId: account.id,
              email: account.email,
              pin: account.pin ?? (decryptCredentials(account.pinEncrypted) as string),
              environment: account.environment,
            }
            angelpayAccounts.push(payload)
          } else {
            logger.info('[Terminal Config] Skipping non-ACTIVE AngelPay account in payload', {
              terminalId: terminal.id,
              accountId: account.id,
              status: account.status,
            })
          }
        }
        // Single-account backward-compat field: first ACTIVE wins. Falls back to
        // the legacy single-account helper only if the multi-account list is
        // empty AND the legacy helper finds a row (shouldn't happen — the
        // multi-account helper supersedes — but keeps the contract stable).
        if (angelpayAccounts.length > 0) {
          angelpayAuth = angelpayAccounts[0]
          logger.info('[Terminal Config] Attached angelpayAuth payload(s)', {
            terminalId: terminal.id,
            accountCount: angelpayAccounts.length,
            primaryAccountId: angelpayAuth.accountId,
            environment: angelpayAuth.environment,
          })
        } else {
          // Fallback to legacy single-fetch path in case multi-fetch returns
          // nothing but the legacy fetch still finds something (defensive).
          const legacyAccount = await getAngelPayUserAccountForTerminal(serialNumber)
          if (legacyAccount && legacyAccount.status === 'ACTIVE' && (legacyAccount.pin || legacyAccount.pinEncrypted)) {
            angelpayAuth = {
              accountId: legacyAccount.id,
              email: legacyAccount.email,
              pin: legacyAccount.pin ?? (decryptCredentials(legacyAccount.pinEncrypted) as string),
              environment: legacyAccount.environment,
            }
            angelpayAccounts = [angelpayAuth]
          }
        }
      } catch (err) {
        // Never break terminal config fetch on AngelPay payload failure — the
        // TPV will simply lack credentials and fall back to its existing error
        // surface. Logged for ops investigation.
        logger.error('[Terminal Config] Failed to build angelpayAuth payload', {
          terminalId: terminal.id,
          serialNumber: terminal.serialNumber,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    logger.info('[Terminal Config] Successfully fetched config', {
      terminalId: terminal.id,
      serialNumber: terminal.serialNumber,
      merchantCount: transformedMerchants.length,
      angelpayAuthAttached: angelpayAuth !== null,
      angelpayAccountsCount: angelpayAccounts.length,
      tpvSettings,
    })

    res.status(200).json({
      success: true,
      data: {
        terminal: {
          id: terminal.id,
          serialNumber: terminal.serialNumber,
          brand: terminal.brand,
          model: terminal.model,
          status: terminal.status,
          venueId: terminal.venueId,
          venue: terminal.venue,
        },
        merchantAccounts: transformedMerchants,
        tpvSettings, // Per-terminal payment flow configuration
        angelpayAuth, // Task 13 / spec §4.5 — optional single-account back-compat; null unless terminal is NEXGO with ACTIVE account
        // Multi-account (2026-05-18) — full list of ACTIVE AngelPay user accounts
        // for the venue. Always present (possibly empty []) when the terminal
        // is NEXGO; omitted entirely on non-NEXGO terminals.
        angelpayAccounts: terminal.brand === 'NEXGO' ? angelpayAccounts : undefined,
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/v1/tpv/terminals/:serialNumber/settings
 * Update TPV settings for a specific terminal
 *
 * **Business Use Case:**
 * Android TPV app calls this endpoint to update payment flow settings.
 * Each terminal can have individual settings (different from other terminals in the same venue).
 *
 * **Request Body:**
 * ```json
 * {
 *   "showReviewScreen": true,
 *   "showTipScreen": false,
 *   "showReceiptScreen": true,
 *   "defaultTipPercentage": 15,
 *   "tipSuggestions": [15, 18, 20, 25],
 *   "requirePinLogin": false
 * }
 * ```
 *
 * **Response:**
 * ```json
 * {
 *   "success": true,
 *   "data": {
 *     "showReviewScreen": true,
 *     "showTipScreen": false,
 *     ...
 *   }
 * }
 * ```
 *
 * **Security:**
 * - Requires TPV JWT authentication
 * - Only updates settings for the specified terminal
 *
 * @param req.params.serialNumber - Terminal serial number
 * @param req.body - Partial TpvSettings to update
 */
export async function updateTpvSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const { serialNumber } = req.params
    const settingsUpdate = req.body

    logger.info('[TPV Settings] Updating settings for terminal', {
      serialNumber,
      settingsUpdate,
    })

    // Step 1: Find terminal by serial number (include venue → org for cascade)
    const terminal = await prisma.terminal.findFirst({
      where: { serialNumber },
      select: { id: true, config: true, configOverrides: true, venueId: true, venue: { select: { organizationId: true } } },
    })

    if (!terminal) {
      throw new NotFoundError(`Terminal not found with serial number: ${serialNumber}`)
    }

    // Step 2: Get org defaults for cascade comparison
    const orgDefaults = await getOrgDefaultsForTerminal(terminal.venue.organizationId)
    const baseSettings = { ...DEFAULT_TPV_SETTINGS, ...orgDefaults }

    // Step 3: Get current settings and merge with update
    const existingConfig = (terminal.config as any) || {}
    const currentSettings = { ...DEFAULT_TPV_SETTINGS, ...(existingConfig.settings || {}) }
    const newSettings: TpvSettings = { ...currentSettings, ...settingsUpdate }

    // Step 4: Compute overrides (diff vs org defaults)
    const overrides = computeOverrides(newSettings, baseSettings)

    // Step 5: Save full merged config.settings (TPV Android compat) + configOverrides (diff only)
    await prisma.terminal.update({
      where: { id: terminal.id },
      data: {
        config: { ...existingConfig, settings: newSettings },
        configOverrides: Object.keys(overrides).length > 0 ? overrides : Prisma.JsonNull,
        updatedAt: new Date(),
      },
    })

    // Step 6: If enableShifts was passed, update VenueSettings (venue-level setting)
    if (settingsUpdate.enableShifts !== undefined) {
      await prisma.venueSettings.upsert({
        where: { venueId: terminal.venueId },
        update: { enableShifts: settingsUpdate.enableShifts },
        create: {
          venueId: terminal.venueId,
          enableShifts: settingsUpdate.enableShifts,
        },
      })
      logger.info('[TPV Settings] VenueSettings.enableShifts updated', {
        venueId: terminal.venueId,
        enableShifts: settingsUpdate.enableShifts,
      })
    }

    logger.info('[TPV Settings] Settings updated successfully', {
      serialNumber,
      settings: newSettings,
    })

    res.status(200).json({
      success: true,
      data: newSettings,
    })
  } catch (error) {
    next(error)
  }
}
