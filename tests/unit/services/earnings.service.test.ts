import { centsToMxn, bucketKey } from '../../../src/services/superadmin/earnings.service'

describe('earnings pure helpers', () => {
  describe('centsToMxn', () => {
    it('converts integer cents to MXN', () => {
      expect(centsToMxn(12345)).toBe(123.45)
    })
    it('treats null/undefined as 0', () => {
      expect(centsToMxn(null)).toBe(0)
      expect(centsToMxn(undefined)).toBe(0)
    })
  })

  describe('bucketKey', () => {
    const d = new Date('2026-05-13T18:30:00.000Z') // a Wednesday
    it('daily → YYYY-MM-DD', () => {
      expect(bucketKey(d, 'daily')).toBe('2026-05-13')
    })
    it('monthly → YYYY-MM', () => {
      expect(bucketKey(d, 'monthly')).toBe('2026-05')
    })
    it('weekly → the Monday of that week (UTC)', () => {
      expect(bucketKey(d, 'weekly')).toBe('2026-05-11')
    })
  })
})
