/**
 * Unit tests (mock-first) — Servicio de solicitud de activación de delivery (Tasks 2 y 4 del plan
 * delivery-activation). Casos obligatorios (brief): getActivationRequest filtra por venueId +
 * status en [PENDING, CONTACTED]; createActivationRequest es idempotente (si ya hay una viva la
 * devuelve, no crea ni re-loguea); updateActivationStatus sella contactedAt/connectedAt según el
 * status destino y siempre escribe ActivityLog; listActivationRequests (Task 4, cola de ops) trae
 * todas ordenadas por createdAt desc con venue { name, slug }, filtrables por status.
 */
import { DeliveryActivationStatus } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import { NotFoundError } from '../../../../src/errors/AppError'
import {
  getActivationRequest,
  createActivationRequest,
  updateActivationStatus,
  listActivationRequests,
} from '../../../../src/services/delivery-channels/core/deliveryActivation.service'

jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

describe('deliveryActivation.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.deliveryActivationRequest.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.deliveryActivationRequest.create as jest.Mock).mockResolvedValue({ id: 'req1', venueId: 'v1', status: 'PENDING' })
  })

  // ============================================================
  // getActivationRequest — solicitud "viva" (PENDING|CONTACTED) por venue
  // ============================================================
  describe('getActivationRequest', () => {
    it('busca con findFirst filtrando venueId + status in [PENDING, CONTACTED]', async () => {
      ;(prisma.deliveryActivationRequest.findFirst as jest.Mock).mockResolvedValue({
        id: 'req1',
        venueId: 'venue1',
        status: DeliveryActivationStatus.PENDING,
      })

      const result = await getActivationRequest('venue1')

      expect(prisma.deliveryActivationRequest.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            venueId: 'venue1',
            status: { in: [DeliveryActivationStatus.PENDING, DeliveryActivationStatus.CONTACTED] },
          },
        }),
      )
      expect(result).toEqual(expect.objectContaining({ id: 'req1', venueId: 'venue1' }))
    })

    it('devuelve null cuando el venue no tiene solicitud viva', async () => {
      ;(prisma.deliveryActivationRequest.findFirst as jest.Mock).mockResolvedValue(null)

      const result = await getActivationRequest('venue1')

      expect(result).toBeNull()
    })
  })

  // ============================================================
  // createActivationRequest — idempotente
  // ============================================================
  describe('createActivationRequest', () => {
    it('cuando NO hay solicitud viva, crea PENDING con requestedChannels/note/requestedById', async () => {
      ;(prisma.deliveryActivationRequest.findFirst as jest.Mock).mockResolvedValue(null)
      ;(prisma.deliveryActivationRequest.create as jest.Mock).mockResolvedValue({
        id: 'newreq1',
        venueId: 'venue1',
        status: DeliveryActivationStatus.PENDING,
        requestedChannels: ['UBER_EATS', 'RAPPI'],
        note: 'Ya tengo cuenta en Uber Eats',
      })

      const result = await createActivationRequest('venue1', 'staff1', {
        requestedChannels: ['UBER_EATS', 'RAPPI'],
        note: 'Ya tengo cuenta en Uber Eats',
      })

      const callArg = (prisma.deliveryActivationRequest.create as jest.Mock).mock.calls[0][0]
      expect(callArg.data).toEqual(
        expect.objectContaining({
          venueId: 'venue1',
          requestedById: 'staff1',
          requestedChannels: ['UBER_EATS', 'RAPPI'],
          note: 'Ya tengo cuenta en Uber Eats',
        }),
      )
      expect(result.id).toBe('newreq1')
    })

    it('note es opcional: sin note, crea con note null', async () => {
      ;(prisma.deliveryActivationRequest.findFirst as jest.Mock).mockResolvedValue(null)
      ;(prisma.deliveryActivationRequest.create as jest.Mock).mockResolvedValue({ id: 'newreq1', venueId: 'venue1' })

      await createActivationRequest('venue1', 'staff1', { requestedChannels: ['RAPPI'] })

      const callArg = (prisma.deliveryActivationRequest.create as jest.Mock).mock.calls[0][0]
      expect(callArg.data.note).toBeNull()
    })

    it('escribe ActivityLog DELIVERY_ACTIVATION_REQUESTED (staffId=requestedById, venueId, entity, data con channels)', async () => {
      ;(prisma.deliveryActivationRequest.findFirst as jest.Mock).mockResolvedValue(null)
      ;(prisma.deliveryActivationRequest.create as jest.Mock).mockResolvedValue({
        id: 'newreq1',
        venueId: 'venue1',
        status: DeliveryActivationStatus.PENDING,
      })

      await createActivationRequest('venue1', 'staff1', { requestedChannels: ['UBER_EATS'] })

      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DELIVERY_ACTIVATION_REQUESTED',
          entity: 'DeliveryActivationRequest',
          entityId: 'newreq1',
          staffId: 'staff1',
          venueId: 'venue1',
          data: expect.objectContaining({ requestedChannels: ['UBER_EATS'] }),
        }),
      )
    })

    it('idempotente: cuando YA hay una viva, la devuelve sin crear otra ni volver a loguear', async () => {
      const existing = {
        id: 'existing1',
        venueId: 'venue1',
        status: DeliveryActivationStatus.PENDING,
        requestedChannels: ['RAPPI'],
      }
      ;(prisma.deliveryActivationRequest.findFirst as jest.Mock).mockResolvedValue(existing)

      const result = await createActivationRequest('venue1', 'staff1', { requestedChannels: ['DIDI_FOOD'] })

      expect(result).toEqual(existing)
      expect(prisma.deliveryActivationRequest.create).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    })

    it('idempotente: la búsqueda de "viva" también respeta el venue (no cruza tenants)', async () => {
      ;(prisma.deliveryActivationRequest.findFirst as jest.Mock).mockResolvedValue(null)
      ;(prisma.deliveryActivationRequest.create as jest.Mock).mockResolvedValue({ id: 'newreq1', venueId: 'venue2' })

      await createActivationRequest('venue2', 'staff1', { requestedChannels: ['RAPPI'] })

      expect(prisma.deliveryActivationRequest.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ venueId: 'venue2' }) }),
      )
    })
  })

  // ============================================================
  // updateActivationStatus — transición de ops, sella contactedAt/connectedAt
  // ============================================================
  describe('updateActivationStatus', () => {
    it('CONTACTED: set status + contactedAt (sin connectedAt) + ActivityLog DELIVERY_ACTIVATION_CONTACTED', async () => {
      ;(prisma.deliveryActivationRequest.update as jest.Mock).mockResolvedValue({
        id: 'req1',
        venueId: 'venue1',
        status: DeliveryActivationStatus.CONTACTED,
        contactedAt: new Date(),
      })

      await updateActivationStatus('req1', DeliveryActivationStatus.CONTACTED, 'staff-ops1')

      const callArg = (prisma.deliveryActivationRequest.update as jest.Mock).mock.calls[0][0]
      expect(callArg.where).toEqual({ id: 'req1' })
      expect(callArg.data.status).toBe(DeliveryActivationStatus.CONTACTED)
      expect(callArg.data.contactedAt).toBeInstanceOf(Date)
      expect(callArg.data.connectedAt).toBeUndefined()

      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DELIVERY_ACTIVATION_CONTACTED',
          entity: 'DeliveryActivationRequest',
          entityId: 'req1',
          staffId: 'staff-ops1',
          venueId: 'venue1',
          data: expect.objectContaining({ status: DeliveryActivationStatus.CONTACTED }),
        }),
      )
    })

    it('CONNECTED: set status + connectedAt (sin contactedAt) + ActivityLog DELIVERY_ACTIVATION_CONNECTED', async () => {
      ;(prisma.deliveryActivationRequest.update as jest.Mock).mockResolvedValue({
        id: 'req1',
        venueId: 'venue1',
        status: DeliveryActivationStatus.CONNECTED,
        connectedAt: new Date(),
      })

      await updateActivationStatus('req1', DeliveryActivationStatus.CONNECTED, 'staff-ops1')

      const callArg = (prisma.deliveryActivationRequest.update as jest.Mock).mock.calls[0][0]
      expect(callArg.data.status).toBe(DeliveryActivationStatus.CONNECTED)
      expect(callArg.data.connectedAt).toBeInstanceOf(Date)
      expect(callArg.data.contactedAt).toBeUndefined()

      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DELIVERY_ACTIVATION_CONNECTED',
          entity: 'DeliveryActivationRequest',
          entityId: 'req1',
          staffId: 'staff-ops1',
          venueId: 'venue1',
          data: expect.objectContaining({ status: DeliveryActivationStatus.CONNECTED }),
        }),
      )
    })

    it('DISMISSED: set status (sin sellar timestamps) + ActivityLog DELIVERY_ACTIVATION_DISMISSED', async () => {
      ;(prisma.deliveryActivationRequest.update as jest.Mock).mockResolvedValue({
        id: 'req1',
        venueId: 'venue1',
        status: DeliveryActivationStatus.DISMISSED,
      })

      await updateActivationStatus('req1', DeliveryActivationStatus.DISMISSED, 'staff-ops1')

      const callArg = (prisma.deliveryActivationRequest.update as jest.Mock).mock.calls[0][0]
      expect(callArg.data.status).toBe(DeliveryActivationStatus.DISMISSED)
      expect(callArg.data.contactedAt).toBeUndefined()
      expect(callArg.data.connectedAt).toBeUndefined()

      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DELIVERY_ACTIVATION_DISMISSED',
          entity: 'DeliveryActivationRequest',
          entityId: 'req1',
          staffId: 'staff-ops1',
          venueId: 'venue1',
          data: expect.objectContaining({ status: DeliveryActivationStatus.DISMISSED }),
        }),
      )
    })

    // ============================================================
    // Fix 2 (audit, API-CONTRACT): id inexistente → P2025 crudo hoy (500 genérico).
    // Los hermanos (updateChannelLink/pauseChannelLink) usan updateMany+count===0 →
    // NotFoundError; update() por id único debe traducir P2025 al mismo contrato.
    // ============================================================
    it('REGRESIÓN Fix 2: id inexistente (P2025 de Prisma) → NotFoundError, no el error crudo', async () => {
      const p2025 = Object.assign(new Error('Record to update not found.'), { code: 'P2025' })
      ;(prisma.deliveryActivationRequest.update as jest.Mock).mockRejectedValue(p2025)

      await expect(updateActivationStatus('nonexistent', DeliveryActivationStatus.CONTACTED, 'staff-ops1')).rejects.toThrow(NotFoundError)
      expect(logAction).not.toHaveBeenCalled()
    })

    it('un error de Prisma que NO es P2025 se propaga tal cual (no se enmascara como NotFoundError)', async () => {
      const dbDown = Object.assign(new Error('connection lost'), { code: 'P1001' })
      ;(prisma.deliveryActivationRequest.update as jest.Mock).mockRejectedValue(dbDown)

      await expect(updateActivationStatus('req1', DeliveryActivationStatus.CONTACTED, 'staff-ops1')).rejects.toThrow('connection lost')
      expect(logAction).not.toHaveBeenCalled()
    })
  })

  // ============================================================
  // listActivationRequests (Task 4) — cola de ops: todas, más recientes primero, con venue
  // ============================================================
  describe('listActivationRequests', () => {
    it('sin filtro: findMany con where {} + orderBy createdAt desc + include venue { name, slug }', async () => {
      ;(prisma.deliveryActivationRequest.findMany as jest.Mock).mockResolvedValue([])

      await listActivationRequests()

      expect(prisma.deliveryActivationRequest.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { createdAt: 'desc' },
        include: { venue: { select: { name: true, slug: true } } },
      })
    })

    it('con status: filtra where { status }', async () => {
      ;(prisma.deliveryActivationRequest.findMany as jest.Mock).mockResolvedValue([])

      await listActivationRequests({ status: DeliveryActivationStatus.CONTACTED })

      expect(prisma.deliveryActivationRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: DeliveryActivationStatus.CONTACTED } }),
      )
    })

    it('devuelve las filas del prisma tal cual (incluyendo venue.name/venue.slug)', async () => {
      const rows = [
        { id: 'req1', venueId: 'v1', status: DeliveryActivationStatus.PENDING, venue: { name: 'Venue Uno', slug: 'venue-uno' } },
        { id: 'req2', venueId: 'v2', status: DeliveryActivationStatus.CONTACTED, venue: { name: 'Venue Dos', slug: 'venue-dos' } },
      ]
      ;(prisma.deliveryActivationRequest.findMany as jest.Mock).mockResolvedValue(rows)

      const result = await listActivationRequests()

      expect(result).toEqual(rows)
    })

    it('sin argumento (undefined) se comporta igual que sin filtro (no revienta, where {})', async () => {
      ;(prisma.deliveryActivationRequest.findMany as jest.Mock).mockResolvedValue([])

      await listActivationRequests(undefined)

      expect(prisma.deliveryActivationRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }))
    })

    // ============================================================
    // Fix 5 (audit, API-CONTRACT): venueId/venueIds — antes el filtro solo aceptaba
    // `status`, así que el MCP single-venue tenía que traer la cola COMPLETA cross-tenant
    // y filtrar en memoria. Ahora la query queda scopeada en el servidor.
    // ============================================================
    it('Fix 5: con venueId filtra where { venueId } (query scopeada, no scan cross-tenant)', async () => {
      ;(prisma.deliveryActivationRequest.findMany as jest.Mock).mockResolvedValue([])

      await listActivationRequests({ venueId: 'venue1' })

      expect(prisma.deliveryActivationRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: 'venue1' } }))
    })

    it('Fix 5: con venueIds filtra where { venueId: { in: venueIds } } (defense-in-depth multi-venue)', async () => {
      ;(prisma.deliveryActivationRequest.findMany as jest.Mock).mockResolvedValue([])

      await listActivationRequests({ venueIds: ['v1', 'v2'] })

      expect(prisma.deliveryActivationRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { venueId: { in: ['v1', 'v2'] } } }),
      )
    })

    it('Fix 5: venueId + status combinados aplican ambos al where', async () => {
      ;(prisma.deliveryActivationRequest.findMany as jest.Mock).mockResolvedValue([])

      await listActivationRequests({ venueId: 'venue1', status: DeliveryActivationStatus.PENDING })

      expect(prisma.deliveryActivationRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { venueId: 'venue1', status: DeliveryActivationStatus.PENDING } }),
      )
    })

    it('REGRESIÓN Fix 5: el REST superadmin (sin venueId/venueIds) sigue trayendo TODO — where {} cuando solo hay status', async () => {
      ;(prisma.deliveryActivationRequest.findMany as jest.Mock).mockResolvedValue([])

      await listActivationRequests({ status: DeliveryActivationStatus.CONTACTED })

      expect(prisma.deliveryActivationRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: DeliveryActivationStatus.CONTACTED } }),
      )
    })
  })
})
