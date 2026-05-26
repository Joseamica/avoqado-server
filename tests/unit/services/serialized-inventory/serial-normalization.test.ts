import { normalizeSerial } from '../../../../src/services/serialized-inventory/serializedInventory.service'

/**
 * Regression test for the duplicate-SIM bug (2026-05-26).
 *
 * Same physical SIM scanned at sale time as '...359f' (lowercase hex check
 * nibble from the barcode scanner) did NOT match the bulk-loaded inventory
 * record '...359F' (uppercase), so the case-sensitive unique lookup missed it
 * and the sale flow registered a DUPLICATE marked SOLD — inflating inventory
 * and leaving the real item AVAILABLE. 30 duplicate pairs accumulated in prod.
 *
 * Fix: normalizeSerial() canonicalizes to trimmed + UPPERCASE at every entry
 * point so both casings resolve to the same stored record.
 */
describe('normalizeSerial', () => {
  // NEW BEHAVIOR — the fix
  it('uppercases the trailing ICCID hex nibble so f and F collapse', () => {
    expect(normalizeSerial('8952140064023736359f')).toBe('8952140064023736359F')
    expect(normalizeSerial('8952140064023736359F')).toBe('8952140064023736359F')
  })

  it('produces an identical result for both casings of the same physical SIM', () => {
    expect(normalizeSerial('8952140064023736359f')).toBe(normalizeSerial('8952140064023736359F'))
  })

  it('trims surrounding whitespace from scanner/file input', () => {
    expect(normalizeSerial('  8952140064023736359f \n')).toBe('8952140064023736359F')
  })

  // REGRESSION — must not corrupt normal input
  it('leaves an already-canonical all-digits serial unchanged', () => {
    expect(normalizeSerial('1234567890123456789')).toBe('1234567890123456789')
  })

  it('is idempotent', () => {
    const once = normalizeSerial('  8952140064023736359f ')
    expect(normalizeSerial(once)).toBe(once)
  })
})
