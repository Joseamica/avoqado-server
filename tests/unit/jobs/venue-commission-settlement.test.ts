import {
  calculateVenueCommissions,
  buildVenueBreakdown,
  buildGrandTotals,
  type CommissionRow,
  type RawPaymentRow,
} from '../../../src/jobs/venue-commission-settlement.job'

describe('VenueCommissionSettlement — Calculations', () => {
  const round2 = (n: number) => Math.round(n * 100) / 100

  describe('calculateVenueCommissions', () => {
    it('should calculate Layer 2 commission and EXTERNAL split (70/30) without IVA on L2', () => {
      const rows: RawPaymentRow[] = [
        {
          venue_name: 'Dona Simona',
          card_type: 'DEBIT',
          tx_count: BigInt(1),
          gross_amount: { toNumber: () => 100 } as any,
          tips: { toNumber: () => 0 } as any,
          commission_rate: { toNumber: () => 0.0462 } as any,
          referred_by: 'EXTERNAL',
          base_fee_rate: 0.025,
          iva_rate: 0.16,
        },
      ]

      const result = calculateVenueCommissions(rows)

      // L1: fee = 100 * 0.025 = 2.5, iva = 2.5 * 0.16 = 0.4
      // netAfterL1 = 100 - 2.5 - 0.4 = 97.1
      // L2: fee = 97.1 * 0.0462 = 4.49 (round2), no IVA on L2
      // netToVenue = 97.1 - 4.49 = 92.61

      expect(result).toHaveLength(1)
      const r = result[0]
      expect(r.venueName).toBe('Dona Simona')
      expect(r.grossAmount).toBe(100)
      expect(r.layer1Fee).toBe(2.5)
      expect(r.layer1Iva).toBe(0.4)
      expect(r.netAfterLayer1).toBe(97.1)
      expect(r.layer2Fee).toBe(round2(97.1 * 0.0462))
      expect(r.netToVenue).toBe(round2(97.1 - r.layer2Fee))
      expect(r.externalShare).toBe(round2(r.layer2Fee * 0.7))
      expect(r.aggregatorShare).toBe(round2(r.layer2Fee * 0.3))
    })

    it('should calculate AGGREGATOR split (30/70) without IVA on L2', () => {
      const rows: RawPaymentRow[] = [
        {
          venue_name: 'Alberto Dominguez',
          card_type: 'CREDIT',
          tx_count: BigInt(5),
          gross_amount: { toNumber: () => 500 } as any,
          tips: { toNumber: () => 25 } as any,
          commission_rate: { toNumber: () => 0.07 } as any,
          referred_by: 'AGGREGATOR',
          base_fee_rate: 0.025,
          iva_rate: 0.16,
        },
      ]

      const result = calculateVenueCommissions(rows)
      const r = result[0]

      // L1: fee = 500 * 0.025 = 12.5, iva = 12.5 * 0.16 = 2.0
      // netAfterL1 = 500 - 12.5 - 2.0 = 485.5
      // L2: fee = 485.5 * 0.07 = 33.99 (round2), no IVA on L2

      expect(r.layer1Fee).toBe(12.5)
      expect(r.layer1Iva).toBe(2.0)
      expect(r.netAfterLayer1).toBe(485.5)
      expect(r.layer2Fee).toBe(round2(485.5 * 0.07))
      expect(r.netToVenue).toBe(round2(485.5 - r.layer2Fee))
      expect(r.externalShare).toBe(round2(r.layer2Fee * 0.3))
      expect(r.aggregatorShare).toBe(round2(r.layer2Fee * 0.7))
    })

    it('should handle AMEX rate (3.3%) for Layer 1 with IVA', () => {
      const rows: RawPaymentRow[] = [
        {
          venue_name: 'Test Venue',
          card_type: 'AMEX',
          tx_count: BigInt(2),
          gross_amount: { toNumber: () => 200 } as any,
          tips: { toNumber: () => 10 } as any,
          commission_rate: { toNumber: () => 0.05 } as any,
          referred_by: 'EXTERNAL',
          base_fee_rate: 0.033,
          iva_rate: 0.16,
        },
      ]

      const result = calculateVenueCommissions(rows)

      // L1: fee = 200 * 0.033 = 6.6, iva = 6.6 * 0.16 = 1.06 (round2)
      // netAfterL1 = 200 - 6.6 - 1.06 = 192.34

      expect(result[0].layer1Fee).toBe(6.6)
      expect(result[0].layer1Iva).toBe(round2(6.6 * 0.16))
      expect(result[0].netAfterLayer1).toBe(round2(200 - 6.6 - round2(6.6 * 0.16)))
    })

    it('should split only layer2Fee for external/aggregator share', () => {
      const rows: RawPaymentRow[] = [
        {
          venue_name: 'Split Test Venue',
          card_type: 'DEBIT',
          tx_count: BigInt(1),
          gross_amount: { toNumber: () => 1000 } as any,
          tips: { toNumber: () => 0 } as any,
          commission_rate: { toNumber: () => 0.05 } as any,
          referred_by: 'EXTERNAL',
          base_fee_rate: 0.025,
          iva_rate: 0.16,
        },
      ]

      const result = calculateVenueCommissions(rows)
      const r = result[0]

      // Verify split applies only to layer2Fee, not layer2Iva
      expect(r.externalShare).toBe(round2(r.layer2Fee * 0.7))
      expect(r.aggregatorShare).toBe(round2(r.layer2Fee * 0.3))
      expect(r.externalShare + r.aggregatorShare).toBeCloseTo(r.layer2Fee, 1)
    })
  })

  describe('buildVenueBreakdown', () => {
    it('should aggregate rows by venue with split totals', () => {
      const rows: CommissionRow[] = [
        {
          venueName: 'Dona Simona',
          cardType: 'DEBIT',
          txCount: 3,
          grossAmount: 300,
          tips: 15,
          layer1Rate: 0.025,
          layer1Fee: 7.5,
          layer1Iva: 1.2,
          netAfterLayer1: 291.3,
          layer2Rate: 0.0462,
          layer2Fee: 13.46,
          netToVenue: 277.84,
          referredBy: 'EXTERNAL',
          externalShare: 9.42,
          aggregatorShare: 4.04,
        },
        {
          venueName: 'Dona Simona',
          cardType: 'CREDIT',
          txCount: 2,
          grossAmount: 200,
          tips: 10,
          layer1Rate: 0.025,
          layer1Fee: 5,
          layer1Iva: 0.8,
          netAfterLayer1: 194.2,
          layer2Rate: 0.0462,
          layer2Fee: 8.97,
          netToVenue: 185.23,
          referredBy: 'EXTERNAL',
          externalShare: 6.28,
          aggregatorShare: 2.69,
        },
      ]

      const breakdown = buildVenueBreakdown(rows)

      expect(breakdown).toHaveLength(1)
      expect(breakdown[0].venueName).toBe('Dona Simona')
      expect(breakdown[0].txCount).toBe(5)
      expect(breakdown[0].grossAmount).toBe(500)
      expect(breakdown[0].layer1Iva).toBeCloseTo(2.0, 1)
      expect(breakdown[0].layer2Fee).toBeCloseTo(22.43, 1)
      expect(breakdown[0].externalShare).toBeCloseTo(15.7, 1)
      expect(breakdown[0].aggregatorShare).toBeCloseTo(6.73, 1)
    })
  })

  describe('buildGrandTotals', () => {
    it('should sum all rows into grand totals without L2 IVA', () => {
      const rows: CommissionRow[] = [
        {
          venueName: 'A',
          cardType: 'DEBIT',
          txCount: 1,
          grossAmount: 100,
          tips: 5,
          layer1Rate: 0.025,
          layer1Fee: 2.5,
          layer1Iva: 0.4,
          netAfterLayer1: 97.1,
          layer2Rate: 0.05,
          layer2Fee: 4.86,
          netToVenue: 92.24,
          referredBy: 'EXTERNAL',
          externalShare: 3.4,
          aggregatorShare: 1.46,
        },
        {
          venueName: 'B',
          cardType: 'CREDIT',
          txCount: 2,
          grossAmount: 200,
          tips: 10,
          layer1Rate: 0.025,
          layer1Fee: 5,
          layer1Iva: 0.8,
          netAfterLayer1: 194.2,
          layer2Rate: 0.07,
          layer2Fee: 13.59,
          netToVenue: 180.61,
          referredBy: 'AGGREGATOR',
          externalShare: 4.08,
          aggregatorShare: 9.51,
        },
      ]

      const totals = buildGrandTotals(rows)

      expect(totals.txCount).toBe(3)
      expect(totals.grossAmount).toBe(300)
      expect(totals.layer1Iva).toBeCloseTo(1.2, 1)
      expect(totals.layer2Fee).toBeCloseTo(18.45, 1)
      expect(totals.externalShare).toBeCloseTo(7.48, 1)
      expect(totals.aggregatorShare).toBeCloseTo(10.97, 1)
    })
  })
})
