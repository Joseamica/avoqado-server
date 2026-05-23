import { isValidEmail, isValidPin, isNumericMerchantId } from '@/lib/angelpayValidators'

describe('angelpayValidators', () => {
  describe('isValidEmail', () => {
    it('accepts a valid email', () => {
      expect(isValidEmail('contacto@avoqado.io')).toBe(true)
    })
    it('rejects a malformed email', () => {
      expect(isValidEmail('nope')).toBe(false)
      expect(isValidEmail('a@b')).toBe(false)
      expect(isValidEmail('')).toBe(false)
    })
  })

  describe('isValidPin', () => {
    it('accepts exactly 6 digits', () => {
      expect(isValidPin('123456')).toBe(true)
    })
    it('rejects wrong length or non-numeric', () => {
      expect(isValidPin('12345')).toBe(false)
      expect(isValidPin('1234567')).toBe(false)
      expect(isValidPin('12345a')).toBe(false)
      expect(isValidPin('')).toBe(false)
    })
  })

  describe('isNumericMerchantId', () => {
    it('accepts a non-empty numeric string', () => {
      expect(isNumericMerchantId('9814275')).toBe(true)
    })
    it('rejects non-numeric or empty', () => {
      expect(isNumericMerchantId('98a')).toBe(false)
      expect(isNumericMerchantId('')).toBe(false)
      expect(isNumericMerchantId('12.5')).toBe(false)
    })
  })
})
