/** Planes editables B4, Task 3: GET /plan pasa su decisión de la versión (la que ya leyó) a `getPlanStateYSuscripcion`. */
const mockVersion = jest.fn()
jest.mock('@/services/billing/cotizacionDeLaOferta', () => ({
  versionDeTuPlanSinRomper: (...a: unknown[]) => mockVersion(...a),
  cotizacionDeTuPlanSinRomper: jest.fn().mockResolvedValue(null),
}))
const mockPlan = jest.fn()
jest.mock('@/services/dashboard/planState.service', () => ({
  ...jest.requireActual('@/services/dashboard/planState.service'),
  getPlanStateYSuscripcion: (...a: unknown[]) => mockPlan(...a),
}))
import { getVenuePlan } from '@/controllers/dashboard/venue.dashboard.controller'

const llamar = async () => {
  const res: Record<string, jest.Mock> = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  await getVenuePlan({ params: { venueId: 'v1' } } as never, res as never, jest.fn())
}

beforeEach(() => {
  mockPlan.mockReset().mockResolvedValue({ planState: { basicOffer: null }, suscripcion: null })
})

describe('getVenuePlan · conVersionDelEditor', () => {
  it('con la versión (o una ilegible del editor) → true', async () => {
    mockVersion.mockResolvedValue({ vigente: { number: 2 }, delEditor: true })
    await llamar()
    expect(mockPlan.mock.calls[0][1]).toMatchObject({ conVersionDelEditor: true })
    mockPlan.mockClear()
    mockVersion.mockResolvedValue({ vigente: null, delEditor: true })
    await llamar()
    expect(mockPlan.mock.calls[0][1]).toMatchObject({ conVersionDelEditor: true })
  })

  it('sin versión del editor → false (lo de hoy, sin leer otra vez)', async () => {
    mockVersion.mockResolvedValue({ vigente: null, delEditor: false })
    await llamar()
    expect(mockPlan.mock.calls[0][1]).toMatchObject({ conVersionDelEditor: false })
  })
})
