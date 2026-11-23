/**
 * El candado del plan Gratis («sólo hoy») del Resumen de ventas (hz:fefa11b6:D15, ajeno del carril E).
 * Con la zona guardada como «GMT-6» (altas viejas, no es IANA) `formatInTimeZone` truena y el GET respondía 500.
 * Lo usan el GET del resumen, el exportador de ventas detalladas y la tool `sales_by_channel`.
 */
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { venue: { findUnique: jest.fn() } } }))
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn() }))

import prisma from '@/utils/prismaClient'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { rangoBloqueadoPorPlan } from '@/services/dashboard/salesSummaryPlanRange'

const venueFindUnique = (prisma as any).venue.findUnique as jest.Mock
const conPlan = venueHasFeatureAccess as jest.Mock

// 23-nov-2026, 12:00 en la Ciudad de México (UTC−6).
const AHORA = new Date('2026-11-23T18:00:00.000Z')
const HOY = { start: '2026-11-23T06:00:00.000Z', end: '2026-11-24T05:59:59.999Z' }
const AYER = { start: '2026-11-22T06:00:00.000Z', end: '2026-11-23T05:59:59.999Z' }

beforeEach(() => {
  jest.useFakeTimers({ now: AHORA, doNotFake: ['nextTick', 'setImmediate'] })
  venueFindUnique.mockReset()
  conPlan.mockReset().mockResolvedValue(false)
})
afterEach(() => jest.useRealTimers())

describe('rangoBloqueadoPorPlan · zona del negocio', () => {
  it('🔴 con la zona guardada como «GMT-6» no truena: usa la Ciudad de México y deja pasar «hoy»', async () => {
    venueFindUnique.mockResolvedValue({ timezone: 'GMT-6' })
    await expect(rangoBloqueadoPorPlan('v1', HOY.start, HOY.end)).resolves.toBe(false)
  })

  it('🔴 con «GMT-6», ayer sigue bloqueado para el plan Gratis', async () => {
    venueFindUnique.mockResolvedValue({ timezone: 'GMT-6' })
    await expect(rangoBloqueadoPorPlan('v1', AYER.start, AYER.end)).resolves.toBe(true)
  })

  // Regresión: lo de siempre.
  it('control · zona IANA válida: hoy pasa, ayer no', async () => {
    venueFindUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
    await expect(rangoBloqueadoPorPlan('v1', HOY.start, HOY.end)).resolves.toBe(false)
    await expect(rangoBloqueadoPorPlan('v1', AYER.start, AYER.end)).resolves.toBe(true)
  })

  it('control · sin zona guardada cae a la Ciudad de México', async () => {
    venueFindUnique.mockResolvedValue({ timezone: null })
    await expect(rangoBloqueadoPorPlan('v1', HOY.start, HOY.end)).resolves.toBe(false)
  })

  it('control · con el plan (ADVANCED_REPORTS) nunca bloquea ni lee la zona', async () => {
    conPlan.mockResolvedValue(true)
    await expect(rangoBloqueadoPorPlan('v1', AYER.start, AYER.end)).resolves.toBe(false)
    expect(venueFindUnique).not.toHaveBeenCalled()
  })

  it('control · fechas inválidas no bloquean (las rechaza quien valida)', async () => {
    venueFindUnique.mockResolvedValue({ timezone: 'GMT-6' })
    await expect(rangoBloqueadoPorPlan('v1', 'no-es-fecha', HOY.end)).resolves.toBe(false)
  })
})
