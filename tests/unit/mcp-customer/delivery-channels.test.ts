/**
 * delivery_channels (Task 12): Feature-gated MCP tool (DELIVERY_CHANNELS, PREMIUM) — mirrors
 * the dashboard's delivery-channels:read gate + the shared planGateMessage() helper (repo-wide
 * planRequired:true shape; Feature resolver underneath, NEVER the Module resolver — see
 * feature-gating.md). The basePlan.service mock below intercepts planGateMessage's resolver.
 */
import { registerDeliveryChannelTools } from '../../../src/mcp/tools/deliveryChannels'
import type { McpScope } from '../../../src/mcp/scope'

const mockHasFeatureAccess = jest.fn()
const mockLinkFindMany = jest.fn()
const mockOrderGroupBy = jest.fn()
const mockRequirePermission = jest.fn()
const mockVenueFindUnique = jest.fn()
const mockVenueStartOfDay = jest.fn()
const mockHasAdapter = jest.fn()
const mockReservationFindUnique = jest.fn()

jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: (...a: unknown[]) => mockHasFeatureAccess(...(a as [])),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
// I1 fix: "today" boundary must resolve the VENUE's timezone (venueStartOfDay), never
// server/host tz (bare `setHours(0,0,0,0)` was UTC in prod → "today" leaked yesterday's
// dinner). Mocked deterministically here (repo pattern, see organizationDashboard test) —
// the real venueStartOfDay is unit-tested on its own in tests/unit/utils/datetime*.
jest.mock('@/utils/datetime', () => ({
  venueStartOfDay: (...a: unknown[]) => mockVenueStartOfDay(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    deliveryChannelLink: { findMany: (...a: unknown[]) => mockLinkFindMany(...(a as [])) },
    order: { groupBy: (...a: unknown[]) => mockOrderGroupBy(...(a as [])) },
    venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...(a as [])) },
    // `resolveDeliveryHours` cae al horario del módulo de RESERVAS cuando el canal no
    // tiene el suyo. Su `.catch(() => null)` cuelga del promise FLUIDO de Prisma, así que
    // el mock tiene que devolver algo thenable — un `jest.fn()` pelón devuelve undefined
    // y revienta con "cannot read .catch of undefined", que no se parece en nada a la
    // causa real.
    reservationSettings: { findUnique: (...a: unknown[]) => mockReservationFindUnique(...(a as [])) },
  },
}))
// Task 8 (plan 2026-08-20-delivery-nucleo-unico, §8.2): "¿esta integración YA tiene
// adaptador real, o el vínculo existe pero todavía no hay a quién delegarle?" — la
// única fuente de verdad es el registro (core/adapterRegistry.ts, Tarea 5 del mismo
// plan), nunca una lista de proveedores copiada aquí a mano.
jest.mock('@/services/delivery-channels/core/injectionRate.service', () => ({
  calcularTasaInyeccion: jest.fn(async () => ({ recibidos: 0, aceptados: 0, porcentaje: null, estado: 'SIN_DATOS', fallidos: [] })),
}))

