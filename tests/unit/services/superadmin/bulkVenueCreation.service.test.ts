/**
 * Bulk Venue Creation Service Unit Tests
 */

import { Prisma } from '@prisma/client'

// ── Mock Prisma ──────────────────────────────────────────────────────

const mockPrisma = {
  organization: {
    findUnique: jest.fn(),
  },
  venue: {
    create: jest.fn(),
    findMany: jest.fn(),
  },
  venueSettings: {
    create: jest.fn(),
  },
  terminal: {
    create: jest.fn(),
    findMany: jest.fn(),
  },
  venuePaymentConfig: {
    create: jest.fn(),
  },
  venuePricingStructure: {
    create: jest.fn(),
  },
  settlementConfiguration: {
    create: jest.fn(),
  },
  merchantAccount: {
    findMany: jest.fn(),
  },
  $transaction: jest.fn(),
}

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: mockPrisma,
}))

jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}))

// Import after mocks
import { bulkCreateVenues, ValidationError } from '../../../../src/services/superadmin/bulkVenueCreation.service'

// ── Helpers ──────────────────────────────────────────────────────────

const mockOrg = { id: 'org-1', name: 'Test Org' }

function setupTransaction() {
  // Make $transaction execute the callback with the mock prisma as tx
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<any>) => {
    return fn(mockPrisma)
  })
}

function setupDefaults() {
  mockPrisma.organization.findUnique.mockResolvedValue(mockOrg)
  mockPrisma.venue.findMany.mockResolvedValue([]) // No slug collisions
  mockPrisma.terminal.findMany.mockResolvedValue([]) // No serial collisions

  let venueCounter = 0
  mockPrisma.venue.create.mockImplementation(async ({ data }: any) => ({
    id: `venue-${++venueCounter}`,
    name: data.name,
    slug: data.slug,
    status: data.status,
    type: data.type,
    feeType: data.feeType,
    feeValue: data.feeValue,
    timezone: data.timezone,
    currency: data.currency,
    country: data.country,
  }))

  mockPrisma.venueSettings.create.mockResolvedValue({ id: 'vs-1' })

  let terminalCounter = 0
  mockPrisma.terminal.create.mockImplementation(async ({ data }: any) => ({
    id: `terminal-${++terminalCounter}`,
    serialNumber: data.serialNumber,
    status: data.status,
    name: data.name,
  }))

  mockPrisma.venuePaymentConfig.create.mockResolvedValue({ id: 'vpc-1' })
  mockPrisma.venuePricingStructure.create.mockResolvedValue({ id: 'vps-1' })
  mockPrisma.settlementConfiguration.create.mockResolvedValue({ id: 'sc-1' })

  setupTransaction()
}

// ── Tests ────────────────────────────────────────────────────────────

