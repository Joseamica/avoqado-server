import prisma from '../../../../src/utils/prismaClient'
import { claimDeliveries, deliverClaimed } from '../../../../src/services/announcements/announcementOutbox.service'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
    platformAnnouncementDelivery: { findMany: jest.fn(), updateMany: jest.fn() },
    notification: { create: jest.fn() },
  },
}))

const mockRaw = prisma.$queryRaw as unknown as jest.Mock
const mockDelivFind = prisma.platformAnnouncementDelivery.findMany as unknown as jest.Mock
const mockDelivUpdate = prisma.platformAnnouncementDelivery.updateMany as unknown as jest.Mock
const mockNotifCreate = prisma.notification.create as unknown as jest.Mock

const AHORA = new Date('2026-08-27T12:00:00.000Z')

const entrega = (over = {}) => ({
  id: 'd1',
  announcementId: 'a1',
  staffId: 's1',
  venueId: 'v1',
  attempts: 1,
  leaseUntil: new Date('2026-08-27T12:05:00.000Z'),
  announcement: {
    id: 'a1',
    title: 'Terminal nueva',
    body: 'Dos pantallas',
    actionLabel: 'Ver',
    priority: 'NORMAL',
  },
  ...over,
})

describe('announcementOutbox.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockNotifCreate.mockResolvedValue({ id: 'n1' })
    mockDelivUpdate.mockResolvedValue({ count: 1 })
  })

  describe('claimDeliveries', () => {
    // ===== CASOS NUEVOS =====
    it('reclama con FOR UPDATE SKIP LOCKED: dos workers nunca toman la misma fila', async () => {
      mockRaw.mockResolvedValue([{ id: 'd1' }])
      await claimDeliveries({ limit: 10, now: AHORA })
      const sql = JSON.stringify(mockRaw.mock.calls[0][0])
      expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    })

    it('incrementa attempts AL RECLAMAR, no al fallar', async () => {
      mockRaw.mockResolvedValue([])
      await claimDeliveries({ limit: 10, now: AHORA })
      const sql = JSON.stringify(mockRaw.mock.calls[0][0])
      // si se contara al fallar, una caída a media entrega dejaría la fila
      // reintentándose para siempre
      expect(sql).toContain('attempts')
      expect(sql).toContain('leaseUntil')
    })

    it('respeta el lease vigente de otro worker', async () => {
      mockRaw.mockResolvedValue([])
      await claimDeliveries({ limit: 10, now: AHORA })
      const sql = JSON.stringify(mockRaw.mock.calls[0][0])
      expect(sql).toContain('leaseUntil')
      expect(sql).toContain('nextAttemptAt')
    })

    it('sin filas listas devuelve vacio', async () => {
      mockRaw.mockResolvedValue([])
      await expect(claimDeliveries({ limit: 10, now: AHORA })).resolves.toEqual([])
    })
  })

  describe('deliverClaimed', () => {
    // ===== CASOS NUEVOS =====
    it('crea el aviso en el buzon y marca la entrega como enviada', async () => {
      mockDelivFind.mockResolvedValue([entrega()])
      const r = await deliverClaimed(['d1'], { now: AHORA })
      expect(mockNotifCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            recipientId: 's1',
            venueId: 'v1',
            type: 'ANNOUNCEMENT',
            entityType: 'PlatformAnnouncement',
            entityId: 'a1',
          }),
        }),
      )
      expect(r.sent).toBe(1)
    })

    // 🔴 El CAS: si otro worker tomo la fila mientras esta entregaba, el resultado
    // NO se acepta. Sin esto, dos workers marcarian SENT la misma fila.
    // 🔴 Bug real encontrado por el founder (27-ago): el aviso apuntaba a
    // `/announcements/<id>`, una ruta que SOLO existe en el superadmin. En el dashboard
    // del cliente daba 404. El detalle se abre en un modal, no navegando.
    it('NO manda al cliente a una ruta que no existe en su dashboard', async () => {
      mockDelivFind.mockResolvedValue([entrega()])
      await deliverClaimed(['d1'], { now: AHORA })
      const data = mockNotifCreate.mock.calls[0][0].data
      expect(data.actionUrl).toBeUndefined()
    })

    it('si el anuncio trae su propio boton, ese SI viaja', async () => {
      mockDelivFind.mockResolvedValue([
        entrega({ announcement: { ...entrega().announcement, actionUrl: 'https://avoqado.io/terminales' } }),
      ])
      await deliverClaimed(['d1'], { now: AHORA })
      expect(mockNotifCreate.mock.calls[0][0].data.actionUrl).toBe('https://avoqado.io/terminales')
    })

    it('el resultado se escribe con CAS sobre attempts y leaseUntil', async () => {
      mockDelivFind.mockResolvedValue([entrega()])
      await deliverClaimed(['d1'], { now: AHORA })
      const where = mockDelivUpdate.mock.calls[0][0].where
      expect(where).toMatchObject({ id: 'd1', attempts: 1 })
      expect(where.leaseUntil).toEqual(entrega().leaseUntil)
    })

    it('si el aviso no se pudo crear, la entrega queda FAILED y se reintenta despues', async () => {
      mockDelivFind.mockResolvedValue([entrega()])
      mockNotifCreate.mockRejectedValue(new Error('boom'))
      const r = await deliverClaimed(['d1'], { now: AHORA })
      expect(r.failed).toBe(1)
      const data = mockDelivUpdate.mock.calls[0][0].data
      expect(data.status).toBe('FAILED')
      expect(data.nextAttemptAt.getTime()).toBeGreaterThan(AHORA.getTime())
      expect(data.lastError).toContain('boom')
    })

    // ===== REGRESION =====
    it('una fila que ya venia SENT no crea un segundo aviso', async () => {
      mockDelivFind.mockResolvedValue([])
      const r = await deliverClaimed(['d1'], { now: AHORA })
      expect(mockNotifCreate).not.toHaveBeenCalled()
      expect(r.sent).toBe(0)
    })
  })
})
