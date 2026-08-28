import prisma from '../../../../src/utils/prismaClient'
import {
  getAnnouncementForStaff,
  getActiveBanner,
  recordOpen,
  recordCta,
  listAnnouncementsForStaff,
  getActiveForHome,
} from '../../../../src/services/announcements/announcementRead.service'
import { ForbiddenError } from '../../../../src/errors/AppError'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    notification: { findMany: jest.fn() },
    platformAnnouncement: { findUnique: jest.fn(), findMany: jest.fn() },
    platformAnnouncementClick: { upsert: jest.fn() },
    platformAnnouncementDelivery: { findFirst: jest.fn(), findMany: jest.fn() },
  },
}))

const mockNotifMany = prisma.notification.findMany as unknown as jest.Mock
const mockAnn = prisma.platformAnnouncement.findUnique as unknown as jest.Mock
const mockAnnMany = prisma.platformAnnouncement.findMany as unknown as jest.Mock
const mockAcuse = prisma.platformAnnouncementDelivery.findFirst as unknown as jest.Mock
const mockAcuseMany = prisma.platformAnnouncementDelivery.findMany as unknown as jest.Mock
const mockClick = prisma.platformAnnouncementClick.upsert as unknown as jest.Mock

describe('announcementRead.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockClick.mockResolvedValue({})
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
      mockNotifMany.mockResolvedValue([])
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
      mockNotifMany.mockResolvedValue([])
      const r = await getActiveForHome('s1')
      expect(r.banner?.id).toBe('viejo-vigente')
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
    it('la ventana solo sale si el aviso NO esta leido', async () => {
      mockAnnMany.mockResolvedValue([anuncio({ showAsModal: true })])
      mockAcuseMany.mockResolvedValue([{ announcementId: 'a1' }])
      mockNotifMany.mockResolvedValue([{ entityId: 'a1', isRead: false }])
      const r = await getActiveForHome('s1')
      expect(r.modal?.id).toBe('a1')
    })

    // 🔴 Lo que pidio el founder: se cierra UNA vez y despues vive en la campanita.
    // Cerrar marca el aviso como leido, y por eso deja de interrumpir.
    it('una vez leido, la ventana YA NO interrumpe', async () => {
      mockAnnMany.mockResolvedValue([anuncio({ showAsModal: true })])
      mockAcuseMany.mockResolvedValue([{ announcementId: 'a1' }])
      mockNotifMany.mockResolvedValue([{ entityId: 'a1', isRead: true }])
      const r = await getActiveForHome('s1')
      expect(r.modal).toBeNull()
    })

    it('un anuncio puede ser banner sin ser ventana', async () => {
      mockAnnMany.mockResolvedValue([anuncio({ showAsBanner: true, showAsModal: false })])
      mockAcuseMany.mockResolvedValue([{ announcementId: 'a1' }])
      mockNotifMany.mockResolvedValue([{ entityId: 'a1', isRead: false }])
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
})
