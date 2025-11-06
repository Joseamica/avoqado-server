import { Request, Response, NextFunction } from 'express'

import logger from '../../config/logger'
import { NotFoundError } from '../../errors/AppError'
import prisma from '@/utils/prismaClient'

/**
 * Terminal TPV Controller
 *
 * REST API endpoints for terminal configuration and merchant assignment retrieval.
 * Used by Android TPV app to fetch dynamic configuration on startup.
 */

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
 *       },
 *       {
 *         "id": "ma_yyyyy",
 *         "displayName": "Ghost Kitchen",
 *         "serialNumber": "2841548418",
 *         "posId": "378",
 *         "environment": "SANDBOX",
 *         "credentials": {...}
 *       }
 *     ]
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

    // Step 2: Fetch assigned merchant accounts with Blumon config
    const merchantAccounts = await prisma.merchantAccount.findMany({
      where: {
        id: { in: terminal.assignedMerchantIds },
        active: true, // Only return active merchants
      },
      select: {
        id: true,
        displayName: true,
        active: true,
        blumonSerialNumber: true,
        blumonPosId: true,
        blumonEnvironment: true,
        blumonMerchantId: true,
        credentialsEncrypted: true, // Encrypted credentials
        providerConfig: true,
      },
    })

    logger.debug('[Terminal Config] Merchant accounts fetched', {
      count: merchantAccounts.length,
      accounts: merchantAccounts.map((ma: any) => ({
        id: ma.id,
        displayName: ma.displayName,
        blumonSerialNumber: ma.blumonSerialNumber,
      })),
    })

    // Step 3: Transform merchant accounts for Android response
    const transformedMerchants = merchantAccounts.map((ma: any) => ({
      id: ma.id,
      displayName: ma.displayName,
      serialNumber: ma.blumonSerialNumber,
      posId: ma.blumonPosId,
      environment: ma.blumonEnvironment,
      merchantId: ma.blumonMerchantId,
      credentials: ma.credentialsEncrypted, // Encrypted - Android will decrypt
      providerConfig: ma.providerConfig,
    }))

    logger.info('[Terminal Config] Successfully fetched config', {
      terminalId: terminal.id,
      serialNumber: terminal.serialNumber,
      merchantCount: transformedMerchants.length,
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
      },
    })
  } catch (error) {
    next(error)
  }
}
