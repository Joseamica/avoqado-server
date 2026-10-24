import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { registerExchangeTools } from '@/mcp/tools/exchanges'
import type { McpScope } from '@/mcp/scope'
import { TOOL_EFFECTS } from '@/mcp/catalog'
import { DIRECTORY_TOOLS } from '@/mcp/directory/catalog'

const mockFind = jest.fn()
const mockCount = jest.fn()
const mockVenue = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    exchange: { findMany: (...args: unknown[]) => mockFind(...args), count: (...args: unknown[]) => mockCount(...args) },
    venue: { findUnique: (...args: unknown[]) => mockVenue(...args) },
  },
}))
jest.mock('@/services/access/access.service', () => ({
  hasPermission: (access: { corePermissions: string[] }, permission: string) => access.corePermissions.includes(permission),
}))

const venueId = 'cm12345678901234567890123'
const otherVenueId = 'cm22345678901234567890123'
const scope: McpScope = {
  staffId: 'cm32345678901234567890123',
  activeOrg: 'cm42345678901234567890123',
  scopes: ['mcp:read'],
  allowedVenueIds: [venueId],
  perVenueAccess: new Map([[venueId, { corePermissions: ['payments:read'] } as never]]),
}

function tool(connection = scope) {
  let schema: z.ZodObject<z.ZodRawShape>
  let handler: (args: any) => Promise<any>
  const server = {
    tool: (_name: string, _description: string, shape: z.ZodRawShape, callback: typeof handler) => {
      schema = z.object(shape)
      handler = callback
    },
  } as never
  registerExchangeTools(server, connection)
  return {
    call: async (input: Record<string, unknown> = {}) => JSON.parse((await handler(schema.parse({ venueId, ...input }))).content[0].text),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockVenue.mockResolvedValue({ name: 'Tienda de prueba', timezone: 'America/Mexico_City' })
  mockFind.mockResolvedValue([])
  mockCount.mockResolvedValue(0)
})