jest.mock('@/services/delivery-channels/core/adapterRegistry', () => ({
  hasAdapter: (...a: unknown[]) => mockHasAdapter(...(a as [])),
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('delivery_channels')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerDeliveryChannelTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockVenueStartOfDay.mockReturnValue(new Date('2026-07-18T06:00:00.000Z'))
  mockHasAdapter.mockReturnValue(false)
  // Default: el venue NO usa el módulo de reservas ⇒ el horario cae al ESTIMADO, que es
  // el caso más común y el que el tool tiene que saber declarar como suposición.
  mockReservationFindUnique.mockResolvedValue(null)
})

const HORARIO_CANAL = {
  monday: { enabled: true, ranges: [{ open: '11:00', close: '23:00' }] },
  tuesday: { enabled: true, ranges: [{ open: '11:00', close: '23:00' }] },
  wednesday: { enabled: true, ranges: [{ open: '11:00', close: '23:00' }] },
  thursday: { enabled: true, ranges: [{ open: '11:00', close: '23:00' }] },
  friday: { enabled: true, ranges: [{ open: '11:00', close: '23:00' }] },
  saturday: { enabled: true, ranges: [{ open: '11:00', close: '23:00' }] },
  sunday: { enabled: false, ranges: [] },
}

const LINK_BASE = {
  venueId: 'v1',
  provider: 'UBER_EATS',
  status: 'ACTIVE',
  orderAcceptanceMode: 'AUTO',
  autoSyncMenu: true,
  lastMenuSyncAt: null,
  lastMenuHash: 'abc',
  externalLocationId: 's1',
}

describe('delivery_channels', () => {
  it('rejects a venue outside the caller scope — no DB read (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockHasFeatureAccess).not.toHaveBeenCalled()
    expect(mockLinkFindMany).not.toHaveBeenCalled()
  })

  it('returns planRequired:true (repo-wide gate shape) and reads NOTHING when the venue lacks the feature', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(false)
    const out = parse(await call({ venueId: 'v1' }))

    expect(out.ok).toBe(false)
    expect(out.planRequired).toBe(true)
    expect(out.feature).toBe('DELIVERY_CHANNELS')
    expect(out.error).toMatch(/DELIVERY_CHANNELS/)
    expect(out.error).toMatch(/plan/)
    expect(mockHasFeatureAccess).toHaveBeenCalledWith('v1', 'DELIVERY_CHANNELS')
    expect(mockLinkFindMany).not.toHaveBeenCalled()
    expect(mockOrderGroupBy).not.toHaveBeenCalled()
  })

  it('enforces delivery-channels:read via the guard', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(false)
    await call({ venueId: 'v1' })
    expect(mockRequirePermission).toHaveBeenCalledWith('delivery-channels:read', 'v1')
  })

  it('lists channels + today-by-channel totals (Decimal -> pesos Number) when entitled', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockVenueFindUnique.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    // Task 8: UBER_EATS ya tiene adaptador real (Tarea 5 del plan); RAPPI todavía no —
    // el vínculo puede existir (el dueño ya lo conectó) sin que el core sepa traducirlo aún.
    mockHasAdapter.mockImplementation((provider: string) => provider === 'UBER_EATS')
    mockLinkFindMany.mockResolvedValueOnce([
      {
        id: 'link1',
        provider: 'UBER_EATS',
        status: 'ACTIVE',
        orderAcceptanceMode: 'AUTO',
        autoSyncMenu: true,
        lastMenuSyncAt: new Date('2026-07-18T10:00:00Z'),
        externalLocationId: 'loc-123',
      },
      {
        id: 'link2',
        provider: 'RAPPI',
        status: 'PAUSED',
        orderAcceptanceMode: 'MANUAL',
        autoSyncMenu: false,
        lastMenuSyncAt: null,
        externalLocationId: 'loc-456',
      },
    ])
    mockOrderGroupBy.mockResolvedValueOnce([
      // Prisma Decimal in real life; a plain number stands in fine since Number(x) is idempotent on it —
      // the point under test is that the value stays in PESOS major units (452.50), never *100 to cents.
      { source: 'UBER_EATS', _count: { id: 3 }, _sum: { total: 452.5 } },
      { source: 'RAPPI', _count: { id: 1 }, _sum: { total: 99 } },
    ])

    const out = parse(await call({ venueId: 'v1' }))

    expect(out.venueId).toBe('v1')
    expect(out.channels).toHaveLength(2)
    expect(out.channels[0]).toMatchObject({ id: 'link1', provider: 'UBER_EATS', status: 'ACTIVE', orderAcceptanceMode: 'AUTO' })
    expect(out.channels[0].lastMenuSyncAt).toBe('2026-07-18T10:00:00.000Z')
    expect(out.channels[1].lastMenuSyncAt).toBeNull()

    expect(out.todayByChannel).toEqual([
      { channel: 'UBER_EATS', orders: 3, totalPesos: 452.5 },
      { channel: 'RAPPI', orders: 1, totalPesos: 99 },
    ])
    // money stays in pesos major units, never cents
    expect(typeof out.todayByChannel[0].totalPesos).toBe('number')
  })

  // ============================================================
  // Task 8 (plan 2026-08-20-delivery-nucleo-unico, §8.2): la tool refleja si CADA vínculo
  // ya tiene un adaptador real detrás (core/adapterRegistry.ts, Tarea 5 del mismo plan) —
  // "una capacidad no alcanzable por el customer MCP está incompleta" (critical-warnings.md).
  // ============================================================
  it('Task 8: refleja integrationReady por vínculo vía hasAdapter(provider) — nunca una lista propia de proveedores', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockVenueFindUnique.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockHasAdapter.mockImplementation((provider: string) => provider === 'UBER_EATS')
    mockLinkFindMany.mockResolvedValueOnce([
      {
        id: 'link1',
        provider: 'UBER_EATS',
        status: 'ACTIVE',
        orderAcceptanceMode: 'AUTO',
        autoSyncMenu: true,
        lastMenuSyncAt: null,
        externalLocationId: 'loc-1',
      },
      {
        id: 'link2',
        provider: 'RAPPI',
        status: 'PENDING',
        orderAcceptanceMode: 'AUTO',
        autoSyncMenu: true,
        lastMenuSyncAt: null,
        externalLocationId: 'loc-2',
      },
      {
        id: 'link3',
        provider: 'DIDI_FOOD',
        status: 'PENDING',
        orderAcceptanceMode: 'AUTO',
        autoSyncMenu: true,
        lastMenuSyncAt: null,
        externalLocationId: 'loc-3',
      },
    ])
    mockOrderGroupBy.mockResolvedValueOnce([])

    const out = parse(await call({ venueId: 'v1' }))

    expect(out.channels[0]).toMatchObject({ provider: 'UBER_EATS', integrationReady: true })
    expect(out.channels[1]).toMatchObject({ provider: 'RAPPI', integrationReady: false })
    expect(out.channels[2]).toMatchObject({ provider: 'DIDI_FOOD', integrationReady: false })
    expect(mockHasAdapter).toHaveBeenCalledWith('UBER_EATS')
    expect(mockHasAdapter).toHaveBeenCalledWith('RAPPI')
    expect(mockHasAdapter).toHaveBeenCalledWith('DIDI_FOOD')
  })

  it('handles zero delivery orders today (no groupBy rows) without throwing', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockVenueFindUnique.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockLinkFindMany.mockResolvedValueOnce([])
    mockOrderGroupBy.mockResolvedValueOnce([])

    const out = parse(await call({ venueId: 'v1' }))

    expect(out.channels).toEqual([])
    expect(out.todayByChannel).toEqual([])
  })

  // ============================================================
  // I1 (IMPORTANT): "today" boundary must be the VENUE's local midnight, never host/server tz
  // ============================================================
  it('I1: resolves the "today" boundary via venueStartOfDay(venue.timezone) — never a bare host-tz setHours(0,0,0,0)', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockVenueFindUnique.mockResolvedValueOnce({ timezone: 'America/Cancun' })
    mockLinkFindMany.mockResolvedValueOnce([])
    mockOrderGroupBy.mockResolvedValueOnce([])

    await call({ venueId: 'v1' })

    expect(mockVenueFindUnique).toHaveBeenCalledWith({ where: { id: 'v1' }, select: { timezone: true } })
    expect(mockVenueStartOfDay).toHaveBeenCalledWith('America/Cancun')
    const groupByArg = mockOrderGroupBy.mock.calls[0][0] as { where: { createdAt: { gte: Date } } }
    expect(groupByArg.where.createdAt.gte).toBe(mockVenueStartOfDay.mock.results[0].value)
  })

  it('I1: falls back to America/Mexico_City when the venue has no timezone set (never crashes)', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockVenueFindUnique.mockResolvedValueOnce({ timezone: null })
    mockLinkFindMany.mockResolvedValueOnce([])
    mockOrderGroupBy.mockResolvedValueOnce([])

    await call({ venueId: 'v1' })

    expect(mockVenueStartOfDay).toHaveBeenCalledWith('America/Mexico_City')
  })

  it('I1: a venue lacking the feature never reaches the venue.findUnique call (reads NOTHING, gate short-circuits first)', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(false)
    await call({ venueId: 'v1' })
    expect(mockVenueFindUnique).not.toHaveBeenCalled()
  })
  it('🔴 reporta si el menú está publicado en el proveedor', async () => {
    // "¿mi menú está actualizado allá?" es la pregunta que un operador SÍ hace, y hasta
    // ahora sólo se podía contestar entrando a la base. Un menú viejo cobra el precio
    // equivocado o provoca rechazos que Uber cuenta contra la tasa que exige para no
    // revocar el acceso.
    //
    // `lastMenuHash` se guarda SÓLO si la publicación salió bien: su ausencia con el
    // auto-sync prendido significa "nunca se logró publicar", no "todavía no toca". Por eso
    // se puede contestar sin adivinar.
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockVenueFindUnique.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockLinkFindMany.mockResolvedValueOnce([
      {
        id: 'l1',
        provider: 'UBER_EATS',
        status: 'ACTIVE',
        orderAcceptanceMode: 'AUTO',
        autoSyncMenu: true,
        lastMenuSyncAt: null,
        lastMenuHash: null,
        externalLocationId: 's1',
      },
      {
        id: 'l2',
        provider: 'UBER_EATS',
        status: 'ACTIVE',
        orderAcceptanceMode: 'AUTO',
        autoSyncMenu: true,
        lastMenuSyncAt: new Date(),
        lastMenuHash: 'abc',
        externalLocationId: 's2',
      },
      {
        id: 'l3',
        provider: 'UBER_EATS',
        status: 'ACTIVE',
        orderAcceptanceMode: 'AUTO',
        autoSyncMenu: false,
        lastMenuSyncAt: null,
        lastMenuHash: null,
        externalLocationId: 's3',
      },
    ])
    mockOrderGroupBy.mockResolvedValueOnce([])

    const out = parse(await call({ venueId: 'v1' }))

    expect(out.channels.map((c: { menuSyncStatus: string }) => c.menuSyncStatus)).toEqual(['NUNCA_PUBLICADO', 'AL_DIA', 'MANUAL'])
    expect(out.channels.map((c: { menuPublicado: boolean }) => c.menuPublicado)).toEqual([false, true, false])
    // La huella misma no le sirve a nadie fuera del sincronizador.
    expect(out.channels[1].lastMenuHash).toBeUndefined()
  })

  // ── El horario y el margen: los dos ajustes que mueven dinero ─────────────────────
  // Vivían SÓLO en la columna JSON del canal, así que la única forma de contestar "¿a
  // qué horas acepto pedidos?" o "¿qué margen tengo?" era abrir Postgres.
  it('🔴 expone el horario Y DE DÓNDE SALIÓ — un estimado dicho como certeza no lo revisa nadie', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockVenueFindUnique.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockLinkFindMany.mockResolvedValueOnce([
      {
        id: 'l1',
        venueId: 'v1',
        provider: 'UBER_EATS',
        status: 'ACTIVE',
        orderAcceptanceMode: 'AUTO',
        autoSyncMenu: true,
        lastMenuSyncAt: null,
        lastMenuHash: 'abc',
        externalLocationId: 's1',
        config: { deliveryHours: HORARIO_CANAL },
      },
      {
        id: 'l2',
        venueId: 'v1',
        provider: 'UBER_EATS',
        status: 'ACTIVE',
        orderAcceptanceMode: 'AUTO',
        autoSyncMenu: true,
        lastMenuSyncAt: null,
        lastMenuHash: 'def',
        externalLocationId: 's2',
        config: null,
      },
    ])
    mockOrderGroupBy.mockResolvedValueOnce([])

    const out = parse(await call({ venueId: 'v1' }))
    const [configurado, sinConfigurar] = out.channels

    expect(configurado.horarioFuente).toBe('CANAL')
    expect(configurado.horario.monday.ranges[0]).toEqual({ open: '11:00', close: '23:00' })

    // Lo que de verdad importa: el segundo canal TAMBIÉN devuelve un horario, pero
    // declarado como suposición. Sin `horarioFuente` se leerían idénticos.
    expect(sinConfigurar.horarioFuente).toBe('ESTIMADO')
    expect(sinConfigurar.horario).not.toBeNull()
  })

  it('🔴 expone el margen, y `null` cuando no hay — publicar el precio de mostrador pierde dinero', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockVenueFindUnique.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockLinkFindMany.mockResolvedValueOnce([
      { ...LINK_BASE, id: 'l1', config: { precios: { markupPercent: 30 } } },
      { ...LINK_BASE, id: 'l2', config: { precios: {} } },
      { ...LINK_BASE, id: 'l3', config: null },
      // Basura en la columna: no debe reportarse como margen ni tumbar el tool.
      { ...LINK_BASE, id: 'l4', config: { precios: { markupPercent: 'treinta' } } },
    ])
    mockOrderGroupBy.mockResolvedValueOnce([])

    const out = parse(await call({ venueId: 'v1' }))
    expect(out.channels.map((c: { margenPorcentaje: number | null }) => c.margenPorcentaje)).toEqual([30, null, null, null])
  })

  it('🔴 NUNCA devuelve webhookSecret ni el blob crudo de config', async () => {
    // Este tool dejó de usar `select` para poder resolver el horario (que necesita el
    // registro entero), así que la consulta AHORA trae el secreto. Se anula en el mapeo —
    // y esto es lo que prueba que se sigue anulando.
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockVenueFindUnique.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockLinkFindMany.mockResolvedValueOnce([
      { ...LINK_BASE, id: 'l1', webhookSecret: 'no-debe-salir-jamas', config: { precios: { markupPercent: 30 } } },
    ])
    mockOrderGroupBy.mockResolvedValueOnce([])

    const crudo = (await call({ venueId: 'v1' })).content[0].text
    expect(crudo).not.toContain('no-debe-salir-jamas')

    const canal = parse({ content: [{ text: crudo }] }).channels[0]
    expect(canal.webhookSecret).toBeUndefined()
    expect(canal.config).toBeUndefined()
    expect(canal.margenPorcentaje).toBe(30) // el dato SÍ sale, desglosado
  })
})
