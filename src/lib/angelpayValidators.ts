/**
 * Pure validators for AngelPay account input. No I/O, no side effects — safe to
 * reuse inside transactions, controllers, and the full-setup service.
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PIN_REGEX = /^\d{6}$/
const NUMERIC_REGEX = /^\d+$/

/** True when `v` is a syntactically valid email address. */
export const isValidEmail = (v: string): boolean => EMAIL_REGEX.test(v)

/** True when `v` is exactly 6 numeric digits (an AngelPay account PIN). */
export const isValidPin = (v: string): boolean => PIN_REGEX.test(v)

/** True when `v` is a non-empty numeric string (an AngelPay merchant id). */
export const isNumericMerchantId = (v: string): boolean => v.length > 0 && NUMERIC_REGEX.test(v)
