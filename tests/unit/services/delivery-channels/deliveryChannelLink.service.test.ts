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
import { adapterFor, hasAdapter } from '../../../../src/services/delivery-channels/core/adapterRegistry'
import { ConflictError, NotFoundError, ValidationError } from '../../../../src/errors/AppError'
import { DeliveryChannelStatus, DeliveryProvider, OrderAcceptanceMode, Prisma } from '@prisma/client'
import {
  listChannelLinks,
  createChannelLink,
  updateChannelLink,
  pauseChannelLink,
  snoozeChannelLink,
  cancelarSnooze,
  reanudarSnoozesVencidos,
  SNOOZE_MINUTOS_VALIDOS,
} from '../../../../src/services/delivery-channels/core/deliveryChannelLink.service'

jest.mock('../../../../src/services/delivery-channels/core/adapterRegistry', () => ({
  hasAdapter: jest.fn(() => false),
  adapterFor: jest.fn(),
}))

jest.mock('../../../../src/services/delivery-channels/core/statusDispatcher.service', () => ({
  getAdapter: jest.fn(),
}))

const HEX64 = /^[0-9a-f]{64}$/

/** Horario semanal válido mínimo — todos los días prendidos con un rango sano. */
const HORARIO_OK = {
  monday: { enabled: true, ranges: [{ open: '09:00', close: '22:00' }] },
  tuesday: { enabled: true, ranges: [{ open: '09:00', close: '22:00' }] },
  wednesday: { enabled: true, ranges: [{ open: '09:00', close: '22:00' }] },
  thursday: { enabled: true, ranges: [{ open: '09:00', close: '22:00' }] },
  friday: { enabled: true, ranges: [{ open: '09:00', close: '22:00' }] },
  saturday: { enabled: true, ranges: [{ open: '09:00', close: '22:00' }] },
  sunday: { enabled: false, ranges: [] },
}

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
    // `clearAllMocks` limpia las LLAMADAS pero NO las implementaciones: sin esto, un
    // `mockReturnValue(true)` de un test se filtra a todos los siguientes y los manda por
    // el camino equivocado. El default es 'no hay adaptador directo' (camino legado).
    ;(hasAdapter as jest.Mock).mockReturnValue(false)
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

    // ============================================================
    // Fix 3 (audit, API-CONTRACT): @@unique([provider, externalLocationId]) sin catch →
    // P2002 crudo (500 genérico). Patrón canónico del repo: productWizard.service.ts
    // (catch P2002 → ConflictError 409). persistDeliveryEvent ya cachea P2002 en este dominio.
    // ============================================================
    it('REGRESIÓN Fix 3: (provider, externalLocationId) duplicado (P2002 de Prisma) → ConflictError, no el error crudo', async () => {
      const p2002 = Object.assign(new Error('Unique constraint failed on the fields: (`provider`,`externalLocationId`)'), {
        code: 'P2002',
      })
      ;(prisma.deliveryChannelLink.create as jest.Mock).mockRejectedValue(p2002)

      await expect(
        createChannelLink('venue1', { provider: DeliveryProvider.DELIVERECT, externalLocationId: 'loc1' }, 'staff1'),
      ).rejects.toThrow(ConflictError)
      expect(logAction).not.toHaveBeenCalled()
    })

    it('un error de Prisma que NO es P2002 se propaga tal cual (no se enmascara como ConflictError)', async () => {
      const dbDown = Object.assign(new Error('connection lost'), { code: 'P1001' })
      ;(prisma.deliveryChannelLink.create as jest.Mock).mockRejectedValue(dbDown)

      await expect(createChannelLink('venue1', { provider: DeliveryProvider.DELIVERECT, externalLocationId: 'loc1' })).rejects.toThrow(
        'connection lost',
      )
      expect(logAction).not.toHaveBeenCalled()
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

    // ── `config` es UNA sola columna con VARIAS cosas adentro (2026-08-21) ─────────────
    // El horario de delivery y el markup de precios viven los dos en `config`. El primer
    // intento la REEMPLAZABA entera, así que guardar el horario desde la pantalla nueva
    // borraba el markup — y el markup es lo único que evita perder dinero en cada pedido,
    // porque Uber se queda ~30%. Nadie se habría enterado: no falla, sólo deja de cobrar
    // de más. Por eso se MEZCLA, y por eso este test existe.
    it('guardar SÓLO deliveryHours NO borra el markup ni las demás llaves de config', async () => {
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
        config: { note: 'alta manual', precios: { markupPercent: 30 } },
      })
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)

      await updateChannelLink('venue1', 'link1', { config: { deliveryHours: HORARIO_OK } }, 'staff1')

      const escrito = (prisma.deliveryChannelLink.updateMany as jest.Mock).mock.calls[0][0].data.config
      expect(escrito.precios).toEqual({ markupPercent: 30 })
      expect(escrito.note).toBe('alta manual')
      expect(escrito.deliveryHours).toEqual(HORARIO_OK)
    })

    it('config: null SÍ limpia todo (es la forma explícita de borrar, no un accidente)', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)

      await updateChannelLink('venue1', 'link1', { config: null }, 'staff1')

      expect(prisma.deliveryChannelLink.findFirst).not.toHaveBeenCalled()
      const escrito = (prisma.deliveryChannelLink.updateMany as jest.Mock).mock.calls[0][0].data.config
      expect(escrito).toBe(Prisma.JsonNull)
    })

    // ── Un horario inválido guardado en silencio es PEOR que rechazarlo ────────────────
    // `esHorarioValido` ya rechaza la basura al PUBLICAR, pero cae al horario estimado sin
    // decir nada. El comercio ve su horario guardado en la pantalla y Uber recibe otro.
    // Se rechaza en la escritura para que el error salga donde el humano puede corregirlo.
    it('rechaza un deliveryHours con forma inválida en vez de guardarlo', async () => {
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({ config: {} })

      await expect(
        updateChannelLink('venue1', 'link1', { config: { deliveryHours: { monday: { enabled: true, ranges: [] } } } }),
      ).rejects.toThrow(ValidationError)

      expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
    })

    it('rechaza una hora imposible (25:00) — el regex sola la dejaba pasar', async () => {
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({ config: {} })
      const roto = { ...HORARIO_OK, monday: { enabled: true, ranges: [{ open: '25:00', close: '30:00' }] } }

      await expect(updateChannelLink('venue1', 'link1', { config: { deliveryHours: roto } })).rejects.toThrow(ValidationError)

      expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
    })

    it('rechaza un markup absurdo (-10% o 500%) en vez de publicarlo a Uber', async () => {
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({ config: {} })

      await expect(updateChannelLink('venue1', 'link1', { config: { precios: { markupPercent: -10 } } })).rejects.toThrow(ValidationError)
      await expect(updateChannelLink('venue1', 'link1', { config: { precios: { markupPercent: 500 } } })).rejects.toThrow(ValidationError)

      expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
    })

    it('rechaza un override de precio negativo (regalaría el producto)', async () => {
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({ config: {} })

      await expect(updateChannelLink('venue1', 'link1', { config: { precios: { overrides: { 'sku-1': -5 } } } })).rejects.toThrow(
        ValidationError,
      )

      expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
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
    // ── Un botón que MIENTE (hallado el 2026-08-21) ───────────────────────────────────
    it('🔴 PAUSAR de verdad le avisa al proveedor DIRECTO, no sólo a nuestra base', async () => {
      // El bug: `pauseChannelLink` resolvía el adaptador con el registro VIEJO
      // (`statusDispatcher`), que sólo tiene Deliverect. Para Uber lanzaba, el try/catch se
      // lo tragaba, y el status local igual pasaba a PAUSED.
      //
      // O sea: el dueño apretaba "Pausar" con la cocina ahogada, el dashboard le decía
      // PAUSADO, y Uber le seguía mandando pedidos. Un botón que miente es peor que un botón
      // que no existe — con el que no existe, al menos busca otra salida.
      const setStoreStatus = jest.fn().mockResolvedValue({ ok: true, status: 200, raw: '' })
      ;(hasAdapter as jest.Mock).mockReturnValue(true)
      ;(adapterFor as jest.Mock).mockReturnValue({ setStoreStatus })
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({
        ...baseLink,
        provider: 'UBER_EATS',
        externalLocationId: 'store-x',
      })

      await pauseChannelLink('venue1', 'link1', true, 'staff1')

      expect(setStoreStatus).toHaveBeenCalledWith(true, 'store-x', expect.any(String))
      expect(getAdapter).not.toHaveBeenCalled() // ya no pasa por el registro viejo
    })

    it('reanudar también le llega al proveedor', async () => {
      const setStoreStatus = jest.fn().mockResolvedValue({ ok: true, status: 200, raw: '' })
      ;(hasAdapter as jest.Mock).mockReturnValue(true)
      ;(adapterFor as jest.Mock).mockReturnValue({ setStoreStatus })
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({
        ...baseLink,
        provider: 'UBER_EATS',
        externalLocationId: 'store-x',
      })

      await pauseChannelLink('venue1', 'link1', false)

      // Sin motivo al reanudar: el motivo describe POR QUÉ se pausó y no aplica al revés.
      expect(setStoreStatus).toHaveBeenCalledWith(false, 'store-x', undefined)
    })

    it('🔴 si el proveedor RECHAZA la pausa, NO decimos que está pausado', async () => {
      // Es la mitad que faltaba: avisarle a Uber no sirve si igual pintamos PAUSADO cuando
      // él dijo que no. El dueño tiene que enterarse para poder hacer otra cosa —apagar el
      // menú, llamar a soporte— en vez de creerse protegido mientras entran pedidos.
      ;(hasAdapter as jest.Mock).mockReturnValue(true)
      ;(adapterFor as jest.Mock).mockReturnValue({ setStoreStatus: jest.fn().mockResolvedValue({ ok: false, status: 500, raw: 'boom' }) })
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({
        ...baseLink,
        provider: 'UBER_EATS',
        externalLocationId: 'store-x',
      })

      await expect(pauseChannelLink('venue1', 'link1', true)).rejects.toThrow(/no se pudo pausar/i)
    })

    it('actualiza status usando SIEMPRE where: { id, venueId } (tenant isolation)', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)
      ;(getAdapter as jest.Mock).mockReturnValue({ setChannelPaused: jest.fn().mockResolvedValue(undefined) })

      await pauseChannelLink('venue1', 'link1', true, 'staff1')

      expect(prisma.deliveryChannelLink.updateMany).toHaveBeenCalledWith({
        where: { id: 'link1', venueId: 'venue1' },
        // `objectContaining` sólo en `data`: desde el snooze, pausar escribe también
        // `snoozedUntil: null`. El `where` se queda EXACTO — es lo que este test cuida.
        data: expect.objectContaining({ status: DeliveryChannelStatus.PAUSED }),
      })
    })

    it('paused=false actualiza status a ACTIVE — Fix B4: el where del updateMany ahora exige status:PAUSED (gate atómico, no check-then-update)', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)
      ;(getAdapter as jest.Mock).mockReturnValue({ setChannelPaused: jest.fn().mockResolvedValue(undefined) })

      await pauseChannelLink('venue1', 'link1', false)

      expect(prisma.deliveryChannelLink.updateMany).toHaveBeenCalledWith({
        where: { id: 'link1', venueId: 'venue1', status: DeliveryChannelStatus.PAUSED },
        data: expect.objectContaining({ status: DeliveryChannelStatus.ACTIVE }),
      })
    })

    // ============================================================
    // Fix B4 (spec §10.2): un-pausar solo permitido desde PAUSED — un link
    // PENDING (nunca confirmado por el proveedor) o DISABLED saltando directo
    // a ACTIVE se brinca el lifecycle de confirmación del proveedor.
    // ============================================================
    it('Fix B4: un-pausar (false) un canal PENDING lanza ValidationError, NO lo activa', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({ ...baseLink, status: DeliveryChannelStatus.PENDING })

      await expect(pauseChannelLink('venue1', 'link1', false)).rejects.toThrow(ValidationError)

      expect(prisma.deliveryChannelLink.findFirst).toHaveBeenCalledWith({
        where: { id: 'link1', venueId: 'venue1' },
        select: { status: true },
      })
      expect(getAdapter).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    })

    it('Fix B4: un-pausar (false) un canal DISABLED lanza ValidationError, NO lo activa', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({ ...baseLink, status: DeliveryChannelStatus.DISABLED })

      await expect(pauseChannelLink('venue1', 'link1', false)).rejects.toThrow(ValidationError)

      expect(getAdapter).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    })

    it('REGRESIÓN Fix B4: pausar (paused:true) sigue SIN gate — permitido desde CUALQUIER estado (PENDING incluido), where sin filtro de status', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({ ...baseLink, status: DeliveryChannelStatus.PAUSED })
      ;(getAdapter as jest.Mock).mockReturnValue({ setChannelPaused: jest.fn().mockResolvedValue(undefined) })

      await pauseChannelLink('venue1', 'link1', true)

      expect(prisma.deliveryChannelLink.updateMany).toHaveBeenCalledWith({
        where: { id: 'link1', venueId: 'venue1' },
        // `objectContaining` sólo en `data`: desde el snooze, pausar escribe también
        // `snoozedUntil: null`. El `where` se queda EXACTO — es lo que este test cuida.
        data: expect.objectContaining({ status: DeliveryChannelStatus.PAUSED }),
      })
      expect(prisma.deliveryChannelLink.findFirst).not.toHaveBeenCalled()
    })

    it('REGRESIÓN tenant isolation: link de OTRO venue → NotFoundError (no pausa, no llama adapter)', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

      await expect(pauseChannelLink('venue-otro', 'link1', true)).rejects.toThrow(NotFoundError)

      expect(getAdapter).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    })

    it('REGRESIÓN tenant isolation (Fix B4, un-pause): link de OTRO venue → NotFoundError, nunca ValidationError (el fallback findFirst también filtra por venueId)', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue(null) // otro venue → no matchea

      await expect(pauseChannelLink('venue-otro', 'link1', false)).rejects.toThrow(NotFoundError)

      expect(prisma.deliveryChannelLink.findFirst).toHaveBeenCalledWith({
        where: { id: 'link1', venueId: 'venue-otro' },
        select: { status: true },
      })
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

  // ============================================================
  // snoozeChannelLink — "me saturé" desde el POS, con reloj
  // ============================================================
  describe('snoozeChannelLink', () => {
    beforeEach(() => {
      ;(hasAdapter as jest.Mock).mockReturnValue(false)
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({ ...baseLink, status: DeliveryChannelStatus.PAUSED })
    })

    // ── El punto entero de la feature ──────────────────────────────────────────────
    // Un apagador SIN reloj en manos de quien está cocinando se queda prendido: se pausa
    // a las 8pm en plena cena, nadie se acuerda, y el negocio pasa la noche apagado en el
    // marketplace. Es el hilo "POS ordering - pause stuck" de la comunidad de Square.
    it('🔴 deja una fecha de reanudación — la pausa del POS CADUCA sola', async () => {
      await snoozeChannelLink('venue1', 'link1', 20, 'staff1')

      const escrituras = (prisma.deliveryChannelLink.updateMany as jest.Mock).mock.calls.map(c => c[0].data)
      const conSnooze = escrituras.find(d => d.snoozedUntil instanceof Date)
      expect(conSnooze).toBeDefined()

      const faltan = (conSnooze!.snoozedUntil.getTime() - Date.now()) / 60000
      expect(faltan).toBeGreaterThan(19)
      expect(faltan).toBeLessThan(21)
    })

    it('pausa de verdad: pasa por pauseChannelLink, que es quien le avisa al proveedor', async () => {
      await snoozeChannelLink('venue1', 'link1', 20, 'staff1')

      const estados = (prisma.deliveryChannelLink.updateMany as jest.Mock).mock.calls.map(c => c[0].data.status)
      expect(estados).toContain(DeliveryChannelStatus.PAUSED)
    })

    it('rechaza una duración fuera del catálogo — nada de pausas de 8 horas desde la cocina', async () => {
      await expect(snoozeChannelLink('venue1', 'link1', 480)).rejects.toThrow(ValidationError)
      await expect(snoozeChannelLink('venue1', 'link1', 0)).rejects.toThrow(ValidationError)
      await expect(snoozeChannelLink('venue1', 'link1', 21)).rejects.toThrow(ValidationError)
      expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
    })

    it('el catálogo de duraciones es cerrado y tiene tope', () => {
      expect(SNOOZE_MINUTOS_VALIDOS).toEqual([20, 40, 60, 120])
      expect(Math.max(...SNOOZE_MINUTOS_VALIDOS)).toBeLessThanOrEqual(120)
    })

    it('escribe ActivityLog con los minutos — quién frenó el reparto y por cuánto', async () => {
      await snoozeChannelLink('venue1', 'link1', 40, 'staff1')

      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DELIVERY_CHANNEL_SNOOZED',
          entityId: 'link1',
          staffId: 'staff1',
          venueId: 'venue1',
          data: expect.objectContaining({ minutos: 40 }),
        }),
      )
    })
  })

  // ============================================================
  // La pausa del DASHBOARD es indefinida — y no se confunde con la del POS
  // ============================================================
  describe('pauseChannelLink y el reloj del snooze', () => {
    it('🔴 pausar desde el dashboard LIMPIA el reloj: esa pausa NO se reactiva sola', async () => {
      // Si no se limpiara, un snooze anterior reanudaría la tienda que el dueño acaba de
      // apagar a propósito — el peor error posible en esta feature.
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({ ...baseLink, status: DeliveryChannelStatus.PAUSED })

      await pauseChannelLink('venue1', 'link1', true, 'staff1')

      expect(prisma.deliveryChannelLink.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ snoozedUntil: null }) }),
      )
    })

    it('reanudar también limpia el reloj', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({ ...baseLink, status: DeliveryChannelStatus.ACTIVE })

      await pauseChannelLink('venue1', 'link1', false, 'staff1')

      expect(prisma.deliveryChannelLink.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ snoozedUntil: null }) }),
      )
    })
  })

  // ============================================================
  // reanudarSnoozesVencidos — el que hace que el reloj SIRVA
  // ============================================================
  describe('reanudarSnoozesVencidos', () => {
    it('sólo toca canales PAUSADOS cuyo reloj ya venció', async () => {
      ;(prisma.deliveryChannelLink.findMany as jest.Mock).mockResolvedValue([])

      await reanudarSnoozesVencidos()

      const where = (prisma.deliveryChannelLink.findMany as jest.Mock).mock.calls[0][0].where
      expect(where.status).toBe(DeliveryChannelStatus.PAUSED)
      expect(where.snoozedUntil.lte).toBeInstanceOf(Date)
    })

    it('🔴 si un canal falla al reanudar, los DEMÁS igual se reanudan', async () => {
      // Sin aislar, un venue con el proveedor caído dejaría a todos los demás negocios
      // apagados. El trabajo por lote no puede rendirse en el primer error.
      ;(prisma.deliveryChannelLink.findMany as jest.Mock).mockResolvedValue([
        { id: 'l1', venueId: 'v1', provider: DeliveryProvider.UBER_EATS },
        { id: 'l2', venueId: 'v2', provider: DeliveryProvider.UBER_EATS },
      ])
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock)
        .mockRejectedValueOnce(new Error('el proveedor no responde'))
        .mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({ ...baseLink, status: DeliveryChannelStatus.ACTIVE })

      const r = await reanudarSnoozesVencidos()

      expect(r.reanudados).toBe(1)
      expect(r.fallidos).toBe(1)
    })
  })

  // ============================================================
  // cancelarSnooze — reanudar antes de tiempo, SIN pisar al dueño
  // ============================================================
  describe('cancelarSnooze', () => {
    it('si la cocina se puso al día, reanuda antes de que venza el reloj', async () => {
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({ snoozedUntil: new Date(Date.now() + 600_000) })
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({ ...baseLink, status: DeliveryChannelStatus.ACTIVE })

      await cancelarSnooze('venue1', 'link1', 'staff1')

      const estados = (prisma.deliveryChannelLink.updateMany as jest.Mock).mock.calls.map(c => c[0].data.status)
      expect(estados).toContain(DeliveryChannelStatus.ACTIVE)
    })

    // ── La asimetría que hace segura la feature ────────────────────────────────────
    // El permiso del POS es angosto a propósito. Si desde ahí se pudiera deshacer la
    // pausa INDEFINIDA, un cocinero reabriría la tienda que el dueño cerró — por avería,
    // por falta de personal, por lo que sea. Poder frenar no puede implicar poder abrir.
    it('🔴 NO puede reabrir una pausa indefinida (la del dashboard, sin reloj)', async () => {
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({ snoozedUntil: null })

      await expect(cancelarSnooze('venue1', 'link1', 'staff1')).rejects.toThrow(ValidationError)
      expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
    })

    it('canal de otro venue → NotFoundError, sin filtrar nada', async () => {
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue(null)

      await expect(cancelarSnooze('venue-otro', 'link1')).rejects.toThrow(NotFoundError)
      expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
    })
  })
})
