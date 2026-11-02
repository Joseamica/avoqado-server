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
import { rappiAdapter } from '../../../../src/services/delivery-channels/providers/rappi/rappi.adapter'
import { ConflictError, NotFoundError, ValidationError } from '../../../../src/errors/AppError'
import { DeliveryChannelStatus, DeliveryProvider, OrderAcceptanceMode, Prisma } from '@prisma/client'
import {
  listChannelLinks,
  listChannelsResumen,
  createChannelLink,
  updateChannelLink,
  pauseChannelLink,
  snoozeChannelLink,
  cancelarSnooze,
  reanudarSnoozesVencidos,
  SNOOZE_MINUTOS_VALIDOS,
} from '../../../../src/services/delivery-channels/core/deliveryChannelLink.service'
import { PLAZO_SIN_VEREDICTO_MS, revisionDeMenuOf } from '../../../../src/services/delivery-channels/core/menuSync.service'

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
    ;(getAdapter as jest.Mock).mockReset().mockReturnValue({ setChannelPaused: jest.fn().mockResolvedValue(undefined) })
    // Pausar lee primero el estado COMPLETO previo (status + reloj) al que revertiría.
    ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
      provider: DeliveryProvider.DELIVERECT,
      status: DeliveryChannelStatus.ACTIVE,
      snoozedUntil: null,
    })
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

    // ── Tarea 21 (Rappi fase 2): el estado de la revisión del menú, a la vista en el listado ──────────────────────
    // El dueño tiene que poder ver «mi menú está en revisión desde…», «Rappi lo rechazó el…» y los motivos, sin abrir el
    // log ni la base. Sale de `config`, que el listado YA trae: ni una consulta más por canal.
    describe('menuRevision (Tarea 21)', () => {
      const AHORA_MS = Date.parse('2026-10-22T12:00:00.000Z')
      const hace = (ms: number) => new Date(AHORA_MS - ms).toISOString()
      let relojSpy: jest.SpyInstance

      beforeEach(() => {
        relojSpy = jest.spyOn(Date, 'now').mockReturnValue(AHORA_MS)
      })
      afterEach(() => {
        relojSpy.mockRestore()
      })

      const vinculo = (config: unknown, id = 'link1') => ({
        id,
        venueId: 'venue1',
        provider: DeliveryProvider.DELIVERECT,
        status: DeliveryChannelStatus.ACTIVE,
        autoSyncMenu: true,
        lastMenuHash: null,
        config,
      })
      const forma = (canal: unknown) => (canal as { menuRevision: unknown }).menuRevision

      it('🔴 el listado trae menuRevision con la pendiente, el último rechazo y los problemas', async () => {
        const publicadaEn = hace(60 * 60 * 1000)
        ;(prisma.deliveryChannelLink.findMany as jest.Mock).mockResolvedValue([
          vinculo({
            menuEnRevision: { huella: 'huella-pendiente-secreta', publicadaEn },
            menuRechazado: { huella: 'huella-rechazada-secreta', en: '2026-10-21T09:30:00.000Z' },
            menuProblemas: {
              en: '2026-10-22T10:55:00.000Z',
              problemas: [
                { sku: 'SKU-1', problema: 'Cuesta $0 y no tiene modificadores: Rappi lo rechaza.' },
                { sku: '(menú)', problema: 'Rappi rechazó: precio inválido' },
              ],
            },
          }),
        ])

        const [canal] = await listChannelLinks('venue1')

        expect(forma(canal)).toEqual({
          enRevisionDesde: publicadaEn,
          sinVeredicto: false,
          ultimoRechazoEn: '2026-10-21T09:30:00.000Z',
          problemas: [
            { sku: 'SKU-1', problema: 'Cuesta $0 y no tiene modificadores: Rappi lo rechaza.' },
            { sku: '(menú)', problema: 'Rappi rechazó: precio inválido' },
          ],
        })
        // Las huellas son del sincronizador: ni en `menuRevision` ni por el camino de la pendiente.
        expect(JSON.stringify(forma(canal))).not.toContain('secreta')
      })

      it('🔴 sin datos ⇒ menuRevision con nulos y lista vacía (config nulo, vacío o sin esas llaves)', async () => {
        ;(prisma.deliveryChannelLink.findMany as jest.Mock).mockResolvedValue([
          vinculo(null, 'a'),
          vinculo({}, 'b'),
          vinculo({ precios: { markupPercent: 30 } }, 'c'),
        ])

        const canales = await listChannelLinks('venue1')

        expect(canales).toHaveLength(3)
        for (const canal of canales) {
          expect(forma(canal)).toEqual({ enRevisionDesde: null, sinVeredicto: false, ultimoRechazoEn: null, problemas: [] })
        }
      })

      it('un canal sin la columna `config` en la fila (un select viejo) también sale con la forma vacía', async () => {
        ;(prisma.deliveryChannelLink.findMany as jest.Mock).mockResolvedValue([
          { id: 'link1', venueId: 'venue1', provider: DeliveryProvider.DELIVERECT, status: DeliveryChannelStatus.ACTIVE },
        ])

        const [canal] = await listChannelLinks('venue1')

        expect(forma(canal)).toEqual({ enRevisionDesde: null, sinVeredicto: false, ultimoRechazoEn: null, problemas: [] })
      })

      it('🔴 NO añade consultas por canal: una sola lectura, y `config` ya viaja en el select', async () => {
        ;(prisma.deliveryChannelLink.findMany as jest.Mock).mockResolvedValue([
          vinculo({ menuEnRevision: { huella: 'h', publicadaEn: hace(1000) } }, 'a'),
          vinculo({ menuRechazado: { huella: 'h', en: hace(1000) } }, 'b'),
          vinculo(null, 'c'),
        ])

        await listChannelLinks('venue1')

        expect(prisma.deliveryChannelLink.findMany).toHaveBeenCalledTimes(1)
        expect((prisma.deliveryChannelLink.findMany as jest.Mock).mock.calls[0][0].select.config).toBe(true)
        expect(prisma.deliveryChannelLink.findFirst).not.toHaveBeenCalled()
        expect(prisma.deliveryChannelLink.findUnique).not.toHaveBeenCalled()
      })

      it('lo que ya devolvía el listado sigue igual: menuSyncStatus, la huella oculta y el config tal cual', async () => {
        ;(prisma.deliveryChannelLink.findMany as jest.Mock).mockResolvedValue([
          { ...vinculo({ precios: { markupPercent: 30 } }), lastMenuHash: 'abc' },
        ])

        const [canal] = await listChannelLinks('venue1')

        expect(canal).toMatchObject({ menuSyncStatus: 'AL_DIA', config: { precios: { markupPercent: 30 } } })
        expect((canal as unknown as { lastMenuHash?: string }).lastMenuHash).toBeUndefined()
      })

      describe('revisionDeMenuOf es TOTAL: cualquier config (basura o heredado) devuelve la forma vacía y nunca lanza', () => {
        const VACIA = { enRevisionDesde: null, sinVeredicto: false, ultimoRechazoEn: null, problemas: [] }
        const BASURA: Array<[string, unknown]> = [
          ['null', null],
          ['undefined', undefined],
          ['un texto', 'menuEnRevision'],
          ['un número', 42],
          ['un booleano', true],
          ['una lista vacía', []],
          ['una lista de objetos', [{ menuEnRevision: { huella: 'h', publicadaEn: 'x' } }]],
          ['un objeto vacío', {}],
          ['pendiente que es un texto', { menuEnRevision: 'x' }],
          ['pendiente sin huella', { menuEnRevision: { publicadaEn: '2026-10-22T10:00:00.000Z' } }],
          ['pendiente con la hora numérica', { menuEnRevision: { huella: 'h', publicadaEn: 1760000000000 } }],
          ['rechazo que es una lista', { menuRechazado: [] }],
          ['rechazo sin huella', { menuRechazado: { en: '2026-10-22T10:00:00.000Z' } }],
          ['problemas que son un texto', { menuProblemas: 'mal' }],
          ['problemas sin lista', { menuProblemas: { en: 'x', problemas: 'mal' } }],
          [
            'problemas con puras entradas rotas',
            { menuProblemas: { en: 'x', problemas: [null, 7, 'x', [], { sku: 1 }, { problema: 'sin sku' }] } },
          ],
        ]

        it.each(BASURA)('config = %s', (_nombre, config) => {
          expect(() => revisionDeMenuOf(config)).not.toThrow()
          expect(revisionDeMenuOf(config)).toEqual(VACIA)
        })

        it.each([
          ['`en` ausente', { huella: 'h' }],
          ['`en` numérico', { huella: 'h', en: 1760000000000 }],
          ['`en` nulo', { huella: 'h', en: null }],
          ['`en` que es un objeto', { huella: 'h', en: { dia: 1 } }],
        ])(
          "🔴 un rechazo con huella y %s ⇒ ultimoRechazoEn: '' (hay rechazo vigente, sin hora legible; nunca null ni la hora rota)",
          (_nombre, menuRechazado) => {
            const r = revisionDeMenuOf({ menuRechazado })
            expect(r.ultimoRechazoEn).toBe('')
            expect(r).toEqual({ ...VACIA, ultimoRechazoEn: '' })
          },
        )

        it("un rechazo con `en: 'xyz'` sale tal cual: ultimoRechazoEn: 'xyz' (no se valida que sea una fecha)", () => {
          expect(revisionDeMenuOf({ menuRechazado: { huella: 'h', en: 'xyz' } }).ultimoRechazoEn).toBe('xyz')
        })

        it('una entrada sana entre basura se queda; y sólo salen `sku` y `problema` (nada más de lo guardado)', () => {
          const r = revisionDeMenuOf({
            menuProblemas: {
              en: 'x',
              problemas: [
                null,
                { sku: 'A', problema: 'p', interno: 'no-sale', huella: 'no-sale' },
                { sku: 2 },
                { sku: 'B', problema: 'q' },
              ],
            },
          })
          expect(r.problemas).toEqual([
            { sku: 'A', problema: 'p' },
            { sku: 'B', problema: 'q' },
          ])
        })
      })

      describe('sinVeredicto: la pendiente pasó el plazo (se calcula con la hora, no con el sello del job)', () => {
        const conPendiente = (publicadaEn: unknown, extra: Record<string, unknown> = {}) => ({
          menuEnRevision: { huella: 'h', publicadaEn, ...extra },
        })

        it('🔴 una pendiente más vieja que el plazo ⇒ sinVeredicto: true, aunque el job todavía no la haya sellado', () => {
          const publicadaEn = hace(PLAZO_SIN_VEREDICTO_MS + 60_000)
          expect(revisionDeMenuOf(conPendiente(publicadaEn))).toMatchObject({ enRevisionDesde: publicadaEn, sinVeredicto: true })
        })

        it('una pendiente dentro del plazo ⇒ sinVeredicto: false', () => {
          const publicadaEn = hace(PLAZO_SIN_VEREDICTO_MS - 60_000)
          expect(revisionDeMenuOf(conPendiente(publicadaEn))).toMatchObject({ enRevisionDesde: publicadaEn, sinVeredicto: false })
        })

        it('justo en el límite del plazo todavía NO es vencida (la misma regla de menuSync: sólo si lo EXCEDE)', () => {
          expect(revisionDeMenuOf(conPendiente(hace(PLAZO_SIN_VEREDICTO_MS))).sinVeredicto).toBe(false)
          expect(revisionDeMenuOf(conPendiente(hace(PLAZO_SIN_VEREDICTO_MS + 1))).sinVeredicto).toBe(true)
        })

        it('🔴 una hora ilegible cuenta como sin veredicto (igual que menuSync), y la pendiente SIGUE a la vista', () => {
          const r = revisionDeMenuOf(conPendiente('no-es-una-fecha'))
          expect(r.sinVeredicto).toBe(true)
          expect(r.enRevisionDesde).toBe('no-es-una-fecha') // null querría decir «no hay pendiente»
        })

        it('con el aviso del job ya sellado sigue siendo sinVeredicto, y el sello no cambia lo que sale', () => {
          const publicadaEn = hace(PLAZO_SIN_VEREDICTO_MS + 3_600_000)
          const r = revisionDeMenuOf(conPendiente(publicadaEn, { sinVeredictoAvisadoEn: hace(60_000) }))
          expect(r).toEqual({ enRevisionDesde: publicadaEn, sinVeredicto: true, ultimoRechazoEn: null, problemas: [] })
        })

        it('sin pendiente nunca hay «sin veredicto», aunque haya un rechazo viejo', () => {
          const r = revisionDeMenuOf({ menuRechazado: { huella: 'h', en: hace(10 * PLAZO_SIN_VEREDICTO_MS) } })
          expect(r).toMatchObject({ enRevisionDesde: null, sinVeredicto: false, ultimoRechazoEn: hace(10 * PLAZO_SIN_VEREDICTO_MS) })
        })
      })
    })
  })

  // ============================================================
  // createChannelLink
  // ============================================================
  describe('createChannelLink', () => {
    // N3: la reclamación del self-onboarding de Rappi la escriben SÓLO el aprovisionamiento y su confirmación.
    // Creada por POST (p. ej. con `statusPrevio: ACTIVE` y una intención inventada), una activación posterior la
    // adoptaba y un rechazo de Rappi restauraba ACTIVE sin suscripciones.
    it('🔴 un POST no puede sembrar rappiProvisioning: se descarta y el resto de config se guarda', async () => {
      ;(prisma.deliveryChannelLink.create as jest.Mock).mockResolvedValue({ id: 'newlink1' })

      await createChannelLink('venue1', {
        provider: DeliveryProvider.RAPPI,
        externalLocationId: 'loc1',
        config: { note: 'alta', rappiProvisioning: { intentId: 'inventada', statusPrevio: 'ACTIVE' } },
      })

      expect((prisma.deliveryChannelLink.create as jest.Mock).mock.calls[0][0].data.config).toEqual({ note: 'alta' })
    })

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
      ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([{ config: { note: 'alta manual', precios: { markupPercent: 30 } } }])
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)

      await updateChannelLink('venue1', 'link1', { config: { deliveryHours: HORARIO_OK } }, 'staff1')

      const escrito = (prisma.deliveryChannelLink.updateMany as jest.Mock).mock.calls[0][0].data.config
      expect(escrito.precios).toEqual({ markupPercent: 30 })
      expect(escrito.note).toBe('alta manual')
      expect(escrito.deliveryHours).toEqual(HORARIO_OK)
    })

    it('config: null SÍ limpia todo (es la forma explícita de borrar, no un accidente)', async () => {
      ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([{ config: { note: 'alta manual', precios: { markupPercent: 30 } } }])
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)

      await updateChannelLink('venue1', 'link1', { config: null }, 'staff1')

      const escrito = (prisma.deliveryChannelLink.updateMany as jest.Mock).mock.calls[0][0].data.config
      expect(escrito).toBe(Prisma.JsonNull)
    })

    // ── La fila se BLOQUEA antes de leer su config ─────────────────────────────────────
    // Una transacción sola no basta: en READ COMMITTED el PATCH leía `config`, el job de disponibilidad
    // guardaba entre medio su lista de agotados, y el PATCH escribía su copia vieja encima. El producto
    // se quedaba "agotado" en Uber aunque volviera a haber, y ninguna pasada lo revivía (ya no estaba en
    // la lista). Lo mismo con dos admins guardando horario y precios a la vez.
    // H2 (Rappi): un PATCH que leyó `config` antes de que el aprovisionamiento guardara su lote escribía
    // después su copia vieja: el `batchId` desaparecía y la tienda ya no se podía confirmar.
    it('lee config con la fila BLOQUEADA (FOR UPDATE) y filtrada por venue, dentro de la transacción', async () => {
      ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([{ config: {} }])
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)

      await updateChannelLink('venue1', 'link1', { config: { deliveryHours: HORARIO_OK } }, 'staff1')

      const [strings, ...valores] = (prisma.$queryRaw as jest.Mock).mock.calls[0]
      expect(strings.join('?')).toMatch(/FOR UPDATE/)
      expect(valores).toEqual(['link1', 'venue1'])
      expect(prisma.deliveryChannelLink.findFirst).not.toHaveBeenCalled()
    })

    // ── H1: `rappiProvisioning` es INTERNA — dice a qué intención y lote pertenece el vínculo ──────────
    // Editable, un administrador de A la apuntaba a la intención de B y el webhook escribía en la de B.
    describe('🔴 rappiProvisioning no se toca desde un PATCH', () => {
      const reclamacion = { intentId: 'i1', since: 'x', batchId: 'b1' }
      beforeEach(() => {
        ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([{ config: { note: 'vieja', rappiProvisioning: reclamacion } }])
        ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
        ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)
      })
      const escrito = () => (prisma.deliveryChannelLink.updateMany as jest.Mock).mock.calls[0][0].data.config

      it('mandar otra rappiProvisioning se ignora: queda la de la base, y el resto se mezcla', async () => {
        await updateChannelLink('venue1', 'link1', { config: { note: 'nueva', rappiProvisioning: { intentId: 'de-otro-negocio' } } })
        expect(escrito()).toEqual({ note: 'nueva', rappiProvisioning: reclamacion })
      })

      it('config: null limpia todo MENOS la reclamación', async () => {
        await updateChannelLink('venue1', 'link1', { config: null })
        expect(escrito()).toEqual({ rappiProvisioning: reclamacion })
      })

      it('sin reclamación en la base, un PATCH tampoco puede crear una', async () => {
        ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([{ config: { note: 'vieja' } }])
        await updateChannelLink('venue1', 'link1', { config: { rappiProvisioning: { intentId: 'i-inventada' } } })
        expect(escrito()).toEqual({ note: 'vieja' })
      })
    })

    // ── Tarea 15: el estado del menú en revisión lo escriben SÓLO el sincronizador y el veredicto ─────────
    // Borrado desde el panel, el sincronizador republicaba un menú que el proveedor todavía revisaba (o uno que ya
    // rechazó, cada 5 min); sembrado, un administrador bloqueaba la publicación de su menú para siempre.
    describe('🔴 las llaves del sistema (menú en revisión, rechazo, problemas, horario) no se tocan desde el panel', () => {
      const sistema = {
        rappiProvisioning: { intentId: 'i1', since: 'x', batchId: 'b1' },
        menuEnRevision: { huella: 'h1', publicadaEn: '2026-10-22T10:00:00.000Z' },
        menuRechazado: { huella: 'h0', en: '2026-10-22T09:00:00.000Z' },
        menuProblemas: { en: '2026-10-22T10:00:00.000Z', problemas: [{ sku: 'A', problema: 'p' }] },
        horarioPublicado: { huella: 'hh', en: '2026-10-22T08:00:00.000Z' },
      }
      beforeEach(() => {
        ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([{ config: { note: 'vieja', ...sistema } }])
        ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
        ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)
      })
      const escrito = () => (prisma.deliveryChannelLink.updateMany as jest.Mock).mock.calls[0][0].data.config

      it('🔴 config: null del panel no borra el menú en revisión ni el rechazado', async () => {
        await updateChannelLink('venue1', 'link1', { config: null })
        expect(escrito()).toEqual(sistema)
      })

      it('mandarlas (en null o con otro valor) se ignora: quedan las de la base, y el resto se mezcla', async () => {
        await updateChannelLink('venue1', 'link1', {
          config: { note: 'nueva', menuEnRevision: null, menuRechazado: { huella: 'x' }, menuProblemas: null, horarioPublicado: null },
        })
        expect(escrito()).toEqual({ note: 'nueva', ...sistema })
      })

      it('sin ellas en la base, un PATCH tampoco puede sembrarlas', async () => {
        ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([{ config: { note: 'vieja' } }])
        await updateChannelLink('venue1', 'link1', {
          config: { menuEnRevision: { huella: 'inventada', publicadaEn: '2099-01-01T00:00:00.000Z' }, menuRechazado: { huella: 'h' } },
        })
        expect(escrito()).toEqual({ note: 'vieja' })
      })

      it('un POST tampoco las siembra', async () => {
        ;(prisma.deliveryChannelLink.create as jest.Mock).mockResolvedValue({ id: 'newlink1' })
        await createChannelLink('venue1', {
          provider: DeliveryProvider.RAPPI,
          externalLocationId: 'loc1',
          config: { note: 'alta', menuEnRevision: { huella: 'inventada' }, horarioPublicado: { huella: 'x' } },
        })
        expect((prisma.deliveryChannelLink.create as jest.Mock).mock.calls[0][0].data.config).toEqual({ note: 'alta' })
      })
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
    // RAPPI ya no está aquí: tiene adaptador desde la fase 2 y su pausa va al proveedor (ver el bloque «Rappi» al final).
    it.each([DeliveryProvider.DIDI_FOOD])('sin adaptador %s rechaza pausa, reanudación y snooze ANTES de escribir', async provider => {
      ;(hasAdapter as jest.Mock).mockReturnValue(false)
      ;(getAdapter as jest.Mock).mockImplementation(() => {
        throw new Error('No adapter')
      })
      for (const paused of [true, false]) {
        ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
          provider,
          status: paused ? DeliveryChannelStatus.ACTIVE : DeliveryChannelStatus.PAUSED,
          snoozedUntil: null,
        })
        ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
        ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({ ...baseLink, provider })
        await expect(pauseChannelLink('venue1', 'link1', paused)).rejects.toMatchObject({ statusCode: 409 })
      }
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
        provider,
        status: DeliveryChannelStatus.ACTIVE,
        snoozedUntil: null,
      })
      await expect(snoozeChannelLink('venue1', 'link1', 20)).rejects.toMatchObject({ statusCode: 409 })
      expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    })

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
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
        provider: DeliveryProvider.DELIVERECT,
        status: DeliveryChannelStatus.PAUSED,
        snoozedUntil: null,
      })
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

    it('🔴 guardia: reanudar (PAUSED → ACTIVE) NO llama a `notifyIntegrationStatus`, aunque el adaptador lo tenga (reanudar no es «integrada sí»)', async () => {
      // «Integrada sí/no» le dice al proveedor por dónde llegan los pedidos; sólo lo mueve el aprovisionamiento y el botón de
      // desconectar. Una pausa o una reanudación solo habla de si la tienda recibe pedidos (`setStoreStatus`).
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
        provider: DeliveryProvider.DELIVERECT,
        status: DeliveryChannelStatus.PAUSED,
        snoozedUntil: null,
      })
      const setStoreStatus = jest.fn().mockResolvedValue({ ok: true, status: 200, raw: '' })
      const notifyIntegrationStatus = jest.fn().mockResolvedValue({ ok: true, status: 200, raw: '' })
      ;(hasAdapter as jest.Mock).mockReturnValue(true)
      ;(adapterFor as jest.Mock).mockReturnValue({ setStoreStatus, notifyIntegrationStatus })
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({
        ...baseLink,
        provider: 'UBER_EATS',
        externalLocationId: 'store-x',
      })

      await pauseChannelLink('venue1', 'link1', false)

      expect(setStoreStatus).toHaveBeenCalledWith(false, 'store-x', undefined) // sí reanudó la tienda
      expect(notifyIntegrationStatus).not.toHaveBeenCalled()
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
        // Spec KDS Uber §4.2: el CAS sale del estado COMPLETO leído (así se sabe a qué revertir).
        where: { id: 'link1', venueId: 'venue1', status: DeliveryChannelStatus.ACTIVE, snoozedUntil: null },
        // `objectContaining` sólo en `data`: desde el snooze, pausar escribe también
        // `snoozedUntil: null`. El `where` se queda EXACTO — es lo que este test cuida.
        data: expect.objectContaining({ status: DeliveryChannelStatus.PAUSED }),
      })
    })

    it('paused=false actualiza status a ACTIVE — Fix B4: el where del updateMany ahora exige status:PAUSED (gate atómico, no check-then-update)', async () => {
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
        provider: DeliveryProvider.DELIVERECT,
        status: DeliveryChannelStatus.PAUSED,
        snoozedUntil: null,
      })
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)
      ;(getAdapter as jest.Mock).mockReturnValue({ setChannelPaused: jest.fn().mockResolvedValue(undefined) })

      await pauseChannelLink('venue1', 'link1', false)

      expect(prisma.deliveryChannelLink.updateMany).toHaveBeenCalledWith({
        where: { id: 'link1', venueId: 'venue1', status: DeliveryChannelStatus.PAUSED, snoozedUntil: null },
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
        select: { status: true, snoozedUntil: true, provider: true, config: true },
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

    it('spec KDS Uber §4.2: pausar un DISABLED (revocado) o PENDING ⇒ 409, sin escribir ni avisar al proveedor', async () => {
      // Un DISABLED pausado y luego reanudado volvería a ACTIVE por encima de la revocación.
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
        provider: DeliveryProvider.DELIVERECT,
        status: DeliveryChannelStatus.DISABLED,
      })

      await expect(pauseChannelLink('venue1', 'link1', true)).rejects.toThrow(ConflictError)

      expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
      expect(getAdapter).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    })

    it('REGRESIÓN tenant isolation: link de OTRO venue → NotFoundError (no pausa, no llama adapter)', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 0 })
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue(null) // el lookup también filtra por venueId

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
        select: { status: true, snoozedUntil: true, provider: true, config: true },
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

    it('sin adaptador legado rechaza antes del CAS y de la auditoría de pausa', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)
      ;(getAdapter as jest.Mock).mockImplementation(() => {
        throw new Error('Delivery provider sin adapter implementado: DELIVERECT')
      })

      await expect(pauseChannelLink('venue1', 'link1', true, 'staff1')).rejects.toMatchObject({ statusCode: 409 })
      expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
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
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
        provider: DeliveryProvider.DELIVERECT,
        status: DeliveryChannelStatus.PAUSED,
        snoozedUntil: null,
      })
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
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
        status: DeliveryChannelStatus.PAUSED,
        snoozedUntil: new Date(Date.now() - 60_000),
      })
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

    // El job elige los vencidos y DESPUÉS reanuda cada uno: si en medio el dueño volvió la pausa
    // indefinida (o la alargó), el estado que manda es el que se relee para el CAS, no la lista vieja.
    it.each([
      ['el dueño la volvió indefinida', null],
      ['el reloj se alargó a futuro', new Date(Date.now() + 600_000)],
    ])('🔴 no reabre un canal si entre la selección y la escritura %s', async (_caso, snoozedUntil) => {
      ;(prisma.deliveryChannelLink.findMany as jest.Mock).mockResolvedValue([
        { id: 'l1', venueId: 'v1', provider: DeliveryProvider.UBER_EATS },
      ])
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
        provider: DeliveryProvider.DELIVERECT,
        status: DeliveryChannelStatus.PAUSED,
        snoozedUntil,
      })

      const r = await reanudarSnoozesVencidos()

      expect(r).toEqual({ reanudados: 0, fallidos: 1, noReabiertos: 0 })
      expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
    })

    // Regla de capacidad: el barrido de cada minuto nunca carga todos los canales.
    it('lee por páginas con tope y en orden de id', async () => {
      ;(prisma.deliveryChannelLink.findMany as jest.Mock).mockResolvedValue([])
      await reanudarSnoozesVencidos()
      const q = (prisma.deliveryChannelLink.findMany as jest.Mock).mock.calls[0][0]
      expect(q.take).toBe(100)
      expect(q.orderBy).toEqual({ id: 'asc' })
    })

    // Codex r2 (código): con un tope fijo, cien canales que fallan siempre le quitaban el turno al 101 para siempre.
    it('🔴 una página llena de canales que fallan no deja sin turno a los siguientes: se sigue con la próxima página', async () => {
      const pagina = Array.from({ length: 100 }, (_, i) => ({
        id: `l${String(i).padStart(3, '0')}`,
        venueId: 'v',
        provider: DeliveryProvider.UBER_EATS,
      }))
      ;(prisma.deliveryChannelLink.findMany as jest.Mock)
        .mockResolvedValueOnce(pagina)
        .mockResolvedValueOnce([{ id: 'l100', venueId: 'v', provider: DeliveryProvider.UBER_EATS }])
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue(null) // cada canal falla (NotFound)

      const r = await reanudarSnoozesVencidos()

      expect(prisma.deliveryChannelLink.findMany).toHaveBeenCalledTimes(2)
      expect((prisma.deliveryChannelLink.findMany as jest.Mock).mock.calls[1][0].where.id).toEqual({ gt: 'l099' })
      expect(r.fallidos).toBe(101)
    })

    // D4 (26-oct): Rappi avisó que la tienda se cerró de SU lado. La pausa del POS que vence ya no la reabre: queda pausada
    // sin fecha, y se dice por qué.
    it('🔴 la tienda cerrada desde el proveedor NO se reabre: se le quita el reloj, sin llamarle al proveedor', async () => {
      const vencio = new Date(Date.now() - 60_000)
      const setStoreStatus = jest.fn()
      ;(hasAdapter as jest.Mock).mockReturnValue(true)
      ;(adapterFor as jest.Mock).mockReturnValue({ setStoreStatus })
      ;(prisma.deliveryChannelLink.findMany as jest.Mock).mockResolvedValue([{ id: 'l1', venueId: 'v1', provider: DeliveryProvider.RAPPI }])
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
        provider: DeliveryProvider.RAPPI,
        status: DeliveryChannelStatus.PAUSED,
        snoozedUntil: vencio,
        config: { cerradaEnElProveedor: { desde: '2026-10-26T18:00:00.000Z' } },
      })
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({
        ...baseLink,
        provider: DeliveryProvider.RAPPI,
        status: DeliveryChannelStatus.PAUSED,
        snoozedUntil: null,
      })

      const r = await reanudarSnoozesVencidos()

      expect(r).toEqual({ reanudados: 0, fallidos: 0, noReabiertos: 1 })
      expect(setStoreStatus).not.toHaveBeenCalled()
      expect(prisma.deliveryChannelLink.updateMany).toHaveBeenCalledTimes(1)
      expect(prisma.deliveryChannelLink.updateMany).toHaveBeenCalledWith({
        where: { id: 'l1', venueId: 'v1', status: DeliveryChannelStatus.PAUSED, snoozedUntil: vencio },
        data: { snoozedUntil: null },
      })
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({ staffId: null, action: 'DELIVERY_CHANNEL_SNOOZE_NO_REABIERTO', entityId: 'l1' }),
      )
    })
  })

  // ============================================================
  // cancelarSnooze — reanudar antes de tiempo, SIN pisar al dueño
  // ============================================================
  describe('cancelarSnooze', () => {
    it('si la cocina se puso al día, reanuda antes de que venza el reloj', async () => {
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
        status: DeliveryChannelStatus.PAUSED,
        snoozedUntil: new Date(Date.now() + 600_000),
      })
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

    // D4 (Codex r3 #5): lo que se cerró desde el proveedor lo reabre quien administra el negocio, desde el panel. El POS lo dice
    // así, con o sin reloj (el job ya se lo quitó, o todavía no vence), y no culpa al dashboard.
    it.each([
      ['sin reloj', null],
      ['con reloj', new Date(Date.now() + 600_000)],
    ])('🔴 la tienda cerrada desde el proveedor (%s): el POS no la reabre y dice por qué', async (_caso, snoozedUntil) => {
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
        provider: DeliveryProvider.RAPPI,
        status: DeliveryChannelStatus.PAUSED,
        snoozedUntil,
        config: { cerradaEnElProveedor: { desde: 'x' } },
      })

      const p = cancelarSnooze('venue1', 'link1', 'staff1')
      await expect(p).rejects.toThrow(ValidationError)
      await expect(p).rejects.toThrow(/portal de la app de reparto/)
      expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
    })
  })

  describe('reabrir desde el panel una tienda cerrada desde el proveedor (D4)', () => {
    it('reabre y borra la nota, con la fila bloqueada', async () => {
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
        provider: DeliveryProvider.DELIVERECT,
        status: DeliveryChannelStatus.PAUSED,
        snoozedUntil: null,
        config: { cerradaEnElProveedor: { desde: 'x' } },
      })
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({ ...baseLink, status: DeliveryChannelStatus.ACTIVE })
      ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([
        { config: { note: 'x', cerradaEnElProveedor: { desde: 'x' } }, lastMenuHash: null },
      ])

      await pauseChannelLink('venue1', 'link1', false, 'staff1')

      expect(prisma.deliveryChannelLink.update).toHaveBeenCalledWith({
        where: { id: 'link1' },
        data: { config: { note: 'x', cerradaEnElProveedor: null } },
      })
    })

    // Codex r2 (código): un cierre NUEVO que llega mientras el panel reabre no se borra: sólo la nota que había al empezar.
    it('un cierre nuevo que llegó mientras se reabría NO se borra', async () => {
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
        provider: DeliveryProvider.DELIVERECT,
        status: DeliveryChannelStatus.PAUSED,
        snoozedUntil: null,
        config: { cerradaEnElProveedor: { desde: '2026-10-26T18:00:00.000Z' } },
      })
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({ ...baseLink, status: DeliveryChannelStatus.ACTIVE })
      ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([
        { config: { cerradaEnElProveedor: { desde: '2026-10-26T18:05:00.000Z' } }, lastMenuHash: null },
      ])

      await pauseChannelLink('venue1', 'link1', false, 'staff1')

      expect(prisma.deliveryChannelLink.update).not.toHaveBeenCalled()
    })

    it('si el proveedor no acepta reabrir, la nota se queda', async () => {
      ;(hasAdapter as jest.Mock).mockReturnValue(true)
      ;(adapterFor as jest.Mock).mockReturnValue({ setStoreStatus: jest.fn().mockResolvedValue({ ok: false, status: 500, raw: '' }) })
      ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
        provider: DeliveryProvider.RAPPI,
        status: DeliveryChannelStatus.PAUSED,
        snoozedUntil: null,
        config: { cerradaEnElProveedor: { desde: 'x' } },
      })
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({ ...baseLink, provider: DeliveryProvider.RAPPI })

      await expect(pauseChannelLink('venue1', 'link1', false, 'staff1')).rejects.toThrow(ConflictError)
      expect(prisma.deliveryChannelLink.update).not.toHaveBeenCalled()
    })
  })

  // ============================================================
  // listChannelsResumen — el semáforo que el POS consulta cada 10s
  // ============================================================
  describe('listChannelsResumen', () => {
    it('🔴 incluye snoozedUntil — sin él la cuenta regresiva NUNCA llega al POS y una pausa con reloj se pinta como pausa del administrador, sin botón de reanudar', async () => {
      ;(prisma.deliveryChannelLink.findMany as jest.Mock).mockResolvedValue([])

      await listChannelsResumen('venue1')

      const arg = (prisma.deliveryChannelLink.findMany as jest.Mock).mock.calls[0][0]
      expect(arg.where).toEqual({ venueId: 'venue1' })
      expect(arg.select.snoozedUntil).toBe(true)
      expect(arg.select.webhookSecret).toBeUndefined()
    })

    it('es LEAN a propósito: ni config, ni secretos — cada aparato de cocina lo consulta cada 10 segundos', async () => {
      ;(prisma.deliveryChannelLink.findMany as jest.Mock).mockResolvedValue([])

      await listChannelsResumen('venue1')

      const select = (prisma.deliveryChannelLink.findMany as jest.Mock).mock.calls[0][0].select
      expect(Object.keys(select).sort()).toEqual(['id', 'provider', 'snoozedUntil', 'status'])
    })
  })

  // ============================================================
  // Rappi: adaptador registrado y SÓLO aceptación automática (F4 del founder)
  // Estos casos usan el registro REAL (no el mock de arriba): lo que se prueba es el cableado de
  // verdad — que el núcleo lee `soloAceptacionAutomatica` del adaptador, sin un `if` por proveedor.
  // ============================================================
  describe('Rappi: adaptador registrado y sólo aceptación automática', () => {
    const registroReal = jest.requireActual('../../../../src/services/delivery-channels/core/adapterRegistry') as {
      hasAdapter: (p: DeliveryProvider) => boolean
      adapterFor: (p: DeliveryProvider) => unknown
    }
    const RAZON = rappiAdapter.soloAceptacionAutomatica as string

    beforeEach(() => {
      ;(hasAdapter as jest.Mock).mockImplementation(registroReal.hasAdapter)
      ;(adapterFor as jest.Mock).mockImplementation(registroReal.adapterFor)
    })
    // Sólo se restaura el espía propio: `restoreAllMocks` también tocaría los `jest.fn()` del registro simulado.
    let espia: jest.SpyInstance | undefined
    afterEach(() => {
      espia?.mockRestore()
      espia = undefined
    })

    it('el texto que se le muestra al usuario viene del adaptador y explica por qué y qué hacer', () => {
      expect(RAZON).toBe(
        'Los pedidos de Rappi se aceptan solos: Rappi los cancela si no se aceptan en 4 a 6 minutos. Para dejar de recibirlos, pausa la tienda.',
      )
    })

    describe('createChannelLink', () => {
      it('🔴 crear un canal RAPPI en MANUAL ⇒ ValidationError con el texto del adaptador, y no escribe nada', async () => {
        await expect(
          createChannelLink('venue1', {
            provider: DeliveryProvider.RAPPI,
            externalLocationId: 'loc1',
            orderAcceptanceMode: OrderAcceptanceMode.MANUAL,
          }),
        ).rejects.toThrow(new ValidationError(RAZON))

        expect(prisma.deliveryChannelLink.create).not.toHaveBeenCalled()
        expect(logAction).not.toHaveBeenCalled()
      })

      it('un canal RAPPI sin modo, o en AUTO, se crea en AUTO', async () => {
        ;(prisma.deliveryChannelLink.create as jest.Mock).mockResolvedValue({ id: 'newlink1' })

        await createChannelLink('venue1', { provider: DeliveryProvider.RAPPI, externalLocationId: 'loc1' })
        await createChannelLink('venue1', {
          provider: DeliveryProvider.RAPPI,
          externalLocationId: 'loc2',
          orderAcceptanceMode: OrderAcceptanceMode.AUTO,
        })

        const modos = (prisma.deliveryChannelLink.create as jest.Mock).mock.calls.map(c => c[0].data.orderAcceptanceMode)
        expect(modos).toEqual([OrderAcceptanceMode.AUTO, OrderAcceptanceMode.AUTO])
      })

      it('regresión: un canal de UBER_EATS en MANUAL SÍ se crea (el rechazo es del adaptador que lo declara, no de todos)', async () => {
        ;(prisma.deliveryChannelLink.create as jest.Mock).mockResolvedValue({ id: 'newlink1' })

        await createChannelLink('venue1', {
          provider: DeliveryProvider.UBER_EATS,
          externalLocationId: 'store1',
          orderAcceptanceMode: OrderAcceptanceMode.MANUAL,
        })

        expect((prisma.deliveryChannelLink.create as jest.Mock).mock.calls[0][0].data.orderAcceptanceMode).toBe(OrderAcceptanceMode.MANUAL)
      })
    })

    describe('updateChannelLink', () => {
      beforeEach(() => {
        ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
        ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)
      })

      it('🔴 cambiar un canal RAPPI a MANUAL ⇒ ValidationError con el texto del adaptador; el proveedor se lee de la fila, en la transacción', async () => {
        ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({ provider: DeliveryProvider.RAPPI })

        await expect(updateChannelLink('venue1', 'link1', { orderAcceptanceMode: OrderAcceptanceMode.MANUAL }, 'staff1')).rejects.toThrow(
          new ValidationError(RAZON),
        )

        // Tenant-scoped, y ANTES de cualquier escritura.
        expect(prisma.deliveryChannelLink.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: 'link1', venueId: 'venue1' } }),
        )
        expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
        expect(logAction).not.toHaveBeenCalled()
      })

      it('un canal de UBER_EATS SÍ cambia a MANUAL', async () => {
        ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({ provider: DeliveryProvider.UBER_EATS })

        await updateChannelLink('venue1', 'link1', { orderAcceptanceMode: OrderAcceptanceMode.MANUAL }, 'staff1')

        expect(prisma.deliveryChannelLink.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'link1', venueId: 'venue1' },
            data: expect.objectContaining({ orderAcceptanceMode: OrderAcceptanceMode.MANUAL }),
          }),
        )
      })

      it('un canal RAPPI: poner AUTO, o no tocar el modo, sigue funcionando igual', async () => {
        ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({ provider: DeliveryProvider.RAPPI })

        await updateChannelLink('venue1', 'link1', { orderAcceptanceMode: OrderAcceptanceMode.AUTO }, 'staff1')
        await updateChannelLink('venue1', 'link1', { autoSyncMenu: false }, 'staff1')

        const datos = (prisma.deliveryChannelLink.updateMany as jest.Mock).mock.calls.map(c => c[0].data)
        expect(datos[0]).toMatchObject({ orderAcceptanceMode: OrderAcceptanceMode.AUTO })
        expect(datos[1]).toMatchObject({ autoSyncMenu: false })
        expect(datos[1]).not.toHaveProperty('orderAcceptanceMode')
      })

      it('un canal de OTRO negocio a MANUAL ⇒ 404, nunca el texto del proveedor (no se filtra qué proveedor es)', async () => {
        ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue(null)
        ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

        await expect(updateChannelLink('venue-otro', 'link1', { orderAcceptanceMode: OrderAcceptanceMode.MANUAL })).rejects.toThrow(
          NotFoundError,
        )
      })
    })

    describe('pauseChannelLink', () => {
      it('🔴 pausar un canal RAPPI llama a setStoreStatus del adaptador (ya no da 409)', async () => {
        const setStoreStatus = (espia = jest.spyOn(rappiAdapter, 'setStoreStatus').mockResolvedValue({ ok: true, status: 200, raw: '' }))
        ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
          provider: DeliveryProvider.RAPPI,
          status: DeliveryChannelStatus.ACTIVE,
          snoozedUntil: null,
        })
        ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
        ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({
          ...baseLink,
          provider: DeliveryProvider.RAPPI,
          externalLocationId: '900105814',
        })

        const r = await pauseChannelLink('venue1', 'link1', true, 'staff1')

        expect(setStoreStatus).toHaveBeenCalledWith(true, '900105814', expect.any(String))
        expect(getAdapter).not.toHaveBeenCalled()
        expect(prisma.deliveryChannelLink.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: { status: DeliveryChannelStatus.PAUSED, snoozedUntil: null } }),
        )
        expect(r).not.toHaveProperty('webhookSecret')
      })

      it('🔴 si Rappi RECHAZA la pausa, el canal no queda pausado en nuestra base', async () => {
        espia = jest
          .spyOn(rappiAdapter, 'setStoreStatus')
          .mockResolvedValue({ ok: false, status: 200, raw: 'SUSPENDED: tienda suspendida' })
        ;(prisma.deliveryChannelLink.findFirst as jest.Mock).mockResolvedValue({
          provider: DeliveryProvider.RAPPI,
          status: DeliveryChannelStatus.ACTIVE,
          snoozedUntil: null,
        })
        ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
        ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue({
          ...baseLink,
          provider: DeliveryProvider.RAPPI,
          externalLocationId: '900105814',
        })

        await expect(pauseChannelLink('venue1', 'link1', true)).rejects.toThrow(/no se pudo pausar/i)

        // Dos escrituras: pausar y la reversión al estado previo.
        const escrituras = (prisma.deliveryChannelLink.updateMany as jest.Mock).mock.calls.map(c => c[0].data.status)
        expect(escrituras).toEqual([DeliveryChannelStatus.PAUSED, DeliveryChannelStatus.ACTIVE])
      })
    })
  })

  describe('SAFE_SELECT expone snoozedUntil', () => {
    it('🔴 el re-read de update lo incluye — el tipo Safe lo promete y quien lo lea no debe recibir undefined', async () => {
      ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
      ;(prisma.deliveryChannelLink.findUnique as jest.Mock).mockResolvedValue(baseLink)

      await updateChannelLink('venue1', 'link1', { autoSyncMenu: false })

      const callArg = (prisma.deliveryChannelLink.findUnique as jest.Mock).mock.calls[0][0]
      expect(callArg.select.snoozedUntil).toBe(true)
    })
  })
})
