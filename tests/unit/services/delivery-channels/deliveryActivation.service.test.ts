/**
 * Unit tests (mock-first) — Servicio de solicitud de activación de delivery (Tasks 2 y 4 del plan
 * delivery-activation). Casos obligatorios (brief): getActivationRequest filtra por venueId +
 * status en [PENDING, CONTACTED]; createActivationRequest es idempotente (si ya hay una viva la
 * devuelve, no crea ni re-loguea); updateActivationStatus sella contactedAt/connectedAt según el
 * status destino y siempre escribe ActivityLog; listActivationRequests (Task 4, cola de ops) trae
 * todas ordenadas por createdAt desc con venue { name, slug }, filtrables por status.
 *
 * Fix A2 (audit, spec §10.2): createActivationRequest ahora aísla el find+create DENTRO de
 * `prisma.$transaction` (cierra el TOCTOU del check-then-create — dos POSTs "concurrentes" ya no
 * pueden ambos ver "sin viva" y duplicar); updateActivationStatus ahora valida la transición
 * ANTES de escribir (CONNECTED/DISMISSED son terminales — no admiten transición de salida).
 */
import { DeliveryActivationStatus } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import { NotFoundError, ValidationError } from '../../../../src/errors/AppError'
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

    // ============================================================
    // Fix A2 (audit, spec §10.2): check-then-create SIN transacción — dos POSTs concurrentes
    // podían leer "sin viva" antes de que cualquiera insertara la suya y ambos crear una fila
    // (duplicado). El find+create ahora vive DENTRO de la MISMA prisma.$transaction.
    // ============================================================
    it('Fix A2: aísla el find+create DENTRO de prisma.$transaction (no fuera de ella)', async () => {
      ;(prisma.deliveryActivationRequest.findFirst as jest.Mock).mockResolvedValue(null)
      ;(prisma.deliveryActivationRequest.create as jest.Mock).mockResolvedValue({ id: 'newreq1', venueId: 'venue1' })

      await createActivationRequest('venue1', 'staff1', { requestedChannels: ['RAPPI'] })

      expect(prisma.$transaction).toHaveBeenCalledTimes(1)
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function))
      // El find+create solo puede haber corrido como efecto de invocar $transaction (el mock de
      // setup.ts ejecuta el callback sincrónicamente) — probamos el ORDEN de invocación para
      // confirmar que no se llaman ANTES/fuera del $transaction.
      const txOrder = (prisma.$transaction as jest.Mock).mock.invocationCallOrder[0]
      const findOrder = (prisma.deliveryActivationRequest.findFirst as jest.Mock).mock.invocationCallOrder[0]
      const createOrder = (prisma.deliveryActivationRequest.create as jest.Mock).mock.invocationCallOrder[0]
      expect(txOrder).toBeLessThan(findOrder)
      expect(txOrder).toBeLessThan(createOrder)
    })

    it('Fix A2 (concurrencia simulada vía re-chequeo en tx): dos llamadas "concurrentes" → una sola fila viva, NO duplica', async () => {
      const winnerRow = { id: 'req-winner', venueId: 'venue1', status: DeliveryActivationStatus.PENDING, requestedChannels: ['RAPPI'] }

      // Llamada 1: su re-chequeo DENTRO de su propia tx no ve nada vivo todavía → crea.
      ;(prisma.deliveryActivationRequest.findFirst as jest.Mock).mockResolvedValueOnce(null)
      ;(prisma.deliveryActivationRequest.create as jest.Mock).mockResolvedValueOnce(winnerRow)

      const result1 = await createActivationRequest('venue1', 'staff1', { requestedChannels: ['RAPPI'] })

      // Llamada 2 "concurrente": su re-chequeo DENTRO de SU tx ya ve la fila que la tx de la
      // llamada 1 confirmó — por eso NO crea otra, devuelve la misma (idempotente).
      ;(prisma.deliveryActivationRequest.findFirst as jest.Mock).mockResolvedValueOnce(winnerRow)

      const result2 = await createActivationRequest('venue1', 'staff2', { requestedChannels: ['RAPPI'] })

      expect(prisma.deliveryActivationRequest.create).toHaveBeenCalledTimes(1) // nunca una segunda fila
      expect(result1.id).toBe('req-winner')
      expect(result2.id).toBe('req-winner') // la 2da devuelve la MISMA fila, no crea otra
      expect(logAction).toHaveBeenCalledTimes(1) // solo la creación real audita
    })
  })

  // ============================================================
  // updateActivationStatus — transición de ops, sella contactedAt/connectedAt
  // ============================================================
  describe('updateActivationStatus', () => {
    it('CONTACTED: set status + contactedAt (sin connectedAt) + ActivityLog DELIVERY_ACTIVATION_CONTACTED', async () => {
      // Fix A2: la guarda de transición lee el status ACTUAL antes de escribir — PENDING→CONTACTED es válida.
      ;(prisma.deliveryActivationRequest.findUnique as jest.Mock).mockResolvedValue({ status: DeliveryActivationStatus.PENDING })
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

    it('CONTACTED→CONNECTED: transición permitida (caso requerido por la auditoría, Fix A2) — set status + connectedAt (sin contactedAt) + ActivityLog DELIVERY_ACTIVATION_CONNECTED', async () => {
      // Fix A2: current status = CONTACTED (no terminal) → CONNECTED está permitido.
      ;(prisma.deliveryActivationRequest.findUnique as jest.Mock).mockResolvedValue({ status: DeliveryActivationStatus.CONTACTED })
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
      // Fix A2: PENDING→DISMISSED es válida (DISMISSED es terminal como DESTINO, no como origen).
      ;(prisma.deliveryActivationRequest.findUnique as jest.Mock).mockResolvedValue({ status: DeliveryActivationStatus.PENDING })
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
    //
    // Fix A2 añadió un pre-chequeo (findUnique) ANTES del update para validar la transición —
    // ahora "id inexistente" se detecta AHÍ (findUnique → null) en vez de esperar al P2025 del
    // update(); el catch de P2025 en update() queda como defensa TOCTOU (fila borrada entre el
    // findUnique y el update). El contrato observable (NotFoundError, sin ActivityLog) no cambia.
    // ============================================================
    it('REGRESIÓN Fix 2: id inexistente → NotFoundError, no el error crudo (ahora detectado por el pre-chequeo de Fix A2)', async () => {
      ;(prisma.deliveryActivationRequest.findUnique as jest.Mock).mockResolvedValue(null)
      const p2025 = Object.assign(new Error('Record to update not found.'), { code: 'P2025' })
      ;(prisma.deliveryActivationRequest.update as jest.Mock).mockRejectedValue(p2025)

      await expect(updateActivationStatus('nonexistent', DeliveryActivationStatus.CONTACTED, 'staff-ops1')).rejects.toThrow(NotFoundError)
      expect(prisma.deliveryActivationRequest.update).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    })

    it('un error de Prisma que NO es P2025 se propaga tal cual (no se enmascara como NotFoundError)', async () => {
      // Fix A2: transición válida (PENDING→CONTACTED) para que el flujo LLEGUE al update() bajo prueba.
      ;(prisma.deliveryActivationRequest.findUnique as jest.Mock).mockResolvedValue({ status: DeliveryActivationStatus.PENDING })
      const dbDown = Object.assign(new Error('connection lost'), { code: 'P1001' })
      ;(prisma.deliveryActivationRequest.update as jest.Mock).mockRejectedValue(dbDown)

      await expect(updateActivationStatus('req1', DeliveryActivationStatus.CONTACTED, 'staff-ops1')).rejects.toThrow('connection lost')
      expect(logAction).not.toHaveBeenCalled()
    })

    // ============================================================
    // Fix A2 (audit, spec §10.2): CONNECTED/DISMISSED son terminales — antes de la auditoría se
    // podía "revertir" una solicitud ya conectada/descartada de vuelta a PENDING/CONTACTED.
    // ============================================================
    it('Fix A2: CONNECTED → PENDING es inválida (estado terminal) → ValidationError, no actualiza, no loguea', async () => {
      ;(prisma.deliveryActivationRequest.findUnique as jest.Mock).mockResolvedValue({ status: DeliveryActivationStatus.CONNECTED })

      await expect(updateActivationStatus('req1', DeliveryActivationStatus.PENDING, 'staff-ops1')).rejects.toThrow(ValidationError)

      expect(prisma.deliveryActivationRequest.update).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    })

    it('Fix A2: DISMISSED → CONTACTED es inválida (estado terminal) → ValidationError, no actualiza, no loguea', async () => {
      ;(prisma.deliveryActivationRequest.findUnique as jest.Mock).mockResolvedValue({ status: DeliveryActivationStatus.DISMISSED })

      await expect(updateActivationStatus('req1', DeliveryActivationStatus.CONTACTED, 'staff-ops1')).rejects.toThrow(ValidationError)

      expect(prisma.deliveryActivationRequest.update).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    })

    it('Fix A2: el mensaje del ValidationError está en español y menciona el estado terminal', async () => {
      ;(prisma.deliveryActivationRequest.findUnique as jest.Mock).mockResolvedValue({ status: DeliveryActivationStatus.CONNECTED })

      await expect(updateActivationStatus('req1', DeliveryActivationStatus.PENDING, 'staff-ops1')).rejects.toThrow(/transición inválida/i)
    })

    it('Fix A2: id inexistente (findUnique → null) → NotFoundError ANTES de intentar validar la transición', async () => {
      ;(prisma.deliveryActivationRequest.findUnique as jest.Mock).mockResolvedValue(null)

      await expect(updateActivationStatus('nonexistent', DeliveryActivationStatus.CONNECTED, 'staff-ops1')).rejects.toThrow(NotFoundError)
      expect(prisma.deliveryActivationRequest.update).not.toHaveBeenCalled()
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
