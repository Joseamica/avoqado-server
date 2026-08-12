import { AreaSettlementRoute, AreaTicketExternalSettlementStatus, AreaTicketStatus } from '@prisma/client'

import { logAction } from '@/services/dashboard/activity-log.service'
import { confirmExternalSettlement } from '@/services/mobile/areaTicketExternal.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const venueId = 'venue-external'
const ticketId = 'ticket-external-1'
const deviceUid = 'device-caja-externa'
const staffId = 'staff-1'
const baseInput = { idempotencyKey: 'confirm-key-1', deviceUid, staffId }
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
 * más `externalSettlement` incluido. `settlement` deja pisar sólo los campos del
 * settlement que cada test necesita, sin repetir el resto — mismo patrón que
 * `mockTicket` en `areaTicketExternal.handoff.test.ts`.
 */
function mockTicket(
  overrides: {
    status?: AreaTicketStatus
    settlement?: Partial<{
      status: AreaTicketExternalSettlementStatus
      referenceAmount: string
      externalAmount: string | null
      idempotencyKey: string
    }>
  } = {},
) {
  const s = overrides.settlement ?? {}
  const ticket = {
    id: ticketId,
    venueId,
    code: '9000000002',
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
      referenceAmount: s.referenceAmount ?? '168.00',
      externalAmount: s.externalAmount ?? null,
      externalReference: null,
      idempotencyKey: s.idempotencyKey ?? 'issue-key-1',
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
// settlement (el caso común) — evita repetir `{ settlement: {...} }` en cada test.
function mockSettlement(overrides: NonNullable<Parameters<typeof mockTicket>[0]>['settlement'] = {}) {
  return mockTicket({ settlement: overrides })
}

describe('confirmExternalSettlement', () => {
  beforeEach(() => {
    mockTerminal()
    mockStaffVenue()
    prismaMock.areaTicketExternalSettlement.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.areaTicketExternalIncident.upsert.mockResolvedValue({ id: 'incident-1' })
  })

  // --- Tests del brief (Task 7, Step 1), verbatim en intención ---

  it('sin importe capturado queda CONFIRMED', async () => {
    mockTicket()

    const r = await confirmExternalSettlement(venueId, ticketId, baseInput)

    expect(r.status).toBe('CONFIRMED')
    expect(r.variance).toBeNull()
    expect(r.alreadyConfirmed).toBe(false)
    expect(prismaMock.areaTicketExternalSettlement.updateMany).toHaveBeenCalledWith({
      where: { areaTicketId: ticketId, venueId, status: AreaTicketExternalSettlementStatus.PENDING },
      data: expect.objectContaining({
        status: AreaTicketExternalSettlementStatus.CONFIRMED,
        externalAmount: null,
        confirmedByStaffId: staffId,
        terminalId: 'terminal-external-1',
      }),
    })
    // Sin discrepancia, no hay incidencia que abrir.
    expect(prismaMock.areaTicketExternalIncident.upsert).not.toHaveBeenCalled()
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AREA_TICKET_EXTERNAL_CHARGE_CONFIRMED', venueId, staffId }),
    )
  })

  it('con el mismo importe queda CONFIRMED y variación cero', async () => {
    mockSettlement({ referenceAmount: '168.00' })

    const r = await confirmExternalSettlement(venueId, ticketId, { ...baseInput, externalAmount: '168.00' })

    expect(r.status).toBe('CONFIRMED')
    expect(r.variance).toBe('0.00')
  })

  it('con importe distinto queda DISCREPANCY y guarda la variación con signo', async () => {
    mockSettlement({ referenceAmount: '168.00' })

    const r = await confirmExternalSettlement(venueId, ticketId, { ...baseInput, externalAmount: '165.50' })

    expect(r.status).toBe('DISCREPANCY')
    expect(r.variance).toBe('-2.50')
    // La incidencia se abre vía upsert sobre @@unique([areaTicketId, kind]) — el
    // `update` reabre (occurrenceCount++, reopenedAt) si ya existía una fila para
    // este (vale, tipo); el `create` es el camino de la primera vez.
    expect(prismaMock.areaTicketExternalIncident.upsert).toHaveBeenCalledWith({
      where: { areaTicketId_kind: { areaTicketId: ticketId, kind: 'AMOUNT_VARIANCE' } },
      create: expect.objectContaining({
        venueId,
        areaTicketId: ticketId,
        kind: 'AMOUNT_VARIANCE',
        status: 'OPEN',
        detail: { referenceAmount: '168.00', externalAmount: '165.50', variance: '-2.50' },
      }),
      update: expect.objectContaining({
        status: 'OPEN',
        detail: { referenceAmount: '168.00', externalAmount: '165.50', variance: '-2.50' },
        occurrenceCount: { increment: 1 },
        reopenedAt: expect.any(Date),
      }),
    })
  })

  it('la variación se calcula en Decimal, no en float: 0.1 + 0.2 no puede dar 0.30000000000000004', async () => {
    mockSettlement({ referenceAmount: '0.30' })

    const r = await confirmExternalSettlement(venueId, ticketId, { ...baseInput, externalAmount: '0.10' })

    expect(r.variance).toBe('-0.20')
  })

  // --- Fix round 1: Finding 1 (revisión) — externalAmount no se cuantizaba a 2
  // decimales antes de comparar/escribir, produciendo una discrepancia mentirosa. ---

  it('cruza un límite de redondeo donde float y Decimal divergen — el test de arriba (0.30 vs 0.10) NO lo detectaría', async () => {
    mockSettlement({ referenceAmount: '160.00' })

    const r = await confirmExternalSettlement(venueId, ticketId, { ...baseInput, externalAmount: '168.165' })

    // Verificado con node contra el Prisma.Decimal real: 168.165 cuantiza a
    // 168.17 en Decimal (ROUND_HALF_UP), pero (168.165).toFixed(2) en `number`
    // da "168.16" — IEEE754 guarda 168.165 como 168.16499999999999204..., así
    // que redondea para abajo. Es un dígito distinto: el test de arriba
    // (0.10 - 0.30 → "-0.20") pasa IGUAL en float que en Decimal, por eso no
    // habría delatado una implementación en `number`; éste sí.
    expect(r.externalAmount).toBe('168.17')
    expect(r.variance).toBe('8.17')
    expect(r.status).toBe('DISCREPANCY')
  })

  it('un sub-céntimo (168.001 vs 168.00) NO es discrepancia tras cuantizar — antes del fix mentía', async () => {
    mockSettlement({ referenceAmount: '168.00' })

    const r = await confirmExternalSettlement(venueId, ticketId, { ...baseInput, externalAmount: '168.001' })

    // Antes del fix: variance SIN cuantizar = 0.001 → isZero()=false → status
    // DISCREPANCY, pero variance.toFixed(2) mostraba "0.00" y
    // externalAmount.toFixed(2) mostraba "168.00" — la respuesta y la
    // incidencia decían "hay discrepancia" con importes idénticos y variación
    // cero (verificado con node antes de aplicar el fix). Cuantizar
    // externalAmount a 2 decimales ANTES de comparar hace que 168.001 sea
    // indistinguible de 168.00 — que es la precisión real con la que se
    // guarda el dinero (`Decimal(12,2)`).
    expect(r.status).toBe('CONFIRMED')
    expect(r.variance).toBe('0.00')
    expect(r.externalAmount).toBe('168.00')
  })

  it('repetir la misma llave devuelve alreadyConfirmed y NO cambia el importe', async () => {
    mockSettlement({ status: AreaTicketExternalSettlementStatus.CONFIRMED, externalAmount: '168.00', idempotencyKey: 'k1' })

    const r = await confirmExternalSettlement(venueId, ticketId, { ...baseInput, idempotencyKey: 'k1', externalAmount: '999.00' })

    expect(r.alreadyConfirmed).toBe(true)
    expect(r.externalAmount).toBe('168.00')
    // La idempotencia es real: no sólo el flag de retorno miente "listo" — no
    // hay segunda escritura ni segunda entrada de auditoría.
    expect(prismaMock.areaTicketExternalSettlement.updateMany).not.toHaveBeenCalled()
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('rechaza confirmar un vale CANCELLED', async () => {
    mockTicket({ status: AreaTicketStatus.CANCELLED })

    await expect(confirmExternalSettlement(venueId, ticketId, baseInput)).rejects.toMatchObject({ code: 'AREA_TICKET_NOT_ISSUED' })
    expect(prismaMock.areaTicketExternalSettlement.updateMany).not.toHaveBeenCalled()
  })

  // --- Endurecimiento adicional (pensando en la carrera y en el guard compartido) ---

  it('un vale que no existe da AREA_TICKET_NOT_FOUND', async () => {
    prismaMock.areaTicket.findFirst.mockResolvedValue(null)

    await expect(confirmExternalSettlement(venueId, 'ticket-missing', baseInput)).rejects.toMatchObject({
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

    await expect(confirmExternalSettlement(venueId, ticketId, baseInput)).rejects.toMatchObject({ code: 'AREA_TICKET_NOT_EXTERNAL' })
  })

  it('pierde la carrera contra otro dispositivo confirmando el mismo vale: responde alreadyConfirmed con lo que de verdad quedó guardado', async () => {
    mockSettlement({ referenceAmount: '168.00' })
    // El updateMany condicionado no afecta ninguna fila — ya lo confirmó otro
    // dispositivo entre nuestra lectura y nuestro intento de escritura.
    prismaMock.areaTicketExternalSettlement.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.areaTicketExternalSettlement.findUniqueOrThrow.mockResolvedValue({
      id: 'settlement-1',
      status: AreaTicketExternalSettlementStatus.CONFIRMED,
      referenceAmount: '168.00',
      externalAmount: '168.00',
    })

    const r = await confirmExternalSettlement(venueId, ticketId, { ...baseInput, externalAmount: '150.00' })

    expect(r.alreadyConfirmed).toBe(true)
    // El importe reportado es el del GANADOR de la carrera (168.00), nunca el
    // que nosotros intentamos escribir (150.00).
    expect(r.externalAmount).toBe('168.00')
    expect(logActionMock).not.toHaveBeenCalled()
  })
})
