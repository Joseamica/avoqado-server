import { NotificationType, PlatformAnnouncementStatus } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import { resolveAudience } from '../../../../src/services/announcements/audience.service'
import { publishAnnouncement, scheduleAnnouncement } from '../../../../src/services/announcements/announcement.service'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    platformAnnouncement: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    notification: { createMany: jest.fn() },
    platformAnnouncementDelivery: { findMany: jest.fn(), createMany: jest.fn() },
  },
}))
jest.mock('../../../../src/services/announcements/audience.service', () => ({
  resolveAudience: jest.fn(),
}))

const mockFind = prisma.platformAnnouncement.findUnique as unknown as jest.Mock
const mockUpdate = prisma.platformAnnouncement.update as unknown as jest.Mock
const mockUpdateMany = prisma.platformAnnouncement.updateMany as unknown as jest.Mock
const mockCreateMany = prisma.notification.createMany as unknown as jest.Mock
const mockAudience = resolveAudience as unknown as jest.Mock
const mockDelivFind = prisma.platformAnnouncementDelivery.findMany as unknown as jest.Mock
const mockDelivCreate = prisma.platformAnnouncementDelivery.createMany as unknown as jest.Mock

const anuncio = {
  id: 'a1',
  title: 'Ya llego la terminal nueva',
  body: 'Dos pantallas.',
  actionLabel: 'Ver mas',
  priority: 'NORMAL',
  status: PlatformAnnouncementStatus.DRAFT,
  publishedAt: null,
  deliveredAt: null,
  deliveredCount: 0,
  audienceRoles: ['OWNER'],
  targetPlanTiers: [],
  targetCategories: [],
  targetVenueIds: [],
}

describe('publishAnnouncement', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFind.mockResolvedValue(anuncio)
    mockCreateMany.mockResolvedValue({ count: 2 })
    mockUpdate.mockResolvedValue({})
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockDelivFind.mockResolvedValue([])
    mockDelivCreate.mockResolvedValue({ count: 2 })
    mockAudience.mockResolvedValue([
      { staffId: 's1', venueId: 'v1' },
      { staffId: 's2', venueId: 'v1' },
    ])
  })

  // ===== CASOS NUEVOS =====
  it('crea una Notification por persona, atada al anuncio', async () => {
    await publishAnnouncement('a1')
    const filas = mockCreateMany.mock.calls[0][0].data
    expect(filas).toHaveLength(2)
    expect(filas[0]).toMatchObject({
      recipientId: 's1',
      venueId: 'v1',
      type: NotificationType.ANNOUNCEMENT,
      title: anuncio.title,
      message: anuncio.body,
      entityType: 'PlatformAnnouncement',
      entityId: 'a1',
    })
  })

  it('el claim marca PUBLISHED y el update final registra cuantas salieron', async () => {
    await publishAnnouncement('a1')
    // el estado lo pone el claim atomico, no el update final
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PlatformAnnouncementStatus.PUBLISHED }),
      }),
    )
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'a1' }, data: { deliveredCount: 2, deliveredAt: expect.any(Date) } }),
    )
  })

  // ===== REGRESION: maquina de estados (P2 de la auditoria) =====
  it('un anuncio ARCHIVADO no se puede publicar', async () => {
    mockFind.mockResolvedValue({ ...anuncio, status: PlatformAnnouncementStatus.ARCHIVED })
    await expect(publishAnnouncement('a1')).rejects.toThrow(/archivado/i)
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })

  it('NO reparte dos veces: un anuncio ya repartido es no-op', async () => {
    mockFind.mockResolvedValue({
      ...anuncio,
      deliveredAt: new Date(),
      deliveredCount: 2,
      status: PlatformAnnouncementStatus.PUBLISHED,
    })
    const r = await publishAnnouncement('a1')
    expect(r.alreadyPublished).toBe(true)
    expect(mockCreateMany).not.toHaveBeenCalled()
  })

  // 🔴 El caso que el test anterior NO cubría (hallazgo P1 de la auditoría):
  // dos publicaciones CONCURRENTES leen deliveredAt=null y ambas reparten.
  it('gana UNA sola: el claim atomico decide antes de repartir', async () => {
    await publishAnnouncement('a1')
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'a1' }) }))
    // el claim ocurre ANTES de crear una sola Notification
    expect(mockUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(mockCreateMany.mock.invocationCallOrder[0])
  })

  it('el perdedor de la carrera NO reparte, aunque haya leido deliveredAt=null', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })
    const r = await publishAnnouncement('a1')
    expect(r.alreadyPublished).toBe(true)
    expect(mockCreateMany).not.toHaveBeenCalled()
  })

  it('sin audiencia no truena: publica con cero entregas', async () => {
    mockAudience.mockResolvedValue([])
    const r = await publishAnnouncement('a1')
    expect(r.delivered).toBe(0)
    expect(mockCreateMany).not.toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalled()
  })

  // ===== REGRESION =====
  it('no inventa campos en Notification: solo los que el modelo ya tiene', async () => {
    await publishAnnouncement('a1')
    const fila = mockCreateMany.mock.calls[0][0].data[0]
    expect(fila).not.toHaveProperty('announcementId')
    expect(fila).not.toHaveProperty('contentBlocks')
  })
})