describe('bulkCreateVenues', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('venue creation', () => {
    it('should create N venues with VenueSettings', async () => {
      setupDefaults()

      const result = await bulkCreateVenues({
        organizationId: 'org-1',
        venues: [{ name: 'Venue A' }, { name: 'Venue B' }, { name: 'Venue C' }],
      })

      expect(result.success).toBe(true)
      expect(result.summary.venuesCreated).toBe(3)
      expect(result.venues).toHaveLength(3)
      expect(mockPrisma.venue.create).toHaveBeenCalledTimes(3)
      expect(mockPrisma.venueSettings.create).toHaveBeenCalledTimes(3)
    })

    it('should set status ACTIVE for all created venues', async () => {
      setupDefaults()

      const result = await bulkCreateVenues({
        organizationId: 'org-1',
        venues: [{ name: 'Venue A' }],
      })

      expect(result.venues[0].status).toBe('ACTIVE')
      expect(mockPrisma.venue.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'ACTIVE' }),
        }),
      )
    })
  })

  describe('new venue fields (lat/lng, entityType, rfc, legalName, website)', () => {
    it('should pass latitude, longitude, website to venue creation', async () => {
      setupDefaults()

      await bulkCreateVenues({
        organizationId: 'org-1',
        venues: [
          {
            name: 'Venue A',
            latitude: 19.4326,
            longitude: -99.1332,
            website: 'https://example.com',
          },
        ],
      })

      const data = mockPrisma.venue.create.mock.calls[0][0].data
      expect(data.latitude).toEqual(new Prisma.Decimal(19.4326))
      expect(data.longitude).toEqual(new Prisma.Decimal(-99.1332))
      expect(data.website).toBe('https://example.com')
    })

    it('should pass entityType, rfc, legalName to venue creation', async () => {
      setupDefaults()

      await bulkCreateVenues({
        organizationId: 'org-1',
        venues: [
          {
            name: 'Venue A',
            entityType: 'PERSONA_MORAL',
            rfc: 'ABC123456XYZ',
            legalName: 'Mi Empresa SA de CV',
          },
        ],
      })

      const data = mockPrisma.venue.create.mock.calls[0][0].data
      expect(data.entityType).toBe('PERSONA_MORAL')
      expect(data.rfc).toBe('ABC123456XYZ')
      expect(data.legalName).toBe('Mi Empresa SA de CV')
    })

    it('should apply entityType from defaults', async () => {
      setupDefaults()

      await bulkCreateVenues({
        organizationId: 'org-1',
        defaults: { entityType: 'PERSONA_FISICA' },
        venues: [{ name: 'Venue A' }],
      })

      const data = mockPrisma.venue.create.mock.calls[0][0].data
      expect(data.entityType).toBe('PERSONA_FISICA')
    })

    it('should set null for optional fields when not provided', async () => {
      setupDefaults()

      await bulkCreateVenues({
        organizationId: 'org-1',
        venues: [{ name: 'Venue A' }],
      })

      const data = mockPrisma.venue.create.mock.calls[0][0].data
      expect(data.latitude).toBeNull()
      expect(data.longitude).toBeNull()
      expect(data.website).toBeNull()
      expect(data.entityType).toBeNull()
      expect(data.rfc).toBeNull()
      expect(data.legalName).toBeNull()
    })
  })

  describe('defaults and overrides', () => {
    it('should apply defaults to all venues', async () => {
      setupDefaults()

      await bulkCreateVenues({
        organizationId: 'org-1',
        defaults: {
          type: 'TELECOMUNICACIONES',
          timezone: 'America/Monterrey',
          currency: 'USD',
          country: 'US',
          feeType: 'FIXED',
          feeValue: 0.05,
        },
        venues: [{ name: 'Venue A' }, { name: 'Venue B' }],
      })

      for (const call of mockPrisma.venue.create.mock.calls) {
        const data = call[0].data
        expect(data.type).toBe('TELECOMUNICACIONES')
        expect(data.timezone).toBe('America/Monterrey')
        expect(data.currency).toBe('USD')
        expect(data.country).toBe('US')
        expect(data.feeType).toBe('FIXED')
        expect(data.feeValue).toEqual(new Prisma.Decimal(0.05))
      }
    })

    it('should allow per-venue overrides over defaults', async () => {
      setupDefaults()

      await bulkCreateVenues({
        organizationId: 'org-1',
        defaults: {
          type: 'TELECOMUNICACIONES',
          feeValue: 0.025,
        },
        venues: [
          { name: 'Venue A', type: 'RETAIL_STORE', feeValue: 0.03 },
          { name: 'Venue B' }, // uses defaults
        ],
      })

      const calls = mockPrisma.venue.create.mock.calls
      expect(calls[0][0].data.type).toBe('RETAIL_STORE')
      expect(calls[0][0].data.feeValue).toEqual(new Prisma.Decimal(0.03))
      expect(calls[1][0].data.type).toBe('TELECOMUNICACIONES')
      expect(calls[1][0].data.feeValue).toEqual(new Prisma.Decimal(0.025))
    })

    it('should merge default settings with per-venue settings overrides', async () => {
      setupDefaults()

      await bulkCreateVenues({
        organizationId: 'org-1',
        defaults: {
          settings: {
            trackInventory: true,
            acceptCash: true,
            paymentTiming: 'PAY_BEFORE',
          },
        },
        venues: [{ name: 'Venue A', settings: { trackInventory: false } }],
      })

      const settingsCall = mockPrisma.venueSettings.create.mock.calls[0][0].data
      expect(settingsCall.trackInventory).toBe(false) // overridden
      expect(settingsCall.acceptCash).toBe(true) // from defaults
      expect(settingsCall.paymentTiming).toBe('PAY_BEFORE') // from defaults
    })
  })

  describe('terminals', () => {
    it('should create terminals linked to their venues', async () => {
      setupDefaults()

      const result = await bulkCreateVenues({
        organizationId: 'org-1',
        venues: [
          {
            name: 'Venue A',
            terminals: [
              { serialNumber: 'SN001', name: 'Terminal 1', type: 'TPV_ANDROID' },
              { serialNumber: 'SN002', name: 'Terminal 2', type: 'TPV_ANDROID', brand: 'PAX', model: 'A910S' },
            ],
          },
        ],
      })

      expect(result.summary.terminalsCreated).toBe(2)
      expect(result.venues[0].terminals).toHaveLength(2)
      expect(mockPrisma.terminal.create).toHaveBeenCalledTimes(2)

      // Verify terminal was linked to the correct venue
      const firstCall = mockPrisma.terminal.create.mock.calls[0][0].data
      expect(firstCall.venueId).toBe('venue-1')
      expect(firstCall.serialNumber).toBe('SN001')
      expect(firstCall.status).toBe('INACTIVE')
    })

    it('should reject duplicate serial numbers within batch', async () => {
      setupDefaults()

      await expect(
        bulkCreateVenues({
          organizationId: 'org-1',
          venues: [
            { name: 'Venue A', terminals: [{ serialNumber: 'SN001', name: 'T1', type: 'TPV_ANDROID' }] },
            { name: 'Venue B', terminals: [{ serialNumber: 'SN001', name: 'T2', type: 'TPV_ANDROID' }] },
          ],
        }),
      ).rejects.toThrow('Número de serie duplicado en el lote: SN001')
    })

    it('should reject serial numbers that already exist in DB', async () => {
      setupDefaults()
      mockPrisma.terminal.findMany.mockResolvedValue([{ serialNumber: 'SN999' }])

      await expect(
        bulkCreateVenues({
          organizationId: 'org-1',
          venues: [{ name: 'Venue A', terminals: [{ serialNumber: 'SN999', name: 'T1', type: 'TPV_ANDROID' }] }],
        }),
      ).rejects.toThrow('El número de serie ya existe: SN999')
    })
  })

  describe('payment config', () => {
    it('should create VenuePaymentConfig when defaultMerchantAccountId is provided', async () => {
      setupDefaults()
      mockPrisma.merchantAccount.findMany.mockResolvedValue([{ id: 'merchant-1', active: true }])

      const result = await bulkCreateVenues({
        organizationId: 'org-1',
        defaultMerchantAccountId: 'merchant-1',
        venues: [{ name: 'Venue A' }, { name: 'Venue B' }],
      })

      expect(result.summary.paymentConfigsCreated).toBe(2)
      expect(result.venues[0].paymentConfigured).toBe(true)
      expect(result.venues[1].paymentConfigured).toBe(true)
      expect(mockPrisma.venuePaymentConfig.create).toHaveBeenCalledTimes(2)
    })

    it('should use per-venue merchantAccountId over default', async () => {
      setupDefaults()
      mockPrisma.merchantAccount.findMany.mockResolvedValue([
        { id: 'merchant-1', active: true },
        { id: 'merchant-2', active: true },
      ])

      await bulkCreateVenues({
        organizationId: 'org-1',
        defaultMerchantAccountId: 'merchant-1',
        venues: [
          { name: 'Venue A', merchantAccountId: 'merchant-2' },
          { name: 'Venue B' }, // uses default
        ],
      })

      const calls = mockPrisma.venuePaymentConfig.create.mock.calls
      expect(calls[0][0].data.primaryAccountId).toBe('merchant-2')
      expect(calls[1][0].data.primaryAccountId).toBe('merchant-1')
    })

    it('should not create VenuePaymentConfig when no merchant specified', async () => {
      setupDefaults()

      const result = await bulkCreateVenues({
        organizationId: 'org-1',
        venues: [{ name: 'Venue A' }],
      })

      expect(result.summary.paymentConfigsCreated).toBe(0)
      expect(result.venues[0].paymentConfigured).toBe(false)
      expect(mockPrisma.venuePaymentConfig.create).not.toHaveBeenCalled()
    })
  })

  describe('pricing structures', () => {
    it('should create VenuePricingStructure when defaultPricing is provided', async () => {
      setupDefaults()

      const result = await bulkCreateVenues({
        organizationId: 'org-1',
        defaultPricing: {
          debitRate: 0.025,
          creditRate: 0.035,
          amexRate: 0.04,
          internationalRate: 0.045,
          fixedFeePerTransaction: 0.75,
          monthlyServiceFee: 299,
        },
        venues: [{ name: 'Venue A' }, { name: 'Venue B' }],
      })

      expect(result.summary.pricingStructuresCreated).toBe(2)
      expect(result.venues[0].pricingConfigured).toBe(true)
      expect(result.venues[1].pricingConfigured).toBe(true)
      expect(mockPrisma.venuePricingStructure.create).toHaveBeenCalledTimes(2)

      // Verify pricing data
      const pricingData = mockPrisma.venuePricingStructure.create.mock.calls[0][0].data
      expect(pricingData.accountType).toBe('PRIMARY')
      expect(pricingData.debitRate).toEqual(new Prisma.Decimal(0.025))
      expect(pricingData.creditRate).toEqual(new Prisma.Decimal(0.035))
      expect(pricingData.amexRate).toEqual(new Prisma.Decimal(0.04))
      expect(pricingData.internationalRate).toEqual(new Prisma.Decimal(0.045))
      expect(pricingData.fixedFeePerTransaction).toEqual(new Prisma.Decimal(0.75))
      expect(pricingData.monthlyServiceFee).toEqual(new Prisma.Decimal(299))
      expect(pricingData.active).toBe(true)
      expect(pricingData.effectiveFrom).toBeInstanceOf(Date)
    })

    it('should allow per-venue pricing override over defaultPricing', async () => {
      setupDefaults()

      await bulkCreateVenues({
        organizationId: 'org-1',
        defaultPricing: {
          debitRate: 0.025,
          creditRate: 0.035,
          amexRate: 0.04,
          internationalRate: 0.045,
        },
        venues: [
          {
            name: 'Venue A',
            pricing: { debitRate: 0.02, creditRate: 0.03, amexRate: 0.035, internationalRate: 0.04 },
          },
          { name: 'Venue B' }, // uses default
        ],
      })

      const calls = mockPrisma.venuePricingStructure.create.mock.calls
      expect(calls[0][0].data.debitRate).toEqual(new Prisma.Decimal(0.02)) // overridden
      expect(calls[1][0].data.debitRate).toEqual(new Prisma.Decimal(0.025)) // default
    })

    it('should not create VenuePricingStructure when no pricing specified', async () => {
      setupDefaults()

      const result = await bulkCreateVenues({
        organizationId: 'org-1',
        venues: [{ name: 'Venue A' }],
      })

      expect(result.summary.pricingStructuresCreated).toBe(0)
      expect(result.venues[0].pricingConfigured).toBe(false)
      expect(mockPrisma.venuePricingStructure.create).not.toHaveBeenCalled()
    })
  })

  describe('settlement configurations', () => {
    it('should create 5 SettlementConfiguration records when settlement + merchant provided', async () => {
      setupDefaults()
      mockPrisma.merchantAccount.findMany.mockResolvedValue([{ id: 'merchant-1', active: true }])

      const result = await bulkCreateVenues({
        organizationId: 'org-1',
        defaultMerchantAccountId: 'merchant-1',
        defaultSettlement: {
          debitDays: 1,
          creditDays: 3,
          amexDays: 5,
          internationalDays: 7,
          otherDays: 3,
          dayType: 'BUSINESS_DAYS',
          cutoffTime: '22:00',
          cutoffTimezone: 'America/Mexico_City',
        },
        venues: [{ name: 'Venue A' }],
      })

      expect(result.summary.settlementConfigsCreated).toBe(5) // 5 card types
      expect(result.venues[0].settlementConfigured).toBe(true)
      expect(mockPrisma.settlementConfiguration.create).toHaveBeenCalledTimes(5)

      // Verify card types are all covered
      const cardTypes = mockPrisma.settlementConfiguration.create.mock.calls.map((c: any) => c[0].data.cardType)
      expect(cardTypes).toContain('DEBIT')
      expect(cardTypes).toContain('CREDIT')
      expect(cardTypes).toContain('AMEX')
      expect(cardTypes).toContain('INTERNATIONAL')
      expect(cardTypes).toContain('OTHER')

      // Verify days match
      const debitConfig = mockPrisma.settlementConfiguration.create.mock.calls.find((c: any) => c[0].data.cardType === 'DEBIT')
      expect(debitConfig[0].data.settlementDays).toBe(1)
      expect(debitConfig[0].data.settlementDayType).toBe('BUSINESS_DAYS')
      expect(debitConfig[0].data.cutoffTime).toBe('22:00')
    })

    it('should NOT create settlement configs when no merchant account is provided', async () => {
      setupDefaults()

      const result = await bulkCreateVenues({
        organizationId: 'org-1',
        defaultSettlement: {
          debitDays: 1,
          creditDays: 3,
          amexDays: 5,
          internationalDays: 7,
          otherDays: 3,
          dayType: 'BUSINESS_DAYS',
        },
        venues: [{ name: 'Venue A' }],
      })

      // Settlement requires a merchant account
      expect(result.summary.settlementConfigsCreated).toBe(0)
      expect(result.venues[0].settlementConfigured).toBe(false)
      expect(mockPrisma.settlementConfiguration.create).not.toHaveBeenCalled()
    })

    it('should allow per-venue settlement override', async () => {
      setupDefaults()
      mockPrisma.merchantAccount.findMany.mockResolvedValue([{ id: 'merchant-1', active: true }])

      await bulkCreateVenues({
        organizationId: 'org-1',
        defaultMerchantAccountId: 'merchant-1',
        defaultSettlement: {
          debitDays: 1,
          creditDays: 3,
          amexDays: 5,
          internationalDays: 7,
          otherDays: 3,
          dayType: 'BUSINESS_DAYS',
        },
        venues: [
          {
            name: 'Venue A',
            settlement: {
              debitDays: 2,
              creditDays: 4,
              amexDays: 6,
              internationalDays: 8,
              otherDays: 4,
              dayType: 'CALENDAR_DAYS',
            },
          },
        ],
      })

      const debitConfig = mockPrisma.settlementConfiguration.create.mock.calls.find((c: any) => c[0].data.cardType === 'DEBIT')
      expect(debitConfig[0].data.settlementDays).toBe(2) // overridden
      expect(debitConfig[0].data.settlementDayType).toBe('CALENDAR_DAYS') // overridden
    })
  })

  describe('slug generation', () => {
    it('should generate unique slugs for venues with different names', async () => {
      setupDefaults()

      const result = await bulkCreateVenues({
        organizationId: 'org-1',
        venues: [{ name: 'Venue Alpha' }, { name: 'Venue Beta' }],
      })

      const slugs = result.venues.map(v => v.slug)
      expect(slugs[0]).toBe('venue-alpha')
      expect(slugs[1]).toBe('venue-beta')
    })

    it('should handle slug collisions within batch', async () => {
      setupDefaults()

      const result = await bulkCreateVenues({
        organizationId: 'org-1',
        venues: [{ name: 'Same Name' }, { name: 'Same Name' }, { name: 'Same Name' }],
      })

      const slugs = result.venues.map(v => v.slug)
      expect(new Set(slugs).size).toBe(3) // all unique
      expect(slugs[0]).toBe('same-name')
      expect(slugs[1]).toBe('same-name-1')
      expect(slugs[2]).toBe('same-name-2')
    })

    it('should handle slug collisions with existing DB slugs', async () => {
      setupDefaults()
      mockPrisma.venue.findMany.mockResolvedValue([{ slug: 'existing-venue' }])

      const result = await bulkCreateVenues({
        organizationId: 'org-1',
        venues: [{ name: 'Existing Venue' }],
      })

      expect(result.venues[0].slug).toBe('existing-venue-1')
    })
  })

  describe('organization validation', () => {
    it('should fail entire batch on invalid organization ID', async () => {
      setupDefaults()
      mockPrisma.organization.findUnique.mockResolvedValue(null)

      await expect(
        bulkCreateVenues({
          organizationId: 'nonexistent-org',
          venues: [{ name: 'Venue A' }],
        }),
      ).rejects.toThrow('Organización no encontrada')
    })

    it('should resolve organization by slug', async () => {
      setupDefaults()

      await bulkCreateVenues({
        organizationSlug: 'test-org',
        venues: [{ name: 'Venue A' }],
      })

      expect(mockPrisma.organization.findUnique).toHaveBeenCalledWith({
        where: { slug: 'test-org' },
        select: { id: true, name: true },
      })
    })
  })

  describe('merchant account validation', () => {
    it('should reject non-existent merchant account', async () => {
      setupDefaults()
      mockPrisma.merchantAccount.findMany.mockResolvedValue([])

      await expect(
        bulkCreateVenues({
          organizationId: 'org-1',
          defaultMerchantAccountId: 'nonexistent-merchant',
          venues: [{ name: 'Venue A' }],
        }),
      ).rejects.toThrow('Cuenta de comerciante no encontrada')
    })

    it('should reject inactive merchant account', async () => {
      setupDefaults()
      mockPrisma.merchantAccount.findMany.mockResolvedValue([{ id: 'merchant-1', active: false }])

      await expect(
        bulkCreateVenues({
          organizationId: 'org-1',
          defaultMerchantAccountId: 'merchant-1',
          venues: [{ name: 'Venue A' }],
        }),
      ).rejects.toThrow('Cuenta de comerciante no está activa')
    })
  })

  describe('transaction atomicity', () => {
    it('should call prisma.$transaction for all-or-nothing creation', async () => {
      setupDefaults()

      await bulkCreateVenues({
        organizationId: 'org-1',
        venues: [{ name: 'Venue A' }],
      })

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
      expect(mockPrisma.$transaction).toHaveBeenCalledWith(expect.any(Function))
    })

    it('should propagate transaction errors', async () => {
      setupDefaults()
      mockPrisma.$transaction.mockRejectedValue(new Error('DB constraint violation'))

      await expect(
        bulkCreateVenues({
          organizationId: 'org-1',
          venues: [{ name: 'Venue A' }],
        }),
      ).rejects.toThrow('DB constraint violation')
    })
  })

  describe('response structure', () => {
    it('should return correct summary and per-venue details', async () => {
      setupDefaults()
      mockPrisma.merchantAccount.findMany.mockResolvedValue([{ id: 'merchant-1', active: true }])

      const result = await bulkCreateVenues({
        organizationId: 'org-1',
        defaultMerchantAccountId: 'merchant-1',
        venues: [
          {
            name: 'Venue A',
            terminals: [{ serialNumber: 'SN001', name: 'T1', type: 'TPV_ANDROID' }],
          },
          { name: 'Venue B' },
        ],
      })

      expect(result.success).toBe(true)
      expect(result.summary).toEqual({
        venuesCreated: 2,
        venuesFailed: 0,
        terminalsCreated: 1,
        terminalsFailed: 0,
        paymentConfigsCreated: 2,
        pricingStructuresCreated: 0,
        settlementConfigsCreated: 0,
      })
      expect(result.errors).toEqual([])

      // Per-venue details
      expect(result.venues[0]).toMatchObject({
        index: 0,
        name: 'Venue A',
        venueId: expect.any(String),
        slug: 'venue-a',
        paymentConfigured: true,
        pricingConfigured: false,
        settlementConfigured: false,
      })
      expect(result.venues[0].terminals).toHaveLength(1)
      expect(result.venues[1].terminals).toHaveLength(0)
    })

    it('should return correct summary with pricing + settlement', async () => {
      setupDefaults()
      mockPrisma.merchantAccount.findMany.mockResolvedValue([{ id: 'merchant-1', active: true }])

      const result = await bulkCreateVenues({
        organizationId: 'org-1',
        defaultMerchantAccountId: 'merchant-1',
        defaultPricing: {
          debitRate: 0.025,
          creditRate: 0.035,
          amexRate: 0.04,
          internationalRate: 0.045,
        },
        defaultSettlement: {
          debitDays: 1,
          creditDays: 3,
          amexDays: 5,
          internationalDays: 7,
          otherDays: 3,
          dayType: 'BUSINESS_DAYS',
        },
        venues: [{ name: 'Venue A' }],
      })

      expect(result.summary).toEqual({
        venuesCreated: 1,
        venuesFailed: 0,
        terminalsCreated: 0,
        terminalsFailed: 0,
        paymentConfigsCreated: 1,
        pricingStructuresCreated: 1,
        settlementConfigsCreated: 5,
      })
      expect(result.venues[0].pricingConfigured).toBe(true)
      expect(result.venues[0].settlementConfigured).toBe(true)
    })
  })
})
