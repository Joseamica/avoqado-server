import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import {
  decodeSupervisorSalesExportCursor,
  encodeSupervisorSalesExportCursor,
  getSupervisorSalesExportPage,
} from '@/services/organization-dashboard/supervisorSalesExport.service'

const baseInput = {
  organizationId: 'org-play',
  scopedVenueIds: undefined,
  startDate: '2026-08-01',
  endDate: '2026-08-07',
}

const firstOrder = {
  id: 'order-abcdef',
  createdAt: new Date('2026-08-07T18:00:00.000Z'),
  total: new Prisma.Decimal('123.45'),
  venue: { name: 'Centro' },
  servedById: 'staff-123456',
  servedBy: { id: 'staff-123456', firstName: 'Isaac', lastName: 'Mayoral', employeeCode: 'EMP-7' },
  items: [{ serializedItem: { serialNumber: '8952140000000000001F' } }],
}

const secondOrder = {
  id: 'order-123456',
  createdAt: new Date('2026-08-07T17:00:00.000Z'),
  total: new Prisma.Decimal('0'),
  venue: { name: 'Norte' },
  servedById: null,
  servedBy: null,
  items: [],
}

describe('supervisorSalesExport service', () => {
  it('loads a lean first page, maps nullable fields, and returns a stable composite cursor', async () => {
    prismaMock.order.count.mockResolvedValue(3)
    prismaMock.order.findMany.mockResolvedValue([firstOrder, secondOrder, { ...secondOrder, id: 'order-overflow' }] as any)

    const result = await getSupervisorSalesExportPage({ ...baseInput, limit: 2 })

    expect(result).toEqual({
      rows: [
        {
          id: 'order-abcdef',
          venueName: 'Centro',
          product: 'Venta: $123.45',
          iccid: '8952140000000000001F',
          staffId: 'staff-123456',
          staffName: 'Isaac Mayoral',
          staffEmployeeCode: 'EMP-7',
          amount: 123.45,
          timestamp: '2026-08-07T18:00:00.000Z',
        },
        {
          id: 'order-123456',
          venueName: 'Norte',
          product: 'Venta: $0.00',
          iccid: null,
          staffId: null,
          staffName: 'Staff desconocido',
          staffEmployeeCode: null,
          amount: 0,
          timestamp: '2026-08-07T17:00:00.000Z',
        },
      ],
      nextCursor: expect.any(String),
      total: 3,
    })

    expect(decodeSupervisorSalesExportCursor(result.nextCursor!)).toEqual({
      createdAt: '2026-08-07T17:00:00.000Z',
      id: 'order-123456',
    })
    expect(prismaMock.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 3,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          createdAt: true,
          total: true,
          venue: { select: { name: true } },
          servedById: true,
          servedBy: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
          items: {
            take: 1,
            orderBy: { sequence: 'asc' },
            select: { serializedItem: { select: { serialNumber: true } } },
          },
        },
      }),
    )
  })

  it('uses the composite keyset after the first page and does not recount', async () => {
    const cursor = encodeSupervisorSalesExportCursor({
      createdAt: '2026-08-07T17:00:00.000Z',
      id: 'order-123456',
    })
    prismaMock.order.findMany.mockResolvedValue([])

    const result = await getSupervisorSalesExportPage({
      ...baseInput,
      scopedVenueIds: ['venue-1', 'venue-2'],
      cursor,
    })

    expect(result).toEqual({ rows: [], nextCursor: null })
    expect(prismaMock.order.count).not.toHaveBeenCalled()
    expect(prismaMock.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          venueId: { in: ['venue-1', 'venue-2'] },
          AND: [
            {
              OR: [
                { createdAt: { lt: new Date('2026-08-07T17:00:00.000Z') } },
                { createdAt: new Date('2026-08-07T17:00:00.000Z'), id: { lt: 'order-123456' } },
              ],
            },
          ],
        }),
      }),
    )
  })

  it('caps every page at 500 rows', async () => {
    prismaMock.order.count.mockResolvedValue(0)
    prismaMock.order.findMany.mockResolvedValue([])

    await getSupervisorSalesExportPage({ ...baseInput, limit: 10_000 })

    expect(prismaMock.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 501 }))
  })

  it('rejects more than 25,000 rows before loading any orders', async () => {
    prismaMock.order.count.mockResolvedValue(25_001)

    await expect(getSupervisorSalesExportPage(baseInput)).rejects.toThrow('25,000')
    expect(prismaMock.order.findMany).not.toHaveBeenCalled()
  })

  it('rejects ranges longer than 370 days before querying', async () => {
    await expect(getSupervisorSalesExportPage({ ...baseInput, startDate: '2025-07-01', endDate: '2026-08-07' })).rejects.toThrow('370')
    expect(prismaMock.order.count).not.toHaveBeenCalled()
    expect(prismaMock.order.findMany).not.toHaveBeenCalled()
  })

  it('rejects a malformed cursor before querying', async () => {
    await expect(getSupervisorSalesExportPage({ ...baseInput, cursor: 'not-a-cursor' })).rejects.toThrow('cursor')
    expect(prismaMock.order.findMany).not.toHaveBeenCalled()
  })

  it('uses the context venue timezone instead of expanding an ISO day in Mexico City', async () => {
    prismaMock.order.count.mockResolvedValue(0)
    prismaMock.order.findMany.mockResolvedValue([])

    await getSupervisorSalesExportPage({
      ...baseInput,
      startDate: '2026-08-07T05:00:00.000Z',
      endDate: '2026-08-08T04:59:59.999Z',
      timezone: 'America/Cancun',
    })

    expect(prismaMock.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date('2026-08-07T05:00:00.000Z'),
            lte: new Date('2026-08-08T04:59:59.999Z'),
          },
        }),
      }),
    )
  })
})
