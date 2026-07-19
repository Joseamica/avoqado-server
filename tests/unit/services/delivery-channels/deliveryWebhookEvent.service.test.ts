/**
 * Unit tests (mock-first) — deliveryWebhookEvent.service.ts
 *
 * Fix B1 (audit §10.2): la clave de dedup ahora incluye `channelLinkId`
 * (`@@unique([provider, channelLinkId, externalEventId, eventType])`, migración
 * f03f55f1) porque `externalEventId` (channelOrderId) nace en el marketplace y
 * NO es único global — dos canales/venues pueden colisionar. El P2002 catch de
 * `persistDeliveryEvent` debe re-consultar con la MISMA llave compuesta nueva,
 * nunca con la vieja de 3 campos (eso colisionaría eventos de canales distintos).
 */
import { DeliveryOrderEventStatus, DeliveryProvider } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import { persistDeliveryEvent, markEventResult } from '../../../../src/services/delivery-channels/core/deliveryWebhookEvent.service'

const baseParams = {
  provider: DeliveryProvider.DELIVERECT,
  externalEventId: 'CHANNEL-ORDER-1',
  eventType: 'order',
  venueId: 'venue1',
  payload: { channelOrderId: 'CHANNEL-ORDER-1', items: [] },
}

function p2002(): Error & { code: string } {
  return Object.assign(new Error('Unique constraint failed on the fields: (`provider`,`channelLinkId`,`externalEventId`,`eventType`)'), {
    code: 'P2002',
  })
}

describe('deliveryWebhookEvent.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('persistDeliveryEvent', () => {
    // ============================================================
    // New behavior (Fix B1)
    // ============================================================
    it('persiste con éxito e incluye channelLinkId en el payload de create', async () => {
      ;(prisma.deliveryOrderEvent.create as jest.Mock).mockResolvedValue({ id: 'evt-A', ...baseParams, channelLinkId: 'linkA' })

      const result = await persistDeliveryEvent({ ...baseParams, channelLinkId: 'linkA' })

      expect(prisma.deliveryOrderEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          channelLinkId: 'linkA',
          provider: baseParams.provider,
          externalEventId: baseParams.externalEventId,
        }),
      })
      expect(result).toEqual({ event: { id: 'evt-A', ...baseParams, channelLinkId: 'linkA' }, duplicate: false })
    })

    it('Fix B1: dos eventos con MISMO externalEventId+eventType pero DISTINTO channelLinkId AMBOS persisten (create resuelve para los dos — antes el 2º colisionaba como DUPLICATE)', async () => {
      ;(prisma.deliveryOrderEvent.create as jest.Mock)
        .mockResolvedValueOnce({ id: 'evt-A', ...baseParams, channelLinkId: 'linkA' })
        .mockResolvedValueOnce({ id: 'evt-B', ...baseParams, channelLinkId: 'linkB' })

      const resultA = await persistDeliveryEvent({ ...baseParams, channelLinkId: 'linkA' })
      const resultB = await persistDeliveryEvent({ ...baseParams, channelLinkId: 'linkB' })

      expect(resultA).toEqual({ duplicate: false, event: expect.objectContaining({ id: 'evt-A' }) })
      expect(resultB).toEqual({ duplicate: false, event: expect.objectContaining({ id: 'evt-B' }) })
      expect(prisma.deliveryOrderEvent.create).toHaveBeenCalledTimes(2)
      // Ningún camino de este flujo debería necesitar re-consultar por P2002 —
      // create() nunca lanzó porque, en Postgres real, la llave compuesta difiere.
      expect(prisma.deliveryOrderEvent.findUnique).not.toHaveBeenCalled()
    })

    it('Fix B1: mismo channelLinkId+externalEventId+eventType (P2002 real) → re-consulta con la llave compuesta NUEVA (provider_channelLinkId_externalEventId_eventType) y devuelve duplicate:true', async () => {
      ;(prisma.deliveryOrderEvent.create as jest.Mock).mockRejectedValue(p2002())
      const existing = { id: 'evt-existing', ...baseParams, channelLinkId: 'linkA' }
      ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(existing)

      const result = await persistDeliveryEvent({ ...baseParams, channelLinkId: 'linkA' })

      expect(prisma.deliveryOrderEvent.findUnique).toHaveBeenCalledWith({
        where: {
          provider_channelLinkId_externalEventId_eventType: {
            provider: baseParams.provider,
            channelLinkId: 'linkA',
            externalEventId: baseParams.externalEventId,
            eventType: baseParams.eventType,
          },
        },
      })
      expect(result).toEqual({ event: existing, duplicate: true })
    })

    it('Fix B1 REGRESIÓN: el catch de P2002 NUNCA debe re-consultar con la llave vieja de 3 campos (provider_externalEventId_eventType) — colisionaría entre channelLinkId distintos', async () => {
      ;(prisma.deliveryOrderEvent.create as jest.Mock).mockRejectedValue(p2002())
      ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue({ id: 'evt-existing', channelLinkId: 'linkA' })

      await persistDeliveryEvent({ ...baseParams, channelLinkId: 'linkA' })

      const callArg = (prisma.deliveryOrderEvent.findUnique as jest.Mock).mock.calls[0][0]
      expect(callArg.where.provider_externalEventId_eventType).toBeUndefined()
      expect(callArg.where.provider_channelLinkId_externalEventId_eventType).toBeDefined()
      expect(callArg.where.provider_channelLinkId_externalEventId_eventType.channelLinkId).toBe('linkA')
    })

    it('si P2002 pero no se encuentra la fila existente (carrera improbable), relanza el error original', async () => {
      const err = p2002()
      ;(prisma.deliveryOrderEvent.create as jest.Mock).mockRejectedValue(err)
      ;(prisma.deliveryOrderEvent.findUnique as jest.Mock).mockResolvedValue(null)

      await expect(persistDeliveryEvent({ ...baseParams, channelLinkId: 'linkA' })).rejects.toThrow(err)
    })

    // ============================================================
    // Regresión — comportamiento previo intacto
    // ============================================================
    it('un error de Prisma que NO es P2002 se propaga tal cual (no dispara la búsqueda de duplicado)', async () => {
      const dbDown = Object.assign(new Error('connection lost'), { code: 'P1001' })
      ;(prisma.deliveryOrderEvent.create as jest.Mock).mockRejectedValue(dbDown)

      await expect(persistDeliveryEvent({ ...baseParams, channelLinkId: 'linkA' })).rejects.toThrow('connection lost')
      expect(prisma.deliveryOrderEvent.findUnique).not.toHaveBeenCalled()
    })
  })

  describe('markEventResult', () => {
    it('actualiza status/orderId/error/processedAt del evento', async () => {
      await markEventResult('evt1', DeliveryOrderEventStatus.PROCESSED, 'order1')

      expect(prisma.deliveryOrderEvent.update).toHaveBeenCalledWith({
        where: { id: 'evt1' },
        data: { status: DeliveryOrderEventStatus.PROCESSED, orderId: 'order1', error: undefined, processedAt: expect.any(Date) },
      })
    })

    it('marca FAILED con mensaje de error, sin orderId', async () => {
      await markEventResult('evt1', DeliveryOrderEventStatus.FAILED, undefined, 'boom')

      expect(prisma.deliveryOrderEvent.update).toHaveBeenCalledWith({
        where: { id: 'evt1' },
        data: { status: DeliveryOrderEventStatus.FAILED, orderId: undefined, error: 'boom', processedAt: expect.any(Date) },
      })
    })
  })
})
