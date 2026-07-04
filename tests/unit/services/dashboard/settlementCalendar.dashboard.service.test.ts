import { projectPaymentSettlement } from '@/services/dashboard/settlementCalendar.dashboard.service'

const TZ = 'America/Mexico_City'

const cfg = {
  merchantAccountId: 'm1',
  cardType: 'CREDIT' as const,
  settlementDays: 1,
  settlementDayType: 'BUSINESS_DAYS' as const,
  cutoffTime: '23:00',
  cutoffTimezone: TZ,
  effectiveFrom: new Date('2026-01-01'),
  effectiveTo: null,
}

describe('projectPaymentSettlement', () => {
  it('projects net = gross − (charge+fixed) onto the venue-tz settlement day', () => {
    const p = {
      amount: 1000,
      tipAmount: 50,
      createdAt: new Date('2026-07-04T02:00:00Z'),
      merchantAccountId: 'm1',
      transactionCost: { transactionType: 'CREDIT' as const, venueChargeAmount: 30, venueFixedFee: 5 },
    }
    expect(projectPaymentSettlement(p, [cfg], TZ)).toEqual({
      settlementDateKey: '2026-07-06',
      gross: 1050,
      commission: 35,
      net: 1015,
      settlementDays: 1,
    })
  })

  it('returns null with no cost', () => {
    const p = {
      amount: 100,
      tipAmount: 0,
      createdAt: new Date('2026-07-01T18:00:00Z'),
      merchantAccountId: 'm1',
      transactionCost: null,
    }
    expect(projectPaymentSettlement(p, [cfg], TZ)).toBeNull()
  })

  it('returns null when no active config matches the merchant×cardType', () => {
    const p = {
      amount: 100,
      tipAmount: 0,
      createdAt: new Date('2026-07-01T18:00:00Z'),
      merchantAccountId: 'zzz',
      transactionCost: { transactionType: 'CREDIT' as const, venueChargeAmount: 4, venueFixedFee: 0 },
    }
    expect(projectPaymentSettlement(p, [cfg], TZ)).toBeNull()
  })
})
