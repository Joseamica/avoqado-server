import prisma from '../../../../src/utils/prismaClient'
import {
  getAnnouncementForStaff,
  getActiveBanner,
  recordOpen,
  recordCta,
  listAnnouncementsForStaff,
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

  describe('getActiveBanner', () => {
    const banner = (id: string, priority: string, publishedAt: Date) => ({ id, priority, publishedAt })

    it('el Home recibe UN solo banner, el que la base ordeno primero', async () => {
      mockAnnMany.mockResolvedValue([banner('a3', 'HIGH', new Date('2026-08-25')), banner('a1', 'NORMAL', new Date('2026-08-20'))])
      mockAcuseMany.mockResolvedValue([{ announcementId: 'a3' }, { announcementId: 'a1' }])
      await expect(getActiveBanner('s1')).resolves.toMatchObject({ id: 'a3' })
    })

    it('pide los banners activos a la BASE, con su orden', async () => {
      mockAnnMany.mockResolvedValue([])
      await getActiveBanner('s1')
      const args = mockAnnMany.mock.calls[0][0]
      expect(args.where.status).toBe('PUBLISHED')
      expect(args.where.showAsBanner).toBe(true)
      expect(args.where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }])
      expect(args.orderBy).toEqual([{ priority: 'desc' }, { publishedAt: 'desc' }])
    })

    // 🔴 P1: antes se tomaban los 50 avisos mas recientes y LUEGO se filtraba por banner,
    // asi que 50 avisos normales escondian un banner vigente.
    it('un banner vigente NO se esconde detras de avisos recientes', async () => {
      mockAnnMany.mockResolvedValue([banner('viejo-vigente', 'HIGH', new Date('2026-01-01'))])
      mockAcuseMany.mockResolvedValue([{ announcementId: 'viejo-vigente' }])
      await expect(getActiveBanner('s1')).resolves.toMatchObject({ id: 'viejo-vigente' })
    })

    it('no enseña un banner que no le repartieron', async () => {
      mockAnnMany.mockResolvedValue([banner('a1', 'HIGH', new Date())])
      mockAcuseMany.mockResolvedValue([])
      await expect(getActiveBanner('s1')).resolves.toBeNull()
    })

    // ===== REGRESION =====
    it('sin banner activo devuelve null, no truena', async () => {
      mockAnnMany.mockResolvedValue([])
      await expect(getActiveBanner('s1')).resolves.toBeNull()
      expect(mockAcuseMany).not.toHaveBeenCalled()
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