describe('scheduleAnnouncement — maquina de estados (P2 de la auditoria)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUpdate.mockResolvedValue({})
  })

  it('rechaza programar DESPUES de la fecha de caducidad', async () => {
    mockFind.mockResolvedValue({
      ...anuncio,
      expiresAt: new Date('2026-09-01'),
    })
    await expect(scheduleAnnouncement('a1', new Date('2026-09-10'))).rejects.toThrow(/caducidad/i)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('acepta programar antes de la caducidad', async () => {
    mockFind.mockResolvedValue({ ...anuncio, expiresAt: new Date('2026-09-30') })
    await scheduleAnnouncement('a1', new Date('2026-09-10'))
    expect(mockUpdate).toHaveBeenCalled()
  })

  it('un anuncio ARCHIVADO tampoco se puede programar', async () => {
    mockFind.mockResolvedValue({ ...anuncio, status: PlatformAnnouncementStatus.ARCHIVED })
    await expect(scheduleAnnouncement('a1', new Date('2026-09-10'))).rejects.toThrow(/archivado/i)
  })
})

describe('publishAnnouncement — reintento sin duplicar (acuse de recibo)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFind.mockResolvedValue(anuncio)
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockUpdate.mockResolvedValue({})
    mockCreateMany.mockResolvedValue({ count: 1 })
    mockDelivCreate.mockResolvedValue({ count: 1 })
    mockAudience.mockResolvedValue([
      { staffId: 's1', venueId: 'v1' },
      { staffId: 's2', venueId: 'v1' },
    ])
  })

  it('escribe el acuse de recibo junto con el aviso', async () => {
    mockDelivFind.mockResolvedValue([])
    await publishAnnouncement('a1')
    const acuses = mockDelivCreate.mock.calls[0][0].data
    expect(acuses).toHaveLength(2)
    expect(acuses[0]).toMatchObject({ announcementId: 'a1', staffId: 's1', venueId: 'v1' })
  })

  // 🔴 El caso que la primera version NO podia: si truena a medio reparto, al reintentar
  // solo salen los que faltaban. Nadie recibe el aviso dos veces.
  it('al reintentar, SALTA a quien ya recibio y solo reparte a los que faltaban', async () => {
    mockDelivFind.mockResolvedValue([{ staffId: 's1', venueId: 'v1' }])
    await publishAnnouncement('a1')
    const avisos = mockCreateMany.mock.calls[0][0].data
    expect(avisos).toHaveLength(1)
    expect(avisos[0].recipientId).toBe('s2')
  })

  it('si ya se le entrego a todos, no crea un solo aviso mas', async () => {
    mockDelivFind.mockResolvedValue([
      { staffId: 's1', venueId: 'v1' },
      { staffId: 's2', venueId: 'v1' },
    ])
    await publishAnnouncement('a1')
    expect(mockCreateMany).not.toHaveBeenCalled()
  })

  // 🔴 CAS por estado: archivar y publicar al mismo tiempo ya no se pisan.
  it('el claim condiciona por ESTADO, no solo por deliveredAt', async () => {
    mockDelivFind.mockResolvedValue([])
    await publishAnnouncement('a1')
    const where = mockUpdateMany.mock.calls[0][0].where
    // un anuncio ARCHIVADO no casa con ninguna rama del OR, asi que un archive
    // concurrente ya no puede ser sobrescrito a PUBLISHED
    expect(JSON.stringify(where)).not.toContain('ARCHIVED')
    expect(where.OR).toHaveLength(2)
    expect(where.OR[0].status.in).toEqual(['DRAFT', 'SCHEDULED'])
    expect(where.OR[1]).toEqual({ status: 'PUBLISHED', deliveredAt: null })
  })

  it('deliveredAt se pone AL TERMINAR, no antes de repartir', async () => {
    mockDelivFind.mockResolvedValue([])
    await publishAnnouncement('a1')
    expect(mockUpdateMany.mock.calls[0][0].data.deliveredAt).toBeUndefined()
    expect(mockUpdate.mock.calls[0][0].data.deliveredAt).toBeInstanceOf(Date)
  })
})
