import { Prisma } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import {
  getAnnouncementForStaff,
  recordOpen,
  recordCta,
  recordDismiss,
  listAnnouncementsForStaff,
  getActiveForHome,
} from '../../../../src/services/announcements/announcementRead.service'
import { ForbiddenError } from '../../../../src/errors/AppError'
import { readHomeAppIdentity } from '../../../../src/services/posAppVersion/appIdentity'
import logger from '../../../../src/config/logger'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    notification: { findMany: jest.fn() },
    platformAnnouncement: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
    platformAnnouncementClick: { upsert: jest.fn(), findMany: jest.fn() },
    platformAnnouncementDelivery: { findFirst: jest.fn(), findMany: jest.fn() },
  },
}))

const mockNotifMany = prisma.notification.findMany as unknown as jest.Mock
const mockAnn = prisma.platformAnnouncement.findUnique as unknown as jest.Mock
const mockAnnMany = prisma.platformAnnouncement.findMany as unknown as jest.Mock
// Lo que `puedeLeer` lee del anuncio (si es un aviso de actualizar y su estado), aparte del contenido.
const mockAnnFirst = prisma.platformAnnouncement.findFirst as unknown as jest.Mock
const mockAcuse = prisma.platformAnnouncementDelivery.findFirst as unknown as jest.Mock
const mockAcuseMany = prisma.platformAnnouncementDelivery.findMany as unknown as jest.Mock
const mockClick = prisma.platformAnnouncementClick.upsert as unknown as jest.Mock
const mockClickMany = prisma.platformAnnouncementClick.findMany as unknown as jest.Mock

