import { registerLoyaltyPromotionTools } from '../../../src/mcp/tools/loyaltyPromotions'
import type { McpScope } from '../../../src/mcp/scope'

const mockList = jest.fn()
const mockCreate = jest.fn()
const mockEnd = jest.fn()
const mockAudit = jest.fn()
const mockCfg = jest.fn()
const mockPromo = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (perm: string, v: string) => {
      if (v === 'no-perm') throw new Error(`Forbidden: missing ${perm}`)
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
const mockValidar = jest.fn()
jest.mock('@/services/loyalty/promotions/loyaltyPromotion.service', () => ({
  ...jest.requireActual('@/services/loyalty/promotions/loyaltyPromotion.service'),
  validarNuevaPromocion: (...a: unknown[]) => mockValidar(...(a as [])),
  listLoyaltyPromotions: (...a: unknown[]) => mockList(...(a as [])),
  createLoyaltyPromotion: (...a: unknown[]) => mockCreate(...(a as [])),
  endLoyaltyPromotion: (...a: unknown[]) => mockEnd(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    loyaltyConfig: { findFirst: (...a: unknown[]) => mockCfg(...(a as [])) },
    loyaltyPromotion: { findFirst: (...a: unknown[]) => mockPromo(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (name: string, args: Record<string, unknown>) => handlers.get(name)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerLoyaltyPromotionTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockCfg.mockResolvedValue({ active: true, stampsEnabled: true, pointsPerDollar: 1, pointsPerVisit: 0 })
  // Por default el servicio acepta y devuelve los valores ya validados (con sus defaults).
  mockValidar.mockImplementation(async (_v: string, i: Record<string, unknown>) => ({
    v: {
      daysOfWeek: [],
      timeFrom: null,
      timeUntil: null,
      productIds: [],
      categoryIds: [],
      minSpend: null,
      limit: 'NONE',
      extraStamps: null,
      extraPoints: null,
      multiplier: null,
      ...i,
    },
  }))
})

const nueva = { venueId: 'v1', name: 'Doble', kind: 'MULTIPLY', multiplier: 2, startDate: '2026-11-13', endDate: '2026-11-17' }

describe('create_loyalty_promotion', () => {
  it('sin confirm no escribe y da la vista previa en español', async () => {
    const out = parse(await call('create_loyalty_promotion', nueva))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview).toBe('Del 13 al 17 de nov., cada visita da 2 sellos en vez de 1 y el doble de puntos')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('sólo menciona lo que el negocio tiene prendido', async () => {
    mockCfg.mockResolvedValue({ active: false, stampsEnabled: true })
    const out = parse(await call('create_loyalty_promotion', nueva))
    expect(out.preview).toBe('Del 13 al 17 de nov., cada visita da 2 sellos en vez de 1')
  })

  // Ola final: la misma regla que el panel — da puntos si el programa está prendido Y da puntos por peso o por visita.
  it('programa prendido pero sin puntos por peso ni por visita: no promete puntos', async () => {
    mockCfg.mockResolvedValue({ active: true, stampsEnabled: true, pointsPerDollar: 0, pointsPerVisit: 0 })
    const out = parse(await call('create_loyalty_promotion', nueva))
    expect(out.preview).toBe('Del 13 al 17 de nov., cada visita da 2 sellos en vez de 1')
    expect(mockCfg).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ pointsPerDollar: true, pointsPerVisit: true }) }),
    )
  })

  it('sólo bono por visita también cuenta como «da puntos»', async () => {
    mockCfg.mockResolvedValue({ active: true, stampsEnabled: false, pointsPerDollar: 0, pointsPerVisit: 5 })
    const out = parse(await call('create_loyalty_promotion', nueva))
    expect(out.preview).toBe('Del 13 al 17 de nov., cada visita da el doble de puntos')
  })

  it('con productos: los puntos dobles son «por esos productos», como el panel', async () => {
    const out = parse(await call('create_loyalty_promotion', { ...nueva, productIds: ['cp1', 'cp2'] }))
    expect(out.preview).toBe(
      'Del 13 al 17 de nov., cada visita que lleve alguno de los 2 productos elegidos da 2 sellos en vez de 1 y el doble de puntos por esos productos',
    )
  })

  it('con categorías: los puntos dobles son «en esas categorías»', async () => {
    const out = parse(await call('create_loyalty_promotion', { ...nueva, categoryIds: ['cc1', 'cc2'] }))
    expect(out.preview).toBe(
      'Del 13 al 17 de nov., cada visita que lleve algo de las 2 categorías elegidas da 2 sellos en vez de 1 y el doble de puntos en esas categorías',
    )
  })

  it.each([
    'El multiplicador va de 2 a 10',
    'Indica cuántos sellos o puntos extra da la promoción',
    'Elige productos o categorías, no los dos',
    'La promoción no puede empezar antes de hoy',
    'Ya hay 10 promociones de lealtad activas o programadas: termina una para crear otra',
  ])('la vista previa rechaza con el mensaje del servicio: %s', async msg => {
    mockValidar.mockRejectedValueOnce(new Error(msg))
    const out = parse(await call('create_loyalty_promotion', nueva))
    expect(out).toEqual({ ok: false, error: msg })
    expect(out.requiresConfirmation).toBeUndefined()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('con confirm escribe y audita', async () => {
    mockCreate.mockResolvedValue({ id: 'p1', name: 'Doble', status: 'SCHEDULED' })
    const out = parse(await call('create_loyalty_promotion', { ...nueva, confirm: true }))
    expect(out.ok).toBe(true)
    expect(mockCreate).toHaveBeenCalledWith('v1', expect.objectContaining({ name: 'Doble', multiplier: 2 }), 's1')
    expect(mockAudit).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ action: 'LOYALTY_PROMOTION_CREATED_VIA_MCP', entityId: 'p1', venueId: 'v1' }),
    )
  })

  it('devuelve el mensaje del servicio si rechaza', async () => {
    mockCreate.mockRejectedValue(new Error('El multiplicador va de 2 a 10'))
    const out = parse(await call('create_loyalty_promotion', { ...nueva, confirm: true }))
    expect(out).toEqual({ ok: false, error: 'El multiplicador va de 2 a 10' })
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('negocio ajeno / sin permiso rechazan sin tocar nada', async () => {
    await expect(call('create_loyalty_promotion', { ...nueva, venueId: 'foreign' })).rejects.toThrow('out of scope')
    await expect(call('create_loyalty_promotion', { ...nueva, venueId: 'no-perm' })).rejects.toThrow('loyalty:update')
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe('end_loyalty_promotion', () => {
  const vigente = { id: 'p1', name: 'Doble', startsAt: new Date('2020-01-01'), endsAt: null, endedAt: null }

  it('sin confirm no termina', async () => {
    mockPromo.mockResolvedValue(vigente)
    const out = parse(await call('end_loyalty_promotion', { venueId: 'v1', promotionId: 'p1' }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview).toContain('Doble')
    expect(mockEnd).not.toHaveBeenCalled()
  })

  it('promo de otro negocio → no encontrada', async () => {
    mockPromo.mockResolvedValue(null)
    const out = parse(await call('end_loyalty_promotion', { venueId: 'v1', promotionId: 'ajena' }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/no encontr/i)
    expect(mockEnd).not.toHaveBeenCalled()
  })

  it('con confirm sobre una ya terminada no audita', async () => {
    mockPromo.mockResolvedValue({ ...vigente, endedAt: new Date('2021-01-01') })
    mockEnd.mockResolvedValue({ id: 'p1', name: 'Doble', status: 'ENDED' })
    const out = parse(await call('end_loyalty_promotion', { venueId: 'v1', promotionId: 'p1', confirm: true }))
    expect(out.ok).toBe(true)
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('con confirm termina y audita', async () => {
    mockPromo.mockResolvedValue(vigente)
    mockEnd.mockResolvedValue({ id: 'p1', name: 'Doble', status: 'ENDED' })
    const out = parse(await call('end_loyalty_promotion', { venueId: 'v1', promotionId: 'p1', confirm: true }))
    expect(out.ok).toBe(true)
    expect(mockEnd).toHaveBeenCalledWith('v1', 'p1', 's1')
    expect(mockAudit).toHaveBeenCalledWith(scope, expect.objectContaining({ action: 'LOYALTY_PROMOTION_ENDED_VIA_MCP', entityId: 'p1' }))
  })
})

describe('list_loyalty_promotions', () => {
  it('lista con el servicio y exige loyalty:read', async () => {
    mockList.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 })
    const out = parse(await call('list_loyalty_promotions', { venueId: 'v1', status: 'ACTIVE' }))
    expect(mockList).toHaveBeenCalledWith('v1', expect.objectContaining({ status: 'ACTIVE' }))
    expect(out.total).toBe(0)
    await expect(call('list_loyalty_promotions', { venueId: 'no-perm' })).rejects.toThrow('loyalty:read')
  })
})
