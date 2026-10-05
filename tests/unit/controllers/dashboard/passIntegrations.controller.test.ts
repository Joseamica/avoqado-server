/**
 * Controller del conector de pases: delgado, pero el cableado importa — el proveedor de la URL (minúsculas) llega en
 * mayúsculas al servicio, las fechas de la lista se convierten con la zona del NEGOCIO, y las respuestas de los servicios
 * que no devuelven nada se arman aquí. Servicios mockeados: aquí sólo se prueba lo que hace el controller.
 */
const mockIntegrations = {
  getPassIntegrationsOverview: jest.fn(),
  connectTotalPass: jest.fn(),
  setPassConfirmMode: jest.fn(),
  setPassProductLinks: jest.fn(),
  disconnectPassProvider: jest.fn(),
}
const mockCapacity = {
  getPassCapacity: jest.fn(),
  setDefaultPassCap: jest.fn(),
  upsertWeeklyPassCap: jest.fn(),
  deletePassCapRule: jest.fn(),
  setSessionPassCap: jest.fn(),
}
const mockVisits = {
  listPassVisits: jest.fn(),
  summarizePassVisits: jest.fn(),
  confirmPassVisit: jest.fn(),
  rejectPassVisit: jest.fn(),
  localDayRange: jest.requireActual('@/services/aggregators/passVisits.service').localDayRange,
}
const mockTz = jest.fn()
jest.mock('@/services/aggregators/passIntegrations.service', () => mockIntegrations)
jest.mock('@/services/aggregators/passCapacity.service', () => mockCapacity)
jest.mock('@/services/aggregators/passVisits.service', () => mockVisits)
jest.mock('@/services/dashboard/commission/commission-utils', () => ({ getVenueTimezone: (...a: unknown[]) => mockTz(...a) }))

import * as ctrl from '@/controllers/dashboard/passIntegrations.controller'

const res = () => {
  const r: any = {}
  r.json = jest.fn(() => r)
  return r
}
const req = (over: Record<string, unknown>) =>
  ({ params: { venueId: 'v1' }, body: {}, query: {}, authContext: { userId: 'staff1' }, ...over }) as any

describe('controller de pases', () => {
  beforeEach(() => jest.clearAllMocks())

  it('el proveedor de la URL llega en mayúsculas y quién lo hizo sale del authContext', async () => {
    mockIntegrations.setPassConfirmMode.mockResolvedValue({ provider: 'WELLHUB' })
    const r = res()
    await ctrl.setConfirmMode(req({ params: { venueId: 'v1', provider: 'wellhub' }, body: { confirmMode: 'AUTO' } }), r)
    expect(mockIntegrations.setPassConfirmMode).toHaveBeenCalledWith('v1', 'WELLHUB', 'AUTO', 'staff1')
    expect(r.json).toHaveBeenCalledWith({ success: true, data: { provider: 'WELLHUB' } })
  })

  // Los tres reciben sólo strings: el typecheck no ve un cruce de argumentos. Valores distintos entre sí para que se note.
  it('conectar, confirmar y rechazar pasan (negocio, llave|visita, quién) en ese orden', async () => {
    const LLAVE = 'llave-inventada-0000-aaaa' // valor inventado: nunca una llave real
    mockIntegrations.connectTotalPass.mockResolvedValue({ provider: 'TOTALPASS' })
    const r1 = res()
    await ctrl.connectTotalPass(req({ params: { venueId: 'venue-9' }, body: { placeApiKey: LLAVE } }), r1)
    expect(mockIntegrations.connectTotalPass).toHaveBeenCalledWith('venue-9', LLAVE, 'staff1')
    expect(r1.json).toHaveBeenCalledWith({ success: true, data: { provider: 'TOTALPASS' } })
    mockVisits.confirmPassVisit.mockResolvedValue({ id: 'visita-7', status: 'CONFIRMED' })
    const r2 = res()
    await ctrl.confirmVisit(req({ params: { venueId: 'venue-9', visitId: 'visita-7' } }), r2)
    expect(mockVisits.confirmPassVisit).toHaveBeenCalledWith('venue-9', 'visita-7', 'staff1')
    expect(r2.json).toHaveBeenCalledWith({ success: true, data: { id: 'visita-7', status: 'CONFIRMED' } })
    mockVisits.rejectPassVisit.mockResolvedValue({ id: 'visita-8', status: 'REJECTED' })
    const r3 = res()
    await ctrl.rejectVisit(req({ params: { venueId: 'venue-9', visitId: 'visita-8' } }), r3)
    expect(mockVisits.rejectPassVisit).toHaveBeenCalledWith('venue-9', 'visita-8', 'staff1')
    expect(r3.json).toHaveBeenCalledWith({ success: true, data: { id: 'visita-8', status: 'REJECTED' } })
  })

  it('desconectar, borrar regla y guardar cupos responden con su confirmación', async () => {
    const r1 = res()
    await ctrl.disconnect(req({ params: { venueId: 'v1', provider: 'totalpass' } }), r1)
    expect(mockIntegrations.disconnectPassProvider).toHaveBeenCalledWith('v1', 'TOTALPASS', 'staff1')
    expect(r1.json).toHaveBeenCalledWith({ success: true, data: { disconnected: true } })
    const r2 = res()
    await ctrl.deleteRule(req({ params: { venueId: 'v1', ruleId: 'r1' } }), r2)
    expect(mockCapacity.deletePassCapRule).toHaveBeenCalledWith('v1', 'r1', 'staff1')
    expect(r2.json).toHaveBeenCalledWith({ success: true, data: { deleted: true } })
    const r3 = res()
    await ctrl.setSessionCap(req({ params: { venueId: 'v1', classSessionId: 's1' }, body: { maxSpots: null } }), r3)
    expect(mockCapacity.setSessionPassCap).toHaveBeenCalledWith('v1', 's1', null, 'staff1')
    expect(r3.json).toHaveBeenCalledWith({ success: true, data: { saved: true } })
  })

  it('la lista convierte los días LOCALES del negocio (to inclusivo) y pasa filtros y página', async () => {
    mockTz.mockResolvedValue('America/Mexico_City')
    mockVisits.listPassVisits.mockResolvedValue({ items: [], total: 0, hasMore: false, nextOffset: null })
    await ctrl.listVisits(
      req({ query: { status: 'PENDING', provider: 'TOTALPASS', from: '2030-01-01', to: '2030-01-31', limit: 20, offset: 40 } }),
      res(),
    )
    expect(mockTz).toHaveBeenCalledWith('v1')
    expect(mockVisits.listPassVisits).toHaveBeenCalledWith('v1', {
      status: 'PENDING',
      provider: 'TOTALPASS',
      limit: 20,
      offset: 40,
      from: new Date('2030-01-01T06:00:00.000Z'),
      to: new Date('2030-02-01T06:00:00.000Z'),
    })
  })

  it('el resumen usa el mes y la zona del negocio', async () => {
    mockTz.mockResolvedValue('America/Cancun')
    mockVisits.summarizePassVisits.mockResolvedValue([])
    await ctrl.visitsSummary(req({ query: { month: '2030-01' } }), res())
    expect(mockVisits.summarizePassVisits).toHaveBeenCalledWith('v1', '2030-01', 'America/Cancun')
  })
})
