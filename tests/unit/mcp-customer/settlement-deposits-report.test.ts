import { registerSettlementReportTools } from '../../../src/mcp/tools/settlementReport'
import type { McpScope } from '../../../src/mcp/scope'
import AppError from '../../../src/errors/AppError'

const mockConstruir = jest.fn()
const mockRequirePermission = jest.fn()
const mockPlanGate = jest.fn()
const mockTurno = jest.fn()
jest.mock('@/services/dashboard/settlementReport/settlementReport.service', () => ({
  ...jest.requireActual('@/services/dashboard/settlementReport/settlementReport.service'),
  construirReporte: (...a: unknown[]) => mockConstruir(...a),
}))
jest.mock('@/services/dashboard/settlementReport/settlementReport.export', () => ({
  conTurnoDeReporte: (fn: () => Promise<unknown>) => mockTurno(fn),
}))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...a) }))
jest.mock('@/mcp/guard', () => ({
  ScopeError: class ScopeError extends Error {},
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v && v !== 'v1') throw new Error('out of scope')
      return { venueId: { in: ['v1'] } }
    },
    requirePermission: (...a: unknown[]) => mockRequirePermission(...a),
  }),
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const base = { venueId: 'v1', fromDate: '2026-08-01', toDate: '2026-08-31' }
const call = (args: Record<string, unknown>) => handlers.get('settlement_deposits_report')!({ ...base, ...args }, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const rep = {
  venueName: 'V',
  timezone: 'America/Mexico_City',
  startDate: '2026-08-01',
  endDate: '2026-08-31',
  dateBasis: 'deposit',
  ventanaDesde: '2026-07-01',
  ventanaHasta: '2026-08-31',
  candidatosLeidos: 3,
  transacciones: [
    { paymentId: 'a', fechaDeposito: '2026-08-03', total: 60, folio: '102298819725', autorizacion: '079820' },
    { paymentId: 'b', fechaDeposito: '2026-08-03', total: 10 },
    { paymentId: 'c', fechaDeposito: null, total: 5 },
  ],
  depositos: [{ fechaDeposito: '2026-08-03', total: 70, depositoNeto: 68 }],
  sinFecha: { cobros: 1, total: 5 },
}

beforeAll(() =>
  registerSettlementReportTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope),
)
beforeEach(() => {
  jest.clearAllMocks()
  mockPlanGate.mockResolvedValue(null)
  mockConstruir.mockResolvedValue(rep)
  mockTurno.mockImplementation((fn: () => Promise<unknown>) => fn())
})

it('resumen: días + sin fecha, con permiso y candado de plan; base depósito por defecto y tope 10,000', async () => {
  const out = parse(await call({}))
  expect(mockRequirePermission).toHaveBeenCalledWith('settlements:read', 'v1')
  expect(mockPlanGate).toHaveBeenCalledWith('v1', 'ADVANCED_REPORTS', expect.any(String))
  expect(mockConstruir).toHaveBeenCalledWith(expect.objectContaining({ dateBasis: 'deposit', tope: 10000 }))
  expect(out.deposits).toEqual(rep.depositos)
  expect(out.unscheduled).toEqual(rep.sinFecha)
  expect(out.estimated).toBe(true)
  expect(typeof out.asOf).toBe('string')
})
it('detalle de un día, paginado con cursor = paymentId del último item', async () => {
  const p1 = parse(await call({ depositDate: '2026-08-03', limit: 1 }))
  expect(p1.items.map((i: any) => i.paymentId)).toEqual(['a'])
  expect(p1.nextCursor).toBe('a')
  expect(p1.total).toBe(2)
  const p2 = parse(await call({ depositDate: '2026-08-03', limit: 1, cursor: 'a', asOf: p1.asOf }))
  expect(p2.items.map((i: any) => i.paymentId)).toEqual(['b'])
  expect(p2.nextCursor).toBeNull()
})
it('cursor inválido', async () => {
  const out = parse(await call({ depositDate: '2026-08-03', cursor: 'zzz' }))
  expect(out).toMatchObject({ ok: false, error: 'El cursor no es válido; vuelve a pedir la primera página.' })
})
it('detalle de lo sin fecha', async () => {
  const out = parse(await call({ unscheduled: true }))
  expect(out.items.map((i: any) => i.paymentId)).toEqual(['c'])
})
it('los filtros y asOf llegan al servicio', async () => {
  const out = parse(
    await call({ terminalIds: ['t1'], cardTypes: ['DEBIT'], brands: ['VISA'], operations: ['SALE'], asOf: '2026-09-01T12:00:00.000Z' }),
  )
  expect(mockConstruir).toHaveBeenCalledWith(
    expect.objectContaining({
      filtros: { terminalIds: ['t1'], cardTypes: ['DEBIT'], brands: ['VISA'], operations: ['SALE'] },
      ahora: new Date('2026-09-01T12:00:00.000Z'),
    }),
  )
  expect(out.asOf).toBe('2026-09-01T12:00:00.000Z')
})
it('semáforo ocupado ⇒ ok:false busy', async () => {
  mockTurno.mockRejectedValue(new AppError('Hay otro reporte armándose', 429, true, 'SETTLEMENT_REPORT_BUSY'))
  expect(parse(await call({}))).toMatchObject({ ok: false, busy: true })
})
it('sin plan ⇒ ok:false planRequired', async () => {
  mockPlanGate.mockResolvedValue('Necesitas PRO')
  expect(parse(await call({}))).toMatchObject({ ok: false, planRequired: true })
})
it('demasiado grande ⇒ ok:false tooLarge con la salida', async () => {
  const { ReporteDemasiadoGrandeError } = jest.requireActual('@/services/dashboard/settlementReport/settlementReport.service')
  mockConstruir.mockRejectedValue(new ReporteDemasiadoGrandeError(20000, 10000))
  expect(parse(await call({}))).toMatchObject({ ok: false, tooLarge: true })
})

test('el detalle MCP omite folio y autorizacion (sensibles) y conserva paymentId', async () => {
  const out = parse(await call({ depositDate: '2026-08-03' }))
  for (const it of out.items) {
    expect(it).not.toHaveProperty('folio')
    expect(it).not.toHaveProperty('autorizacion')
    expect(it.paymentId).toBeDefined()
  }
})
