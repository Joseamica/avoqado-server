/**
 * Máquina de efectivo 1a · A7 + R4-7 #11 + R3#10: `cash_machine_closes`, sólo lectura y sólo en el MCP libre. Los cierres de la máquina
 * de un rango (fechas del negocio), en PESOS, acotados (≤ 100) con el total y un cursor que llega más allá de los primeros 100. Los
 * guardias de `list_payments` (`venueFilter` + `payments:read`), y el total con el MISMO filtro que las filas. «Originó deuda», nunca
 * «pendiente»: la 1a no registra quién la pagó.
 */
import prisma from '@/utils/prismaClient'
import { registerCashMachineTools } from '@/mcp/tools/cash-machine'
import { TOOL_EFFECTS } from '@/mcp/catalog'
import { DIRECTORY_TIERS } from '@/mcp/directory/catalog'
import type { McpScope } from '@/mcp/scope'

const venueId = 'c0000000000000000000000001'
const scope: McpScope = {
  staffId: 'c0000000000000000000000003',
  activeOrg: 'c0000000000000000000000004',
  scopes: ['mcp:read'],
  allowedVenueIds: [venueId],
  perVenueAccess: new Map([[venueId, { corePermissions: ['payments:read'] } as never]]),
}
type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>
const handlers = new Map<string, Handler>()
const descripciones = new Map<string, string>()
const call = async (args: Record<string, unknown>) => JSON.parse((await handlers.get('cash_machine_closes')!(args, {})).content[0].text)

/** 150 cierres en memoria, más nuevos primero; el doble de la base aplica el filtro, el cursor, el orden y el tope. */
const cierre = (i: number) => ({
  id: `c${String(i).padStart(24, '0')}`,
  referenceCC: `AQ${String(i).padStart(12, '0')}`,
  outcome: i % 3 === 0 ? 'GUARDADO' : 'PAGADO',
  resolvedBy: i === 7 ? 'GERENTE' : 'MAQUINA',
  dueCents: 18750,
  saleCents: 18000,
  tipCents: 750,
  creditCents: 20000,
  changeDispensedCents: i % 3 === 0 ? 0 : 1000,
  appliedCents: i % 3 === 0 ? 0 : 18000,
  excedenteCents: 0,
  owedCents: i % 3 === 0 ? 20000 : 250,
  owedKind: i % 3 === 0 ? 'GUARDADO' : 'CAMBIO',
  orderId: i % 3 === 0 ? null : `orden-${i}`,
  paymentId: i % 3 === 0 ? null : `pago-${i}`,
  shiftStatus: 'EN_TURNO',
  occurredAt: new Date(Date.UTC(2026, 10, 20, 18, 0, 0) - i * 60_000),
  occurredAtKnown: true,
  createdAt: new Date(Date.UTC(2026, 10, 20, 18, 0, 0) - i * 60_000),
})
const BASE = Array.from({ length: 150 }, (_, i) => cierre(i + 1))

/** El cursor del doble: `AND: [filtro, { OR: [createdAt < x, (createdAt = x, id < y)] }]`. */
function aplicar(where: any, filas: any[]) {
  const [filtro, cursor] = where.AND ?? [where, null]
  return filas.filter(f => {
    if (filtro.venueId !== venueId) return false
    if (filtro.owedCents?.gt !== undefined && !(f.owedCents > filtro.owedCents.gt)) return false
    if (filtro.referenceCC?.contains && !f.referenceCC.includes(filtro.referenceCC.contains)) return false
    if (!cursor) return true
    const [antes, empate] = cursor.OR
    return f.createdAt < antes.createdAt.lt || (+f.createdAt === +empate.createdAt && f.id < empate.id.lt)
  })
}

beforeAll(() =>
  registerCashMachineTools(
    {
      tool: (...args: any[]) => {
        handlers.set(args[0], args[args.length - 1])
        descripciones.set(args[0], typeof args[1] === 'string' ? args[1] : '')
      },
    } as never,
    scope,
  ),
)

beforeEach(() => {
  jest.clearAllMocks()
  scope.perVenueAccess.set(venueId, { corePermissions: ['payments:read'] } as never)
  jest.mocked(prisma.venue.findUnique).mockResolvedValue({ timezone: 'America/Mexico_City' } as never)
  jest.mocked(prisma.cashMachineClose.count).mockImplementation((async (a: any) => aplicar(a.where, BASE).length) as never)
  jest.mocked(prisma.cashMachineClose.findMany).mockImplementation((async (a: any) =>
    aplicar(a.where, BASE)
      .sort((x, y) => +y.createdAt - +x.createdAt || (y.id < x.id ? -1 : 1))
      .slice(0, a.take)) as never)
})

