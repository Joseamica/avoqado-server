const mockPrisma: any = {
  venue: { findUnique: jest.fn() },
  areaTicketExternalSettlement: { findMany: jest.fn() },
  areaTicketExternalIncident: { findMany: jest.fn() },
}

jest.mock('../../../../src/utils/prismaClient', () => ({ __esModule: true, default: mockPrisma }))

import { listExternalIncidents, listExternalSettlements } from '../../../../src/services/dashboard/areaTicket.dashboard.service'

const VENUE_ID = 'venue_1'

const SETTLEMENT_ROW = {
  id: 'settlement_1',
  status: 'PENDING',
  handoffState: 'PENDING',
  confirmationMode: 'MANUAL',
  referenceAmount: '150.00',
  externalAmount: null,
  externalReference: null,
  notes: null,
  createdAt: new Date('2026-08-01T12:00:00.000Z'),
  confirmedAt: null,
  confirmedByStaff: null,
  terminal: null,
  areaTicket: {
    id: 'ticket_1',
    code: 'CRE-000123',
    issuedAt: new Date('2026-08-01T12:00:00.000Z'),
    fulfillmentArea: { id: 'area_1', name: 'Cremería' },
  },
}

const INCIDENT_ROW = {
  id: 'incident_1',
  kind: 'UNCONFIRMED_CHARGE',
  status: 'OPEN',
  detail: { referenceAmount: '150.00', issuedAt: '2026-08-01T12:00:00.000Z', code: 'CRE-000123' },
  openedAt: new Date('2026-08-01T13:00:00.000Z'),
  occurrenceCount: 1,
  reopenedAt: null,
  resolvedAt: null,
  resolution: null,
  resolvedByStaff: null,
  areaTicket: { id: 'ticket_1', code: 'CRE-000123', fulfillmentArea: { id: 'area_1', name: 'Cremería' } },
}

describe('listExternalSettlements() — cola "cobros por confirmar"', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPrisma.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
    mockPrisma.areaTicketExternalSettlement.findMany.mockResolvedValue([SETTLEMENT_ROW])
  })

  it('lists settlements scoped to the venue and labels the amount as reference, never as paid', async () => {
    const result = await listExternalSettlements(VENUE_ID, {})

    expect(mockPrisma.areaTicketExternalSettlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: VENUE_ID }) }),
    )
    expect(result.items).toHaveLength(1)
    expect(result.items[0].referenceAmount).toBe('150.00')
    expect(result.items[0].externalAmount).toBeNull()
    expect(result.items[0].variance).toBeNull()
    expect(result.nextCursor).toBeNull()
  })

  it('derives variance with sign instead of reading a stored column — positive when the external charge is higher', async () => {
    mockPrisma.areaTicketExternalSettlement.findMany.mockResolvedValue([
      { ...SETTLEMENT_ROW, status: 'DISCREPANCY', externalAmount: '175.50' },
    ])

    const result = await listExternalSettlements(VENUE_ID, {})

    expect(result.items[0].referenceAmount).toBe('150.00')
    expect(result.items[0].externalAmount).toBe('175.50')
    expect(result.items[0].variance).toBe('25.50')
  })

  it('derives variance with a negative sign when the external charge is lower', async () => {
    mockPrisma.areaTicketExternalSettlement.findMany.mockResolvedValue([
      { ...SETTLEMENT_ROW, status: 'DISCREPANCY', externalAmount: '120.00' },
    ])

    const result = await listExternalSettlements(VENUE_ID, {})

    expect(result.items[0].variance).toBe('-30.00')
  })

  it('filters by area and status when provided', async () => {
    await listExternalSettlements(VENUE_ID, { areaId: 'area_1', status: 'PENDING' })

    expect(mockPrisma.areaTicketExternalSettlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          venueId: VENUE_ID,
          status: 'PENDING',
          areaTicket: { fulfillmentAreaId: 'area_1' },
        }),
      }),
    )
  })

  it('converts a venue-local dateFrom/dateTo into a UTC range instead of trusting the host timezone', async () => {
    await listExternalSettlements(VENUE_ID, { dateFrom: '2026-08-01', dateTo: '2026-08-01' })

    const call = mockPrisma.areaTicketExternalSettlement.findMany.mock.calls[0][0]
    // Mexico City is UTC-6 in August (no DST) — venue midnight is 06:00 UTC.
    expect(call.where.createdAt.gte.toISOString()).toBe('2026-08-01T06:00:00.000Z')
    expect(call.where.createdAt.lte.toISOString()).toBe('2026-08-02T05:59:59.999Z')
  })

  it('never applies a date filter when neither dateFrom nor dateTo is given — a stale unconfirmed charge must stay visible', async () => {
    await listExternalSettlements(VENUE_ID, {})

    const call = mockPrisma.areaTicketExternalSettlement.findMany.mock.calls[0][0]
    expect(call.where.createdAt).toBeUndefined()
  })

  it('returns a decodable nextCursor when there is one more row than the page size', async () => {
    const extraRow = { ...SETTLEMENT_ROW, id: 'settlement_2' }
    mockPrisma.areaTicketExternalSettlement.findMany.mockResolvedValue([SETTLEMENT_ROW, extraRow])

    const result = await listExternalSettlements(VENUE_ID, { pageSize: 1 })

    expect(result.items).toHaveLength(1)
    expect(result.nextCursor).not.toBeNull()

    // The cursor must round-trip: passing it back must not throw and must be usable
    // to keep paging (asserted indirectly — a second call with it must not throw).
    mockPrisma.areaTicketExternalSettlement.findMany.mockResolvedValue([])
    await expect(listExternalSettlements(VENUE_ID, { cursor: result.nextCursor! })).resolves.toEqual({ items: [], nextCursor: null })
  })

  it('rejects a malformed cursor instead of silently ignoring it', async () => {
    await expect(listExternalSettlements(VENUE_ID, { cursor: 'not-a-valid-cursor' })).rejects.toThrow('El cursor de la lista no es válido.')
  })

  it('throws NotFoundError when the venue does not exist', async () => {
    mockPrisma.venue.findUnique.mockResolvedValue(null)

    await expect(listExternalSettlements(VENUE_ID, {})).rejects.toThrow('Venue no encontrado')
  })
})

