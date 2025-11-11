import { Request, Response, NextFunction } from 'express'
import * as merchantAccountService from '../../services/superadmin/merchantAccount.service'
import logger from '../../config/logger'
import { BadRequestError } from '../../errors/AppError'
import { blumonApiService } from '../../services/blumon/blumonApi.service'
import type { BlumonEnvironment } from '../../services/blumon/types'
import { createBlumonService } from '../../services/tpv/blumon.service'
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
    const { serialNumber, brand, model, displayName, environment = 'SANDBOX' } = req.body

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
    })

    // Create Blumon service for specified environment
    const blumonService = createBlumonService(environment as 'SANDBOX' | 'PRODUCTION')

    // Auto-fetch credentials from Blumon API
    logger.info('[Blumon Auto-Fetch] Step 1: Fetching credentials from Blumon API...')
    const merchantInfo = await blumonService.fetchMerchantCredentials(serialNumber, brand, model)

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

    const message = merchantInfo.dukptKeysAvailable
      ? 'Blumon credentials fetched and merchant account created successfully'
      : 'Blumon merchant account created successfully. DUKPT keys will be initialized automatically on first payment.'

    res.status(201).json({
      success: true,
      data: {
        id: merchantAccount.id,
        serialNumber: merchantInfo.serialNumber,
        posId: merchantInfo.posId,
        displayName: merchantAccount.displayName,
        blumonEnvironment: environment,
        dukptKeysAvailable: merchantInfo.dukptKeysAvailable,
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
