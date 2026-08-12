import { AreaSettlementRoute, AreaTicketExternalSettlementStatus, AreaTicketStatus } from '@prisma/client'

import { logAction } from '@/services/dashboard/activity-log.service'
import { markExternalNotCharged } from '@/services/mobile/areaTicketExternal.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const venueId = 'venue-external'
const ticketId = 'ticket-external-1'
const deviceUid = 'device-caja-externa'
const staffId = 'staff-1'
const baseInput = { idempotencyKey: 'not-charged-key-1', deviceUid, staffId }
const logActionMock = logAction as jest.Mock

function mockTerminal() {
  prismaMock.terminal.findFirst.mockResolvedValue({
    id: 'terminal-external-1',
    name: 'Cremería externa',
    fulfillmentAreaId: 'area-external-1',
    canIssueAreaTickets: true,
    canCheckoutAreaTickets: false,
    canDeliverAreaTickets: false,
    defaultWorkspace: 'AREA_OPERATIONS',
    scaleProfile: null,
    fulfillmentArea: { id: 'area-external-1', name: 'Cremería externa', fulfillmentMode: 'HOLD_UNTIL_PAID', active: true },
  })
}

function mockStaffVenue() {
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId, venueId, active: true, role: 'MANAGER' })
}

/**
 * Refleja lo que `loadExternalTicket` devuelve: el vale (con su `status` propio)
 * más `externalSettlement` incluido. Mismo patrón que `mockTicket` en
 * `areaTicketExternal.confirm.test.ts` / `areaTicketExternal.handoff.test.ts`.
 */
function mockTicket(
  overrides: {
    status?: AreaTicketStatus
    settlement?: Partial<{ status: AreaTicketExternalSettlementStatus }>
  } = {},
) {
  const s = overrides.settlement ?? {}
  const ticket = {
    id: ticketId,
    venueId,
    code: '9000000003',
    status: overrides.status ?? AreaTicketStatus.ISSUED,
    settlementRoute: AreaSettlementRoute.EXTERNAL,
    fulfillmentArea: { id: 'area-external-1', name: 'Cremería externa', settlementRoute: AreaSettlementRoute.EXTERNAL },
    externalSettlement: {
      id: 'settlement-1',
      venueId,
      areaTicketId: ticketId,
      status: s.status ?? AreaTicketExternalSettlementStatus.PENDING,
      handoffState: 'HANDED_OFF',
      confirmationMode: 'MANUAL',
      referenceAmount: '168.00',
      externalAmount: null,
      externalReference: null,
      idempotencyKey: 'issue-key-1',
      confirmedByStaffId: null,
      confirmedAt: null,
      terminalId: null,
      notes: null,
    },
  }
  prismaMock.areaTicket.findFirst.mockResolvedValue(ticket)
  return ticket
}

// Alias con el nombre que usa el brief cuando sólo le interesa pisar el
// settlement — evita repetir `{ settlement: {...} }` en cada test.
function mockSettlement(overrides: NonNullable<Parameters<typeof mockTicket>[0]>['settlement'] = {}) {
  return mockTicket({ settlement: overrides })
}