describe('listExternalIncidents() — cola "incidencias"', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPrisma.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
    mockPrisma.areaTicketExternalIncident.findMany.mockResolvedValue([INCIDENT_ROW])
  })

  it('lists incidents scoped to the venue, passing detail through untouched', async () => {
    const result = await listExternalIncidents(VENUE_ID, {})

    expect(mockPrisma.areaTicketExternalIncident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: VENUE_ID }) }),
    )
    expect(result.items[0].detail).toEqual(INCIDENT_ROW.detail)
    expect(result.items[0].area).toEqual({ id: 'area_1', name: 'Cremería' })
  })

  it('filters by kind and status when provided', async () => {
    await listExternalIncidents(VENUE_ID, { kind: 'AMOUNT_VARIANCE', status: 'OPEN' })

    expect(mockPrisma.areaTicketExternalIncident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: VENUE_ID, kind: 'AMOUNT_VARIANCE', status: 'OPEN' }) }),
    )
  })

  it('handles an incident with no linked area ticket (areaTicketId is nullable) without throwing', async () => {
    mockPrisma.areaTicketExternalIncident.findMany.mockResolvedValue([{ ...INCIDENT_ROW, areaTicket: null }])

    const result = await listExternalIncidents(VENUE_ID, {})

    expect(result.items[0].areaTicket).toBeNull()
    expect(result.items[0].area).toBeNull()
  })

  it('formats resolvedBy from the staff relation when the incident was resolved', async () => {
    mockPrisma.areaTicketExternalIncident.findMany.mockResolvedValue([
      {
        ...INCIDENT_ROW,
        status: 'RESOLVED',
        resolvedAt: new Date('2026-08-02T09:00:00.000Z'),
        resolution: 'La otra caja confirmó el cobro por teléfono.',
        resolvedByStaff: { firstName: 'Ana', lastName: 'Pérez' },
      },
    ])

    const result = await listExternalIncidents(VENUE_ID, {})

    expect(result.items[0].resolvedBy).toBe('Ana Pérez')
    expect(result.items[0].resolution).toBe('La otra caja confirmó el cobro por teléfono.')
  })

  it('throws NotFoundError when the venue does not exist', async () => {
    mockPrisma.venue.findUnique.mockResolvedValue(null)

    await expect(listExternalIncidents(VENUE_ID, {})).rejects.toThrow('Venue no encontrado')
  })
})
