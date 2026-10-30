import { registerLoyaltyTools } from '../../../src/mcp/tools/loyalty'
import type { McpScope } from '../../../src/mcp/scope'
import { conectarPorElCatalogo } from '../../__helpers__/mcp-por-el-catalogo'

const mockCustomerFind = jest.fn()
const mockAdjust = jest.fn()
const mockStatus = jest.fn()
const mockVersion = jest.fn()
const mockAudit = jest.fn()
const mockStaffVenueFind = jest.fn()
const mockGate = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockGate(...(a as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing loyalty:adjust')
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/wallet/stampLedger.service', () => ({
  adjustStamps: (...a: unknown[]) => mockAdjust(...(a as [])),
  getStampCardStatus: (...a: unknown[]) => mockStatus(...(a as [])),
  contarVersionDeCartilla: (...a: unknown[]) => mockVersion(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    customer: { findMany: (...a: unknown[]) => mockCustomerFind(...(a as [])) },
    staffVenue: { findFirst: (...a: unknown[]) => mockStaffVenueFind(...(a as [])) },
    stampReward: { findMany: jest.fn().mockResolvedValue([]) },
  },
}))

type H = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>
const handlers = new Map<string, H>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('adjust_stamps')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const ana = { id: 'c1', firstName: 'Ana', lastName: 'López' }
const motivo = 'migración del cartón de papel'
const expected = {
  expectedCustomerId: 'c1',
  expectedStampCardId: 'k1',
  expectedStampsEarned: 2,
  expectedVersion: 3,
  expectedStampsRequired: 10,
}

beforeAll(() => {
  registerLoyaltyTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.resetAllMocks()
  mockGate.mockResolvedValue(null)
  mockStatus.mockResolvedValue({ stampsEarned: 2, stampsRequired: 10, rewardLabel: 'Café gratis', pendingRewards: 0, stampCardId: 'k1' })
  mockVersion.mockResolvedValue(3)
})