describe('cash_machine_closes — MCP libre, sólo lectura, pesos', () => {
  it('se registra como lectura y no está en ningún catálogo certificado', () => {
    expect(handlers.has('cash_machine_closes')).toBe(true)
    expect(TOOL_EFFECTS.cash_machine_closes).toBe('read')
    expect(DIRECTORY_TIERS.flatMap(t => [...t.tools])).not.toContain('cash_machine_closes')
  })

  it('🔴 R3#10: dice «originó deuda» y «pago por retiro sin verificar», nunca «pendiente»', () => {
    const d = descripciones.get('cash_machine_closes')!
    expect(d).toMatch(/originó deuda/)
    expect(d).toMatch(/pago por retiro sin verificar/)
    expect(d).not.toMatch(/pendiente/i)
  })

  it('🔴 en PESOS, nunca centavos', async () => {
    const r = await call({ venueId, fromDate: '2026-11-19', toDate: '2026-11-20', limit: 1 })
    expect(r.cierres[0]).toMatchObject({
      folio: 'AQ000000000001',
      desenlace: 'PAGADO',
      resueltoPor: 'MAQUINA',
      adeudo: 187.5,
      venta: 180,
      propina: 7.5,
      entro: 200,
      cambioEntregado: 10,
      aplicado: 180,
      excedente: 0,
      origenDeuda: 2.5,
      tipoDeDeuda: 'CAMBIO',
    })
    expect(JSON.stringify(r)).not.toMatch(/Cents/)
  })

  it('🔴 el total usa el MISMO filtro que las filas (y el rango en fechas del negocio)', async () => {
    const r = await call({ venueId, fromDate: '2026-11-20', toDate: '2026-11-20', soloConDeuda: true, folio: 'aq0000000001' })
    const filtroDelTotal = jest.mocked(prisma.cashMachineClose.count).mock.calls[0][0]!.where
    const filtroDeLasFilas = jest.mocked(prisma.cashMachineClose.findMany).mock.calls[0][0]!.where
    expect(filtroDeLasFilas).toEqual(filtroDelTotal)
    expect(filtroDelTotal).toMatchObject({
      venueId,
      owedCents: { gt: 0 },
      referenceCC: { contains: 'AQ0000000001' },
      // 20-nov en México (UTC-6): de las 06:00Z del 20 a las 05:59:59.999Z del 21.
      createdAt: { gte: new Date('2026-11-20T06:00:00.000Z'), lte: new Date('2026-11-21T05:59:59.999Z') },
    })
    // AQ + 9 ceros + 1 = los folios 100 a 150: el total cuenta los que cumplen el filtro, no la página.
    expect(r.total).toBe(51)
  })

  it('🔴 tope de 100 con el total y un cursor que encuentra un cierre más allá de los primeros 100', async () => {
    const p1 = await call({ venueId, limit: 1000 })
    expect(p1).toMatchObject({ total: 150, count: 100 })
    expect(jest.mocked(prisma.cashMachineClose.findMany).mock.calls[0][0]!.take).toBe(101)
    expect(p1.nextCursor).toEqual(expect.any(String))
    const p2 = await call({ venueId, limit: 100, cursor: p1.nextCursor })
    expect(p2).toMatchObject({ total: 150, count: 50, nextCursor: null })
    expect(p2.cierres.map((c: any) => c.folio)).toContain('AQ000000000150')
    const vistos = new Set([...p1.cierres, ...p2.cierres].map((c: any) => c.folio))
    expect(vistos.size).toBe(150)
  })

  it('«con deuda»: sólo los que originaron deuda, con su nota', async () => {
    const r = await call({ venueId, soloConDeuda: true, limit: 3 })
    expect(r.cierres.every((c: any) => c.origenDeuda > 0)).toBe(true)
    expect(r.cierres[0].nota).toMatch(/pago por retiro sin verificar/)
  })

  it('«en duda»: las dudas ABIERTAS de la máquina, en pesos', async () => {
    jest.mocked(prisma.cashMachineIncident.count).mockResolvedValue(1 as never)
    jest.mocked(prisma.cashMachineIncident.findMany).mockResolvedValue([
      {
        id: 'c00000000000000000000duda',
        referenceCC: 'AQ00000000DUDA',
        createdAt: new Date('2026-11-20T18:00:00.000Z'),
        deviceId: 'terminal-pc',
        payload: { dueCents: 18750, saleCents: 18000, tipCents: 750, startedAt: '2026-11-20T17:58:00.000Z', lastSeen: null },
      },
    ] as never)
    const r = await call({ venueId, enDuda: true })
    const filtro = { venueId, kind: 'ESPERANDO', status: 'ABIERTO' }
    expect(jest.mocked(prisma.cashMachineIncident.count).mock.calls[0][0]!.where).toEqual(filtro)
    expect(jest.mocked(prisma.cashMachineIncident.findMany).mock.calls[0][0]!.where).toEqual(filtro)
    expect(r).toMatchObject({ total: 1, count: 1, dudas: [{ folio: 'AQ00000000DUDA', adeudo: 187.5, venta: 180, propina: 7.5 }] })
    expect(prisma.cashMachineClose.findMany).not.toHaveBeenCalled()
  })

  it('🔴 niega una sucursal ajena antes de leer', async () => {
    await expect(call({ venueId: 'ajena' })).rejects.toThrow(/scope|alcance/i)
    expect(prisma.cashMachineClose.findMany).not.toHaveBeenCalled()
    expect(prisma.cashMachineClose.count).not.toHaveBeenCalled()
  })

  it('🔴 sin payments:read en ESA sucursal no lee nada', async () => {
    scope.perVenueAccess.set(venueId, { corePermissions: [] } as never)
    await expect(call({ venueId })).rejects.toThrow(/payments:read/)
    expect(prisma.cashMachineClose.findMany).not.toHaveBeenCalled()
  })

  it('un cursor que no es nuestro se rechaza', async () => {
    const r = await call({ venueId, cursor: 'no-es-un-cursor' })
    expect(r).toMatchObject({ ok: false })
    expect(prisma.cashMachineClose.findMany).not.toHaveBeenCalled()
  })
})
