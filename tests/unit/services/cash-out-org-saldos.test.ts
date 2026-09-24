/**
 * Unit test (mock-first) — org-wide Cash Out saldo roll-up per promoter.
 * Proves getSaldosForOrg materializes + reconciles PER VENUE before summing
 * (the real fresh-read path — never a raw ledger groupBy that skips
 * materialize), then groups AVAILABLE entries by staff.
 */
const mockMaterialize = jest.fn()
const mockReconcile = jest.fn()
const mockGroupBy = jest.fn()
const mockStaffFindMany = jest.fn()
const mockVenueFindMany = jest.fn()
const mockOrganizationModuleFindFirst = jest.fn()
const mockVenueModuleFindFirst = jest.fn()

jest.mock('@/services/dashboard/cash-out/cash-out.ledger.service', () => ({
  materializeEntries: (...a: unknown[]) => mockMaterialize(...(a as [])),
  reconcileClawbacks: (...a: unknown[]) => mockReconcile(...(a as [])),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    promoterCommissionEntry: { groupBy: (...a: unknown[]) => mockGroupBy(...(a as [])) },
    staff: { findMany: (...a: unknown[]) => mockStaffFindMany(...(a as [])) },
    venue: { findMany: (...a: unknown[]) => mockVenueFindMany(...(a as [])) },
    // assertCashOutEnabledForOrg (called by listVenueIdsForOrg, defined in the file under
    // test) checks org-level module enablement via organizationModule.findFirst first, then
    // falls back to venueModule.findFirst. Stub org-level as enabled so listVenueIdsForOrg
    // resolves straight to venue.findMany without hitting the fallback.
    organizationModule: { findFirst: (...a: unknown[]) => mockOrganizationModuleFindFirst(...(a as [])) },
    venueModule: { findFirst: (...a: unknown[]) => mockVenueModuleFindFirst(...(a as [])) },
  },
}))

import { getSaldosForOrg } from '../../../src/services/dashboard/cash-out/cash-out.org.service'

beforeEach(() => {
  jest.clearAllMocks()
  mockOrganizationModuleFindFirst.mockResolvedValue({ id: 'om1', enabled: true })
  mockVenueFindMany.mockResolvedValue([{ id: 'v1' }])
})

it('materializes + reconciles per venue, then sums AVAILABLE by staff', async () => {
  mockMaterialize.mockResolvedValue({ created: 0 })
  mockReconcile.mockResolvedValue({ clawedBack: 0 })
  mockGroupBy.mockResolvedValue([{ venueId: 'v1', staffId: 'p1', _sum: { amount: '120.50' } }])
  mockStaffFindMany.mockResolvedValue([{ id: 'p1', firstName: 'Ana', lastName: 'León' }])

  const res = await getSaldosForOrg('o1')

  expect(mockMaterialize).toHaveBeenCalledWith('v1')
  expect(mockReconcile).toHaveBeenCalledWith('v1')
  expect(mockVenueModuleFindFirst).not.toHaveBeenCalled()
  expect(res).toEqual([{ venueId: 'v1', staffId: 'p1', promoterName: 'Ana León', saldo: '120.5' }])
})

it('returns [] without touching the ledger when the org has no active venues', async () => {
  mockVenueFindMany.mockResolvedValue([])

  const res = await getSaldosForOrg('o1')

  expect(res).toEqual([])
  expect(mockMaterialize).not.toHaveBeenCalled()
  expect(mockReconcile).not.toHaveBeenCalled()
  expect(mockGroupBy).not.toHaveBeenCalled()
})

it('sorts saldos from highest to lowest across multiple promoters/venues', async () => {
  mockMaterialize.mockResolvedValue({ created: 0 })
  mockReconcile.mockResolvedValue({ clawedBack: 0 })
  mockVenueFindMany.mockResolvedValue([{ id: 'v1' }, { id: 'v2' }])
  mockGroupBy.mockResolvedValue([
    { venueId: 'v1', staffId: 'p1', _sum: { amount: '50' } },
    { venueId: 'v2', staffId: 'p2', _sum: { amount: '200' } },
  ])
  mockStaffFindMany.mockResolvedValue([
    { id: 'p1', firstName: 'Ana', lastName: 'León' },
    { id: 'p2', firstName: 'Beto', lastName: 'Ruiz' },
  ])

  const res = await getSaldosForOrg('o1')

  expect(mockMaterialize).toHaveBeenCalledWith('v1')
  expect(mockMaterialize).toHaveBeenCalledWith('v2')
  expect(res.map(r => r.staffId)).toEqual(['p2', 'p1'])
})

/**
 * Freno del incidente del 23-sep-2026 (auditoría de Codex, P2-6): `cash_out_org_saldos` materializa saldos
 * tienda por tienda y ESCRIBE en el camino. Tras la primera escritura el freno ya no cortaba nada y la
 * herramienta recorría las 57 tiendas aunque venciera el tope. La materialización de cada tienda es completa
 * e idempotente, así que el corte puede ocurrir ENTRE tiendas — nunca dentro de una — y el recorrido termina
 * en error, jamás en un saldo parcial presentado como completo.
 */
describe('con una petición del MCP cancelada (freno 23-sep)', () => {
  const { runWithContext, getContext } = jest.requireActual(
    '@/observability/executionContext',
  ) as typeof import('@/observability/executionContext')
  const { RequestCancelledError, checkCancellation } = jest.requireActual(
    '@/utils/requestCancellation',
  ) as typeof import('@/utils/requestCancellation')

  it('se detiene ENTRE tiendas y no entrega un saldo incompleto', async () => {
    mockVenueFindMany.mockResolvedValue([{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }])
    const controller = new AbortController()
    const cancellation = { signal: controller.signal, hasWritten: false, refused: false }
    mockMaterialize.mockImplementation(async (venueId: string) => {
      const c = getContext()?.cancellation
      checkCancellation('findMany', c) // lee las ventas de la tienda
      checkCancellation('create', c) // materializa: escribe
      if (venueId === 'v1') controller.abort(new RequestCancelledError('timeout', 25_000)) // el tope vence durante v1
      return { created: 1 }
    })
    mockReconcile.mockResolvedValue({ clawedBack: 0 })

    const corrida = runWithContext(
      { correlationId: 'c-co', source: 'http', entrypoint: 'POST /mcp tools/call cash_out_org_saldos', cancellation },
      () => getSaldosForOrg('o1'),
    )

    await expect(corrida).rejects.toBeInstanceOf(RequestCancelledError)
    expect(mockMaterialize.mock.calls.map(c => c[0])).toEqual(['v1', 'v2']) // v1 completa; v2 se corta en su primera lectura
    expect(mockReconcile).toHaveBeenCalledTimes(1) // la de v1: nunca se deja una tienda a medias
    expect(mockGroupBy).not.toHaveBeenCalled() // nunca se arma un saldo parcial
  })

  // REGRESIÓN — fuera de una petición cancelable (el dashboard), nada cambia
  it('fuera de una petición del MCP recorre todas las tiendas como siempre', async () => {
    mockVenueFindMany.mockResolvedValue([{ id: 'v1' }, { id: 'v2' }])
    mockMaterialize.mockResolvedValue({ created: 1 })
    mockReconcile.mockResolvedValue({ clawedBack: 0 })
    mockGroupBy.mockResolvedValue([])
    await expect(getSaldosForOrg('o1')).resolves.toEqual([])
    expect(mockMaterialize).toHaveBeenCalledTimes(2)
  })
})
