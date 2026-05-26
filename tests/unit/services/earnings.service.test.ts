import { centsToMxn, mergeByVenue, mergeTimeSeries } from '../../../src/services/superadmin/earnings.service'

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

  describe('mergeByVenue', () => {
    it('adds online fees onto the matching terminal venue and sorts by profit desc', () => {
      const terminal = [
        { venueId: 'v1', venueName: 'A', profit: 100, volume: 1000, transactions: 10 },
        { venueId: 'v2', venueName: 'B', profit: 50, volume: 500, transactions: 5 },
      ]
      const online = [{ venueId: 'v1', venueName: 'A', fees: 25, volume: 300, transactions: 3 }]
      const result = mergeByVenue(terminal, online)
      expect(result).toEqual([
        { venueId: 'v1', venueName: 'A', profit: 125, terminalProfit: 100, onlineFees: 25, volume: 1300, transactions: 13 },
        { venueId: 'v2', venueName: 'B', profit: 50, terminalProfit: 50, onlineFees: 0, volume: 500, transactions: 5 },
      ])
    })
    it('includes online-only venues (no terminal row)', () => {
      const result = mergeByVenue([], [{ venueId: 'v9', venueName: 'Z', fees: 10, volume: 90, transactions: 1 }])
      expect(result).toEqual([
        { venueId: 'v9', venueName: 'Z', profit: 10, terminalProfit: 0, onlineFees: 10, volume: 90, transactions: 1 },
      ])
    })
  })

  describe('mergeTimeSeries', () => {
    it('merges terminal + online points by date and fills gaps with 0', () => {
      const terminal = [
        { date: '2026-05-01', profit: 100 },
        { date: '2026-05-02', profit: 200 },
      ]
      const online = [
        { date: '2026-05-02', fees: 30 },
        { date: '2026-05-03', fees: 5 },
      ]
      expect(mergeTimeSeries(terminal, online)).toEqual([
        { date: '2026-05-01', terminalProfit: 100, onlineFees: 0, profit: 100 },
        { date: '2026-05-02', terminalProfit: 200, onlineFees: 30, profit: 230 },
        { date: '2026-05-03', terminalProfit: 0, onlineFees: 5, profit: 5 },
      ])
    })
  })
})
