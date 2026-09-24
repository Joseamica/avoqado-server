/**
 * Auditoría del 21-sep-2026, hallazgo #4 (P1 de acceso), y su revisión por Codex el mismo día.
 *
 * El middleware sólo le preguntaba al PLAN cuando la fila propia no existía o estaba `active:false`.
 * Si existía con `active:true` y la prueba vencida —o suspendida— cortaba con 403 ANTES. Medido:
 * PREMIUM pagado + inventario suelto con el trial vencido ⇒ 403 en inventario.
 *
 * El primer arreglo usó un atajo propio (tier + `elPlanConcede`) y Codex encontró que seguía
 * negando CHATBOT —gratis para todos— si había una fila vieja vencida: el chatbot no depende de
 * plan. Ahora el middleware delega en el resolver canónico `venueHasFeatureAccess`.
 *
 * 🔑 Esta prueba usa el resolver REAL (sólo se simula la base). Si simulara el resolver, pasaría
 * aunque el middleware y el resolver volvieran a contestar distinto.
 */
const mockVfFindFirst = jest.fn()
const mockVfFindMany = jest.fn()
const mockVenueFindUnique = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueFeature: {
      findFirst: (...a: unknown[]) => mockVfFindFirst(...a),
      findMany: (...a: unknown[]) => mockVfFindMany(...a),
    },
    venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...a) },
    staffVenue: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}))
jest.mock('./../../../src/middlewares/checkPermission.middleware', () => ({
  resolveRequestVenueId: () => 'venue-1',
}))

import { checkFeatureAccess } from '@/middlewares/checkFeatureAccess.middleware'

const ayer = new Date(Date.now() - 86_400_000)

function plan(code: 'PLAN_PRO' | 'PLAN_PREMIUM' | null) {
  mockVfFindMany.mockResolvedValue(code ? [{ active: true, suspendedAt: null, endDate: null, feature: { code } }] : [])
}

async function correr(featureCode: string, fila: { endDate: Date | null; suspendedAt: Date | null }) {
  mockVfFindFirst.mockResolvedValue({ active: true, ...fila, feature: { name: featureCode } })
  const req: any = { authContext: { userId: 'staff-1' }, params: { venueId: 'venue-1' } }
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
  const next = jest.fn()
  await checkFeatureAccess(featureCode)(req, res, next)
  return { paso: next.mock.calls.length > 0, status: res.status.mock.calls[0]?.[0] }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockVenueFindUnique.mockResolvedValue({ seatCapExempt: false, organization: { seatCapExempt: false }, status: 'ACTIVE' })
})

describe('el plan cubre lo que una suelta caducada bloqueaba', () => {
  it('trial VENCIDO + plan PREMIUM → pasa (el plan lo incluye)', async () => {
    plan('PLAN_PREMIUM')
    expect(await correr('INVENTORY_TRACKING', { endDate: ayer, suspendedAt: null })).toMatchObject({ paso: true })
  })

  it('suelta SUSPENDIDA + plan PREMIUM → pasa', async () => {
    plan('PLAN_PREMIUM')
    expect(await correr('INVENTORY_TRACKING', { endDate: null, suspendedAt: ayer })).toMatchObject({ paso: true })
  })

  it('🔴 trial VENCIDO + plan PRO → SIGUE bloqueado: Pro no incluye inventario', async () => {
    plan('PLAN_PRO')
    expect(await correr('INVENTORY_TRACKING', { endDate: ayer, suspendedAt: null })).toMatchObject({ paso: false, status: 403 })
  })

  it('trial VENCIDO y SIN plan → sigue bloqueado', async () => {
    plan(null)
    expect(await correr('INVENTORY_TRACKING', { endDate: ayer, suspendedAt: null })).toMatchObject({ paso: false, status: 403 })
  })
})

describe('🔴 lo que es gratis para todos no lo bloquea una fila vieja (Codex, 21-sep)', () => {
  it('CHATBOT con el trial VENCIDO y SIN plan → pasa', async () => {
    plan(null)
    expect(await correr('CHATBOT', { endDate: ayer, suspendedAt: null })).toMatchObject({ paso: true })
  })

  it('CHATBOT SUSPENDIDO y SIN plan → pasa', async () => {
    plan(null)
    expect(await correr('CHATBOT', { endDate: null, suspendedAt: ayer })).toMatchObject({ paso: true })
  })
})
