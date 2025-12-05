/**
 * Blumon TPV Webhook Service
 *
 * Layer 4 of the 4-layer payment reconciliation strategy:
 * 1. Android SDK → Blumon (direct payment processing)
 * 2. Android → Backend (payment recording)
 * 3. Backend validation (merchantAccountId fallback)
 * 4. Blumon webhook (independent confirmation) ← THIS SERVICE
 *
 * This webhook receives payment confirmations directly from Blumon,
 * enabling reconciliation even when Android fails to record the payment.
 *
 * Use Cases:
 * - Reconcile payments that Android failed to record
 * - Verify amounts match between Blumon and our records
 * - Detect discrepancies for investigation
 */

import prisma from '../../utils/prismaClient'
import { Prisma } from '@prisma/client'
import logger from '../../config/logger'

/**
 * Helper function for async delay
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Retry configuration for payment lookup
 *
 * WHY: Blumon webhook often arrives BEFORE Android finishes recording the payment.
 * The webhook is processed in ~100ms, but Android's POST /fast can take 500ms+.
 *
 * Strategy: 3 attempts with increasing delays
 * - Attempt 1: Immediate (0ms)
 * - Attempt 2: After 2000ms
 * - Attempt 3: After 3000ms more
 * - Total max wait: 5 seconds
 */
const RETRY_CONFIG = {
  maxAttempts: 3,
  delays: [0, 2000, 3000], // Immediate, then 2s, then 3s
}

/**
 * Blumon webhook payload structure
 *
 * NOTE: Blumon's actual payload differs from initial documentation!
 * Field mapping (Blumon sends → We expected):
 * - business → (new field) Merchant name registered with Blumon
 * - businessRfc → (new field) Tax ID (RFC) of the merchant
 * - reference → Not always present, use authorizationCode + lastFour for matching
 *
 * @example Actual sandbox payload (2025-12-03):
 * {
 *   "business": "AVOQADO",
 *   "businessRfc": "STA241210PW8",
 *   "lastFour": "7182",
 *   "cardType": "CREDITO",
 *   "brand": "MASTERCARD",
 *   "bank": "GENERAL",
 *   "amount": "20.00",
 *   ...
 * }
 */
export interface BlumonWebhookPayload {
  // Merchant identification (ACTUAL fields from Blumon)
  business?: string // Merchant name registered with Blumon (e.g., "AVOQADO")
  businessRfc?: string // Tax ID (RFC) of the merchant

  // Card information
  bin?: string // Card BIN (first 6 digits)
  lastFour: string // Card last 4 digits
  cardType: 'DEBITO' | 'CREDITO' | string // DEBITO, CREDITO
  brand: 'VISA' | 'MASTERCARD' | 'AMERICAN_EXPRESS' | string
  bank: string // Issuing bank (e.g., "BANORTE", "GENERAL")

  // Transaction details
  amount: string // Transaction amount (string format)
  reference?: string // Our transaction reference (may not be present in all webhooks)
  cardHolder?: string // Cardholder name (PCI - careful with logging)
  authorizationCode?: string // Bank authorization code
  operationType?: 'VENTA' | 'DEVOLUCION' | string // VENTA = sale
  operationNumber?: number // Blumon's operation ID
  descriptionResponse?: string // Response description (e.g., "APROBADA")
  dateTransaction?: string // Format: "20/01/2021 18:24:38"
  authentication?: string // 3DS status
  membership?: string // Blumon membership ID
  provideResponse?: string // Provider response code (e.g., "SB" for sandbox)
  codeResponse?: string // Response code ("00" = approved)

  // Allow additional unknown fields from Blumon
  [key: string]: unknown
}

/**
 * Webhook processing result
 */
export interface WebhookProcessingResult {
  success: boolean
  action: 'MATCHED' | 'RECONCILED' | 'DISCREPANCY' | 'NOT_FOUND' | 'ERROR'
  paymentId?: string
  message: string
  details?: {
    blumonAmount: number
    recordedAmount?: number
    difference?: number
  }
}

/**
 * Process Blumon payment confirmation webhook
 *
 * Strategy:
 * 1. Parse and validate the webhook payload
 * 2. Find matching payment by transactionReference
 * 3. If found: verify amounts match, log confirmation
 * 4. If not found: create reconciliation record for investigation
 */
