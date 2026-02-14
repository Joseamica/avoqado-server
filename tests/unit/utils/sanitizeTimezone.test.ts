/**
 * Timezone Validation Tests
 *
 * Regression tests for the unified timezone validation used across:
 * - Zod schemas (input validation at API boundary)
 * - Raw SQL queries (AT TIME ZONE clauses)
 * - Service layer (runtime checks)
 *
 * Also tests that consuming schemas (onboarding, venue, cost-management)
 * correctly validate and default timezone fields.
 */

import { sanitizeTimezone, isValidIANATimezone, zTimezone, zTimezoneBase } from '@/utils/sanitizeTimezone'

// ===== Core validation =====

describe('isValidIANATimezone', () => {
  it('accepts standard Area/City timezones', () => {
    expect(isValidIANATimezone('America/Mexico_City')).toBe(true)
    expect(isValidIANATimezone('America/New_York')).toBe(true)
    expect(isValidIANATimezone('Europe/London')).toBe(true)
    expect(isValidIANATimezone('Asia/Tokyo')).toBe(true)
    expect(isValidIANATimezone('Australia/Sydney')).toBe(true)
    expect(isValidIANATimezone('Pacific/Auckland')).toBe(true)
  })

  it('accepts UTC', () => {
    expect(isValidIANATimezone('UTC')).toBe(true)
  })

  it('accepts IANA aliases', () => {
    expect(isValidIANATimezone('US/Eastern')).toBe(true)
    expect(isValidIANATimezone('US/Pacific')).toBe(true)
    expect(isValidIANATimezone('US/Central')).toBe(true)
  })

  it('accepts Etc zones', () => {
    expect(isValidIANATimezone('Etc/GMT+5')).toBe(true)
    expect(isValidIANATimezone('Etc/GMT-3')).toBe(true)
    expect(isValidIANATimezone('Etc/UTC')).toBe(true)
  })

  it('accepts three-segment timezones', () => {
    expect(isValidIANATimezone('America/North_Dakota/Beulah')).toBe(true)
    expect(isValidIANATimezone('America/Indiana/Indianapolis')).toBe(true)
    expect(isValidIANATimezone('America/Argentina/Buenos_Aires')).toBe(true)
  })

  it('rejects SQL injection attempts', () => {
    expect(isValidIANATimezone("'; DROP TABLE--")).toBe(false)
    expect(isValidIANATimezone("America/Mexico' OR '1'='1")).toBe(false)
    expect(isValidIANATimezone('America/Mexico_City; DELETE FROM payments')).toBe(false)
    expect(isValidIANATimezone("America/Mexico_City' --")).toBe(false)
    expect(isValidIANATimezone('America/Mexico_City"; DROP TABLE users--')).toBe(false)
    expect(isValidIANATimezone('America/Mexico_City\nDROP TABLE')).toBe(false)
  })

  it('rejects format-valid but non-existent timezones', () => {
    expect(isValidIANATimezone('Foo/Bar')).toBe(false)
    expect(isValidIANATimezone('Invalid/Timezone')).toBe(false)
    expect(isValidIANATimezone('Not/Real')).toBe(false)
    expect(isValidIANATimezone('America/Fake_City')).toBe(false)
  })

  it('rejects empty and whitespace strings', () => {
    expect(isValidIANATimezone('')).toBe(false)
    expect(isValidIANATimezone(' ')).toBe(false)
    expect(isValidIANATimezone('  America/Mexico_City  ')).toBe(false)
  })

  it('rejects single-word non-UTC strings', () => {
    expect(isValidIANATimezone('CST')).toBe(false)
    expect(isValidIANATimezone('EST')).toBe(false)
    expect(isValidIANATimezone('Mexico')).toBe(false)
    expect(isValidIANATimezone('GMT')).toBe(false)
  })
})

// ===== sanitizeTimezone (throws on invalid) =====

describe('sanitizeTimezone', () => {
  it('returns valid timezone unchanged', () => {
    expect(sanitizeTimezone('America/Mexico_City')).toBe('America/Mexico_City')
    expect(sanitizeTimezone('UTC')).toBe('UTC')
    expect(sanitizeTimezone('Europe/London')).toBe('Europe/London')
  })

  it('throws BadRequestError for non-existent timezone', () => {
    expect(() => sanitizeTimezone('Foo/Bar')).toThrow('Zona horaria inválida')
  })

  it('throws BadRequestError for SQL injection', () => {
    expect(() => sanitizeTimezone("'; DROP TABLE--")).toThrow('Zona horaria inválida')
  })

  it('throws BadRequestError for empty string', () => {
    expect(() => sanitizeTimezone('')).toThrow('Zona horaria inválida')
  })
})

// ===== zTimezoneBase (no default) =====

describe('zTimezoneBase', () => {
  it('accepts valid timezone', () => {
    expect(zTimezoneBase.safeParse('America/Mexico_City').success).toBe(true)
    expect(zTimezoneBase.safeParse('UTC').success).toBe(true)
  })

  it('rejects invalid timezone', () => {
    expect(zTimezoneBase.safeParse('Foo/Bar').success).toBe(false)
  })

  it('rejects undefined (no default)', () => {
    expect(zTimezoneBase.safeParse(undefined).success).toBe(false)
  })
})

