import { formatScheme } from '../../../src/mcp/tools/commissions'

// Avoid ts-jest compiling the heavy access.service graph (imported transitively
// via the guard). formatScheme is pure and doesn't use it.
jest.mock('@/services/access/access.service', () => ({
  hasPermission: () => true,
  getUserAccess: jest.fn(),
  createAccessCache: jest.fn(() => ({})),
}))

describe('formatScheme', () => {
  const categoryName = new Map([
    ['cat-1', 'Hidrógeno'],
    ['cat-2', 'Iyashi'],
  ])

  it('maps a tiered scheme: STAFF_GOAL boundaries -> EMPLOYEE_GOAL, fixed -> numbers, categories -> names', () => {
    const scheme = formatScheme(
      {
        id: 'c1',
        venueId: 'v1',
        name: 'Hidrógeno + Iyashi',
        priority: 100,
        recipient: 'SERVER',
        calcType: 'TIERED',
        defaultRate: '0.04',
        filterByCategories: true,
        categoryIds: ['cat-1', 'cat-2'],
        useGoalAsTier: false,
        goalBonusRate: null,
        tiers: [
          {
            tierLevel: 1,
            tierName: 'Base',
            minThreshold: '0',
            maxThreshold: '30000',
            minThresholdType: 'FIXED',
            maxThresholdType: 'FIXED',
            rate: '0.04',
          },
          {
            tierLevel: 2,
            tierName: 'Meta',
            minThreshold: '30000',
            maxThreshold: '0',
            minThresholdType: 'FIXED',
            maxThresholdType: 'STAFF_GOAL',
            rate: '0.06',
          },
          {
            tierLevel: 3,
            tierName: 'Super',
            minThreshold: '0',
            maxThreshold: null,
            minThresholdType: 'STAFF_GOAL',
            maxThresholdType: 'FIXED',
            rate: '0.08',
          },
        ],
      } as never,
      categoryName,
    )

    expect(scheme.appliesTo).toEqual(['Hidrógeno', 'Iyashi'])
    expect(scheme.defaultRate).toBe(0.04)
    expect(scheme.tiers[0]).toMatchObject({ from: 0, to: 30000, rate: 0.04 })
    expect(scheme.tiers[1].to).toBe('EMPLOYEE_GOAL') // max = the employee's goal
    expect(scheme.tiers[2].from).toBe('EMPLOYEE_GOAL') // min = the employee's goal
    expect(scheme.tiers[2].to).toBeNull() // open-ended top band
  })

  it('flat scheme without category filter -> ALL_CATEGORIES, numeric rate', () => {
    const scheme = formatScheme(
      {
        id: 'c2',
        venueId: 'v1',
        name: 'Lagree 3%',
        priority: 0,
        recipient: 'SERVER',
        calcType: 'PERCENTAGE',
        defaultRate: '0.03',
        filterByCategories: false,
        categoryIds: [],
        useGoalAsTier: false,
        goalBonusRate: null,
        tiers: [],
      } as never,
      categoryName,
    )

    expect(scheme.appliesTo).toBe('ALL_CATEGORIES')
    expect(scheme.defaultRate).toBe(0.03)
    expect(scheme.tiers).toEqual([])
  })
})