describe('announcementRead.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockClick.mockResolvedValue({})
    // Por omisión, un anuncio normal (sin `posAppPlatform`): el candado de hoy, por acuse.
    mockAnnFirst.mockResolvedValue({ posAppPlatform: null, status: 'PUBLISHED' })
  })

  describe('autorizacion por ACUSE DE RECIBO', () => {
    // ===== CASOS NUEVOS =====
    it('devuelve el anuncio a quien tiene su acuse', async () => {
      mockAcuse.mockResolvedValue({ id: 'd1' })
      mockAnn.mockResolvedValue({ id: 'a1', title: 'Hola', contentBlocks: [] })
      await expect(getAnnouncementForStaff('a1', 's1')).resolves.toMatchObject({ id: 'a1' })
    })

    it('sin acuse, niega el acceso y ni consulta el anuncio', async () => {
      mockAcuse.mockResolvedValue(null)
      await expect(getAnnouncementForStaff('a1', 's9')).rejects.toBeInstanceOf(ForbiddenError)
      expect(mockAnn).not.toHaveBeenCalled()
    })

    // 🔴 El acuse lo escribe SOLO el publisher. La Notification si es fabricable por
    // cualquiera con notifications:send, por eso ya no se usa para autorizar.
    it('autoriza contra la tabla de acuses, NO contra las notificaciones', async () => {
      mockAcuse.mockResolvedValue({ id: 'd1' })
      mockAnn.mockResolvedValue({ id: 'a1' })
      await getAnnouncementForStaff('a1', 's1')
      expect(mockAcuse).toHaveBeenCalledWith(expect.objectContaining({ where: { announcementId: 'a1', staffId: 's1' } }))
      expect(mockNotifMany).not.toHaveBeenCalled()
    })

    // 🔴 El caso del founder: un GRATIS ve el anuncio de una funcion PRO, compra PRO,
    // y NO puede perder el aviso que lo convencio de pagar.
    it('quien cambio de plan CONSERVA el anuncio que ya recibio', async () => {
      mockAcuse.mockResolvedValue({ id: 'd1' })
      mockAnn.mockResolvedValue({ id: 'a1', targetPlanTiers: ['GRATIS'] })
      // el staff ya es PRO: bajo el diseño viejo esto habria dado 403
      await expect(getAnnouncementForStaff('a1', 'el-que-subio-a-pro')).resolves.toMatchObject({ id: 'a1' })
    })

    it('recordOpen exige acuse', async () => {
      mockAcuse.mockResolvedValue(null)
      await expect(recordOpen('a1', 'atacante')).rejects.toBeInstanceOf(ForbiddenError)
      expect(mockClick).not.toHaveBeenCalled()
    })

    it('recordCta exige acuse', async () => {
      mockAcuse.mockResolvedValue(null)
      await expect(recordCta('a1', 'atacante')).rejects.toBeInstanceOf(ForbiddenError)
      expect(mockClick).not.toHaveBeenCalled()
    })
  })

  describe('el banner, dentro de getActiveForHome', () => {
    const banner = (id: string, priority: string, publishedAt: Date) => ({
      id,
      priority,
      publishedAt,
      showAsBanner: true,
      showAsModal: false,
    })

    // ===== CASOS NUEVOS =====
    it('el Home recibe UN solo banner, el que la base ordeno primero', async () => {
      mockAnnMany.mockResolvedValue([banner('a3', 'HIGH', new Date('2026-08-25')), banner('a1', 'NORMAL', new Date('2026-08-20'))])
      mockAcuseMany.mockResolvedValue([{ announcementId: 'a3' }, { announcementId: 'a1' }])
      mockClickMany.mockResolvedValue([])
      const r = await getActiveForHome('s1')
      expect(r.banner?.id).toBe('a3')
    })

    it('pide los anuncios activos a la BASE, con su orden', async () => {
      mockAnnMany.mockResolvedValue([])
      await getActiveForHome('s1')
      const args = mockAnnMany.mock.calls[0][0]
      expect(args.where.status).toBe('PUBLISHED')
      expect(args.where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }])
      expect(args.where.AND).toEqual([{ OR: [{ showAsBanner: true }, { showAsModal: true }] }])
      expect(args.orderBy).toEqual([{ priority: 'desc' }, { publishedAt: 'desc' }])
    })

    // 🔴 P1 de la auditoria: antes se tomaban los 50 avisos mas recientes y LUEGO se
    // filtraba por banner, asi que 50 avisos normales escondian un banner vigente.
    // El recorte va sobre anuncios activos, que son pocos por naturaleza.
    it('un banner vigente NO se esconde detras de avisos recientes', async () => {
      mockAnnMany.mockResolvedValue([banner('viejo-vigente', 'HIGH', new Date('2026-01-01'))])
      mockAcuseMany.mockResolvedValue([{ announcementId: 'viejo-vigente' }])
      mockClickMany.mockResolvedValue([])
      const r = await getActiveForHome('s1')
      expect(r.banner?.id).toBe('viejo-vigente')
    })

    // 🔴 El banner tambien respeta el cierre. La primera version solo filtraba la
    // ventana: cerrabas el banner con la X, recargabas, y volvia a salir. Lo encontro el
    // founder el 27-ago.
    it('un banner CERRADO no vuelve a salir al recargar', async () => {
      mockAnnMany.mockResolvedValue([banner('a1', 'HIGH', new Date())])
      mockAcuseMany.mockResolvedValue([{ announcementId: 'a1' }])
      mockClickMany.mockResolvedValue([{ announcementId: 'a1' }])
      const r = await getActiveForHome('s1')
      expect(r.banner).toBeNull()
    })

    it('no enseña un banner que no le repartieron', async () => {
      mockAnnMany.mockResolvedValue([banner('a1', 'HIGH', new Date())])
      mockAcuseMany.mockResolvedValue([])
      const r = await getActiveForHome('s1')
      expect(r.banner).toBeNull()
    })
  })

  describe('getActiveForHome — banner y ventana del inicio', () => {
    const anuncio = (over = {}) => ({
      id: 'a1',
      title: 'Cambian los precios',
      body: 'A partir del 1 de octubre.',
      priority: 'HIGH',
      showAsBanner: true,
      showAsModal: false,
      publishedAt: new Date(),
      ...over,
    })

    // ===== CASOS NUEVOS =====
    it('la ventana sale mientras no la hayan CERRADO', async () => {
      mockAnnMany.mockResolvedValue([anuncio({ showAsModal: true })])
      mockAcuseMany.mockResolvedValue([{ announcementId: 'a1' }])
      mockClickMany.mockResolvedValue([])
      const r = await getActiveForHome('s1')
      expect(r.modal?.id).toBe('a1')
    })

    it('getActiveForHome sigue regresando el anuncio sin campana', async () => {
      mockAnnMany.mockResolvedValue([anuncio({ showAsModal: true, showInInbox: false })])
      mockAcuseMany.mockResolvedValue([{ announcementId: 'a1', notificationId: null }])
      mockClickMany.mockResolvedValue([])
      const r = await getActiveForHome('s1')
      expect(r.modal?.id).toBe('a1')
    })

    // 🔴 Lo que pidio el founder: se cierra UNA vez y despues vive en la campanita.
    it('una vez cerrada, la ventana YA NO interrumpe', async () => {
      mockAnnMany.mockResolvedValue([anuncio({ showAsModal: true })])
      mockAcuseMany.mockResolvedValue([{ announcementId: 'a1' }])
      mockClickMany.mockResolvedValue([{ announcementId: 'a1' }])
      const r = await getActiveForHome('s1')
      expect(r.modal).toBeNull()
    })

    // 🔴 El defecto que encontro el founder probandolo (27-ago): la ventana dependia de
    // `Notification.isRead`, y la campana del dashboard marca TODO como leido nada mas
    // ABRIRLA. Asomarse al buzon apagaba una ventana que la persona nunca vio.
    it('abrir la campana NO apaga la ventana: no depende de isRead', async () => {
      mockAnnMany.mockResolvedValue([anuncio({ showAsModal: true })])
      mockAcuseMany.mockResolvedValue([{ announcementId: 'a1' }])
      mockClickMany.mockResolvedValue([])
      // aunque TODOS los avisos esten leidos, la ventana sigue pendiente
      mockNotifMany.mockResolvedValue([{ entityId: 'a1', isRead: true }])
      const r = await getActiveForHome('s1')
      expect(r.modal?.id).toBe('a1')
    })

    it('la consulta de cerrados filtra por dismissedAt, no por lectura', async () => {
      mockAnnMany.mockResolvedValue([anuncio({ showAsModal: true })])
      mockAcuseMany.mockResolvedValue([{ announcementId: 'a1' }])
      mockClickMany.mockResolvedValue([])
      await getActiveForHome('s1')
      expect(mockClickMany.mock.calls[0][0].where.dismissedAt).toEqual({ not: null })
    })

    it('un anuncio puede ser banner sin ser ventana', async () => {
      mockAnnMany.mockResolvedValue([anuncio({ showAsBanner: true, showAsModal: false })])
      mockAcuseMany.mockResolvedValue([{ announcementId: 'a1' }])
      mockClickMany.mockResolvedValue([])
      const r = await getActiveForHome('s1')
      expect(r.banner?.id).toBe('a1')
      expect(r.modal).toBeNull()
    })

    it('sin acuse no sale ni banner ni ventana, aunque el anuncio exista', async () => {
      mockAnnMany.mockResolvedValue([anuncio({ showAsModal: true })])
      mockAcuseMany.mockResolvedValue([])
      const r = await getActiveForHome('atacante')
      expect(r).toEqual({ banner: null, modal: null })
    })

    // ===== REGRESION =====
    it('sin anuncios activos no truena', async () => {
      mockAnnMany.mockResolvedValue([])
      await expect(getActiveForHome('s1')).resolves.toEqual({ banner: null, modal: null })
    })
  })

  describe('listAnnouncementsForStaff — el camino que usa el MCP', () => {
    it('parte de los ACUSES: sin acuses no devuelve nada', async () => {
      mockAcuseMany.mockResolvedValue([])
      await expect(listAnnouncementsForStaff('s1', { limit: 10, unreadOnly: false })).resolves.toEqual([])
      expect(mockNotifMany).not.toHaveBeenCalled()
    })

    it('acota los avisos a los anuncios con acuse', async () => {
      mockAcuseMany.mockResolvedValue([{ announcementId: 'a1' }])
      mockNotifMany.mockResolvedValue([])
      await listAnnouncementsForStaff('s1', { limit: 10, unreadOnly: false })
      expect(mockNotifMany.mock.calls[0][0].where.entityId).toEqual({ in: ['a1'] })
      expect(mockNotifMany.mock.calls[0][0].where.type).toBe('ANNOUNCEMENT')
    })
  })

  // Actualizador del POS (r7, spec §4.7.3): el aviso de actualizar sale en el inicio de las apps de hoy, elegido por la
  // versión que trae la app, sin acuses. Ocupa SÓLO los lugares que llena (fallo 8 del coordinador); el que deja vacío lo
  // llena el camino de hoy, con sus mismas reglas. «Bloquear» llena los dos y no respeta el cierre en ninguno (fallo 9).
  describe('getActiveForHome — el aviso de actualizar, por la versión de la app', () => {
    const bloquear = (over: Record<string, unknown> = {}) => ({
      id: 'bloq-android-100',
      title: 'Actualiza Avoqado cuanto antes',
      body: 'Esta versión ya no debe usarse. Actualizar toma un minuto.',
      priority: 'URGENT',
      status: 'PUBLISHED',
      showAsBanner: true,
      showAsModal: true,
      expiresAt: null,
      publishedAt: new Date('2026-11-04'),
      posAppPlatform: 'ANDROID',
      posAppNoticeKind: 'REQUIRED',
      posAppBelowVersionCode: 100,
      posAppBelowVersionName: null,
      ...over,
    })
    const avisar = (over: Record<string, unknown> = {}) =>
      bloquear({
        id: 'avisar-android-110',
        title: 'Hay una versión nueva de Avoqado',
        priority: 'HIGH',
        showAsModal: false,
        posAppNoticeKind: 'RECOMMENDED',
        posAppBelowVersionCode: 110,
        ...over,
      })
    const avisarIos = (over: Record<string, unknown> = {}) =>
      avisar({
        id: 'avisar-ios-1.16',
        posAppPlatform: 'IOS',
        posAppBelowVersionCode: null,
        posAppBelowVersionName: '1.16',
        ...over,
      })
    // Un anuncio normal, con su acuse, que hoy sale como banner y ventana.
    const normal = {
      id: 'normal-1',
      title: 'Cambian los precios',
      priority: 'NORMAL',
      showAsBanner: true,
      showAsModal: true,
      publishedAt: new Date('2026-11-01'),
      posAppPlatform: null,
    }

    /** La base: los avisos para la consulta de avisos (`posAppPlatform` = la plataforma), los normales para la de hoy. */
    const servir = (avisos: unknown[], normales: unknown[] = [normal]) =>
      mockAnnMany.mockImplementation(async (args: any) => (args.where.posAppPlatform ? avisos : normales))
    /** Los cierres de esta persona: sólo los ids que se pidieron y están en la lista. */
    const cerrados = (ids: string[]) =>
      mockClickMany.mockImplementation(async (args: any) =>
        ids.filter(id => (args.where.announcementId?.in ?? []).includes(id)).map(announcementId => ({ announcementId })),
      )

    const android = (versionCode: number) => ({ platform: 'ANDROID' as const, versionCode })
    const ios = (versionName: string) => ({ platform: 'IOS' as const, versionName })

    beforeEach(() => {
      mockAnnMany.mockReset()
      mockClickMany.mockReset()
      mockAcuseMany.mockReset()
      mockAcuseMany.mockResolvedValue([{ announcementId: 'normal-1' }])
      cerrados([])
    })

    // ===== CASOS NUEVOS =====
    // 🔴 Fallo 9: el ANDROID de hoy no tiene banner, sólo la ventana, y la pide una vez al abrir la app. Para «Bloquear»
    // la ventana tampoco respeta el cierre: sale cada vez que abren la app.
    it('ANDROID 95 con «Bloquear» debajo de 100, ya cerrado: banner Y ventana siguen siendo el aviso', async () => {
      servir([bloquear()])
      cerrados(['bloq-android-100'])
      const r = await getActiveForHome('s1', android(95))
      expect(r.banner?.id).toBe('bloq-android-100')
      expect(r.modal?.id).toBe('bloq-android-100')
    })

    it('si el aviso llena los dos lugares, el camino de hoy no corre ni una vez', async () => {
      servir([bloquear()])
      await getActiveForHome('s1', android(95))
      expect(mockAnnMany).toHaveBeenCalledTimes(1)
      expect(mockAnnMany.mock.calls.some(c => c[0].where.posAppPlatform === null || c[0].take === 20)).toBe(false)
      expect(mockAcuseMany).not.toHaveBeenCalled()
      // «Bloquear» no mira el cierre: ni se lee.
      expect(mockClickMany).not.toHaveBeenCalled()
    })

    it('«Avisar» como ventana, sin cerrar: el camino de hoy tampoco corre', async () => {
      servir([avisar({ showAsModal: true })])
      await getActiveForHome('s1', android(95))
      expect(mockAnnMany.mock.calls.some(c => c[0].where.posAppPlatform === null)).toBe(false)
      expect(mockAcuseMany).not.toHaveBeenCalled()
    })

    it('ANDROID 95 con «Bloquear» debajo de 100, sin cerrar: banner y ventana son el aviso', async () => {
      servir([bloquear()])
      const r = await getActiveForHome('s1', android(95))
      expect(r.banner?.id).toBe('bloq-android-100')
      expect(r.modal?.id).toBe('bloq-android-100')
    })

    it('ANDROID 100 (igual a la mínima) no está debajo: sigue el camino de hoy', async () => {
      servir([bloquear()])
      const r = await getActiveForHome('s1', android(100))
      expect(r.banner?.id).toBe('normal-1')
      expect(r.modal?.id).toBe('normal-1')
      const deHoy = mockAnnMany.mock.calls.find(c => c[0].where.posAppPlatform === null)
      expect(deHoy).toBeDefined()
    })

    it('sin app (el DASHBOARD): sólo el camino de hoy, y su consulta excluye los avisos de actualizar', async () => {
      servir([bloquear()])
      const r = await getActiveForHome('s1', null)
      expect(r.banner?.id).toBe('normal-1')
      expect(mockAnnMany).toHaveBeenCalledTimes(1)
      expect(mockAnnMany.mock.calls[0][0].where.posAppPlatform).toBeNull()
    })

    it('con la firma de antes (un solo argumento) también excluye los avisos de actualizar', async () => {
      servir([bloquear()])
      await getActiveForHome('s1')
      expect(mockAnnMany).toHaveBeenCalledTimes(1)
      expect(mockAnnMany.mock.calls[0][0].where.posAppPlatform).toBeNull()
    })

    it('iOS «1.15.11» con «Avisar» «1.16» como banner: el banner es el aviso y la ventana, la del camino de hoy', async () => {
      servir([avisarIos({ showAsModal: false })])
      const r = await getActiveForHome('s1', ios('1.15.11'))
      expect(r.banner?.id).toBe('avisar-ios-1.16')
      // Fallo 8: el aviso no llenó la ventana, así que la llena el anuncio normal con acuse.
      expect(r.modal?.id).toBe('normal-1')
    })

    it('«Avisar» como banner y una ventana normal con acuse: banner = el aviso, ventana = la normal', async () => {
      const ventanaNormal = { ...normal, id: 'normal-ventana', showAsBanner: false, showAsModal: true }
      servir([avisar()], [ventanaNormal])
      mockAcuseMany.mockResolvedValue([{ announcementId: 'normal-ventana' }])
      const r = await getActiveForHome('s1', android(95))
      expect(r.banner?.id).toBe('avisar-android-110')
      expect(r.modal?.id).toBe('normal-ventana')
      // El camino de hoy corre UNA vez, con sus reglas de siempre.
      expect(mockAnnMany.mock.calls.filter(c => c[0].where.posAppPlatform === null)).toHaveLength(1)
    })

    it('«Avisar» como banner sin ventana normal con acuse: la ventana queda vacía', async () => {
      servir([avisar()], [normal])
      mockAcuseMany.mockResolvedValue([])
      const r = await getActiveForHome('s1', android(95))
      expect(r).toEqual({ banner: expect.objectContaining({ id: 'avisar-android-110' }), modal: null })
    })

    it('iOS «1.16» con «Avisar» «1.16» no está debajo: sigue el camino de hoy', async () => {
      servir([avisarIos()])
      const r = await getActiveForHome('s1', ios('1.16.0'))
      expect(r.banner?.id).toBe('normal-1')
    })

    it('«Avisar» como ventana: banner y ventana son el aviso', async () => {
      servir([avisar({ showAsModal: true })])
      const r = await getActiveForHome('s1', android(95))
      expect(r.banner?.id).toBe('avisar-android-110')
      expect(r.modal?.id).toBe('avisar-android-110')
    })

    it('«Avisar» como ventana y cerrado no vuelve: banner y ventana, del camino de hoy', async () => {
      servir([avisar({ showAsModal: true })])
      cerrados(['avisar-android-110'])
      const r = await getActiveForHome('s1', android(95))
      expect(r.banner?.id).toBe('normal-1')
      expect(r.modal?.id).toBe('normal-1')
    })

    // Review Focus 5: con un anuncio normal con acuse y un «Avisar» a la vez, gana el aviso.
    it('un anuncio normal con acuse y un «Avisar» a la vez: gana el aviso', async () => {
      servir([avisar({ showAsModal: true })], [normal])
      mockAcuseMany.mockResolvedValue([{ announcementId: 'normal-1' }])
      const r = await getActiveForHome('s1', android(95))
      expect(r.banner?.id).toBe('avisar-android-110')
      expect(r.modal?.id).toBe('avisar-android-110')
    })

    it('debajo de los dos niveles: gana «Bloquear»', async () => {
      servir([avisar({ showAsModal: true }), bloquear()])
      const r = await getActiveForHome('s1', android(95))
      expect(r.banner?.id).toBe('bloq-android-100')
      expect(r.modal?.id).toBe('bloq-android-100')
    })

    it('«Bloquear» cerrado y «Avisar» abierto: los dos lugares siguen siendo «Bloquear»', async () => {
      servir([avisar({ showAsModal: true }), bloquear()])
      cerrados(['bloq-android-100'])
      const r = await getActiveForHome('s1', android(95))
      expect(r.banner?.id).toBe('bloq-android-100')
      expect(r.modal?.id).toBe('bloq-android-100')
    })

    it('debajo sólo de «Avisar» (ANDROID 100 con «Bloquear» 100 y «Avisar» 110): banner «Avisar», ventana la de hoy', async () => {
      servir([bloquear(), avisar()])
      const r = await getActiveForHome('s1', android(100))
      expect(r.banner?.id).toBe('avisar-android-110')
      expect(r.modal?.id).toBe('normal-1')
    })

    it('la consulta de avisos pide su plataforma, publicados, vigentes y con tope', async () => {
      servir([])
      await getActiveForHome('s1', android(95))
      const args = mockAnnMany.mock.calls[0][0]
      expect(args.where.posAppPlatform).toBe('ANDROID')
      expect(args.where.status).toBe('PUBLISHED')
      expect(args.where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }])
      expect(args.take).toBeGreaterThan(0)
      expect(args.take).toBeLessThanOrEqual(4)
    })

    it('el cierre de «Avisar» se lee de esta persona, por dismissedAt, para ese aviso y con tope', async () => {
      servir([avisar({ showAsModal: true })])
      await getActiveForHome('s1', android(95))
      const args = mockClickMany.mock.calls[0][0]
      expect(args.where.staffId).toBe('s1')
      expect(args.where.dismissedAt).toEqual({ not: null })
      expect(args.where.announcementId).toEqual({ in: ['avisar-android-110'] })
      expect(args.take).toBeGreaterThan(0)
    })

    // 🔴 Fallo 11: el paso nuevo nunca tumba el inicio de las apps.
    it('si la consulta de avisos falla, sale el camino de hoy y se avisa en el log una vez', async () => {
      mockAnnMany.mockImplementation(async (args: any) => {
        if (args.where.posAppPlatform) throw new Error('la base no contestó')
        return [normal]
      })
      const r = await getActiveForHome('s1', android(95))
      expect(r.banner?.id).toBe('normal-1')
      expect(r.modal?.id).toBe('normal-1')
      expect(logger.warn).toHaveBeenCalledTimes(1)
      // El error va como TEXTO: en producción winston (`json()` sin `format.errors()`) escribe un `Error` crudo como `{}`.
      const campos = (logger.warn as jest.Mock).mock.calls[0][1]
      expect(campos).toEqual({ error: 'la base no contestó', platform: 'ANDROID', versionCode: 95, versionName: undefined })
      expect(JSON.stringify(campos)).toContain('"error":"la base no contestó"')
    })

    it('si el fallo es de Prisma, el log lleva también su código', async () => {
      mockAnnMany.mockImplementation(async (args: any) => {
        if (args.where.posAppPlatform) {
          throw new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: 'test' })
        }
        return [normal]
      })
      const r = await getActiveForHome('s1', android(95))
      expect(r.banner?.id).toBe('normal-1')
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect((logger.warn as jest.Mock).mock.calls[0][1]).toEqual(
        expect.objectContaining({ error: "Can't reach database server", code: 'P1001', platform: 'ANDROID', versionCode: 95 }),
      )
    })

    it('si la lectura del cierre del aviso falla, sale el camino de hoy y se avisa en el log una vez', async () => {
      servir([avisar({ showAsModal: true })])
      mockClickMany.mockImplementation(async (args: any) => {
        if ((args.where.announcementId?.in ?? []).includes('avisar-android-110')) throw new Error('la base no contestó')
        return []
      })
      const r = await getActiveForHome('s1', android(95))
      expect(r.banner?.id).toBe('normal-1')
      expect(r.modal?.id).toBe('normal-1')
      expect(logger.warn).toHaveBeenCalledTimes(1)
    })

    it('el camino de hoy, cuando falla el aviso, es idéntico al que sale sin app', async () => {
      mockAnnMany.mockImplementation(async (args: any) => {
        if (args.where.posAppPlatform) throw new Error('la base no contestó')
        return [normal]
      })
      const conFalla = await getActiveForHome('s1', android(95))
      const sinApp = await getActiveForHome('s1', null)
      expect(conFalla).toEqual(sinApp)
    })

    // 🔴 Como lo arma el controlador: las cabeceras del WINDOWS (manda ANDROID, pero su fabricante es «Avoqado» y su
    // modelo, el nombre del sistema) no dan identidad, así que nunca reciben el aviso de ANDROID.
    it('con las cabeceras del WINDOWS no sale el aviso de ANDROID: sigue el camino de hoy', async () => {
      servir([bloquear()])
      const windows = readHomeAppIdentity({
        'x-device-platform': 'ANDROID',
        'x-device-form-factor': 'TABLET',
        'x-device-manufacturer': 'Avoqado',
        'x-device-model': 'Windows 11',
        'x-app-version-code': '95',
      })
      const r = await getActiveForHome('s1', windows)
      expect(r.banner?.id).toBe('normal-1')
      expect(mockAnnMany).toHaveBeenCalledTimes(1)
      expect(mockAnnMany.mock.calls[0][0].where.posAppPlatform).toBeNull()
    })

    it('con las cabeceras de un ANDROID real, el mismo aviso sí sale', async () => {
      servir([bloquear()])
      const tableta = readHomeAppIdentity({
        'x-device-platform': 'ANDROID',
        'x-device-form-factor': 'TABLET',
        'x-device-manufacturer': 'samsung',
        'x-device-model': 'SM-X710',
        'x-app-version-code': '95',
      })
      const r = await getActiveForHome('s1', tableta)
      expect(r.banner?.id).toBe('bloq-android-100')
    })

    // ===== REGRESION =====
    it('sin avisos de su plataforma, el camino de hoy queda igual (acuse y cierre)', async () => {
      servir([])
      mockAcuseMany.mockResolvedValue([])
      const r = await getActiveForHome('s1', android(95))
      // Sin acuse, el anuncio normal no se enseña: nada cambió para los anuncios de hoy.
      expect(r).toEqual({ banner: null, modal: null })
    })
  })

  // Spec §4.7.4: una app vieja tiene que poder abrir, tocar y cerrar el aviso de actualizar, que no tiene acuse.
  describe('puedeLeer — el aviso de actualizar se lee sin acuse mientras esté publicado', () => {
    const avisoAndroid = { id: 'aviso-1', title: 'Actualiza Avoqado cuanto antes', posAppPlatform: 'ANDROID', status: 'PUBLISHED' }

    // ===== CASOS NUEVOS =====
    it('un aviso publicado sin acuse se lee', async () => {
      mockAnnFirst.mockResolvedValue({ posAppPlatform: 'ANDROID', status: 'PUBLISHED' })
      mockAcuse.mockResolvedValue(null)
      mockAnn.mockResolvedValue(avisoAndroid)
      await expect(getAnnouncementForStaff('aviso-1', 's1')).resolves.toMatchObject({ id: 'aviso-1' })
    })

    it('un aviso archivado da 403', async () => {
      mockAnnFirst.mockResolvedValue({ posAppPlatform: 'ANDROID', status: 'ARCHIVED' })
      mockAcuse.mockResolvedValue(null)
      await expect(getAnnouncementForStaff('aviso-1', 's1')).rejects.toBeInstanceOf(ForbiddenError)
      expect(mockAnn).not.toHaveBeenCalled()
    })

    it('un aviso archivado da 403 aunque existiera un acuse', async () => {
      mockAnnFirst.mockResolvedValue({ posAppPlatform: 'IOS', status: 'ARCHIVED' })
      mockAcuse.mockResolvedValue({ id: 'd1' })
      await expect(getAnnouncementForStaff('aviso-1', 's1')).rejects.toBeInstanceOf(ForbiddenError)
    })

    it('cerrar un aviso publicado sin acuse registra el cierre', async () => {
      mockAnnFirst.mockResolvedValue({ posAppPlatform: 'ANDROID', status: 'PUBLISHED' })
      mockAcuse.mockResolvedValue(null)
      await recordDismiss('aviso-1', 's1', 'v1')
      expect(mockClick).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { announcementId_staffId: { announcementId: 'aviso-1', staffId: 's1' } },
          create: expect.objectContaining({ dismissedAt: expect.any(Date) }),
        }),
      )
    })

    it('el botón de un aviso publicado sin acuse se registra', async () => {
      mockAnnFirst.mockResolvedValue({ posAppPlatform: 'ANDROID', status: 'PUBLISHED' })
      mockAcuse.mockResolvedValue(null)
      await recordCta('aviso-1', 's1')
      expect(mockClick).toHaveBeenCalled()
    })

    it('el estado se lee por el id del anuncio, sólo esas columnas', async () => {
      mockAnnFirst.mockResolvedValue({ posAppPlatform: 'ANDROID', status: 'PUBLISHED' })
      mockAnn.mockResolvedValue(avisoAndroid)
      await getAnnouncementForStaff('aviso-1', 's1')
      expect(mockAnnFirst).toHaveBeenCalledWith({
        where: { id: 'aviso-1' },
        select: { posAppPlatform: true, status: true },
      })
    })

    // ===== REGRESION: los anuncios normales siguen pidiendo acuse =====
    it('un anuncio normal publicado sin acuse sigue dando 403', async () => {
      mockAnnFirst.mockResolvedValue({ posAppPlatform: null, status: 'PUBLISHED' })
      mockAcuse.mockResolvedValue(null)
      await expect(getAnnouncementForStaff('a1', 's9')).rejects.toBeInstanceOf(ForbiddenError)
    })

    it('un anuncio normal con acuse se sigue leyendo, aunque esté archivado (como hoy)', async () => {
      mockAnnFirst.mockResolvedValue({ posAppPlatform: null, status: 'ARCHIVED' })
      mockAcuse.mockResolvedValue({ id: 'd1' })
      mockAnn.mockResolvedValue({ id: 'a1' })
      await expect(getAnnouncementForStaff('a1', 's1')).resolves.toMatchObject({ id: 'a1' })
    })

    it('un id que no existe sin acuse da 403, como hoy', async () => {
      mockAnnFirst.mockResolvedValue(null)
      mockAcuse.mockResolvedValue(null)
      await expect(recordOpen('no-existe', 's1')).rejects.toBeInstanceOf(ForbiddenError)
      expect(mockClick).not.toHaveBeenCalled()
    })
  })
})
