/**
 * Timezone Sanitization Utility
 *
 * Single source of truth for timezone validation across the entire backend:
 * - Zod schemas (input validation at API boundary)
 * - Raw SQL queries (AT TIME ZONE clauses)
 * - Service layer (runtime checks)
 *
 * Two-layer validation:
 * 1. Regex format guard — blocks SQL injection characters before touching Intl
 * 2. Intl.DateTimeFormat — validates against the runtime's real IANA database
 *
 * Supports: Area/City ("America/Mexico_City"), aliases ("US/Eastern"), Etc zones ("Etc/GMT+5")
 * Also supports: "UTC" as a special case (common in APIs, valid in both Intl and PostgreSQL)
 *
 * Rejects: "Foo/Bar", "'; DROP TABLE--", arbitrary strings
 */

import { z } from 'zod'
import { BadRequestError } from '../errors/AppError'

// Format guard: blocks injection attempts before hitting Intl.
// Matches Area/City, Area/City/Sub, Etc/GMT+5, US/Eastern, etc.
const IANA_TZ_REGEX = /^[A-Za-z0-9_+-]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?$/

// Special single-word timezones that are valid in both Intl and PostgreSQL
const ALLOWED_SHORT_TIMEZONES = new Set(['UTC'])

/**
 * Check if a timezone string is a valid IANA timezone.
 * Pure boolean check — no throws. Use this for conditional logic.
 */
export function isValidIANATimezone(timezone: string): boolean {
  if (!IANA_TZ_REGEX.test(timezone) && !ALLOWED_SHORT_TIMEZONES.has(timezone)) {
    return false
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/**
 * Sanitize a timezone string for safe use in raw SQL queries.
 * Throws BadRequestError (400) if invalid.
 */
export function sanitizeTimezone(timezone: string): string {
  if (!isValidIANATimezone(timezone)) {
    throw new BadRequestError(`Zona horaria inválida: ${timezone}`)
  }
  return timezone
}

/**
 * Base Zod refinement for timezone — validates string is real IANA.
 * No default, no optional. Compose as needed at each schema site.
 */
export const zTimezoneBase = z.string().refine(isValidIANATimezone, { message: 'Zona horaria inválida' })

/**
 * Zod schema for timezone with default America/Mexico_City.
 * Use for required timezone fields:  { timezone: zTimezone }
 * For optional fields:               { timezone: zTimezone.optional() }
 *   → If omitted, falls back to 'America/Mexico_City' (default fires before optional).
 */
export const zTimezone = zTimezoneBase.default('America/Mexico_City')
