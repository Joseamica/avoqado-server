import { Request, Response, NextFunction } from 'express'
import * as merchantAccountService from '../../services/superadmin/merchantAccount.service'
import logger from '../../config/logger'
import { BadRequestError } from '../../errors/AppError'
import { blumonApiService } from '../../services/blumon/blumonApi.service'
import type { BlumonEnvironment } from '../../services/blumon/types'
import { createBlumonTpvService } from '../../services/tpv/blumon-tpv.service'
import prisma from '@/utils/prismaClient'

/**
 * MerchantAccount Controller
 *
 * REST API endpoints for managing merchant accounts with encrypted credentials.
 * All endpoints require SUPERADMIN role (enforced by parent router middleware).
 */

/**
 * GET /api/v1/superadmin/merchant-accounts
 * Get all merchant accounts with optional filters
 */
export async function getMerchantAccounts(req: Request, res: Response, next: NextFunction) {
  try {
    const { providerId, active } = req.query

    const filters: any = {}

    if (providerId) {
      filters.providerId = providerId as string
    }

    if (active !== undefined) {
      filters.active = active === 'true'
    }

    const accounts = await merchantAccountService.getMerchantAccounts(filters)

    res.json({
      success: true,
      data: accounts,
      count: accounts.length,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/merchant-accounts/:id
 * Get a single merchant account by ID
 */
export async function getMerchantAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { includeCredentials } = req.query

    // Only decrypt credentials if explicitly requested
    const shouldIncludeCredentials = includeCredentials === 'true'

    const account = await merchantAccountService.getMerchantAccount(id, shouldIncludeCredentials)

    res.json({
      success: true,
      data: account,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/merchant-accounts/:id/credentials
 * Get decrypted credentials for a merchant account
 * SECURITY: Only use this endpoint when needed for payment processing setup
 */
export async function getMerchantAccountCredentials(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const credentials = await merchantAccountService.getDecryptedCredentials(id)

    logger.warn('Merchant account credentials accessed', {
      accountId: id,
      requestedBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      data: credentials,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/superadmin/merchant-accounts
 * Create a new merchant account
 */
export async function createMerchantAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { providerId, externalMerchantId, alias, displayName, active, displayOrder, credentials, providerConfig } = req.body

    // Validate required fields
    if (!providerId) {
      throw new BadRequestError('providerId is required')
    }

    if (!externalMerchantId) {
      throw new BadRequestError('externalMerchantId is required')
    }

    if (!credentials || typeof credentials !== 'object') {
      throw new BadRequestError('credentials object is required')
    }

    if (!credentials.merchantId || !credentials.apiKey) {
      throw new BadRequestError('credentials must include merchantId and apiKey')
    }

    const account = await merchantAccountService.createMerchantAccount({
      providerId,
      externalMerchantId,
      alias,
      displayName,
      active,
      displayOrder,
      credentials,
      providerConfig,
    })

    logger.info('Merchant account created via API', {
      accountId: account.id,
      createdBy: (req as any).user?.uid,
    })

    res.status(201).json({
      success: true,
      data: account,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/v1/superadmin/merchant-accounts/:id
 * Update a merchant account
 */
export async function updateMerchantAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { externalMerchantId, alias, displayName, active, displayOrder, credentials, providerConfig } = req.body

    const account = await merchantAccountService.updateMerchantAccount(id, {
      externalMerchantId,
      alias,
      displayName,
      active,
      displayOrder,
      credentials,
      providerConfig,
    })

    logger.info('Merchant account updated via API', {
      accountId: id,
      updatedBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      data: account,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PATCH /api/v1/superadmin/merchant-accounts/:id/toggle
 * Toggle merchant account active status
 */
export async function toggleMerchantAccountStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const account = await merchantAccountService.toggleMerchantAccountStatus(id)

    logger.info('Merchant account status toggled via API', {
      accountId: id,
      newStatus: account.active,
      toggledBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      data: account,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/superadmin/merchant-accounts/:id
 * Delete a merchant account
 * Only allowed if no cost structures or venue configs reference it
 */
export async function deleteMerchantAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    await merchantAccountService.deleteMerchantAccount(id)

    logger.warn('Merchant account deleted via API', {
      accountId: id,
      deletedBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      message: 'Merchant account deleted successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/merchant-accounts/:id/terminals
 * Get terminals that have this merchant account assigned
 */
export async function getTerminalsByMerchantAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const terminals = await merchantAccountService.getTerminalsByMerchantAccount(id)

    res.json({
      success: true,
      data: terminals,
      count: terminals.length,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/superadmin/merchant-accounts/:id/terminals/:terminalId
 * Remove merchant account from a terminal's assignedMerchantIds
 */
export async function removeMerchantFromTerminal(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, terminalId } = req.params

    await merchantAccountService.removeMerchantFromTerminal(terminalId, id)

    logger.info('Merchant account removed from terminal via API', {
      merchantAccountId: id,
      terminalId,
      removedBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      message: 'Merchant account removed from terminal',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/superadmin/merchant-accounts/blumon/register
 * Register a new Blumon merchant account with auto-config from Blumon API
 *
 * **Workflow:**
 * 1. Validate serial number with Blumon API
 * 2. Fetch terminal config (posId, merchantId, credentials)
 * 3. Create MerchantAccount with Blumon-specific fields
 * 4. Create default pricing structures (provider cost + venue pricing)
 * 5. Return merchant account with all config
 *
 * **Body:**
 * ```json
 * {
 *   "venueId": "venue_xxx",
 *   "serialNumber": "2841548417",
 *   "environment": "SANDBOX",  // or "PRODUCTION"
 *   "displayName": "Cuenta Principal"  // Optional
 * }
 * ```
 *
 * **Response:**
 * ```json
 * {
 *   "success": true,
 *   "data": {
 *     "merchantAccount": { ... },
 *     "autoConfigured": true,
 *     "blumonData": {
 *       "posId": "376",
 *       "merchantId": "blumon_merchant_xxx"
 *     }
 *   }
 * }
 * ```
 */
export async function registerBlumonMerchant(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, serialNumber, environment, displayName } = req.body

    // Validate required fields
    if (!venueId) {
      throw new BadRequestError('venueId is required')
    }

    if (!serialNumber) {
      throw new BadRequestError('serialNumber is required')
    }

    if (!environment || !['SANDBOX', 'PRODUCTION'].includes(environment)) {
      throw new BadRequestError('environment must be SANDBOX or PRODUCTION')
    }

    const blumonEnv = environment as BlumonEnvironment

    logger.info('[Blumon Registration] Starting registration', {
      venueId,
      serialNumber,
      environment: blumonEnv,
    })

    // Step 1: Validate serial number with Blumon API
    logger.info('[Blumon Registration] Step 1: Validating serial with Blumon API...')
    const validation = await blumonApiService.validateSerial(serialNumber, blumonEnv)

    if (!validation.valid) {
      logger.warn('[Blumon Registration] Serial validation failed', {
        serialNumber,
        errors: validation.errors,
      })

      throw new BadRequestError(validation.message || 'Serial number is invalid or inactive')
    }

    // Step 2: Fetch terminal config from Blumon API
    logger.info('[Blumon Registration] Step 2: Fetching terminal config from Blumon API...')
    const terminalConfig = await blumonApiService.getTerminalConfig(serialNumber, blumonEnv)

    logger.info('[Blumon Registration] Config fetched successfully', {
      posId: terminalConfig.posId,
      merchantId: terminalConfig.merchantId,
      status: terminalConfig.status,
    })

    // Step 3: Fetch pricing structure from Blumon
    logger.info('[Blumon Registration] Step 3: Fetching pricing structure...')
    const blumonPricing = await blumonApiService.getPricingStructure(terminalConfig.merchantId, blumonEnv)

    // Step 4: Create merchant account with auto-fetched config
    logger.info('[Blumon Registration] Step 4: Creating merchant account in database...')

    // TODO: Get or create Blumon PaymentProvider
    // For now, assume BLUMON provider exists in database
    // If not, this will fail - superadmin needs to create provider first

    const merchantAccountData = {
      providerId: 'BLUMON', // TODO: Fetch actual providerId from database
      externalMerchantId: terminalConfig.merchantId,
      displayName: displayName || `Blumon - ${serialNumber}`,
      active: terminalConfig.status === 'ACTIVE',
      displayOrder: 0,

      // Blumon-specific fields
      blumonSerialNumber: serialNumber,
      blumonPosId: terminalConfig.posId,
      blumonEnvironment: blumonEnv,
      blumonMerchantId: terminalConfig.merchantId,

      // Credentials (encrypted)
      credentials: terminalConfig.credentials || {},

      // Provider config
      providerConfig: {
        brand: terminalConfig.brand,
        model: terminalConfig.model,
        status: terminalConfig.status,
      },

      // Bank account info (optional, can be added later)
      clabeNumber: null,
      bankName: null,
      accountHolder: null,
    }

    // Call existing service to create merchant account
    // This handles encryption and validation
    const merchantAccount = await merchantAccountService.createMerchantAccount(merchantAccountData)

    // Step 5: Create provider cost structure
    logger.info('[Blumon Registration] Step 5: Creating pricing structures...')

    // TODO: Create ProviderCostStructure and VenuePricingStructure
    // using blumonPricing data with Avoqado's margin

    // For now, log the pricing data
    logger.info('[Blumon Registration] Blumon pricing structure:', blumonPricing)

    logger.info('[Blumon Registration] Registration completed successfully', {
      merchantAccountId: merchantAccount.id,
      serialNumber,
      posId: terminalConfig.posId,
    })

    res.status(201).json({
      success: true,
      data: {
        merchantAccount,
        autoConfigured: true,
        blumonData: {
          posId: terminalConfig.posId,
          merchantId: terminalConfig.merchantId,
          serialNumber,
          environment: blumonEnv,
        },
      },
      message: 'Blumon merchant account registered successfully with auto-configuration',
    })
  } catch (error) {
    logger.error('[Blumon Registration] Failed', {
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
    })

    next(error)
  }
}

/**
 * POST /api/v1/superadmin/merchant-accounts/blumon/auto-fetch
 * Auto-fetch Blumon merchant credentials using device OAuth flow
 *
 * **Workflow:**
 * 1. Calculate OAuth password: SHA256(serial + brand + model)
 * 2. Get OAuth token from Blumon Token Server
 * 3. Extract posId from JWT userId field
 * 4. Fetch RSA encryption keys
 * 5. Try to fetch DUKPT keys (optional - may not be initialized yet)
 * 6. Create MerchantAccount with encrypted credentials
 *
 * **Note:** DUKPT keys may not be available on first registration.
 * The Blumon SDK will automatically initialize them on the first payment.
 *
 * **Body:**
 * ```json
 * {
 *   "serialNumber": "2841548417",
 *   "brand": "PAX",
 *   "model": "A910S",
 *   "environment": "SANDBOX",  // or "PRODUCTION"
 *   "displayName": "Terminal Principal"  // Optional
 * }
 * ```
 *
 * **Response:**
 * ```json
 * {
 *   "success": true,
 *   "data": {
 *     "id": "ma_xxx",
 *     "serialNumber": "2841548417",
 *     "posId": "376",
 *     "displayName": "Terminal Principal",
 *     "blumonEnvironment": "SANDBOX",
 *     "dukptKeysAvailable": false
 *   },
 *   "message": "Blumon merchant account created successfully. DUKPT keys will be initialized automatically on first payment."
 * }
 * ```
 */
export async function autoFetchBlumonCredentials(req: Request, res: Response, next: NextFunction) {
  try {
    // Changed: venueName → businessCategory (Giro) as fallback for MCC lookup
    // skipCostStructure: Optional - if true, skip automatic cost structure creation (user will configure later)
    const { serialNumber, brand, model, displayName, environment = 'SANDBOX', businessCategory, skipCostStructure = false } = req.body

    // Validate required fields
    if (!serialNumber || typeof serialNumber !== 'string') {
      throw new BadRequestError('serialNumber is required and must be a string')
    }

    if (!brand || typeof brand !== 'string') {
      throw new BadRequestError('brand is required and must be a string (e.g., "PAX", "Verifone")')
    }

    if (!model || typeof model !== 'string') {
      throw new BadRequestError('model is required and must be a string (e.g., "A910S")')
    }

    if (environment !== 'SANDBOX' && environment !== 'PRODUCTION') {
      throw new BadRequestError('environment must be either "SANDBOX" or "PRODUCTION"')
    }

    logger.info('[Blumon Auto-Fetch] Starting credential fetch', {
      serialNumber,
      brand,
      model,
      environment,
      businessCategory,
      skipCostStructure,
    })

    // Create Blumon TPV service for specified environment
    const blumonTpvService = createBlumonTpvService(environment as 'SANDBOX' | 'PRODUCTION')

    // Auto-fetch credentials from Blumon API
    logger.info('[Blumon Auto-Fetch] Step 1: Fetching credentials from Blumon API...')
    const merchantInfo = await blumonTpvService.fetchMerchantCredentials(serialNumber, brand, model)

    logger.info('[Blumon Auto-Fetch] Step 2: Credentials fetched successfully', {
      posId: merchantInfo.posId,
      serialNumber: merchantInfo.serialNumber,
      dukptKeysAvailable: merchantInfo.dukptKeysAvailable,
    })

    // Create merchant account with encrypted credentials
    logger.info('[Blumon Auto-Fetch] Step 3: Creating merchant account in database...')

    // Fetch Blumon provider ID from database
    const blumonProvider = await prisma.paymentProvider.findUnique({
      where: { code: 'BLUMON' },
    })

    if (!blumonProvider) {
      throw new BadRequestError('Blumon payment provider not found in database. Please create it first.')
    }

    // Check if merchant account already exists for this serial number
    const externalMerchantId = `blumon_${serialNumber}`
    const existingAccount = await prisma.merchantAccount.findFirst({
      where: {
        providerId: blumonProvider.id,
        externalMerchantId,
      },
      include: {
        provider: true,
      },
    })

    if (existingAccount) {
      logger.info('[Blumon Auto-Fetch] Merchant account already exists', {
        accountId: existingAccount.id,
        serialNumber,
        displayName: existingAccount.displayName,
      })

      // Return existing account with a flag indicating it was already created
      res.status(200).json({
        success: true,
        data: {
          id: existingAccount.id,
          serialNumber: existingAccount.blumonSerialNumber,
          posId: existingAccount.blumonPosId,
          displayName: existingAccount.displayName,
          blumonEnvironment: existingAccount.blumonEnvironment,
          provider: existingAccount.provider,
          alreadyExists: true,
        },
        message: `Ya existe una cuenta merchant para este terminal (${existingAccount.displayName}). Puedes editarla si necesitas actualizar las credenciales.`,
      })
      return
    }

    const merchantAccountData = {
      providerId: blumonProvider.id,
      externalMerchantId: `blumon_${serialNumber}`,
      displayName: displayName || `Blumon ${brand} ${model} - ${serialNumber}`,
      active: true,
      displayOrder: 0,

      // Blumon-specific fields
      blumonSerialNumber: merchantInfo.serialNumber,
      blumonPosId: merchantInfo.posId,
      blumonEnvironment: environment,
      blumonMerchantId: `blumon_${serialNumber}`, // Use serial as merchant ID

      // Credentials (will be encrypted by service)
      credentials: {
        oauthAccessToken: merchantInfo.credentials.oauthAccessToken,
        oauthRefreshToken: merchantInfo.credentials.oauthRefreshToken,
        oauthExpiresAt: merchantInfo.credentials.oauthExpiresAt,
        rsaId: merchantInfo.credentials.rsaId,
        rsaKey: merchantInfo.credentials.rsaKey,
        // DUKPT keys are optional - may not be initialized yet
        ...(merchantInfo.dukptKeysAvailable && {
          dukptKsn: merchantInfo.credentials.dukptKsn,
          dukptKey: merchantInfo.credentials.dukptKey,
          dukptKeyCrc32: merchantInfo.credentials.dukptKeyCrc32,
          dukptKeyCheckValue: merchantInfo.credentials.dukptKeyCheckValue,
        }),
      },

      // Provider config
      providerConfig: {
        brand,
        model,
        environment,
        autoFetched: true,
        autoFetchedAt: new Date().toISOString(),
        dukptKeysAvailable: merchantInfo.dukptKeysAvailable,
      },

      // Bank account info (optional, can be added later)
      clabeNumber: null,
      bankName: null,
      accountHolder: null,
    }

    const merchantAccount = await merchantAccountService.createMerchantAccount(merchantAccountData)

    logger.info('[Blumon Auto-Fetch] Merchant account created successfully', {
      merchantAccountId: merchantAccount.id,
      serialNumber,
      posId: merchantInfo.posId,
      dukptKeysAvailable: merchantInfo.dukptKeysAvailable,
    })

    // Step 4: Find venue via terminal to get venueType for MCC lookup
    // PRIORITY: venue.type (from onboarding) → businessCategory (manual fallback)
    let costStructureResult: Awaited<ReturnType<typeof merchantAccountService.autoCreateProviderCostStructure>> = null
    let venueType: string | null = null

    // Try to find venue via terminal with matching serial
    const terminalWithVenue = await prisma.terminal.findFirst({
      where: {
        OR: [{ serialNumber }, { serialNumber: { endsWith: serialNumber } }, { serialNumber: { contains: serialNumber } }],
      },
      include: {
        venue: {
          select: {
            id: true,
            name: true,
            type: true,
          },
        },
      },
    })

    if (terminalWithVenue?.venue?.type) {
      venueType = terminalWithVenue.venue.type
      logger.info('[Blumon Auto-Fetch] Found venue via terminal', {
        venueId: terminalWithVenue.venue.id,
        venueName: terminalWithVenue.venue.name,
        venueType: terminalWithVenue.venue.type,
      })
    }

    // Auto-create ProviderCostStructure if we have venueType or businessCategory AND not skipped by user
    if (skipCostStructure) {
      logger.info('[Blumon Auto-Fetch] Skipping ProviderCostStructure - user requested to configure later')
    } else if (venueType || businessCategory) {
      logger.info('[Blumon Auto-Fetch] Step 4a: Creating ProviderCostStructure via MCC lookup...', {
        venueType,
        businessCategory,
        priority: venueType ? 'venueType' : 'businessCategory',
      })

      costStructureResult = await merchantAccountService.autoCreateProviderCostStructure(merchantAccount.id, blumonProvider.id, {
        venueType, // PRIORITY: from venue (onboarding)
        businessCategory: typeof businessCategory === 'string' ? businessCategory : null, // FALLBACK: manual input
      })

      if (costStructureResult) {
        logger.info('[Blumon Auto-Fetch] ProviderCostStructure created successfully', {
          costStructureId: costStructureResult.costStructure.id,
          familia: costStructureResult.mccLookup.familia,
          confidence: costStructureResult.mccLookup.confidence,
          usedSource: venueType ? 'venueType' : 'businessCategory',
        })
      }
    } else {
      logger.info('[Blumon Auto-Fetch] Skipping ProviderCostStructure - no venueType or businessCategory available')
    }

    // Step 5: Auto-attach to terminals with matching serial number
    // Note: Terminal serialNumber may have prefix (e.g., "AVQD-2841548417") while
    // Blumon returns raw serial ("2841548417"), so we search with contains/endsWith
    logger.info('[Blumon Auto-Fetch] Step 4: Looking for terminals to auto-attach...')
    const terminalsWithSerial = await prisma.terminal.findMany({
      where: {
        OR: [
          { serialNumber }, // Exact match
          { serialNumber: { endsWith: serialNumber } }, // Match suffix (e.g., "AVQD-2841548417" ends with "2841548417")
          { serialNumber: { contains: serialNumber } }, // Contains (fallback)
        ],
      },
      select: {
        id: true,
        name: true,
        serialNumber: true,
        assignedMerchantIds: true,
      },
    })

    const attachedTerminals: Array<{ id: string; name: string | null }> = []

    if (terminalsWithSerial.length > 0) {
      for (const terminal of terminalsWithSerial) {
        // Check if merchant is not already attached
        if (!terminal.assignedMerchantIds.includes(merchantAccount.id)) {
          await prisma.terminal.update({
            where: { id: terminal.id },
            data: {
              assignedMerchantIds: {
                push: merchantAccount.id,
              },
            },
          })
          attachedTerminals.push({ id: terminal.id, name: terminal.name })
          logger.info('[Blumon Auto-Fetch] Auto-attached merchant to terminal', {
            terminalId: terminal.id,
            terminalName: terminal.name,
            merchantAccountId: merchantAccount.id,
          })
        }
      }

      // Notify terminals about the new merchant (they now have it in assignedMerchantIds)
      if (attachedTerminals.length > 0) {
        await merchantAccountService.notifyAffectedTerminals(
          merchantAccount.id,
          merchantAccount.displayName || `Blumon ${serialNumber}`,
          'MERCHANT_ADDED',
          false,
        )
        logger.info(`[Blumon Auto-Fetch] Auto-attached to ${attachedTerminals.length} terminal(s)`, {
          terminalIds: attachedTerminals.map(t => t.id),
        })
      }
    } else {
      logger.info('[Blumon Auto-Fetch] No terminals found with matching serial number for auto-attach', {
        serialNumber,
      })
    }

    const baseMessage = merchantInfo.dukptKeysAvailable
      ? 'Blumon credentials fetched and merchant account created successfully'
      : 'Blumon merchant account created successfully. DUKPT keys will be initialized automatically on first payment.'

    const costStructureMessage = costStructureResult
      ? ` Provider cost structure auto-created (${costStructureResult.mccLookup.familia}, ${costStructureResult.mccLookup.confidence}% confidence).`
      : ''

    const terminalMessage = attachedTerminals.length > 0 ? ` Auto-attached to ${attachedTerminals.length} terminal(s).` : ''

    const message = baseMessage + costStructureMessage + terminalMessage

    res.status(201).json({
      success: true,
      data: {
        id: merchantAccount.id,
        serialNumber: merchantInfo.serialNumber,
        posId: merchantInfo.posId,
        displayName: merchantAccount.displayName,
        blumonEnvironment: environment,
        dukptKeysAvailable: merchantInfo.dukptKeysAvailable,
        autoAttached: {
          terminalIds: attachedTerminals.map(t => t.id),
          terminals: attachedTerminals,
          count: attachedTerminals.length,
        },
        // Include cost structure result if created
        costStructure: costStructureResult?.costStructure || null,
        mccLookup: costStructureResult?.mccLookup
          ? {
              found: costStructureResult.mccLookup.found,
              mcc: costStructureResult.mccLookup.mcc,
              familia: costStructureResult.mccLookup.familia,
              rates: costStructureResult.mccLookup.rates,
              confidence: costStructureResult.mccLookup.confidence,
            }
          : null,
      },
      message,
    })
  } catch (error: any) {
    logger.error('[Blumon Auto-Fetch] Failed', {
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
    })

    next(error)
  }
}

/**
 * GET /api/v1/superadmin/merchant-accounts/mcc-lookup
 * Get MCC rate suggestion for a business name
 *
 * Uses Blumon MCC lookup to suggest provider cost rates based on business type.
 * The frontend can show these suggested rates when creating a MerchantAccount.
 *
 * **Query Params:**
 * - businessName: The business name to lookup (required)
 *
 * **Response:**
 * ```json
 * {
 *   "success": true,
 *   "data": {
 *     "found": true,
 *     "mcc": "5812",
 *     "familia": "Restaurantes",
 *     "rates": {
 *       "credito": 1.70,
 *       "debito": 1.63,
 *       "internacional": 3.30,
 *       "amex": 3.00
 *     },
 *     "matchType": "partial_synonym",
 *     "matchedTerm": "restaurante",
 *     "confidence": 85
 *   }
 * }
 * ```
 */
export async function getMccRateSuggestion(req: Request, res: Response, next: NextFunction) {
  try {
    const { businessName } = req.query

    if (!businessName || typeof businessName !== 'string') {
      throw new BadRequestError('businessName query parameter is required')
    }

    const lookup = merchantAccountService.getMccRateSuggestion(businessName)

    logger.info('[MCC Lookup] Rate suggestion requested', {
      businessName,
      found: lookup.found,
      familia: lookup.familia,
      mcc: lookup.mcc,
      confidence: lookup.confidence,
    })

    res.json({
      success: true,
      data: {
        found: lookup.found,
        mcc: lookup.mcc,
        familia: lookup.familia,
        rates: lookup.rates,
        confidence: lookup.confidence,
        matchType: lookup.matchType,
        matchedTerm: lookup.matchedTerm,
        nota: lookup.nota,
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/superadmin/merchant-accounts/with-cost-structure
 * Create a MerchantAccount and auto-create ProviderCostStructure
 *
 * This endpoint is used when creating a merchant account for a specific venue.
 * It automatically looks up the MCC rates and creates the ProviderCostStructure.
 *
 * **MCC Lookup Priority:**
 * 1. venueType - The VenueType enum (RESTAURANT, FITNESS, etc.) - most reliable
 * 2. businessCategory - Manual business category/giro as fallback
 *
 * **Body:**
 * ```json
 * {
 *   "providerId": "blumon_provider_id",
 *   "externalMerchantId": "blumon_xxx",
 *   "displayName": "Cuenta Principal",
 *   "venueType": "RESTAURANT",  // PRIORITY: VenueType enum for MCC lookup
 *   "businessCategory": "Taquería",  // FALLBACK: Manual giro if venueType not available
 *   "credentials": { ... },
 *   ... other MerchantAccount fields
 * }
 * ```
 *
 * **Response:**
 * ```json
 * {
 *   "success": true,
 *   "data": {
 *     "merchantAccount": { ... },
 *     "costStructure": { ... },
 *     "mccLookup": {
 *       "found": true,
 *       "familia": "Restaurantes",
 *       "rates": { ... },
 *       "confidence": 85
 *     }
 *   }
 * }
 * ```
 */
export async function createMerchantAccountWithCostStructure(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      providerId,
      externalMerchantId,
      alias,
      displayName,
      active,
      displayOrder,
      credentials,
      providerConfig,
      venueType, // PRIORITY: VenueType enum for MCC lookup
      businessCategory, // FALLBACK: Manual giro
      blumonSerialNumber,
      blumonPosId,
      blumonEnvironment,
      blumonMerchantId,
      clabeNumber,
      bankName,
      accountHolder,
    } = req.body

    // Validate required fields
    if (!providerId) {
      throw new BadRequestError('providerId is required')
    }

    if (!externalMerchantId) {
      throw new BadRequestError('externalMerchantId is required')
    }

    if (!credentials || typeof credentials !== 'object') {
      throw new BadRequestError('credentials object is required')
    }

    // For Blumon, we don't require merchantId/apiKey (uses OAuth)
    // For other providers, require merchantId and apiKey
    const provider = await prisma.paymentProvider.findUnique({
      where: { id: providerId },
    })

    if (!provider) {
      throw new BadRequestError(`Payment provider ${providerId} not found`)
    }

    if (provider.code !== 'BLUMON' && (!credentials.merchantId || !credentials.apiKey)) {
      throw new BadRequestError('credentials must include merchantId and apiKey for non-Blumon providers')
    }

    const result = await merchantAccountService.createMerchantAccountWithCostStructure(
      {
        providerId,
        externalMerchantId,
        alias,
        displayName,
        active,
        displayOrder,
        credentials,
        providerConfig,
        blumonSerialNumber,
        blumonPosId,
        blumonEnvironment,
        blumonMerchantId,
        clabeNumber,
        bankName,
        accountHolder,
      },
      {
        venueType: typeof venueType === 'string' ? venueType : null,
        businessCategory: typeof businessCategory === 'string' ? businessCategory : null,
      },
    )

    logger.info('[MerchantAccount] Created with ProviderCostStructure', {
      merchantAccountId: result.merchantAccount.id,
      costStructureCreated: !!result.costStructure,
      venueType,
      businessCategory,
      mccFamilia: result.mccLookup?.familia,
      mccConfidence: result.mccLookup?.confidence,
      createdBy: (req as any).user?.uid,
    })

    res.status(201).json({
      success: true,
      data: {
        merchantAccount: result.merchantAccount,
        costStructure: result.costStructure,
        mccLookup: result.mccLookup
          ? {
              found: result.mccLookup.found,
              mcc: result.mccLookup.mcc,
              familia: result.mccLookup.familia,
              rates: result.mccLookup.rates,
              confidence: result.mccLookup.confidence,
              matchType: result.mccLookup.matchType,
            }
          : null,
      },
      message: result.costStructure
        ? 'Merchant account and provider cost structure created successfully'
        : 'Merchant account created successfully (no cost structure auto-created)',
    })
  } catch (error) {
    next(error)
  }
}
