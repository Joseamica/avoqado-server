/**
 * updateAreaSettlementRoute — §caja externa fase 1, Task 14.
 *
 * Este switch cambia DÓNDE ENTRA EL DINERO de un área (otro POS cobra en su propia
 * caja, Avoqado deja de crear Order/Payment para esos vales). Cubre: las cuatro
 * políticas se escriben juntas, el ActivityLog trae `{ from, to }` completos, el área
 * ajena a otro venue no se puede tocar, y apagar (volver a AVOQADO) audita igual.
 */
const mockPrisma: any = {
  fulfillmentArea: { findFirst: jest.fn(), update: jest.fn() },
}

jest.mock('../../../../src/utils/prismaClient', () => ({ __esModule: true, default: mockPrisma }))
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn().mockResolvedValue(undefined),
}))

import { updateAreaSettlementRoute } from '../../../../src/services/dashboard/areaTicket.dashboard.service'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'

const AVOQADO_AREA = {
  id: 'area_1',
  venueId: 'venue_1',
  name: 'Cremería',
  settlementRoute: 'AVOQADO',
  externalConfirmationMode: 'MANUAL',
  externalOfflinePolicy: 'BLOCK',
  externalDeliveryTracking: 'TRACKED',
}

describe('updateAreaSettlementRoute', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('enciende la ruta externa con las cuatro políticas y audita el before/after completo', async () => {
    mockPrisma.fulfillmentArea.findFirst.mockResolvedValue(AVOQADO_AREA)
    const updated = {
      ...AVOQADO_AREA,
      settlementRoute: 'EXTERNAL',
      externalConfirmationMode: 'ASSUME_ON_PRINT',
      externalOfflinePolicy: 'ALLOW',
      externalDeliveryTracking: 'UNTRACKED',
    }
    mockPrisma.fulfillmentArea.update.mockResolvedValue(updated)

    const result = await updateAreaSettlementRoute(
      'venue_1',
      'area_1',
      {
        settlementRoute: 'EXTERNAL',
        externalConfirmationMode: 'ASSUME_ON_PRINT',
        externalOfflinePolicy: 'ALLOW',
        externalDeliveryTracking: 'UNTRACKED',
      },
      'staff_1',
    )

    expect(mockPrisma.fulfillmentArea.findFirst).toHaveBeenCalledWith({ where: { id: 'area_1', venueId: 'venue_1' } })
    expect(mockPrisma.fulfillmentArea.update).toHaveBeenCalledWith({
      where: { id: 'area_1' },
      data: {
        settlementRoute: 'EXTERNAL',
        externalConfirmationMode: 'ASSUME_ON_PRINT',
        externalOfflinePolicy: 'ALLOW',
        externalDeliveryTracking: 'UNTRACKED',
      },
    })
    expect(result).toEqual(updated)

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'staff_1',
        venueId: 'venue_1',
        action: 'AREA_SETTLEMENT_ROUTE_CHANGED',
        entity: 'FulfillmentArea',
        entityId: 'area_1',
        data: expect.objectContaining({
          from: expect.objectContaining({
            settlementRoute: 'AVOQADO',
            externalConfirmationMode: 'MANUAL',
            externalOfflinePolicy: 'BLOCK',
            externalDeliveryTracking: 'TRACKED',
          }),
          to: expect.objectContaining({
            settlementRoute: 'EXTERNAL',
            externalConfirmationMode: 'ASSUME_ON_PRINT',
            externalOfflinePolicy: 'ALLOW',
            externalDeliveryTracking: 'UNTRACKED',
          }),
        }),
      }),
    )
  })

  it('apagar vuelve a los defaults AVOQADO y también audita el cambio (no es un no-op silencioso)', async () => {
    const externalArea = {
      ...AVOQADO_AREA,
      settlementRoute: 'EXTERNAL',
      externalConfirmationMode: 'ASSUME_ON_PRINT',
      externalOfflinePolicy: 'ALLOW',
      externalDeliveryTracking: 'UNTRACKED',
    }
    mockPrisma.fulfillmentArea.findFirst.mockResolvedValue(externalArea)
    mockPrisma.fulfillmentArea.update.mockResolvedValue(AVOQADO_AREA)

    await updateAreaSettlementRoute('venue_1', 'area_1', {
      settlementRoute: 'AVOQADO',
      externalConfirmationMode: 'MANUAL',
      externalOfflinePolicy: 'BLOCK',
      externalDeliveryTracking: 'TRACKED',
    })

    expect(mockPrisma.fulfillmentArea.update).toHaveBeenCalledWith({
      where: { id: 'area_1' },
      data: {
        settlementRoute: 'AVOQADO',
        externalConfirmationMode: 'MANUAL',
        externalOfflinePolicy: 'BLOCK',
        externalDeliveryTracking: 'TRACKED',
      },
    })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AREA_SETTLEMENT_ROUTE_CHANGED',
        data: expect.objectContaining({
          from: expect.objectContaining({ settlementRoute: 'EXTERNAL' }),
          to: expect.objectContaining({ settlementRoute: 'AVOQADO' }),
        }),
      }),
    )
  })

  it('rechaza un área que no pertenece al venue (tenant isolation) sin tocar Prisma.update ni auditar', async () => {
    mockPrisma.fulfillmentArea.findFirst.mockResolvedValue(null)

    await expect(
      updateAreaSettlementRoute('venue_1', 'area_de_otro_venue', {
        settlementRoute: 'EXTERNAL',
        externalConfirmationMode: 'MANUAL',
        externalOfflinePolicy: 'BLOCK',
        externalDeliveryTracking: 'TRACKED',
      }),
    ).rejects.toThrow('Área no encontrada')

    expect(mockPrisma.fulfillmentArea.update).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('registra staffId null cuando no hay actor (nunca truena por falta de performedBy)', async () => {
    mockPrisma.fulfillmentArea.findFirst.mockResolvedValue(AVOQADO_AREA)
    mockPrisma.fulfillmentArea.update.mockResolvedValue({ ...AVOQADO_AREA, settlementRoute: 'EXTERNAL' })

    await updateAreaSettlementRoute('venue_1', 'area_1', {
      settlementRoute: 'EXTERNAL',
      externalConfirmationMode: 'MANUAL',
      externalOfflinePolicy: 'BLOCK',
      externalDeliveryTracking: 'TRACKED',
    })

    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ staffId: null }))
  })
})
