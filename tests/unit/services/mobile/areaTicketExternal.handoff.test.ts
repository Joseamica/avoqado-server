import {
  AreaSettlementRoute,
  AreaTicketExternalHandoffState,
  AreaTicketExternalSettlementStatus,
  AreaTicketPrintStatus,
} from '@prisma/client'

import { logAction } from '@/services/dashboard/activity-log.service'
import { markExternalHandoff } from '@/services/mobile/areaTicketExternal.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const venueId = 'venue-external'
const ticketId = 'ticket-external-1'
const deviceUid = 'device-caja-externa'
const baseInput = { idempotencyKey: 'handoff-key-1', deviceUid }
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

/**
 * Refleja lo que `loadExternalTicket` (el guard compartido) devuelve:
 * el vale con `externalSettlement` y `fulfillmentArea` ya incluidos.
 */
function mockTicket(
  overrides: {
    printStatus?: AreaTicketPrintStatus
    settlementRoute?: AreaSettlementRoute
    handoffState?: AreaTicketExternalHandoffState
  } = {},
) {
  const settlementRoute = overrides.settlementRoute ?? AreaSettlementRoute.EXTERNAL
  const isExternal = settlementRoute === AreaSettlementRoute.EXTERNAL
  const ticket = {
    id: ticketId,
    venueId,
    code: '9000000001',
    printStatus: overrides.printStatus ?? AreaTicketPrintStatus.PRINTED,
    settlementRoute,
    fulfillmentArea: { id: 'area-external-1', name: 'Cremería externa', settlementRoute },
    externalSettlement: isExternal
      ? {
          id: 'settlement-1',
          venueId,
          areaTicketId: ticketId,
          status: AreaTicketExternalSettlementStatus.PENDING,
          handoffState: overrides.handoffState ?? AreaTicketExternalHandoffState.PENDING,
          confirmationMode: 'MANUAL',
          referenceAmount: '50.00',
          externalAmount: null,
          externalReference: null,
          idempotencyKey: 'issue-key-1',
          confirmedByStaffId: null,
          confirmedAt: null,
          terminalId: null,
          notes: null,
        }
      : null,
  }
  prismaMock.areaTicket.findFirst.mockResolvedValue(ticket)
  return ticket
}

describe('markExternalHandoff', () => {
  beforeEach(() => {
    mockTerminal()
    prismaMock.areaTicketExternalSettlement.updateMany.mockResolvedValue({ count: 1 })
  })

  // --- Tests del brief (Task 6, Step 1), verbatim en intención ---

  it('marca HANDED_OFF cuando el vale se imprimió', async () => {
    mockTicket({ printStatus: AreaTicketPrintStatus.PRINTED, settlementRoute: AreaSettlementRoute.EXTERNAL })

    const r = await markExternalHandoff(venueId, ticketId, baseInput)

    expect(r.handoffState).toBe('HANDED_OFF')
    expect(r.alreadyHandedOff).toBe(false)
    // La escritura real es un updateMany CONDICIONADO a PENDING (no un update
    // ciego) — es lo que hace la idempotencia real bajo concurrencia, no sólo
    // en el happy path.
    expect(prismaMock.areaTicketExternalSettlement.updateMany).toHaveBeenCalledWith({
      where: { areaTicketId: ticketId, venueId, handoffState: AreaTicketExternalHandoffState.PENDING },
      data: { handoffState: AreaTicketExternalHandoffState.HANDED_OFF },
    })
    expect(logActionMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'AREA_TICKET_EXTERNAL_HANDED_OFF', venueId }))
  })

  it('NO deja marcar el envío de un vale que nunca se imprimió — no hay papel que llevar', async () => {
    mockTicket({ printStatus: AreaTicketPrintStatus.PRINT_FAILED, settlementRoute: AreaSettlementRoute.EXTERNAL })

    await expect(markExternalHandoff(venueId, ticketId, baseInput)).rejects.toMatchObject({ code: 'AREA_TICKET_NOT_PRINTED' })
    expect(prismaMock.areaTicketExternalSettlement.updateMany).not.toHaveBeenCalled()
  })

  it('repetir la misma llave devuelve alreadyHandedOff sin volver a escribir', async () => {
    mockTicket({ printStatus: AreaTicketPrintStatus.PRINTED, handoffState: AreaTicketExternalHandoffState.HANDED_OFF })

    const r = await markExternalHandoff(venueId, ticketId, baseInput)

    expect(r.alreadyHandedOff).toBe(true)
    // La idempotencia es real: no sólo el flag de retorno miente "listo" —
    // literalmente no hay segunda escritura.
    expect(prismaMock.areaTicketExternalSettlement.updateMany).not.toHaveBeenCalled()
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('rechaza un vale de ruta AVOQADO', async () => {
    mockTicket({ settlementRoute: AreaSettlementRoute.AVOQADO })

    await expect(markExternalHandoff(venueId, ticketId, baseInput)).rejects.toMatchObject({ code: 'AREA_TICKET_NOT_EXTERNAL' })
    expect(prismaMock.areaTicketExternalSettlement.updateMany).not.toHaveBeenCalled()
  })

  // --- Endurecimiento adicional del guard compartido (pensando en Tasks 7-9) ---

  it('un vale que no existe da AREA_TICKET_NOT_FOUND, distinto de "no es externo"', async () => {
    prismaMock.areaTicket.findFirst.mockResolvedValue(null)

    await expect(markExternalHandoff(venueId, 'ticket-missing', baseInput)).rejects.toMatchObject({
      code: 'AREA_TICKET_NOT_FOUND',
      statusCode: 404,
    })
  })

  it('un handoff en estado RETURNED no se reporta como ya entregado — son estados distintos', async () => {
    mockTicket({ printStatus: AreaTicketPrintStatus.PRINTED, handoffState: AreaTicketExternalHandoffState.RETURNED })

    await expect(markExternalHandoff(venueId, ticketId, baseInput)).rejects.toMatchObject({ code: 'AREA_TICKET_HANDOFF_NOT_PENDING' })
    expect(prismaMock.areaTicketExternalSettlement.updateMany).not.toHaveBeenCalled()
  })

  it('pierde la carrera contra otro dispositivo marcando el mismo handoff: responde alreadyHandedOff, no un error', async () => {
    mockTicket({ printStatus: AreaTicketPrintStatus.PRINTED, handoffState: AreaTicketExternalHandoffState.PENDING })
    // El updateMany condicionado no afecta ninguna fila — ya la ganó otro
    // dispositivo entre nuestra lectura y nuestro intento de escritura.
    prismaMock.areaTicketExternalSettlement.updateMany.mockResolvedValue({ count: 0 })

    const r = await markExternalHandoff(venueId, ticketId, baseInput)

    expect(r.alreadyHandedOff).toBe(true)
    expect(logActionMock).not.toHaveBeenCalled()
  })
})
