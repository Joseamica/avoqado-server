/**
 * Retry Utility with Exponential Backoff
 *
 * Handles transient failures in external API calls (Stripe, etc.)
 * with configurable retry logic and exponential backoff
 */

import logger from '@/config/logger'

export interface RetryOptions {
  /**
   * Maximum number of retry attempts
   * @default 3
   */
  retries?: number

  /**
   * Initial delay in milliseconds before first retry
   * @default 1000
   */
  initialDelay?: number

  /**
   * Backoff strategy: 'exponential' or 'linear'
   * @default 'exponential'
   */
  backoff?: 'exponential' | 'linear'

  /**
   * Maximum delay between retries (ms)
   * Prevents exponential backoff from growing too large
   * @default 30000 (30 seconds)
   */
  maxDelay?: number

  /**
   * Function to determine if error is retryable
   * If not provided, all errors trigger retry
   */
  shouldRetry?: (error: any) => boolean

  /**
   * Context for logging (e.g., 'stripe.updateCustomer')
   */
  context?: string
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  retries: 3,
  initialDelay: 1000,
  backoff: 'exponential',
  maxDelay: 30000,
  shouldRetry: () => true, // Retry all errors by default
  context: 'unknown',
}

/**
 * Default shouldRetry for Stripe API errors
 * Retries on network errors and 5xx status codes
 * Does NOT retry on 4xx (client errors like invalid API key)
 */
export function shouldRetryStripeError(error: any): boolean {
  // Network errors (ECONNRESET, ETIMEDOUT, etc.)
  if (error.code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'].includes(error.code)) {
    return true
  }

  // Stripe API errors
  if (error.type === 'StripeConnectionError' || error.type === 'StripeAPIError') {
    return true
  }

  // HTTP 5xx errors (server-side issues)
  if (error.statusCode && error.statusCode >= 500 && error.statusCode < 600) {
    return true
  }

  // HTTP 429 (Rate limit) - should retry with backoff
  if (error.statusCode === 429) {
    return true
  }

  // Don't retry 4xx errors (client errors)
  return false
}

/**
 * Calculate delay for next retry attempt
 *
 * @param attempt - Current attempt number (0-indexed)
 * @param options - Retry options
 * @returns Delay in milliseconds
 */
function calculateDelay(attempt: number, options: Required<RetryOptions>): number {
  const { initialDelay, backoff, maxDelay } = options

  let delay: number

  if (backoff === 'exponential') {
    // Exponential: 1s, 2s, 4s, 8s, 16s, ...
    delay = initialDelay * Math.pow(2, attempt)
  } else {
    // Linear: 1s, 2s, 3s, 4s, 5s, ...
    delay = initialDelay * (attempt + 1)
  }

  // Cap at maxDelay
  return Math.min(delay, maxDelay)
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Retry a function with exponential backoff
 *
 * @param fn - Async function to retry
 * @param options - Retry configuration
 * @returns Result of successful function call
 * @throws Last error if all retries exhausted
 *
 * @example
 * ```typescript
 * // Basic usage with defaults (3 retries, exponential backoff)
 * const result = await retry(() => stripe.customers.retrieve(customerId))
 *
 * // Custom configuration
 * const result = await retry(
 *   () => stripe.customers.update(customerId, { email }),
 *   {
 *     retries: 5,
 *     initialDelay: 500,
 *     shouldRetry: shouldRetryStripeError,
 *     context: 'stripe.updateCustomer'
 *   }
 * )
 * ```
 */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const opts: Required<RetryOptions> = { ...DEFAULT_OPTIONS, ...options }
  let lastError: any

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      // Try executing function
      const result = await fn()

      // Log success if this was a retry
      if (attempt > 0) {
        logger.info('✅ Retry succeeded', {
          context: opts.context,
          attempt: attempt + 1,
          totalAttempts: opts.retries + 1,
        })
      }

      return result
    } catch (error: unknown) {
      lastError = error

      // Type-safe error handling
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      const errorType = (error as any).type || 'unknown'
      const statusCode = (error as any).statusCode

      // Check if we should retry this error
      if (!opts.shouldRetry(error)) {
        logger.warn('⚠️ Error not retryable, failing immediately', {
          context: opts.context,
          error: errorMessage,
          errorType,
          statusCode,
        })
        throw error
      }

      // Check if we've exhausted retries
      if (attempt === opts.retries) {
        logger.error('❌ All retries exhausted', {
          context: opts.context,
          totalAttempts: attempt + 1,
          error: errorMessage,
        })
        throw error
      }

      // Calculate delay and wait
      const delay = calculateDelay(attempt, opts)
      logger.warn('⚠️ Retrying after error', {
        context: opts.context,
        attempt: attempt + 1,
        totalAttempts: opts.retries + 1,
        delayMs: delay,
        error: errorMessage,
        errorType,
      })

      await sleep(delay)
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError
}

export default retry