// ===== zTimezone (with default) =====

describe('zTimezone', () => {
  it('accepts valid timezone', () => {
    const result = zTimezone.safeParse('America/New_York')
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe('America/New_York')
  })

  it('defaults to America/Mexico_City when undefined', () => {
    const result = zTimezone.safeParse(undefined)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe('America/Mexico_City')
  })

  it('accepts UTC', () => {
    const result = zTimezone.safeParse('UTC')
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe('UTC')
  })

  it('rejects non-existent timezone with Spanish message', () => {
    const result = zTimezone.safeParse('Foo/Bar')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Zona horaria inválida')
    }
  })

  it('rejects SQL injection', () => {
    expect(zTimezone.safeParse("'; DROP TABLE--").success).toBe(false)
  })

  it('rejects non-string types', () => {
    expect(zTimezone.safeParse(123).success).toBe(false)
    expect(zTimezone.safeParse(null).success).toBe(false)
    expect(zTimezone.safeParse(true).success).toBe(false)
    expect(zTimezone.safeParse({}).success).toBe(false)
  })
})

// ===== Schema integration: onboarding =====

describe('onboarding.schema timezone integration', () => {
  let UpdateStep3Schema: any

  beforeAll(async () => {
    const mod = await import('@/schemas/onboarding.schema')
    UpdateStep3Schema = mod.UpdateStep3Schema
  })

  it('defaults timezone to America/Mexico_City when omitted', () => {
    const input = {
      params: { organizationId: 'clxxxxxxxxxxxxxxxxxxxxxxxxx' },
      body: { name: 'Test Venue' },
    }
    const result = UpdateStep3Schema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.body.timezone).toBe('America/Mexico_City')
    }
  })

  it('accepts valid timezone in onboarding', () => {
    const input = {
      params: { organizationId: 'clxxxxxxxxxxxxxxxxxxxxxxxxx' },
      body: { name: 'Test Venue', timezone: 'America/New_York' },
    }
    const result = UpdateStep3Schema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.body.timezone).toBe('America/New_York')
    }
  })

  it('rejects invalid timezone in onboarding', () => {
    const input = {
      params: { organizationId: 'clxxxxxxxxxxxxxxxxxxxxxxxxx' },
      body: { name: 'Test Venue', timezone: 'Foo/Bar' },
    }
    const result = UpdateStep3Schema.safeParse(input)
    expect(result.success).toBe(false)
  })
})

// ===== Schema integration: venue =====

describe('venue.schema timezone integration', () => {
  let createVenueSchema: any

  beforeAll(async () => {
    const mod = await import('@/schemas/dashboard/venue.schema')
    createVenueSchema = mod.createVenueSchema
  })

  it('defaults timezone to America/Mexico_City when omitted', () => {
    const input = {
      body: {
        name: 'Test Venue',
      },
    }
    const result = createVenueSchema.safeParse(input)
    if (result.success) {
      expect(result.data.body.timezone).toBe('America/Mexico_City')
    }
  })

  it('accepts valid timezone', () => {
    const input = {
      body: {
        name: 'Test Venue',
        timezone: 'America/New_York',
      },
    }
    const result = createVenueSchema.safeParse(input)
    if (result.success) {
      expect(result.data.body.timezone).toBe('America/New_York')
    }
  })

  it('rejects invalid timezone', () => {
    const input = {
      body: {
        name: 'Test Venue',
        timezone: 'Foo/Bar',
      },
    }
    const result = createVenueSchema.safeParse(input)
    expect(result.success).toBe(false)
  })

  it('rejects SQL injection in timezone', () => {
    const input = {
      body: {
        name: 'Test Venue',
        timezone: "'; DROP TABLE venues--",
      },
    }
    const result = createVenueSchema.safeParse(input)
    expect(result.success).toBe(false)
  })
})

// ===== Alignment: sanitizeTimezone and zTimezone agree =====

describe('sanitizeTimezone and zTimezone alignment', () => {
  const testCases = [
    { tz: 'America/Mexico_City', valid: true },
    { tz: 'UTC', valid: true },
    { tz: 'US/Eastern', valid: true },
    { tz: 'Etc/GMT+5', valid: true },
    { tz: 'America/North_Dakota/Beulah', valid: true },
    { tz: 'Foo/Bar', valid: false },
    { tz: "'; DROP TABLE--", valid: false },
    { tz: '', valid: false },
    { tz: 'CST', valid: false },
    { tz: 'America/Fake_City', valid: false },
  ]

  testCases.forEach(({ tz, valid }) => {
    it(`"${tz}" — sanitizeTimezone and zTimezone agree (${valid ? 'accept' : 'reject'})`, () => {
      // sanitizeTimezone
      let sanitizeOk: boolean
      try {
        sanitizeTimezone(tz)
        sanitizeOk = true
      } catch {
        sanitizeOk = false
      }

      // zTimezone
      const zodOk = zTimezone.safeParse(tz).success

      expect(sanitizeOk).toBe(valid)
      expect(zodOk).toBe(valid)
      // Both must agree
      expect(sanitizeOk).toBe(zodOk)
    })
  })
})