describe('list_exchanges', () => {
  it('clamps limit 500 to 100, uses skip/take, and count uses the same where as findMany', async () => {
    await tool().call({ limit: 500, offset: 100 })
    expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({ take: 100, skip: 100 }))
    expect(mockCount.mock.calls[0][0].where).toEqual(mockFind.mock.calls[0][0].where)
    expect(mockFind.mock.calls[0][0].where.venueId).toEqual({ in: [venueId] })
    expect(mockFind.mock.calls[0][0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
  })

  it('filters by status NEEDS_REVIEW and by venue-local dates', async () => {
    await tool().call({ status: 'NEEDS_REVIEW', fromDate: '2026-10-01', toDate: '2026-10-02' })
    expect(mockFind.mock.calls[0][0].where).toEqual({
      venueId: { in: [venueId] },
      status: 'NEEDS_REVIEW',
      createdAt: { gte: new Date('2026-10-01T06:00:00.000Z'), lte: new Date('2026-10-03T05:59:59.999Z') },
    })
    expect(mockCount.mock.calls[0][0].where).toEqual(mockFind.mock.calls[0][0].where)
  })

  it('returns total, hayMas and siguienteOffset, with money in pesos', async () => {
    mockCount.mockResolvedValue(4)
    mockFind.mockResolvedValue([
      {
        id: 'cm52345678901234567890123',
        status: 'COMPLETED',
        createdAt: new Date('2026-10-02T07:30:00.000Z'),
        originalOrderId: 'cm62345678901234567890123',
        newOrderId: 'cm72345678901234567890123',
        returnedAmount: new Prisma.Decimal('150.50'),
        takenAmount: new Prisma.Decimal('120.25'),
        differenceAmount: new Prisma.Decimal('-30.25'),
        settlementKind: 'PAYOUT',
        settlementMethod: 'CASH',
        staffId: scope.staffId,
      },
    ])
    const output = await tool().call({ limit: 1, offset: 1, fromDate: '2026-10-01', toDate: '2026-10-02' })
    expect(output).toEqual({
      sucursal: 'Tienda de prueba',
      zonaHoraria: 'America/Mexico_City',
      desde: '2026-10-01T00:00:00.000-06:00',
      hasta: '2026-10-02T23:59:59.999-06:00',
      total: 4,
      cuantos: 1,
      hayMas: true,
      siguienteOffset: 2,
      cambios: [
        {
          id: 'cm52345678901234567890123',
          estado: 'COMPLETED',
          fecha: '2026-10-02T01:30:00.000-06:00',
          ventaOriginal: 'cm62345678901234567890123',
          ventaNueva: 'cm72345678901234567890123',
          regresa: 150.5,
          seLleva: 120.25,
          diferencia: -30.25,
          liquidacion: { tipo: 'PAYOUT', medio: 'CASH' },
          hizo: scope.staffId,
        },
      ],
    })
  })

  it('defaults to 25 rows and the last seven venue-local days without a status filter', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-24T02:00:00.000Z'))
    try {
      await tool().call()
      expect(mockFind).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 25,
          skip: 0,
          where: {
            venueId: { in: [venueId] },
            createdAt: { gte: new Date('2026-10-16T06:00:00.000Z'), lte: new Date('2026-10-24T05:59:59.999Z') },
          },
        }),
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it.each([0, 8])('returns no next page for an empty result at offset %i', async offset => {
    expect(await tool().call({ offset })).toMatchObject({ total: 0, cuantos: 0, hayMas: false, siguienteOffset: null, cambios: [] })
  })

  it('returns null for siguienteOffset on the last non-empty page and preserves an even settlement', async () => {
    mockCount.mockResolvedValue(2)
    mockFind.mockResolvedValue([
      {
        createdAt: new Date('2026-10-02T07:30:00Z'),
        returnedAmount: new Prisma.Decimal(10),
        takenAmount: new Prisma.Decimal(10),
        differenceAmount: new Prisma.Decimal(0),
        settlementKind: 'EVEN',
        settlementMethod: null,
      },
    ])
    expect(await tool().call({ offset: 1 })).toMatchObject({
      total: 2,
      cuantos: 1,
      hayMas: false,
      siguienteOffset: null,
      cambios: [{ regresa: 10, seLleva: 10, diferencia: 0, liquidacion: { tipo: 'EVEN', medio: null } }],
    })
  })

  it('requires payments:read through the guard before any database read', async () => {
    const denied = { ...scope, perVenueAccess: new Map([[venueId, { corePermissions: ['orders:read'] } as never]]) }
    await expect(tool(denied).call()).rejects.toThrow('payments:read')
    expect(mockVenue).not.toHaveBeenCalled()
    expect(mockFind).not.toHaveBeenCalled()
    expect(mockCount).not.toHaveBeenCalled()
  })

  it('rejects an out-of-scope venue before any database read', async () => {
    await expect(tool().call({ venueId: otherVenueId })).rejects.toThrow('not in your scope')
    expect(mockVenue).not.toHaveBeenCalled()
    expect(mockFind).not.toHaveBeenCalled()
    expect(mockCount).not.toHaveBeenCalled()
  })

  it('rejects a connection without mcp:read', async () => {
    await expect(tool({ ...scope, scopes: [] }).call()).rejects.toThrow('mcp:read')
    expect(mockVenue).not.toHaveBeenCalled()
  })

  it('rejects a missing venue instead of returning a misleading empty report', async () => {
    mockVenue.mockResolvedValue(null)
    await expect(tool().call()).rejects.toThrow('No se encontró la sucursal')
    expect(mockFind).not.toHaveBeenCalled()
    expect(mockCount).not.toHaveBeenCalled()
  })

  it('rejects a reversed date range before querying exchanges', async () => {
    await expect(tool().call({ fromDate: '2026-10-02', toDate: '2026-10-01' })).rejects.toThrow('fecha inicial')
    expect(mockFind).not.toHaveBeenCalled()
    expect(mockCount).not.toHaveBeenCalled()
  })

  it('propagates query errors instead of presenting zero exchanges', async () => {
    mockFind.mockRejectedValueOnce(new Error('query failed'))
    await expect(tool().call()).rejects.toThrow('query failed')
  })

  it.each([{ limit: 0 }, { limit: -1 }, { offset: -1 }, { offset: 0.5 }, { status: 'INVALID' }, { fromDate: '2026-02-30' }])(
    'rejects invalid input %j before querying exchanges',
    async input => {
      await expect(tool().call(input)).rejects.toThrow()
      expect(mockFind).not.toHaveBeenCalled()
      expect(mockCount).not.toHaveBeenCalled()
    },
  )

  it('classifies the tool as read-only and keeps it out of the certified catalog', () => {
    expect(TOOL_EFFECTS.list_exchanges).toBe('read')
    expect(DIRECTORY_TOOLS.has('list_exchanges')).toBe(false)
  })
})
