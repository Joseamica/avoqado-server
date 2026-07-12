/**
 * Orquestador getMerchantEligibility — unit tests con Prisma/servicios mockeados.
 *
 * Cubre lo que el motor puro no puede: gating PREMIUM server-side, carga de
 * reglas, agregados por merchant/período, fallback auditado en ActivityLog y
 * fail-open ante Json inválido en DB.
 */
import { getMerchantEligibility } from '../../../../src/services/tpv/merchantRouting.service'
import { NotFoundError } from '../../../../src/errors/AppError'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    merchantRoutingRule: { findMany: jest.fn() },
    payment: { groupBy: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    terminal: { findFirst: jest.fn(), findMany: jest.fn() },
    merchantAccount: { findMany: jest.fn() },
  },
}))
jest.mock('../../../../src/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(),
}))
jest.mock('../../../../src/services/organization-payment-config.service', () => ({
  getEffectivePaymentConfig: jest.fn(),
}))
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn().mockResolvedValue(undefined),
}))

import prisma from '../../../../src/utils/prismaClient'
import { venueHasFeatureAccess } from '../../../../src/services/access/basePlan.service'
import { getEffectivePaymentConfig } from '../../../../src/services/organization-payment-config.service'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'

const mockPrisma = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  merchantRoutingRule: { findMany: jest.Mock }
  payment: { groupBy: jest.Mock }
  staffVenue: { findFirst: jest.Mock }
  terminal: { findFirst: jest.Mock; findMany: jest.Mock }
  merchantAccount: { findMany: jest.Mock }
}
const mockFeature = venueHasFeatureAccess as jest.Mock
const mockEffectiveCfg = getEffectivePaymentConfig as jest.Mock
const mockLogAction = logAction as jest.Mock

/** El universo visible se deriva de terminales + slots; este helper lo configura entero. */
function mockVisibleMerchants(ids: string[]) {
  mockPrisma.terminal.findFirst.mockResolvedValue(null)
  mockPrisma.terminal.findMany.mockResolvedValue([{ assignedMerchantIds: ids }])
  mockEffectiveCfg.mockResolvedValue(null)
  mockPrisma.merchantAccount.findMany.mockResolvedValue(
    ids.map((id, i) => ({ id, displayName: id.toUpperCase(), displayOrder: i, provider: { code: 'BLUMON_TPV' } })),
  )
}

const VENUE = { id: 'venue_1', timezone: 'America/Mexico_City' }
// Jueves 2026-07-09 16:30 México = 2026-07-09T22:30:00Z (UTC-6, sin DST)
const SIMULATE_AT = '2026-07-09T22:30:00.000Z'

const scheduleDay = { schedule: { days: [4], windows: [{ start: '09:00', end: '18:00' }] } } // jueves de día
const scheduleNight = { schedule: { days: [4], windows: [{ start: '18:00', end: '23:00' }] } } // jueves de noche

beforeEach(() => {
  jest.clearAllMocks()
  mockPrisma.venue.findUnique.mockResolvedValue(VENUE)
  mockPrisma.merchantRoutingRule.findMany.mockResolvedValue([])
  mockPrisma.payment.groupBy.mockResolvedValue([])
  mockPrisma.staffVenue.findFirst.mockResolvedValue(null)
  mockFeature.mockResolvedValue(true)
  mockVisibleMerchants(['ma_A', 'ma_B'])
})

