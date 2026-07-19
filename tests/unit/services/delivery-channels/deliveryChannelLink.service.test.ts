/**
 * Unit tests (mock-first) — Gestión de canales de delivery (DeliveryChannelLink).
 * Casos obligatorios (Task 10 brief): webhookSecret random + status PENDING en create;
 * tenant isolation (where: { id, venueId }) en update/pause; pause llama al adapter
 * best-effort (nunca lanza); cada mutación escribe ActivityLog; listChannelLinks NUNCA
 * devuelve webhookSecret.
 */
import prisma from '../../../../src/utils/prismaClient'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import { getAdapter } from '../../../../src/services/delivery-channels/core/statusDispatcher.service'
import { NotFoundError } from '../../../../src/errors/AppError'
import { DeliveryChannelStatus, DeliveryProvider, OrderAcceptanceMode } from '@prisma/client'
import {
  listChannelLinks,
  createChannelLink,
  updateChannelLink,
  pauseChannelLink,
} from '../../../../src/services/delivery-channels/core/deliveryChannelLink.service'

jest.mock('../../../../src/services/delivery-channels/core/statusDispatcher.service', () => ({
  getAdapter: jest.fn(),
}))

const HEX64 = /^[0-9a-f]{64}$/

const baseLink = {
  id: 'link1',
  venueId: 'venue1',
  provider: DeliveryProvider.DELIVERECT,
  externalLocationId: 'loc1',
  externalAccountId: 'acct1',
  webhookSecret: 'top-secret-value',
  orderAcceptanceMode: OrderAcceptanceMode.AUTO,
  status: DeliveryChannelStatus.ACTIVE,
  autoSyncMenu: true,
  lastMenuSyncAt: null,
  config: null,
  createdAt: new Date('2026-07-18T00:00:00.000Z'),
  updatedAt: new Date('2026-07-18T00:00:00.000Z'),
}