export async function processBlumonPaymentWebhook(payload: BlumonWebhookPayload): Promise<WebhookProcessingResult> {
  const correlationId = `blumon-wh-${Date.now()}`

  try {
    // Parse amount from string
    const blumonAmount = parseFloat(payload.amount)

    // Log ALL fields from Blumon for investigation (first time seeing real payload)
    logger.info('📥 Blumon webhook received - FULL PAYLOAD', {
      correlationId,
      // Merchant identification (new fields discovered)
      business: payload.business,
      businessRfc: payload.businessRfc,
      // Card info
      lastFour: payload.lastFour,
      cardBrand: payload.brand,
      cardType: payload.cardType,
      bank: payload.bank,
      // Transaction info
      amount: blumonAmount,
      reference: payload.reference,
      authorizationCode: payload.authorizationCode,
      operationNumber: payload.operationNumber,
      operationType: payload.operationType,
      codeResponse: payload.codeResponse,
      descriptionResponse: payload.descriptionResponse,
      dateTransaction: payload.dateTransaction,
      membership: payload.membership,
      // Log ALL other fields we might have missed
      allFields: Object.keys(payload),
      // ⚠️ PCI: Do NOT log cardHolder or full card data
    })

    // Only process approved transactions
    // If codeResponse is missing, assume approved (lenient mode for discovery)
    const isApproved = !payload.codeResponse || payload.codeResponse === '00'
    if (!isApproved) {
      logger.warn('⚠️ Blumon webhook: Non-approved transaction received', {
        correlationId,
        reference: payload.reference,
        codeResponse: payload.codeResponse,
        descriptionResponse: payload.descriptionResponse,
      })

      return {
        success: true,
        action: 'NOT_FOUND',
        message: `Transaction not approved: ${payload.descriptionResponse || 'Unknown'}`,
      }
    }

    // Build matching conditions based on available fields
    const matchConditions: Prisma.PaymentWhereInput[] = []

    if (payload.reference) {
      matchConditions.push({ referenceNumber: payload.reference })
      // Try partial match on last 10 chars
      if (payload.reference.length >= 10) {
        matchConditions.push({ referenceNumber: { contains: payload.reference.slice(-10) } })
      }
    }

    if (payload.authorizationCode) {
      matchConditions.push({ authorizationNumber: payload.authorizationCode })
    }

    if (payload.operationNumber) {
      matchConditions.push({ processorId: payload.operationNumber.toString() })
    }

    // If we have lastFour, add a combined condition with amount + lastFour + date
    // This is a fallback for when reference/auth might not match exactly
    if (payload.lastFour && payload.dateTransaction) {
      // Parse dateTransaction format: "DD/MM/YYYY HH:mm:ss" or similar
      // For now, just log it - we'll add this matching later if needed
      logger.debug('🔍 Additional matching fields available', {
        correlationId,
        lastFour: payload.lastFour,
        dateTransaction: payload.dateTransaction,
        amount: blumonAmount,
      })
    }

    if (matchConditions.length === 0) {
      logger.error('❌ Blumon webhook: No matching fields available', {
        correlationId,
        payload: {
          reference: payload.reference,
          authorizationCode: payload.authorizationCode,
          operationNumber: payload.operationNumber,
        },
      })

      return {
        success: false,
        action: 'ERROR',
        message: 'No fields available for payment matching',
        details: { blumonAmount },
      }
    }

    // Try to find the payment with retry logic
    // WHY: Blumon webhook often arrives BEFORE Android records the payment
    let payment = null
    for (let attempt = 0; attempt < RETRY_CONFIG.maxAttempts; attempt++) {
      // Wait before retry (first attempt is immediate)
      if (RETRY_CONFIG.delays[attempt] > 0) {
        logger.debug(
          `🔄 Blumon webhook: Retry attempt ${attempt + 1}/${RETRY_CONFIG.maxAttempts} after ${RETRY_CONFIG.delays[attempt]}ms`,
          {
            correlationId,
            reference: payload.reference,
          },
        )
        await delay(RETRY_CONFIG.delays[attempt])
      }

      payment = await prisma.payment.findFirst({
        where: {
          OR: matchConditions,
          // Only match approved/completed payments
          status: { in: ['COMPLETED', 'PENDING'] },
        },
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
              venueId: true,
            },
          },
        },
      })

      if (payment) {
        if (attempt > 0) {
          logger.info(`✅ Blumon webhook: Payment found on retry attempt ${attempt + 1}`, {
            correlationId,
            paymentId: payment.id,
            totalWaitMs: RETRY_CONFIG.delays.slice(0, attempt + 1).reduce((a, b) => a + b, 0),
          })
        }
        break // Found payment, exit retry loop
      }
    }

    if (payment) {
      // Payment found - verify amounts match
      const recordedAmount = parseFloat(payment.amount.toString())
      const difference = Math.abs(blumonAmount - recordedAmount)

      if (difference < 0.01) {
        // Amounts match - perfect reconciliation
        logger.info('✅ Blumon webhook: Payment verified', {
          correlationId,
          paymentId: payment.id,
          reference: payload.reference,
          amount: blumonAmount,
          authCode: payload.authorizationCode,
        })

        // Update payment with Blumon operation data if not already received
        const existingProcessorData = (payment.processorData as Record<string, unknown>) || {}
        if (!existingProcessorData.blumonWebhookReceived) {
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              processorData: {
                ...existingProcessorData,
                blumonOperationNumber: payload.operationNumber,
                blumonWebhookReceived: new Date().toISOString(),
                blumonAuthCode: payload.authorizationCode,
                blumonMembership: payload.membership,
              },
            },
          })
        }

        return {
          success: true,
          action: 'MATCHED',
          paymentId: payment.id,
          message: 'Payment verified successfully',
          details: {
            blumonAmount,
            recordedAmount,
          },
        }
      } else {
        // Amounts don't match - discrepancy detected
        logger.error('❌ Blumon webhook: AMOUNT DISCREPANCY detected', {
          correlationId,
          paymentId: payment.id,
          reference: payload.reference,
          blumonAmount,
          recordedAmount,
          difference,
        })

        // Create discrepancy alert (could trigger notification to admin)
        const discrepancyProcessorData = (payment.processorData as Record<string, unknown>) || {}
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            processorData: {
              ...discrepancyProcessorData,
              blumonDiscrepancy: {
                detectedAt: new Date().toISOString(),
                blumonAmount,
                recordedAmount,
                difference,
                operationNumber: payload.operationNumber,
              },
            },
          },
        })

        return {
          success: false,
          action: 'DISCREPANCY',
          paymentId: payment.id,
          message: `Amount discrepancy: Blumon=${blumonAmount}, Recorded=${recordedAmount}`,
          details: {
            blumonAmount,
            recordedAmount,
            difference,
          },
        }
      }
    } else {
      // Payment not found after all retries - this could be:
      // 1. Android failed to record the payment entirely
      // 2. Reference format mismatch
      // 3. Payment recording failed on Android side

      const totalWaitTime = RETRY_CONFIG.delays.reduce((a, b) => a + b, 0)
      logger.warn('⚠️ Blumon webhook: Payment NOT FOUND after all retries', {
        correlationId,
        reference: payload.reference,
        operationNumber: payload.operationNumber,
        amount: blumonAmount,
        retryAttempts: RETRY_CONFIG.maxAttempts,
        totalWaitMs: totalWaitTime,
        hint: 'Android may have failed to record this payment. Check for orphaned transactions.',
      })

      // Store the orphaned webhook for manual reconciliation
      // We could create a separate table for this, or use a general audit log
      // For now, we'll log it prominently
      logger.error('🚨 RECONCILIATION REQUIRED: Blumon payment not found after retries', {
        correlationId,
        reference: payload.reference,
        operationNumber: payload.operationNumber,
        amount: blumonAmount,
        cardBrand: payload.brand,
        cardType: payload.cardType,
        authorizationCode: payload.authorizationCode,
        dateTransaction: payload.dateTransaction,
        membership: payload.membership,
        serialNumber: payload.serialNumber,
        retryAttempts: RETRY_CONFIG.maxAttempts,
        totalWaitMs: totalWaitTime,
        // This should trigger an alert to operations team
      })

      return {
        success: true, // Webhook processed successfully, but no matching payment
        action: 'NOT_FOUND',
        message: `Payment not found after ${RETRY_CONFIG.maxAttempts} attempts (${totalWaitTime}ms) - requires manual reconciliation`,
        details: {
          blumonAmount,
        },
      }
    }
  } catch (error) {
    logger.error('❌ Blumon webhook processing error', {
      correlationId,
      reference: payload.reference,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    })

    return {
      success: false,
      action: 'ERROR',
      message: error instanceof Error ? error.message : 'Unknown error processing webhook',
    }
  }
}

/**
 * Validate webhook payload has minimum required fields
 *
 * We use lenient validation because:
 * 1. Blumon's payload format may differ from documentation
 * 2. Different sandbox/production environments may have different fields
 * 3. We want to LOG all webhooks for investigation, even if some fields missing
 *
 * Minimum requirements:
 * - amount: Must know how much was charged
 * - At least one card identifier (lastFour OR authorizationCode)
 */
export function validateBlumonWebhookPayload(payload: unknown): payload is BlumonWebhookPayload {
  if (!payload || typeof payload !== 'object') {
    return false
  }

  const p = payload as Record<string, unknown>

  // MINIMUM required: amount (how much was charged)
  if (!('amount' in p)) {
    return false
  }

  // At least one card/transaction identifier for matching
  const hasCardIdentifier = 'lastFour' in p || 'authorizationCode' in p || 'reference' in p
  if (!hasCardIdentifier) {
    return false
  }

  return true
}