describe('getMerchantEligibility (orquestador)', () => {
  it('venue inexistente ⇒ NotFoundError', async () => {
    mockPrisma.venue.findUnique.mockResolvedValue(null)
    await expect(getMerchantEligibility('nope', { amount: 100 })).rejects.toThrow(NotFoundError)
  })

  it('feature OFF ⇒ todos elegibles, sin auto-select, y NO consulta reglas (idéntico a hoy)', async () => {
    mockFeature.mockResolvedValue(false)
    const r = await getMerchantEligibility('venue_1', { amount: 100, simulateAt: SIMULATE_AT })
    expect(r.routingFeatureActive).toBe(false)
    expect(r.merchants).toEqual([
      { merchantAccountId: 'ma_A', eligible: true, reasons: [] },
      { merchantAccountId: 'ma_B', eligible: true, reasons: [] },
    ])
    expect(r.autoSelectMerchantAccountId).toBeNull()
    expect(r.fallbackAll).toBe(false)
    expect(mockPrisma.merchantRoutingRule.findMany).not.toHaveBeenCalled()
  })

  it('feature ON: regla de horario deja 1 elegible ⇒ auto-select', async () => {
    mockPrisma.merchantRoutingRule.findMany.mockResolvedValue([
      { id: 'r1', merchantAccountId: 'ma_A', conditions: scheduleDay },
      { id: 'r2', merchantAccountId: 'ma_B', conditions: scheduleNight },
    ])
    const r = await getMerchantEligibility('venue_1', { amount: 100, simulateAt: SIMULATE_AT })
    expect(r.routingFeatureActive).toBe(true)
    expect(r.autoSelectMerchantAccountId).toBe('ma_A') // 16:30 jueves
    expect(r.merchants.find(m => m.merchantAccountId === 'ma_B')!.eligible).toBe(false)
    expect(r.fallbackAll).toBe(false)
  })

  it('volumeCap: agrega por merchant con el inicio de período correcto y excluye al saturado', async () => {
    mockPrisma.merchantRoutingRule.findMany.mockResolvedValue([
      { id: 'r1', merchantAccountId: 'ma_A', conditions: { volumeCap: { period: 'DAY', maxAmount: 10000 } } },
      { id: 'r2', merchantAccountId: 'ma_B', conditions: { volumeCap: { period: 'DAY', maxAmount: 10000 } } },
    ])
    mockPrisma.payment.groupBy.mockResolvedValue([
      // Bruto = amount + tip. ma_A saturado (9,900 + ticket 200 > 10,000); ma_B libre.
      { merchantAccountId: 'ma_A', _sum: { amount: 9800, tipAmount: 100 }, _count: { _all: 12 } },
      { merchantAccountId: 'ma_B', _sum: { amount: 100, tipAmount: 0 }, _count: { _all: 1 } },
    ])

    const r = await getMerchantEligibility('venue_1', { amount: 200, simulateAt: SIMULATE_AT })

    expect(r.merchants.find(m => m.merchantAccountId === 'ma_A')!.eligible).toBe(false)
    expect(r.autoSelectMerchantAccountId).toBe('ma_B')

    // Inicio del DAY en TZ venue: 2026-07-09T00:00 México = 06:00Z (host-tz-independiente)
    const call = mockPrisma.payment.groupBy.mock.calls[0][0]
    expect(call.where.createdAt.gte.toISOString()).toBe('2026-07-09T06:00:00.000Z')
    expect(call.where.status).toBe('COMPLETED')
    expect(call.where.venueId).toBe('venue_1')
  })

  it('merchant con tope y CERO pagos en el período ⇒ elegible ({0,0}, no falla cerrado)', async () => {
    mockPrisma.merchantRoutingRule.findMany.mockResolvedValue([
      { id: 'r1', merchantAccountId: 'ma_A', conditions: { volumeCap: { period: 'WEEK', maxAmount: 10000 } } },
    ])
    mockPrisma.payment.groupBy.mockResolvedValue([]) // sin filas
    const r = await getMerchantEligibility('venue_1', { amount: 200, simulateAt: SIMULATE_AT })
    expect(r.merchants.find(m => m.merchantAccountId === 'ma_A')!.eligible).toBe(true)
  })

  it('0 elegibles ⇒ fallbackAll + auditoría MERCHANT_ROUTING_FALLBACK en ActivityLog', async () => {
    mockPrisma.merchantRoutingRule.findMany.mockResolvedValue([
      { id: 'r1', merchantAccountId: 'ma_A', conditions: scheduleNight },
      { id: 'r2', merchantAccountId: 'ma_B', conditions: scheduleNight },
    ])
    const r = await getMerchantEligibility('venue_1', { amount: 100, simulateAt: SIMULATE_AT, terminalSerial: 'AVQD-1' })
    expect(r.fallbackAll).toBe(true)
    expect(r.merchants.every(m => m.eligible)).toBe(true) // se muestran todos
    expect(r.autoSelectMerchantAccountId).toBeNull()
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MERCHANT_ROUTING_FALLBACK', venueId: 'venue_1', entity: 'MerchantRoutingRule' }),
    )
  })

  it('conditions inválidas en DB ⇒ regla ignorada (fail-open), merchant elegible', async () => {
    mockPrisma.merchantRoutingRule.findMany.mockResolvedValue([
      { id: 'r1', merchantAccountId: 'ma_A', conditions: { schedule: { days: 'lunes' } } }, // inválido
      { id: 'r2', merchantAccountId: 'ma_B', conditions: scheduleNight },
    ])
    const r = await getMerchantEligibility('venue_1', { amount: 100, simulateAt: SIMULATE_AT })
    expect(r.merchants.find(m => m.merchantAccountId === 'ma_A')!.eligible).toBe(true)
    expect(r.autoSelectMerchantAccountId).toBe('ma_A')
  })

  it('config de circuitBreaker viaja a la TPV en la respuesta (passthrough)', async () => {
    mockPrisma.merchantRoutingRule.findMany.mockResolvedValue([
      { id: 'r1', merchantAccountId: 'ma_A', conditions: { circuitBreaker: { consecutiveFailures: 3, cooldownMinutes: 15 } } },
    ])
    const r = await getMerchantEligibility('venue_1', { amount: 100, simulateAt: SIMULATE_AT })
    expect(r.merchants.find(m => m.merchantAccountId === 'ma_A')!.circuitBreaker).toEqual({
      consecutiveFailures: 3,
      cooldownMinutes: 15,
    })
  })

  it('sin merchants configurados ⇒ respuesta vacía estable (sin fallback)', async () => {
    mockPrisma.terminal.findMany.mockResolvedValue([])
    mockEffectiveCfg.mockResolvedValue(null)
    const r = await getMerchantEligibility('venue_1', { amount: 100, simulateAt: SIMULATE_AT })
    expect(r.merchants).toEqual([])
    expect(r.fallbackAll).toBe(false)
    expect(r.routingFeatureActive).toBe(false)
  })

  it('con terminalSerial usa el set asignado a ESA terminal', async () => {
    mockPrisma.terminal.findFirst.mockResolvedValue({ assignedMerchantIds: ['ma_A'] })
    mockPrisma.merchantAccount.findMany.mockResolvedValue([
      { id: 'ma_A', displayName: 'A', displayOrder: 0, provider: { code: 'BLUMON_TPV' } },
    ])
    const r = await getMerchantEligibility('venue_1', { amount: 100, simulateAt: SIMULATE_AT, terminalSerial: 'AVQD-1' })
    expect(r.merchants.map(m => m.merchantAccountId)).toEqual(['ma_A'])
    expect(r.autoSelectMerchantAccountId).toBe('ma_A') // 1 solo elegible ⇒ auto-select
  })
})
