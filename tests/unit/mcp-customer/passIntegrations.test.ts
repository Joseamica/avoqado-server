// Herramientas MCP del conector de pases (TotalPass/Wellhub). Llaves y datos inventados: nada real.
const mockAudit = jest.fn()
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...a) }))
const mockRequirePermission = jest.fn()
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => ({ venueId: { in: [v ?? 'v1'] } }),
    requirePermission: (...a: unknown[]) => mockRequirePermission(...a),
  }),
}))
const mockGate = jest.fn()
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockGate(...a) }))
const mockCapacity = {
  getPassCapacity: jest.fn(),
  getPassCapacityRules: jest.fn(),
  getSessionPassCap: jest.fn(),
  setDefaultPassCap: jest.fn(),
  upsertWeeklyPassCap: jest.fn(),
  deletePassCapRule: jest.fn(),
  setSessionPassCap: jest.fn(),
}
jest.mock('@/services/aggregators/passCapacity.service', () => mockCapacity)
// `localDayRange` es la real: la prueba fija la conversión de días locales a instantes.
const mockListPassVisits = jest.fn()
jest.mock('@/services/aggregators/passVisits.service', () => ({
  ...jest.requireActual('@/services/aggregators/passVisits.service'),
  listPassVisits: (...a: unknown[]) => mockListPassVisits(...a),
}))
const mockTz = jest.fn()
jest.mock('@/services/dashboard/commission/commission-utils', () => ({ getVenueTimezone: (...a: unknown[]) => mockTz(...a) }))
const mockIntegrations = { getPassIntegrationsOverview: jest.fn() }
jest.mock('@/services/aggregators/passIntegrations.service', () => mockIntegrations)

import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { registerPassIntegrationTools } from '@/mcp/tools/passIntegrations'

