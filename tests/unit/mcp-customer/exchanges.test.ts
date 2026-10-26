import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { registerExchangeTools } from '@/mcp/tools/exchanges'
import type { McpScope } from '@/mcp/scope'
import { TOOL_EFFECTS } from '@/mcp/catalog'
import { DIRECTORY_TOOLS } from '@/mcp/directory/catalog'

const mockFind = jest.fn()
const mockCount = jest.fn()
const mockVenue = jest.fn()
const mockDetail = jest.fn()
const mockReview = jest.fn()
jest.mock('@/services/dashboard/exchange.dashboard.service', () => ({ markExchangeReviewed: (...args: unknown[]) => mockReview(...args) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    exchange: {
      findFirst: (...args: unknown[]) => mockDetail(...args),
      findMany: (...args: unknown[]) => mockFind(...args),
      count: (...args: unknown[]) => mockCount(...args),
    },
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

function tool(connection = scope, name = 'list_exchanges') {
  let schema: z.ZodObject<z.ZodRawShape>
  let handler: (args: any) => Promise<any>
  let description: string
  const server = {
    tool: (_name: string, toolDescription: string, shape: z.ZodRawShape, callback: typeof handler) => {
      if (_name !== name) return
      schema = z.object(shape)
      handler = callback
      description = toolDescription
    },
  } as never
  registerExchangeTools(server, connection)
  return {
    description: description!,
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
  it.each([
    ['PENDING_PAYMENT', 30.25],
    ['CANCELLED', null],
    ['NEEDS_REVIEW', null],
    ['COMPLETED', null],
    ['COMPLETED_PENDING_CARD_REFUND', null],
  ])('filters %s and exposes an amount due only for pending payment', async (status, amountDue) => {
    mockCount.mockResolvedValue(1)
    mockFind.mockResolvedValue([
      {
        status,
        createdAt: new Date('2026-10-02T07:30:00Z'),
        returnedAmount: new Prisma.Decimal('120.25'),
        takenAmount: new Prisma.Decimal('150.50'),
        differenceAmount: new Prisma.Decimal('30.25'),
        settlementKind: 'COLLECT',
        settlementMethod: 'CARD_TERMINAL',
        chargePaymentId: null,
        reviewReason: null,
      },
    ])
    const output = await tool().call({ status })
    expect(mockFind.mock.calls[0][0].where.status).toBe(status)
    expect(mockCount.mock.calls[0][0].where).toEqual(mockFind.mock.calls[0][0].where)
    expect(output.cambios).toEqual([expect.objectContaining({ estado: status, porCobrar: amountDue })])
  })

  it.each([
    ['cm82345678901234567890123', 'LATE_CHARGE_AFTER_CANCEL'],
    [null, null],
    [undefined, undefined],
  ])('exposes the terminal charge %s and review reason %s, or null when absent', async (chargePaymentId, reviewReason) => {
    mockFind.mockResolvedValue([
      {
        status: 'NEEDS_REVIEW',
        createdAt: new Date('2026-10-02T07:30:00Z'),
        returnedAmount: new Prisma.Decimal('120.25'),
        takenAmount: new Prisma.Decimal('150.50'),
        differenceAmount: new Prisma.Decimal('30.25'),
        settlementKind: 'COLLECT',
        settlementMethod: 'CARD_TERMINAL',
        chargePaymentId,
        reviewReason,
      },
    ])
    const output = await tool().call()
    expect(mockFind.mock.calls[0][0].select).toMatchObject({ chargePaymentId: true, reviewReason: true })
    expect(output.cambios).toEqual([
      expect.objectContaining({ cobroDeLaTerminal: chargePaymentId ?? null, motivoDeRevision: reviewReason ?? null, porCobrar: null }),
    ])
  })

  it('describes cancellation, amount due, terminal charge and review reason without model, table or route names', () => {
    const { description } = tool()
    expect(description).toMatch(/CANCELLED\s*\(cancelado\)/)
    expect(description).toMatch(/por cobrar/i)
    expect(description).toMatch(/cobro de la terminal/i)
    expect(description).toMatch(/motivo de revisi[oó]n/i)
    expect(description).not.toMatch(/\bExchange\b|\bPayment\b|\bPrisma\b|\btabla\b|src\/|\/api\/|\/mcp\b/)
  })

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
          porCobrar: null,
          cobroDeLaTerminal: null,
          motivoDeRevision: null,
          revisado: null,
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

describe('exchange review MCP', () => {
  const exchangeId = 'cm52345678901234567890123'
  const writer = {
    ...scope,
    scopes: ['mcp:read', 'mcp:write'],
    perVenueAccess: new Map([[venueId, { corePermissions: ['payments:read', 'payments:refund'] } as never]]),
  }
  const input = { exchangeId, note: 'Reviewed with the manager' }
  beforeEach(() => {
    mockDetail.mockResolvedValue({
      id: exchangeId,
      venueId,
      status: 'NEEDS_REVIEW',
      reviewReason: 'CHARGE_AMOUNT_MISMATCH',
      reviewedAt: null,
    })
    mockReview.mockResolvedValue({
      id: exchangeId,
      reviewedAt: new Date('2026-10-26T18:00:00Z'),
      reviewedById: scope.staffId,
      reviewNote: input.note,
    })
  })

  it('filters pending reviews without an implicit date cutoff and projects local review details', async () => {
    mockFind.mockResolvedValue([
      {
        status: 'NEEDS_REVIEW',
        createdAt: new Date('2026-10-01T06:00:00Z'),
        reviewedAt: new Date('2026-10-26T18:00:00Z'),
        reviewedById: scope.staffId,
        reviewNote: input.note,
      },
    ])
    const result = await tool().call({ porRevisar: true })
    expect(mockFind.mock.calls[0][0].where).toEqual({ venueId: { in: [venueId] }, status: 'NEEDS_REVIEW', reviewedAt: null })
    expect(mockCount.mock.calls[0][0].where).toEqual(mockFind.mock.calls[0][0].where)
    expect(result.cambios[0].revisado).toEqual({ fecha: '2026-10-26T12:00:00.000-06:00', quien: scope.staffId, nota: input.note })
  })

  // The signed preview gate lives in the catalog: exchanges.twoStep.test.ts drives it end to end.
  it('previews without writing and confirms the same exchange and note through the shared service', async () => {
    const review = tool(writer, 'review_exchange')
    const preview = await review.call(input)
    expect(preview).toMatchObject({ ok: false, requiresConfirmation: true, preview: { nota: input.note } })
    expect(mockReview).not.toHaveBeenCalled()
    expect(await review.call({ ...input, confirm: true })).toMatchObject({ ok: true })
    expect(mockReview).toHaveBeenCalledWith(
      expect.objectContaining({ venueId, exchangeId, staffId: scope.staffId, note: input.note, source: 'MCP' }),
    )
  })

  it('requires write scope, refund permission and tenant scope for previews and confirmations', async () => {
    for (const connection of [scope, { ...writer, scopes: undefined }, { ...writer, perVenueAccess: scope.perVenueAccess }]) {
      await expect(tool(connection, 'review_exchange').call(input)).rejects.toThrow()
    }
    await expect(tool(writer, 'review_exchange').call({ ...input, venueId: otherVenueId })).rejects.toThrow('not in your scope')
    expect(mockDetail).not.toHaveBeenCalled()
    expect(mockReview).not.toHaveBeenCalled()
  })

  it('permits review with refund permission alone and rejects invalid notes before any read', async () => {
    const reviewer = {
      ...writer,
      scopes: ['mcp:write'],
      perVenueAccess: new Map([[venueId, { corePermissions: ['payments:refund'] } as never]]),
    }
    const review = tool(reviewer, 'review_exchange')
    for (const note of [undefined, '', 'ab', '   ', 'x'.repeat(501)]) await expect(review.call({ ...input, note })).rejects.toThrow(/nota/i)
    expect(mockDetail).not.toHaveBeenCalled()
    expect(await review.call({ ...input, confirm: true })).toMatchObject({ ok: true, revisado: { fecha: '2026-10-26T12:00:00.000-06:00' } })
  })

  it.each([
    [{ status: 'COMPLETED', reviewedAt: null }, 'EXCHANGE_NOT_IN_REVIEW'],
    [{ status: 'NEEDS_REVIEW', reviewedAt: new Date() }, 'EXCHANGE_ALREADY_REVIEWED'],
  ])('does not offer an inapplicable preview for %j', async (fields, code) => {
    mockDetail.mockResolvedValue({ id: exchangeId, ...fields })
    await expect(tool(writer, 'review_exchange').call(input)).rejects.toMatchObject({ statusCode: 409, code })
    expect(mockReview).not.toHaveBeenCalled()
  })

  it('returns 404 for another venue and propagates shared-service conflicts', async () => {
    const review = tool(writer, 'review_exchange')
    mockDetail.mockResolvedValueOnce(null)
    await expect(review.call(input)).rejects.toMatchObject({ statusCode: 404 })
    mockReview.mockRejectedValueOnce(
      Object.assign(new Error('Este cambio ya fue revisado'), { statusCode: 409, code: 'EXCHANGE_ALREADY_REVIEWED' }),
    )
    await expect(review.call({ ...input, confirm: true })).rejects.toMatchObject({ code: 'EXCHANGE_ALREADY_REVIEWED' })
  })

  it('classifies the write and excludes it from the certified catalog without internal descriptions', () => {
    expect(TOOL_EFFECTS.review_exchange).toBe('write')
    expect(DIRECTORY_TOOLS.has('review_exchange')).toBe(false)
    expect(tool(writer, 'review_exchange').description).not.toMatch(/\bExchange\b|\bPayment\b|\bPrisma\b|\btabla\b|src\/|\/api\/|\/mcp\b/)
  })
})
