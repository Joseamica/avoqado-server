/**
 * D2 de vales (La Galeterie, 3-nov-2026): un área puede apagar su comanda. Apagada, la PC que emite vales de esa área
 * saca sólo el vale. Nace prendida (nadie cambia) y cada cambio queda en la bitácora con quién y desde dónde.
 */
const mockPrisma: any = {
  venue: { findUnique: jest.fn() },
  fulfillmentArea: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  printStation: { findFirst: jest.fn() },
}

jest.mock('../../../../src/utils/prismaClient', () => ({ __esModule: true, default: mockPrisma }))
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn().mockResolvedValue(undefined),
}))

import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import { createArea, updateArea } from '../../../../src/services/dashboard/areaTicket.dashboard.service'
import { createFulfillmentAreaSchema, updateFulfillmentAreaSchema } from '../../../../src/schemas/dashboard/areaTicket.schema'

describe('«Comanda» sí/no por área (D2)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPrisma.venue.findUnique.mockResolvedValue({ id: 'venue_1' })
    mockPrisma.fulfillmentArea.findFirst.mockResolvedValue({ id: 'area_cremeria', venueId: 'venue_1', sendsComanda: true })
    mockPrisma.fulfillmentArea.update.mockImplementation(({ data }: any) => ({ id: 'area_cremeria', name: 'Cremería', ...data }))
    mockPrisma.fulfillmentArea.create.mockImplementation(({ data }: any) => ({ id: 'area_nueva', ...data }))
  })

  it('apagarla guarda el campo y lo deja en la bitácora, con la fuente', async () => {
    await updateArea('venue_1', 'area_cremeria', { sendsComanda: false }, 'staff_1', { source: 'pos', terminalId: 'terminal_1' })

    expect(mockPrisma.fulfillmentArea.update.mock.calls[0][0].data.sendsComanda).toBe(false)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'FULFILLMENT_AREA_UPDATED',
        staffId: 'staff_1',
        data: expect.objectContaining({
          changes: { sendsComanda: false },
          previous: { sendsComanda: true },
          source: 'pos',
          terminalId: 'terminal_1',
        }),
      }),
    )
  })

  it('desde el POS escribe sólo si esa terminal SIGUE emitiendo el área, en el mismo UPDATE (Codex r2 #2)', async () => {
    mockPrisma.fulfillmentArea.updateMany.mockResolvedValue({ count: 1 })
    await updateArea('venue_1', 'area_cremeria', { sendsComanda: false }, 'staff_1', {
      source: 'pos',
      terminalId: 'terminal_1',
      soloSiEmite: 'terminal_1',
    })
    expect(mockPrisma.fulfillmentArea.updateMany).toHaveBeenCalledWith({
      where: { id: 'area_cremeria', venueId: 'venue_1', terminals: { some: { id: 'terminal_1', canIssueAreaTickets: true } } },
      data: expect.objectContaining({ sendsComanda: false }),
    })
    expect(mockPrisma.fulfillmentArea.update).not.toHaveBeenCalled()
    expect(logAction).toHaveBeenCalledTimes(1)
  })

  it('si el panel le quitó el área a la terminal mientras viajaba, no escribe ni deja bitácora', async () => {
    mockPrisma.fulfillmentArea.updateMany.mockResolvedValue({ count: 0 })
    await expect(
      updateArea('venue_1', 'area_cremeria', { sendsComanda: false }, 'staff_1', { source: 'pos', soloSiEmite: 'terminal_1' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'AREA_NOT_OF_THIS_DEVICE' })
    expect(logAction).not.toHaveBeenCalled()
  })

  it('desde el MCP escribe sólo si el área sigue como la vio la vista previa (Codex r3)', async () => {
    mockPrisma.fulfillmentArea.updateMany.mockResolvedValue({ count: 0 })
    await expect(
      updateArea('venue_1', 'area_cremeria', { sendsComanda: false }, 'staff_1', {
        source: 'mcp',
        siSigueComo: { name: 'Cremería', sendsComanda: true },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'AREA_CHANGED' })
    expect(mockPrisma.fulfillmentArea.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'area_cremeria', venueId: 'venue_1', name: 'Cremería', sendsComanda: true } }),
    )
    expect(logAction).not.toHaveBeenCalled()
  })

  it('un cambio de otra cosa no toca la comanda', async () => {
    await updateArea('venue_1', 'area_cremeria', { name: 'Cremería fina' })
    expect(mockPrisma.fulfillmentArea.update.mock.calls[0][0].data.sendsComanda).toBeUndefined()
  })

  it('un área de otro negocio no se cambia', async () => {
    mockPrisma.fulfillmentArea.findFirst.mockResolvedValue(null)
    await expect(updateArea('venue_1', 'area_ajena', { sendsComanda: false })).rejects.toMatchObject({ statusCode: 404 })
    expect(mockPrisma.fulfillmentArea.update).not.toHaveBeenCalled()
  })

  it('un área nueva nace mandando comanda salvo que se diga lo contrario', async () => {
    await createArea('venue_1', { name: 'Panadería' })
    expect(mockPrisma.fulfillmentArea.create.mock.calls[0][0].data.sendsComanda).toBe(true)
    await createArea('venue_1', { name: 'Cremería', sendsComanda: false })
    expect(mockPrisma.fulfillmentArea.create.mock.calls[1][0].data.sendsComanda).toBe(false)
  })

  it('el panel acepta el campo y sólo booleano', () => {
    const update = (body: unknown) =>
      updateFulfillmentAreaSchema.safeParse({ params: { venueId: 'venue_1', areaId: 'area_1' }, query: {}, body })
    expect(update({ sendsComanda: false }).success).toBe(true)
    expect(update({ sendsComanda: 'no' }).success).toBe(false)
    expect(
      createFulfillmentAreaSchema.safeParse({ params: { venueId: 'venue_1' }, query: {}, body: { name: 'X', sendsComanda: true } }).success,
    ).toBe(true)
  })
})