describe('adjust_stamps (critical write, confirm-gated)', () => {
  it('rejects out-of-scope / no-perm', async () => {
    await expect(call({ venueId: 'foreign', search: 'ana', stampsEarned: 5, reason: motivo })).rejects.toThrow('out of scope')
    await expect(call({ venueId: 'no-perm', search: 'ana', stampsEarned: 5, reason: motivo })).rejects.toThrow('Forbidden')
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('sin plan: planRequired', async () => {
    mockGate.mockResolvedValueOnce('Necesitas PRO')
    const out = parse(await call({ venueId: 'v1', search: 'ana', stampsEarned: 5, reason: motivo }))
    expect(out).toMatchObject({ ok: false, planRequired: true })
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('motivo de 5 espacios: error, sin escribir', async () => {
    const out = parse(await call({ venueId: 'v1', search: 'ana', stampsEarned: 5, reason: '     ', confirm: true, ...expected }))
    expect(out.ok).toBe(false)
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('sin confirm: PREVIEW con customerId y expected*, no escribe', async () => {
    mockCustomerFind.mockResolvedValueOnce([ana])
    const out = parse(await call({ venueId: 'v1', search: 'ana', stampsEarned: 5, reason: motivo }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview).toEqual({
      customer: 'Ana López',
      customerId: 'c1',
      currentStamps: 2,
      newStamps: 5,
      stampsRequired: 10,
      completes: false,
      rewardLabel: 'Café gratis',
      expectedStampCardId: 'k1',
      expectedStampsEarned: 2,
      expectedVersion: 3,
    })
    // F8: ARRIBA, donde el catálogo los firma y los copia a confirmationArguments.
    expect(out).toMatchObject({
      expectedCustomerId: 'c1',
      expectedStampCardId: 'k1',
      expectedStampsEarned: 2,
      expectedVersion: 3,
      expectedStampsRequired: 10,
    })
    expect(out.message).toMatch(/5 de 10 sellos/)
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('confirm sin expected*: error, sin escribir', async () => {
    mockCustomerFind.mockResolvedValueOnce([ana])
    // el cliente correcto: aísla el chequeo de los otros tres expected*
    const out = parse(
      await call({ venueId: 'v1', search: 'ana', stampsEarned: 5, reason: motivo, confirm: true, expectedCustomerId: 'c1' }),
    )
    expect(out.ok).toBe(false)
    // falla por los tres expected* de la tarjeta, no por el cliente
    expect(out.error).toMatch(/expectedStampCardId/)
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('🔴 F1 confirm sin expectedStampsRequired: error, sin escribir', async () => {
    mockCustomerFind.mockResolvedValueOnce([ana])
    const { expectedStampsRequired: _meta, ...sinMeta } = expected
    const out = parse(await call({ venueId: 'v1', search: 'ana', stampsEarned: 5, reason: motivo, confirm: true, ...sinMeta }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/expectedStampsRequired/)
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('confirm con expectedCustomerId de OTRO cliente: error, sin escribir', async () => {
    mockCustomerFind.mockResolvedValueOnce([ana])
    const out = parse(
      await call({ venueId: 'v1', search: 'ana', stampsEarned: 5, reason: motivo, confirm: true, ...expected, expectedCustomerId: 'c2' }),
    )
    expect(out.ok).toBe(false)
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('confirm: llama a adjustStamps con expected*, staffVenueId y actor; audita', async () => {
    mockCustomerFind.mockResolvedValueOnce([ana])
    mockStaffVenueFind.mockResolvedValueOnce({ id: 'sv-1' })
    mockAdjust.mockResolvedValueOnce({ stampCardId: 'k1', from: 2, to: 5, delta: 3, completed: false, stampsRequired: 10 })
    const out = parse(await call({ venueId: 'v1', search: 'ana', stampsEarned: 5, reason: motivo, confirm: true, ...expected }))
    expect(mockAdjust).toHaveBeenCalledWith('v1', 'c1', {
      stampsEarned: 5,
      expectedStampCardId: 'k1',
      expectedStampsEarned: 2,
      expectedVersion: 3,
      expectedStampsRequired: 10,
      reason: motivo,
      staffVenueId: 'sv-1',
      actorStaffId: 's1',
    })
    expect(out).toMatchObject({ ok: true, customer: 'Ana López', from: 2, to: 5 })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'STAMPS_ADJUSTED', entityId: 'c1', venueId: 'v1' })
  })

  it('dueño sin fila en StaffVenue: igual escribe (staffVenueId undefined)', async () => {
    mockCustomerFind.mockResolvedValueOnce([ana])
    mockStaffVenueFind.mockResolvedValueOnce(null)
    mockAdjust.mockResolvedValueOnce({ stampCardId: 'k1', from: 2, to: 5, delta: 3, completed: false, stampsRequired: 10 })
    const out = parse(await call({ venueId: 'v1', search: 'ana', stampsEarned: 5, reason: motivo, confirm: true, ...expected }))
    expect(out.ok).toBe(true)
    expect(mockAdjust.mock.calls[0][2]).toMatchObject({ staffVenueId: undefined, actorStaffId: 's1' })
  })

  it('varios clientes: ambiguous, sin escribir', async () => {
    mockCustomerFind.mockResolvedValueOnce([ana, { id: 'c2', firstName: 'Anabel', lastName: 'Ruiz' }])
    const out = parse(await call({ venueId: 'v1', search: 'an', stampsEarned: 5, reason: motivo }))
    expect(out.ambiguous).toBe(true)
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('STAMPS_CHANGED se devuelve como ok:false con el número actual', async () => {
    mockCustomerFind.mockResolvedValueOnce([ana])
    mockStaffVenueFind.mockResolvedValueOnce({ id: 'sv-1' })
    mockAdjust.mockRejectedValueOnce(
      Object.assign(new Error('Los sellos de este cliente cambiaron mientras tanto'), {
        code: 'STAMPS_CHANGED',
        details: { stampCardId: 'k1', stampsEarned: 4, stampsRequired: 8, version: 4, rewardLabel: 'Postre gratis' },
      }),
    )
    const out = parse(await call({ venueId: 'v1', search: 'ana', stampsEarned: 5, reason: motivo, confirm: true, ...expected }))
    expect(out).toMatchObject({ ok: false, code: 'STAMPS_CHANGED', currentStamps: 4, stampsRequired: 8, rewardLabel: 'Postre gratis' })
    expect(mockAudit).not.toHaveBeenCalled()
  })
})

/**
 * F8 (pasada de la familia): como corre en producción, POR EL CATÁLOGO. El catálogo firma la intención del paso 1 y sólo agrega a
 * `confirmationArguments` los campos de su lista que la vista previa devuelve ARRIBA. Sin eso, confirmar con los expected*
 * rompía la firma y confirmar sin ellos lo rechazaba la herramienta: `adjust_stamps` no podía aplicarse nunca.
 */
describe('adjust_stamps — por el catálogo real (token de confirmación)', () => {
  let c: Awaited<ReturnType<typeof conectarPorElCatalogo>>
  const paso1 = { venueId: 'v1', search: 'ana', stampsEarned: 5, reason: motivo }
  beforeEach(async () => {
    mockCustomerFind.mockResolvedValue([ana])
    mockStaffVenueFind.mockResolvedValue({ id: 'sv-1' })
    mockAdjust.mockResolvedValue({ stampCardId: 'k1', from: 2, to: 5, delta: 3, completed: false, stampsRequired: 10 })
    c = await conectarPorElCatalogo(server => registerLoyaltyTools(server as never, scope), scope)
  })
  afterEach(async () => {
    await c.close()
  })

  it('🔴 con tarjeta: vista previa y confirm con confirmationArguments + token ⇒ ok, UNA llamada con los expected* de la vista', async () => {
    const vista = await c.call('adjust_stamps', paso1)
    expect(vista.requiresConfirmation).toBe(true)
    expect(vista.confirmationArguments).toEqual({ ...paso1, ...expected })
    const out = await c.call('adjust_stamps', { ...vista.confirmationArguments, confirm: true, confirmationToken: vista.confirmationToken })
    expect(out).toMatchObject({ ok: true, from: 2, to: 5 })
    expect(mockAdjust).toHaveBeenCalledTimes(1)
    const { expectedCustomerId: _cliente, ...foto } = expected
    expect(mockAdjust).toHaveBeenCalledWith('v1', 'c1', expect.objectContaining({ stampsEarned: 5, ...foto }))
  })

  it('🔴 sin tarjeta (expectedStampCardId:null): el null también se firma y el confirm aplica', async () => {
    mockStatus.mockResolvedValue({ stampsEarned: 0, stampsRequired: 10, rewardLabel: 'Café gratis', pendingRewards: 0, stampCardId: null })
    mockVersion.mockResolvedValue(0)
    const vista = await c.call('adjust_stamps', paso1)
    const sinTarjeta = {
      expectedCustomerId: 'c1',
      expectedStampCardId: null,
      expectedStampsEarned: 0,
      expectedVersion: 0,
      expectedStampsRequired: 10,
    }
    expect(vista.confirmationArguments).toEqual({ ...paso1, ...sinTarjeta })
    const out = await c.call('adjust_stamps', { ...vista.confirmationArguments, confirm: true, confirmationToken: vista.confirmationToken })
    expect(out).toMatchObject({ ok: true })
    expect(mockAdjust).toHaveBeenCalledTimes(1)
    expect(mockAdjust.mock.calls[0][2]).toMatchObject({
      expectedStampCardId: null,
      expectedStampsEarned: 0,
      expectedVersion: 0,
      expectedStampsRequired: 10,
    })
  })

  it.each<[string, Record<string, unknown>]>([
    ['el total', { stampsEarned: 6 }],
    ['expectedStampCardId', { expectedStampCardId: 'k2' }],
    ['expectedStampCardId a null', { expectedStampCardId: null }],
    ['expectedStampsRequired', { expectedStampsRequired: 5 }],
    ['expectedStampsEarned', { expectedStampsEarned: 3 }],
    ['expectedVersion', { expectedVersion: 4 }],
    ['expectedCustomerId', { expectedCustomerId: 'c2' }],
  ])('control — alterar %s después de la vista previa: el token no vale y no se llama al servicio', async (_n, cambio) => {
    const vista = await c.call('adjust_stamps', paso1)
    const out = await c.call('adjust_stamps', {
      ...vista.confirmationArguments,
      ...cambio,
      confirm: true,
      confirmationToken: vista.confirmationToken,
    })
    expect(out).toMatchObject({ needsInput: true, field: 'confirmationToken' })
    expect(mockAdjust).not.toHaveBeenCalled()
  })
})

describe('stamp_card_status (certificada): no filtra stampCardId', () => {
  it('la salida no trae stampCardId', async () => {
    const out = parse(await handlers.get('stamp_card_status')!({ venueId: 'v1', customerId: 'c1' }, {}))
    expect(out.ok).toBe(true)
    expect(out.stampsEarned).toBe(2)
    expect('stampCardId' in out).toBe(false)
  })
})