describe('markExternalNotCharged', () => {
  beforeEach(() => {
    mockTerminal()
    mockStaffVenue()
    prismaMock.areaTicketExternalSettlement.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.areaTicketExternalIncident.updateMany.mockResolvedValue({ count: 0 })
  })

  // --- Tests del brief (Task 8, Step 1), verbatim en intención ---

  it('marca NOT_CHARGED y exige motivo', async () => {
    mockSettlement({ status: AreaTicketExternalSettlementStatus.PENDING })

    const r = await markExternalNotCharged(venueId, ticketId, { ...baseInput, reason: 'El cliente no pasó a caja' })

    expect(r.status).toBe('NOT_CHARGED')
    expect(r.areaTicketId).toBe(ticketId)
    expect(prismaMock.areaTicketExternalSettlement.updateMany).toHaveBeenCalledWith({
      where: {
        areaTicketId: ticketId,
        venueId,
        status: { in: [AreaTicketExternalSettlementStatus.PENDING, AreaTicketExternalSettlementStatus.ASSUMED] },
      },
      data: { status: AreaTicketExternalSettlementStatus.NOT_CHARGED },
    })
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AREA_TICKET_EXTERNAL_MARKED_NOT_CHARGED', venueId, staffId }),
    )
  })

  it('sin motivo no procede — es una afirmación que alguien tendrá que auditar', async () => {
    mockSettlement()

    await expect(markExternalNotCharged(venueId, ticketId, { ...baseInput, reason: '   ' })).rejects.toMatchObject({
      code: 'REASON_REQUIRED',
    })
    expect(prismaMock.areaTicketExternalSettlement.updateMany).not.toHaveBeenCalled()
  })

  it('no se puede marcar no cobrado algo ya CONFIRMED', async () => {
    mockSettlement({ status: AreaTicketExternalSettlementStatus.CONFIRMED })

    await expect(markExternalNotCharged(venueId, ticketId, { ...baseInput, reason: 'x' })).rejects.toMatchObject({
      code: 'AREA_TICKET_EXTERNAL_ALREADY_CHARGED',
    })
    expect(prismaMock.areaTicketExternalSettlement.updateMany).not.toHaveBeenCalled()
  })

  it('cierra la incidencia de cobro sin confirmar, si estaba abierta', async () => {
    mockSettlement({ status: AreaTicketExternalSettlementStatus.PENDING })
    prismaMock.areaTicketExternalIncident.updateMany.mockResolvedValue({ count: 1 })

    await markExternalNotCharged(venueId, ticketId, { ...baseInput, reason: 'no pasó' })

    expect(prismaMock.areaTicketExternalIncident.updateMany).toHaveBeenCalledWith({
      where: {
        areaTicketId: ticketId,
        venueId,
        kind: 'UNCONFIRMED_CHARGE',
        status: 'OPEN',
      },
      data: expect.objectContaining({
        status: 'RESOLVED',
        resolvedByStaffId: staffId,
        resolution: 'no pasó',
      }),
    })
  })

  // --- Endurecimiento adicional (mismo patrón que Tasks 6-7: guard compartido,
  // el estado ASSUMED que esta función existe para desbloquear, y la carrera) ---

  it('también se puede marcar no cobrado un vale ASSUMED — es exactamente el caso que esta función desbloquea', async () => {
    mockSettlement({ status: AreaTicketExternalSettlementStatus.ASSUMED })

    const r = await markExternalNotCharged(venueId, ticketId, { ...baseInput, reason: 'Nunca pasó a la otra caja' })

    expect(r.status).toBe('NOT_CHARGED')
    expect(prismaMock.areaTicketExternalSettlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: [AreaTicketExternalSettlementStatus.PENDING, AreaTicketExternalSettlementStatus.ASSUMED] },
        }),
      }),
    )
  })

  it('no se puede marcar no cobrado algo en DISCREPANCY — ya se afirmó que sí cobraron, sólo que por otro importe', async () => {
    mockSettlement({ status: AreaTicketExternalSettlementStatus.DISCREPANCY })

    await expect(markExternalNotCharged(venueId, ticketId, { ...baseInput, reason: 'x' })).rejects.toMatchObject({
      code: 'AREA_TICKET_EXTERNAL_ALREADY_CHARGED',
    })
    expect(prismaMock.areaTicketExternalSettlement.updateMany).not.toHaveBeenCalled()
  })

  it('repetir sobre un vale ya NOT_CHARGED es idempotente y no vuelve a escribir', async () => {
    mockSettlement({ status: AreaTicketExternalSettlementStatus.NOT_CHARGED })

    const r = await markExternalNotCharged(venueId, ticketId, { ...baseInput, reason: 'x' })

    expect(r.status).toBe('NOT_CHARGED')
    expect(prismaMock.areaTicketExternalSettlement.updateMany).not.toHaveBeenCalled()
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('rechaza un vale CANCELLED — nada que declarar sobre el cobro de un vale muerto', async () => {
    mockTicket({ status: AreaTicketStatus.CANCELLED, settlement: { status: AreaTicketExternalSettlementStatus.PENDING } })

    await expect(markExternalNotCharged(venueId, ticketId, { ...baseInput, reason: 'x' })).rejects.toMatchObject({
      code: 'AREA_TICKET_NOT_ISSUED',
    })
    expect(prismaMock.areaTicketExternalSettlement.updateMany).not.toHaveBeenCalled()
  })

  it('un vale que no existe da AREA_TICKET_NOT_FOUND', async () => {
    prismaMock.areaTicket.findFirst.mockResolvedValue(null)

    await expect(markExternalNotCharged(venueId, 'ticket-missing', { ...baseInput, reason: 'x' })).rejects.toMatchObject({
      code: 'AREA_TICKET_NOT_FOUND',
      statusCode: 404,
    })
  })

  it('rechaza un vale de ruta AVOQADO', async () => {
    prismaMock.areaTicket.findFirst.mockResolvedValue({
      id: ticketId,
      venueId,
      status: AreaTicketStatus.ISSUED,
      settlementRoute: AreaSettlementRoute.AVOQADO,
      fulfillmentArea: { id: 'area-1', settlementRoute: AreaSettlementRoute.AVOQADO },
      externalSettlement: null,
    })

    await expect(markExternalNotCharged(venueId, ticketId, { ...baseInput, reason: 'x' })).rejects.toMatchObject({
      code: 'AREA_TICKET_NOT_EXTERNAL',
    })
  })

  it('pierde la carrera contra otra declaración: responde con lo que de verdad quedó guardado, sin re-escribir', async () => {
    mockSettlement({ status: AreaTicketExternalSettlementStatus.PENDING })
    // El updateMany condicionado no afecta ninguna fila — ya lo declaró otro
    // dispositivo entre nuestra lectura y nuestro intento de escritura.
    prismaMock.areaTicketExternalSettlement.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.areaTicketExternalSettlement.findUniqueOrThrow.mockResolvedValue({
      id: 'settlement-1',
      status: AreaTicketExternalSettlementStatus.NOT_CHARGED,
    })

    const r = await markExternalNotCharged(venueId, ticketId, { ...baseInput, reason: 'x' })

    expect(r.status).toBe('NOT_CHARGED')
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('pierde la carrera contra una confirmación real: propaga el conflicto en vez de fingir NOT_CHARGED', async () => {
    mockSettlement({ status: AreaTicketExternalSettlementStatus.PENDING })
    prismaMock.areaTicketExternalSettlement.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.areaTicketExternalSettlement.findUniqueOrThrow.mockResolvedValue({
      id: 'settlement-1',
      status: AreaTicketExternalSettlementStatus.CONFIRMED,
    })

    await expect(markExternalNotCharged(venueId, ticketId, { ...baseInput, reason: 'x' })).rejects.toMatchObject({
      code: 'AREA_TICKET_EXTERNAL_ALREADY_CHARGED',
    })
  })
})