describe('deliveryChannelLink.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ============================================================
  // listChannelLinks — NUNCA devuelve webhookSecret
  // ============================================================
  describe('listChannelLinks', () => {
    it('lista los canales del venue sin exponer webhookSecret (select explícito)', async () => {
      ;(prisma.deliveryChannelLink.findMany as jest.Mock).mockResolvedValue([
        { id: 'link1', venueId: 'venue1', provider: DeliveryProvider.DELIVERECT, status: DeliveryChannelStatus.ACTIVE },
      ])

      await listChannelLinks('venue1')

      const callArg = (prisma.deliveryChannelLink.findMany as jest.Mock).mock.calls[0][0]
      expect(callArg.where).toEqual({ venueId: 'venue1' })
      expect(callArg.select).toBeDefined()
      expect(callArg.select.webhookSecret).toBeUndefined()
      // Aserción positiva: campos esperados sí están seleccionados
      expect(callArg.select.provider).toBe(true)
      expect(callArg.select.status).toBe(true)
    })
  })

  // ============================================================
  // createChannelLink
  // ============================================================
  describe('createChannelLink', () => {
    it('genera webhookSecret con crypto.randomBytes(32).toString(hex) y status PENDING', async () => {
      ;(prisma.deliveryChannelLink.create as jest.Mock).mockImplementation(async ({ data }: any) => ({
        id: 'newlink1',
        ...data,
      }))

      await createChannelLink('venue1', { provider: DeliveryProvider.DELIVERECT, externalLocationId: 'loc1' }, 'staff1')

      const callArg = (prisma.deliveryChannelLink.create as jest.Mock).mock.calls[0][0]
      expect(callArg.data.webhookSecret).toMatch(HEX64)
      expect(callArg.data.status).toBe(DeliveryChannelStatus.PENDING)
      expect(callArg.data.venueId).toBe('venue1')
      expect(callArg.data.provider).toBe(DeliveryProvider.DELIVERECT)
      expect(callArg.data.externalLocationId).toBe('loc1')
    })

    it('no devuelve webhookSecret al caller (select explícito sin secret)', async () => {
      ;(prisma.deliveryChannelLink.create as jest.Mock).mockResolvedValue({
        id: 'newlink1',
        venueId: 'venue1',
        provider: DeliveryProvider.DELIVERECT,
        externalLocationId: 'loc1',
        status: DeliveryChannelStatus.PENDING,
      })

      const result = await createChannelLink('venue1', { provider: DeliveryProvider.DELIVERECT, externalLocationId: 'loc1' })

      const callArg = (prisma.deliveryChannelLink.create as jest.Mock).mock.calls[0][0]
      expect(callArg.select).toBeDefined()
      expect(callArg.select.webhookSecret).toBeUndefined()
      expect((result as any).webhookSecret).toBeUndefined()
    })

    it('escribe ActivityLog DELIVERY_CHANNEL_CONNECTED con staffId, venueId y data relevante', async () => {
      ;(prisma.deliveryChannelLink.create as jest.Mock).mockResolvedValue({
        id: 'newlink1',
        venueId: 'venue1',
        provider: DeliveryProvider.DELIVERECT,
        externalLocationId: 'loc1',
        status: DeliveryChannelStatus.PENDING,
      })

      await createChannelLink('venue1', { provider: DeliveryProvider.DELIVERECT, externalLocationId: 'loc1' }, 'staff1')

      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DELIVERY_CHANNEL_CONNECTED',
          entity: 'DeliveryChannelLink',
          entityId: 'newlink1',
          staffId: 'staff1',
          venueId: 'venue1',
          data: expect.objectContaining({ provider: DeliveryProvider.DELIVERECT, externalLocationId: 'loc1' }),
        }),
      )
    })

    it('aplica defaults: orderAcceptanceMode AUTO y autoSyncMenu true cuando no se envían', async () => {
      ;(prisma.deliveryChannelLink.create as jest.Mock).mockResolvedValue({ id: 'newlink1', venueId: 'venue1' })

      await createChannelLink('venue1', { provider: DeliveryProvider.DELIVERECT, externalLocationId: 'loc1' })

      const callArg = (prisma.deliveryChannelLink.create as jest.Mock).mock.calls[0][0]
      expect(callArg.data.orderAcceptanceMode).toBe(OrderAcceptanceMode.AUTO)
      expect(callArg.data.autoSyncMenu).toBe(true)
    })
  })

  // ============================================================
  // updateChannelLink — tenant isolation + ActivityLog
  // ============================================================
  describe('updateChannelLink', () => {
    it('actualiza usando SIEMPRE where: { id, venueId } (tenant isolation)', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({ ...baseLink, autoSyncMenu: false })

      await updateChannelLink('venue1', 'link1', { autoSyncMenu: false }, 'staff1')

      expect(prisma.deliveryChannelLink.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'link1', venueId: 'venue1' } }),
      )
    })

    it('REGRESIÓN tenant isolation: link de OTRO venue → NotFoundError (no actualiza)', async () => {
      // updateMany con where compuesto venueId no matchea → count 0 (simula link de otro venue)
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

      await expect(updateChannelLink('venue-otro', 'link1', { autoSyncMenu: false })).rejects.toThrow(NotFoundError)

      expect(prisma.deliveryChannelLink.findUnique).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    })

    it('escribe ActivityLog DELIVERY_CHANNEL_UPDATED con staffId, venueId, entityId y data', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)

      await updateChannelLink('venue1', 'link1', { autoSyncMenu: false }, 'staff1')

      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DELIVERY_CHANNEL_UPDATED',
          entity: 'DeliveryChannelLink',
          entityId: 'link1',
          staffId: 'staff1',
          venueId: 'venue1',
          data: expect.objectContaining({ autoSyncMenu: false }),
        }),
      )
    })

    it('el resultado devuelto NUNCA incluye webhookSecret', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({
        id: 'link1',
        venueId: 'venue1',
        autoSyncMenu: false,
      })

      const result = await updateChannelLink('venue1', 'link1', { autoSyncMenu: false })

      const callArg = (prisma.deliveryChannelLink.findUnique as jest.Mock).mock.calls[0][0]
      expect(callArg.select).toBeDefined()
      expect(callArg.select.webhookSecret).toBeUndefined()
      expect((result as any).webhookSecret).toBeUndefined()
    })
  })

  // ============================================================
  // pauseChannelLink — tenant isolation + adapter best-effort + ActivityLog
  // ============================================================
  describe('pauseChannelLink', () => {
    it('actualiza status usando SIEMPRE where: { id, venueId } (tenant isolation)', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)
      ;(getAdapter as jest.Mock).mockReturnValue({ setChannelPaused: jest.fn().mockResolvedValue(undefined) })

      await pauseChannelLink('venue1', 'link1', true, 'staff1')

      expect(prisma.deliveryChannelLink.updateMany).toHaveBeenCalledWith({
        where: { id: 'link1', venueId: 'venue1' },
        data: { status: DeliveryChannelStatus.PAUSED },
      })
    })

    it('paused=false actualiza status a ACTIVE', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)
      ;(getAdapter as jest.Mock).mockReturnValue({ setChannelPaused: jest.fn().mockResolvedValue(undefined) })

      await pauseChannelLink('venue1', 'link1', false)

      expect(prisma.deliveryChannelLink.updateMany).toHaveBeenCalledWith({
        where: { id: 'link1', venueId: 'venue1' },
        data: { status: DeliveryChannelStatus.ACTIVE },
      })
    })

    it('REGRESIÓN tenant isolation: link de OTRO venue → NotFoundError (no pausa, no llama adapter)', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

      await expect(pauseChannelLink('venue-otro', 'link1', true)).rejects.toThrow(NotFoundError)

      expect(getAdapter).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    })

    it('llama getAdapter(provider).setChannelPaused best-effort', async () => {
      const setChannelPaused = jest.fn().mockResolvedValue(undefined)
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)
      ;(getAdapter as jest.Mock).mockReturnValue({ setChannelPaused })

      await pauseChannelLink('venue1', 'link1', true)

      expect(getAdapter).toHaveBeenCalledWith(DeliveryProvider.DELIVERECT)
      expect(setChannelPaused).toHaveBeenCalledWith(baseLink, true)
    })

    it('si el adapter falla (getAdapter lanza o setChannelPaused rechaza), NO propaga el error — solo loguea', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)
      ;(getAdapter as jest.Mock).mockImplementation(() => {
        throw new Error('Delivery provider sin adapter implementado: DELIVERECT')
      })

      await expect(pauseChannelLink('venue1', 'link1', true, 'staff1')).resolves.toBeDefined()
      // La mutación sigue completándose (status actualizado + ActivityLog) aunque el adapter falle
      expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'DELIVERY_CHANNEL_PAUSED' }))
    })

    it('si setChannelPaused rechaza (promise), tampoco propaga el error', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)
      ;(getAdapter as jest.Mock).mockReturnValue({ setChannelPaused: jest.fn().mockRejectedValue(new Error('network down')) })

      await expect(pauseChannelLink('venue1', 'link1', true)).resolves.toBeDefined()
    })

    it('escribe ActivityLog DELIVERY_CHANNEL_PAUSED con staffId, venueId, entityId y data.paused', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)
      ;(getAdapter as jest.Mock).mockReturnValue({ setChannelPaused: jest.fn().mockResolvedValue(undefined) })

      await pauseChannelLink('venue1', 'link1', true, 'staff1')

      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DELIVERY_CHANNEL_PAUSED',
          entity: 'DeliveryChannelLink',
          entityId: 'link1',
          staffId: 'staff1',
          venueId: 'venue1',
          data: expect.objectContaining({ paused: true }),
        }),
      )
    })

    it('el resultado devuelto NUNCA incluye webhookSecret (aunque el adapter necesite el link completo)', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)
      ;(getAdapter as jest.Mock).mockReturnValue({ setChannelPaused: jest.fn().mockResolvedValue(undefined) })

      const result = await pauseChannelLink('venue1', 'link1', true)

      expect((result as any).webhookSecret).toBeUndefined()
    })
  })
})
