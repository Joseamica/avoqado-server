// tests/unit/services/serialized-inventory/iccidFormat.test.ts
/**
 * Format guard for Mexican ICCIDs (ITU-T E.118): 8952 prefix + 15-16 digits,
 * optional trailing F. Mirrors the TPV regex (SerializedInventoryViewModel.kt:441).
 */
import { isValidMxIccid } from '@/services/serialized-inventory/serializedInventory.service'

describe('isValidMxIccid', () => {
  it('accepts a real 19-digit ALTAN ICCID', () => {
    expect(isValidMxIccid('8952140000001234567')).toBe(true)
  })
  it('accepts a 20-digit ICCID', () => {
    expect(isValidMxIccid('89521400000012345678')).toBe(true)
  })
  it('accepts a trailing F (BCD padding)', () => {
    expect(isValidMxIccid('8952140000001234567F')).toBe(true)
  })
  it('normalizes lowercase f and surrounding whitespace before checking', () => {
    expect(isValidMxIccid('  8952140000001234567f  ')).toBe(true)
  })
  it('rejects a non-8952 prefix', () => {
    expect(isValidMxIccid('8951140000001234567')).toBe(false)
  })
  it('rejects too-short input', () => {
    expect(isValidMxIccid('895214000000')).toBe(false)
  })
  it('rejects letters in the middle', () => {
    expect(isValidMxIccid('89521400ABCD01234567')).toBe(false)
  })
})