const handlers = new Map<string, (args: any) => Promise<any>>()
const shapes = new Map<string, z.ZodRawShape>()
const reg = {
  tool: (...a: any[]) => {
    handlers.set(a[0], a[a.length - 1])
    shapes.set(a[0], a[2])
  },
} as never
const mockSessionFind = (prisma as any).classSession.findFirst as jest.Mock
// Clase inventada: sábado 10-oct-2026 a las 09:00 en Ciudad de México (UTC-6).
const SESSION = { startsAt: new Date('2026-10-10T15:00:00.000Z'), product: { name: 'Yoga Prueba' } }
const scope = { staffId: 's1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as any
registerPassIntegrationTools(reg, scope)
const call = async (name: string, args: any) => JSON.parse((await handlers.get(name)!(args)).content[0].text)

beforeEach(() => {
  jest.clearAllMocks()
  mockGate.mockResolvedValue(null)
  mockTz.mockResolvedValue('America/Mexico_City')
  mockListPassVisits.mockResolvedValue({ items: [], total: 0, hasMore: false, nextOffset: null })
  mockCapacity.getPassCapacity.mockResolvedValue({ defaultMaxSpots: 4, weekly: [], suggestions: [] })
  mockCapacity.getPassCapacityRules.mockResolvedValue({
    defaultMaxSpots: 4,
    weekly: [{ id: 'w1', weekday: 6, startMinute: 540, maxSpots: 1 }],
  })
  mockCapacity.getSessionPassCap.mockResolvedValue(null)
  mockSessionFind.mockResolvedValue(SESSION)
})

describe('herramientas MCP de pases', () => {
  // nuevo
  it('registra las 4 herramientas', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'aggregator_capacity_rules',
      'aggregator_connection_status',
      'list_aggregator_visits',
      'set_aggregator_capacity_rule',
    ])
  })

  // nuevo — C1 / P2-12: sin candado de plan (como el resumen HTTP): el negocio que lo perdió ve `planActive: false`
  it('estado de la conexión: permiso de lectura, sin candado de plan, y sólo las conexiones', async () => {
    mockGate.mockResolvedValue('Los pases no están incluidos…')
    const connections = [{ provider: 'TOTALPASS', available: true, status: 'ACTIVE' }]
    mockIntegrations.getPassIntegrationsOverview.mockResolvedValueOnce({
      planActive: false,
      connections,
      classProducts: { items: [], total: 0 },
    })
    const out = await call('aggregator_connection_status', { venueId: 'v1' })
    expect(out).toEqual({ ok: true, venueId: 'v1', planActive: false, connections })
    expect(mockRequirePermission).toHaveBeenCalledWith('reservations:read', 'v1')
    expect(mockGate).not.toHaveBeenCalled()
  })

  // C1 — pausa suave: los check-ins que ya existen se siguen leyendo sin el plan (con el permiso de lectura)
  it('sin el plan, los check-ins se leen igual', async () => {
    mockGate.mockResolvedValue('Los pases no están incluidos…')
    const out = await call('list_aggregator_visits', { venueId: 'v1' })
    expect(out).toMatchObject({ ok: true, venueId: 'v1' })
    expect(mockListPassVisits).toHaveBeenCalledTimes(1)
    expect(mockRequirePermission).toHaveBeenCalledWith('reservations:read', 'v1')
    expect(mockGate).not.toHaveBeenCalled()
  })

  // nuevo — la configuración de lugares sí conserva el candado
  it('sin el plan ⇒ las reglas de lugares responden planRequired y no leen nada', async () => {
    mockGate.mockResolvedValueOnce('Los pases no están incluidos…')
    const out = await call('aggregator_capacity_rules', { venueId: 'v1' })
    expect(out).toMatchObject({ ok: false, planRequired: true })
    expect(mockCapacity.getPassCapacity).not.toHaveBeenCalled()
  })

  // nuevo — R58: from/to son días LOCALES del negocio (AAAA-MM-DD, `to` inclusivo)
  it('check-ins por días locales: medianoche del negocio, `to` incluye su día completo', async () => {
    const out = await call('list_aggregator_visits', { venueId: 'v1', status: 'PENDING', from: '2026-10-01', to: '2026-10-02', limit: 10 })
    expect(mockTz).toHaveBeenCalledWith('v1')
    expect(mockListPassVisits).toHaveBeenCalledWith('v1', {
      status: 'PENDING',
      provider: undefined,
      from: new Date('2026-10-01T06:00:00.000Z'),
      to: new Date('2026-10-03T06:00:00.000Z'),
      limit: 10,
      offset: undefined,
    })
    expect(out).toMatchObject({ ok: true, venueId: 'v1', timezone: 'America/Mexico_City', count: 0, total: 0 })
  })

  // nuevo — una fecha que no existe no se recorre a otro día
  it('fecha imposible ⇒ error en español y no lee', async () => {
    await expect(call('list_aggregator_visits', { venueId: 'v1', from: '2026-02-30' })).rejects.toThrow(/AAAA-MM-DD/)
    expect(mockListPassVisits).not.toHaveBeenCalled()
  })

  // nuevo
  it('set_aggregator_capacity_rule sin confirm ⇒ vista previa actual → nuevo, sin escribir ni auditar', async () => {
    const out = await call('set_aggregator_capacity_rule', { venueId: 'v1', scope: 'DEFAULT', maxSpots: 2 })
    expect(out).toMatchObject({
      ok: false,
      requiresConfirmation: true,
      preview: { actual: expect.stringMatching(/4/), nuevo: expect.stringMatching(/2/) },
    })
    expect(mockCapacity.setDefaultPassCap).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
    expect(mockRequirePermission).toHaveBeenCalledWith('reservations:manage-passes', 'v1')
  })

  // nuevo
  it('con confirm ⇒ guarda y audita', async () => {
    mockCapacity.setDefaultPassCap.mockResolvedValueOnce(undefined)
    const out = await call('set_aggregator_capacity_rule', { venueId: 'v1', scope: 'DEFAULT', maxSpots: 2, confirm: true })
    expect(out.ok).toBe(true)
    expect(mockCapacity.setDefaultPassCap).toHaveBeenCalledWith('v1', 2, 's1')
    expect(mockAudit).toHaveBeenCalledWith(scope, expect.objectContaining({ action: 'MCP_PASS_CAPACITY_RULE_SET', venueId: 'v1' }))
  })

  // nuevo — P2-16: la vista previa dice qué regla vuelve a aplicar al quitar una
  it('quitar la regla de una sesión explica que vuelve la del día o la general; quitar una excepción la borra', async () => {
    mockCapacity.getSessionPassCap.mockResolvedValueOnce(0)
    const prev = await call('set_aggregator_capacity_rule', { venueId: 'v1', scope: 'SESSION', classSessionId: 's9', maxSpots: null })
    expect(prev.preview).toMatchObject({
      actual: expect.stringMatching(/0 lugar/),
      nuevo: expect.stringMatching(/se usa la del día y hora, o la general/),
    })
    await call('set_aggregator_capacity_rule', {
      venueId: 'v1',
      scope: 'WEEKLY',
      weekday: 6,
      startTime: '09:00',
      maxSpots: null,
      confirm: true,
    })
    expect(mockCapacity.deletePassCapRule).toHaveBeenCalledWith('v1', 'w1', 's1')
    expect(mockCapacity.getPassCapacity).not.toHaveBeenCalled() // las sugerencias no se recalculan para un cambio
  })

  // nuevo
  it('WEEKLY con hora «HH:mm» la convierte a minutos; SESSION exige classSessionId', async () => {
    await call('set_aggregator_capacity_rule', {
      venueId: 'v1',
      scope: 'WEEKLY',
      weekday: 6,
      startTime: '09:00',
      maxSpots: 1,
      confirm: true,
    })
    expect(mockCapacity.upsertWeeklyPassCap).toHaveBeenCalledWith('v1', { weekday: 6, startMinute: 540, maxSpots: 1 }, 's1')
    const bad = await call('set_aggregator_capacity_rule', { venueId: 'v1', scope: 'SESSION', maxSpots: 1, confirm: true })
    expect(bad).toMatchObject({ ok: false })
  })

  // nuevo — quitar lo que no existe no escribe ni deja rastro
  it('quitar un tope general o de sesión que no existe ⇒ nada que quitar, sin escribir ni auditar', async () => {
    mockCapacity.getPassCapacityRules.mockResolvedValueOnce({ defaultMaxSpots: null, weekly: [] })
    const general = await call('set_aggregator_capacity_rule', { venueId: 'v1', scope: 'DEFAULT', maxSpots: null, confirm: true })
    const session = await call('set_aggregator_capacity_rule', {
      venueId: 'v1',
      scope: 'SESSION',
      classSessionId: 's9',
      maxSpots: null,
      confirm: true,
    })
    expect(general).toMatchObject({ ok: false, error: expect.stringMatching(/nada que quitar/) })
    expect(session).toMatchObject({ ok: false, error: expect.stringMatching(/nada que quitar/) })
    expect(mockCapacity.setDefaultPassCap).not.toHaveBeenCalled()
    expect(mockCapacity.setSessionPassCap).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  // Ronda 1 · H1 — la vista previa de una sesión dice qué clase es; una sesión ajena o inexistente no llega a vista previa
  it('SESSION con un id que no es de este negocio ⇒ ok:false, sin vista previa ni escritura', async () => {
    mockSessionFind.mockResolvedValue(null)
    const prev = await call('set_aggregator_capacity_rule', { venueId: 'v1', scope: 'SESSION', classSessionId: 'ajena', maxSpots: 2 })
    expect(prev).toMatchObject({ ok: false, error: 'No encontré esa clase en este negocio. Búscala con list_class_sessions y usa su id.' })
    expect(prev.requiresConfirmation).toBeUndefined()
    expect(prev.preview).toBeUndefined()
    expect(mockSessionFind).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'ajena', venueId: 'v1' } }))
    const conf = await call('set_aggregator_capacity_rule', {
      venueId: 'v1',
      scope: 'SESSION',
      classSessionId: 'ajena',
      maxSpots: 2,
      confirm: true,
    })
    expect(conf.ok).toBe(false)
    expect(mockCapacity.setSessionPassCap).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('SESSION válida ⇒ la vista previa nombra la clase con su día y hora del negocio', async () => {
    const prev = await call('set_aggregator_capacity_rule', { venueId: 'v1', scope: 'SESSION', classSessionId: 's9', maxSpots: 2 })
    expect(prev).toMatchObject({
      requiresConfirmation: true,
      preview: { regla: 'Yoga Prueba · sábado 2026-10-10 09:00', nuevo: '2 lugar(es)' },
    })
    expect(mockTz).toHaveBeenCalledWith('v1')
  })

  // Ronda 1 · H2 — zod responde en español en las 4 herramientas
  it('los mensajes de validación salen en español', () => {
    const issues = (name: string, input: unknown) => {
      const r = z.object(shapes.get(name)!).safeParse(input)
      return r.success ? [] : r.error.issues.map(i => i.message)
    }
    const startTime = issues('set_aggregator_capacity_rule', { venueId: 'v1', scope: 'WEEKLY', weekday: 6, startTime: '9am', maxSpots: 1 })
    expect(startTime).toEqual(['La hora va en formato HH:MM de 24 horas (ej. 09:00).'])
    const all = [
      ...issues('aggregator_connection_status', {}),
      ...issues('aggregator_capacity_rules', { venueId: 3 }),
      ...issues('list_aggregator_visits', {}),
      ...issues('list_aggregator_visits', { venueId: 'v1', status: 'X', provider: 'X', from: '1/10', to: 5, limit: 0.5, offset: -1 }),
      ...issues('list_aggregator_visits', { venueId: 'v1', limit: 101, offset: 'a' }),
      ...issues('set_aggregator_capacity_rule', {}),
      ...issues('set_aggregator_capacity_rule', {
        venueId: 'v1',
        scope: 'X',
        weekday: 9,
        startTime: 9,
        classSessionId: 3,
        maxSpots: 'dos',
        confirm: 'si',
      }),
      ...issues('set_aggregator_capacity_rule', { venueId: 'v1', scope: 'WEEKLY', weekday: -1, maxSpots: 501 }),
      ...issues('set_aggregator_capacity_rule', { venueId: 'v1', scope: 'WEEKLY', weekday: 1.5, maxSpots: -1 }),
    ]
    expect(all.length).toBeGreaterThan(15)
    expect(all.filter(m => /\b(Invalid|Expected|Required|received|must|greater|less|enum)\b/i.test(m))).toEqual([])
  })

  // Ronda 1 · H3 — cobertura que faltaba
  it('sin el plan, cambiar lugares responde el mensaje del candado y no escribe', async () => {
    mockGate.mockResolvedValueOnce('Los pases no están incluidos en tu plan.')
    const out = await call('set_aggregator_capacity_rule', { venueId: 'v1', scope: 'DEFAULT', maxSpots: 2, confirm: true })
    expect(out).toEqual({ ok: false, planRequired: true, error: 'Los pases no están incluidos en tu plan.' })
    expect(mockGate).toHaveBeenCalledWith('v1', 'AGGREGATOR_PASSES', expect.any(String))
    expect(mockCapacity.getPassCapacityRules).not.toHaveBeenCalled()
    expect(mockCapacity.setDefaultPassCap).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('quitar una excepción semanal que no existe ⇒ nada que quitar, sin borrar ni auditar', async () => {
    const out = await call('set_aggregator_capacity_rule', {
      venueId: 'v1',
      scope: 'WEEKLY',
      weekday: 2,
      startTime: '18:00',
      maxSpots: null,
      confirm: true,
    })
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/martes 18:00.*nada que quitar/) })
    expect(mockCapacity.deletePassCapRule).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('la auditoría guarda qué regla cambió: WEEKLY por día y minuto, SESSION por la clase', async () => {
    await call('set_aggregator_capacity_rule', {
      venueId: 'v1',
      scope: 'WEEKLY',
      weekday: 6,
      startTime: '09:00',
      maxSpots: 1,
      confirm: true,
    })
    expect(mockAudit).toHaveBeenLastCalledWith(scope, {
      action: 'MCP_PASS_CAPACITY_RULE_SET',
      entity: 'AggregatorCapacityRule',
      entityId: 'WEEKLY:6:540',
      venueId: 'v1',
      data: { scope: 'WEEKLY', weekday: 6, startMinute: 540, maxSpots: 1 },
    })
    await call('set_aggregator_capacity_rule', {
      venueId: 'v1',
      scope: 'SESSION',
      classSessionId: 's9',
      weekday: 3,
      startTime: '10:00',
      maxSpots: 2,
      confirm: true,
    })
    expect(mockCapacity.setSessionPassCap).toHaveBeenCalledWith('v1', 's9', 2, 's1')
    expect(mockAudit).toHaveBeenLastCalledWith(scope, {
      action: 'MCP_PASS_CAPACITY_RULE_SET',
      entity: 'AggregatorCapacityRule',
      entityId: 's9',
      venueId: 'v1',
      data: { scope: 'SESSION', weekday: null, startMinute: null, maxSpots: 2, classSessionId: 's9' },
    })
  })
})
