/**
 * D3 (5-nov-2026): la cortesía con fecha (prueba REGALADA) dice en `origin.firstChargeAt` el día del primer cobro si el
 * dueño se queda hoy con su plan. Sólo con ≥ 72 h por delante: Facturación nunca ofrece lo que el checkout ya no daría.
 */
jest.mock('stripe')
import { prismaMock } from '../../../__helpers__/setup'
import { getPlanState } from '@/services/dashboard/planState.service'

const H = 3600000
const fila = (horas: number | null, over: Record<string, unknown> = {}) => ({
  id: 'vf-1',
  active: true,
  endDate: horas === null ? null : new Date(Date.now() + horas * H),
  suspendedAt: null,
  gracePeriodEndsAt: null,
  monthlyPrice: { toNumber: () => 999 },
  stripeSubscriptionId: null,
  updatedAt: new Date(),
  feature: { code: 'PLAN_PRO', name: 'Plan Pro' },
  ...over,
})

beforeEach(() => {
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'v1',
    stripeCustomerId: null,
    seatCapExempt: false,
    organization: { seatCapExempt: false },
  } as never)
})

describe('getPlanState — origin.firstChargeAt de la prueba regalada (D3)', () => {
  it('prueba regalada con 8 días → COMP con firstChargeAt = su fin', async () => {
    const f = fila(8 * 24)
    prismaMock.venueFeature.findMany.mockResolvedValue([f] as never)
    const plan = await getPlanState('v1')
    expect(plan.origin).toMatchObject({ kind: 'COMP', tier: 'PRO', firstChargeAt: f.endDate!.toISOString() })
  })

  it.each([
    ['le quedan menos de 3 días', fila(60)],
    ['cortesía permanente (sin fecha)', fila(null)],
  ])('%s → firstChargeAt null (no se ofrece)', async (_caso, f) => {
    prismaMock.venueFeature.findMany.mockResolvedValue([f] as never)
    const plan = await getPlanState('v1')
    expect(plan.origin?.kind).toBe('COMP')
    expect(plan.origin?.firstChargeAt).toBeNull()
  })
})
