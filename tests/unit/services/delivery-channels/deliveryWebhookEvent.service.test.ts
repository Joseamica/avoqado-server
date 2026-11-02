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
import logger from '@/config/logger'
import prisma from '../../../../src/utils/prismaClient'
import {
  persistDeliveryEvent,
  markEventResult,
  reclamarEvento,
  renovarReclamo,
  cerrarEventoReclamado,
} from '../../../../src/services/delivery-channels/core/deliveryWebhookEvent.service'

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

    it('regresión: sigue sin reclamo — Uber lo usa tal cual y no toca claimToken ni lockedUntil', async () => {
      await markEventResult('evt1', DeliveryOrderEventStatus.PROCESSED, 'order1')

      const { data } = (prisma.deliveryOrderEvent.update as jest.Mock).mock.calls[0][0]
      expect(data).not.toHaveProperty('claimToken')
      expect(data).not.toHaveProperty('lockedUntil')
      expect(prisma.deliveryOrderEvent.updateMany).not.toHaveBeenCalled()
    })
  })

  // ============================================================
  // El reclamo del evento: dos procesos nunca trabajan el MISMO evento a la vez
  // ============================================================
  describe('reclamo del evento', () => {
    const NOW = new Date('2026-10-21T18:00:00.000Z').getTime()
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

    beforeEach(() => {
      jest.useFakeTimers({ now: NOW })
    })
    afterEach(() => {
      jest.useRealTimers()
    })

    describe('reclamarEvento', () => {
      it('🔴 un solo updateMany condicional: excluye PROCESSED y los reclamos vigentes; escribe un token nuevo y el vencimiento', async () => {
        ;(prisma.deliveryOrderEvent.updateMany as jest.Mock).mockResolvedValue({ count: 1 })

        const token = await reclamarEvento('evt1', 45_000)

        expect(prisma.deliveryOrderEvent.updateMany).toHaveBeenCalledTimes(1)
        const { where, data } = (prisma.deliveryOrderEvent.updateMany as jest.Mock).mock.calls[0][0]
        expect(where).toEqual({
          id: 'evt1',
          status: { not: DeliveryOrderEventStatus.PROCESSED },
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date(NOW) } }],
        })
        expect(data).toEqual({ claimToken: expect.stringMatching(UUID), lockedUntil: new Date(NOW + 45_000) })
        // Devuelve EXACTAMENTE el token que escribió: con él renueva y cierra.
        expect(token).toBe(data.claimToken)
        // Ni lectura previa ni escritura sin condición: la decisión la toma la base en ese único UPDATE.
        expect(prisma.deliveryOrderEvent.findUnique).not.toHaveBeenCalled()
        expect(prisma.deliveryOrderEvent.update).not.toHaveBeenCalled()
      })

      it('si el UPDATE no tocó la fila (otro lo tiene, ya está PROCESSED o no existe) devuelve null', async () => {
        ;(prisma.deliveryOrderEvent.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

        await expect(reclamarEvento('evt1', 45_000)).resolves.toBeNull()
      })

      it('cada reclamo lleva un token distinto: el de un dueño viejo nunca coincide con el del nuevo', async () => {
        ;(prisma.deliveryOrderEvent.updateMany as jest.Mock).mockResolvedValue({ count: 1 })

        const a = await reclamarEvento('evt1', 45_000)
        const b = await reclamarEvento('evt1', 45_000)

        expect(a).not.toBe(b)
      })
    })

    describe('renovarReclamo', () => {
      it('extiende el vencimiento SÓLO si el token sigue siendo el suyo', async () => {
        ;(prisma.deliveryOrderEvent.updateMany as jest.Mock).mockResolvedValue({ count: 1 })

        await expect(renovarReclamo('evt1', 'tok-A', 45_000)).resolves.toBe(true)

        expect(prisma.deliveryOrderEvent.updateMany).toHaveBeenCalledWith({
          where: { id: 'evt1', claimToken: 'tok-A' },
          data: { lockedUntil: new Date(NOW + 45_000) },
        })
      })

      it('con el token de otro no toca nada y devuelve false: otro lo tomó', async () => {
        ;(prisma.deliveryOrderEvent.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

        await expect(renovarReclamo('evt1', 'tok-viejo', 45_000)).resolves.toBe(false)
        expect(prisma.deliveryOrderEvent.update).not.toHaveBeenCalled()
      })
    })

    describe('cerrarEventoReclamado', () => {
      it('escribe el resultado como markEventResult y suelta el reclamo, sólo con su token', async () => {
        ;(prisma.deliveryOrderEvent.updateMany as jest.Mock).mockResolvedValue({ count: 1 })

        await expect(cerrarEventoReclamado('evt1', 'tok-A', DeliveryOrderEventStatus.PROCESSED, 'order1')).resolves.toBe(true)

        expect(prisma.deliveryOrderEvent.updateMany).toHaveBeenCalledWith({
          where: { id: 'evt1', claimToken: 'tok-A' },
          data: {
            status: DeliveryOrderEventStatus.PROCESSED,
            orderId: 'order1',
            error: null,
            processedAt: new Date(NOW),
            claimToken: null,
            lockedUntil: null,
          },
        })
        expect(prisma.deliveryOrderEvent.update).not.toHaveBeenCalled()
      })

      it('🔴 PROCESSED escribe error: null (con undefined Prisma deja el texto de un intento anterior: PROCESSED con un error viejo)', async () => {
        ;(prisma.deliveryOrderEvent.updateMany as jest.Mock).mockResolvedValue({ count: 1 })

        await cerrarEventoReclamado('evt1', 'tok-A', DeliveryOrderEventStatus.PROCESSED)

        const data = (prisma.deliveryOrderEvent.updateMany as jest.Mock).mock.calls[0][0].data
        expect(data.error).toBeNull()
        expect('error' in data).toBe(true)
      })

      it('FAILED con su error, sin orderId', async () => {
        ;(prisma.deliveryOrderEvent.updateMany as jest.Mock).mockResolvedValue({ count: 1 })

        await cerrarEventoReclamado('evt1', 'tok-A', DeliveryOrderEventStatus.FAILED, undefined, 'ACCEPT_500: boom')

        expect((prisma.deliveryOrderEvent.updateMany as jest.Mock).mock.calls[0][0].data).toMatchObject({
          status: DeliveryOrderEventStatus.FAILED,
          orderId: undefined,
          error: 'ACCEPT_500: boom',
          claimToken: null,
          lockedUntil: null,
        })
      })

      it('🔴 con un token ajeno devuelve false, grita 🚨 y NO sobrescribe nada: el cierre de un dueño viejo nunca borra el reclamo del nuevo', async () => {
        ;(prisma.deliveryOrderEvent.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

        await expect(cerrarEventoReclamado('evt1', 'tok-viejo', DeliveryOrderEventStatus.FAILED, undefined, 'INGEST: x')).resolves.toBe(
          false,
        )

        // La única escritura fue la condicionada (que no tocó nada); ninguna escritura de respaldo por id.
        expect(prisma.deliveryOrderEvent.updateMany).toHaveBeenCalledTimes(1)
        expect(prisma.deliveryOrderEvent.update).not.toHaveBeenCalled()
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('🚨'),
          expect.objectContaining({ eventId: 'evt1', status: DeliveryOrderEventStatus.FAILED }),
        )
      })
    })
  })
})
