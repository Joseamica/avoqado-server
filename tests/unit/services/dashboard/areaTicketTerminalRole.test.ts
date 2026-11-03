/**
 * D3 (2-nov-2026): el papel de un aparato en los vales.
 *
 * `areaRoleChosenAt` distingue «nunca se eligió» de «ya se eligió», para que sólo un aparato nuevo pregunte. Lo llena
 * quien cambia el papel: el panel o el propio aparato, los dos por `updateTerminal`. Quitarle la caja con un cobro en
 * curso NO se bloquea aquí: ese cobro lo sigue cerrando su propia terminal (areaTicketFormerCaja.test.ts).
 */
const mockPrisma: any = {
  terminal: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  fulfillmentArea: { findFirst: jest.fn() },
  scaleProfile: { findFirst: jest.fn() },
  $queryRaw: jest.fn(),
  $transaction: jest.fn(),
}

jest.mock('../../../../src/utils/prismaClient', () => ({ __esModule: true, default: mockPrisma }))
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn().mockResolvedValue(undefined),
}))

import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import { updateTerminal } from '../../../../src/services/dashboard/areaTicket.dashboard.service'

const CAJA = {
  id: 'terminal_1',
  fulfillmentAreaId: null,
  canIssueAreaTickets: false,
  canCheckoutAreaTickets: true,
  canDeliverAreaTickets: false,
  defaultWorkspace: 'AREA_OPERATIONS',
}

describe('updateTerminal: papel del aparato (D3)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPrisma.$queryRaw.mockResolvedValue([])
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockPrisma))
    mockPrisma.terminal.findFirst.mockResolvedValue(CAJA)
    mockPrisma.terminal.update.mockResolvedValue({ id: CAJA.id })
    mockPrisma.fulfillmentArea.findFirst.mockResolvedValue({ id: 'area_cremeria' })
  })

  it('el panel marca el papel como elegido al cambiar capacidades', async () => {
    await updateTerminal('venue_1', CAJA.id, { canIssueAreaTickets: true, canCheckoutAreaTickets: false })

    const data = mockPrisma.terminal.update.mock.calls[0][0].data
    expect(data.areaRoleChosenAt).toBeInstanceOf(Date)
  })

  it('cambiar el área también marca el papel como elegido', async () => {
    await updateTerminal('venue_1', CAJA.id, { fulfillmentAreaId: 'area_cremeria' })

    expect(mockPrisma.terminal.update.mock.calls[0][0].data.areaRoleChosenAt).toBeInstanceOf(Date)
  })

  it('cambiar sólo la báscula no marca el papel', async () => {
    mockPrisma.scaleProfile.findFirst.mockResolvedValue({ id: 'bascula_1' })

    await updateTerminal('venue_1', CAJA.id, { scaleProfileId: 'bascula_1' })

    expect(mockPrisma.terminal.update.mock.calls[0][0].data.areaRoleChosenAt).toBeUndefined()
  })

  it('la bitácora guarda cómo estaba antes y de dónde vino el cambio', async () => {
    await updateTerminal('venue_1', CAJA.id, { canIssueAreaTickets: true, canCheckoutAreaTickets: false }, 'staff_1')

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AREA_TICKET_TERMINAL_UPDATED',
        data: expect.objectContaining({
          changes: { canIssueAreaTickets: true, canCheckoutAreaTickets: false },
          before: expect.objectContaining({ canIssueAreaTickets: false, canCheckoutAreaTickets: true, fulfillmentAreaId: null }),
          source: 'dashboard',
        }),
      }),
    )
  })

  it('la fuente del aparato queda como pos', async () => {
    await updateTerminal('venue_1', CAJA.id, { canIssueAreaTickets: true, canCheckoutAreaTickets: false }, 'staff_1', { source: 'pos' })

    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ source: 'pos' }) }))
  })

  // D5, opción A (founder, 2-nov: «primero la corta»): un aparato emite vales O los cobra. Si emite, su botón siempre
  // emite y rechaza los vales escaneados, así que «Cobrar» en ese aparato no hacía nada.
  it('no deja que un aparato emita y cobre vales a la vez', async () => {
    await expect(updateTerminal('venue_1', CAJA.id, { canIssueAreaTickets: true })).rejects.toMatchObject({
      statusCode: 400,
      code: 'AREA_TICKET_ISSUE_AND_CHECKOUT',
      message: 'Un aparato emite vales o los cobra, no las dos cosas. Para cobrar vales usa la caja.',
    })
    expect(mockPrisma.terminal.update).not.toHaveBeenCalled()
  })

  it('tampoco deja prender cobrar en un aparato que emite', async () => {
    mockPrisma.terminal.findFirst.mockResolvedValue({ ...CAJA, canIssueAreaTickets: true, canCheckoutAreaTickets: false })

    await expect(updateTerminal('venue_1', CAJA.id, { canCheckoutAreaTickets: true })).rejects.toMatchObject({
      code: 'AREA_TICKET_ISSUE_AND_CHECKOUT',
    })
  })

  it('un aparato que ya tenía las dos casillas puede cambiar otra cosa sin tocarlas', async () => {
    mockPrisma.terminal.findFirst.mockResolvedValue({ ...CAJA, canIssueAreaTickets: true, canCheckoutAreaTickets: true })

    await updateTerminal('venue_1', CAJA.id, { canDeliverAreaTickets: true })

    expect(mockPrisma.terminal.update).toHaveBeenCalled()
  })

  it('y puede apagar una de las dos para quedar bien', async () => {
    mockPrisma.terminal.findFirst.mockResolvedValue({ ...CAJA, canIssueAreaTickets: true, canCheckoutAreaTickets: true })

    await updateTerminal('venue_1', CAJA.id, { canCheckoutAreaTickets: false })

    expect(mockPrisma.terminal.update).toHaveBeenCalled()
  })

  // Codex final #3: dos cambios a la vez (uno prende Emitir y otro Cobrar) leían los dos «apagado» y dejaban las dos.
  it('toma el candado de la fila del aparato antes de leerla', async () => {
    await updateTerminal('venue_1', CAJA.id, { canDeliverAreaTickets: true })

    expect(mockPrisma.$transaction).toHaveBeenCalled()
    const candado = mockPrisma.$queryRaw.mock.invocationCallOrder[0]
    const lectura = mockPrisma.terminal.findFirst.mock.invocationCallOrder[0]
    expect(candado).toBeLessThan(lectura)
    expect(String(mockPrisma.$queryRaw.mock.calls[0][0].join('?'))).toContain('FOR UPDATE')
  })
})
