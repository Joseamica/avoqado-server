import { PlatformAnnouncementStatus } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import { resolveAudience } from '../../../../src/services/announcements/audience.service'
import {
  publishAnnouncement,
  scheduleAnnouncement,
  listAnnouncements,
  updateAnnouncement,
  archiveAnnouncement,
} from '../../../../src/services/announcements/announcement.service'
import { NotFoundError } from '../../../../src/errors/AppError'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    platformAnnouncement: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    notification: { createMany: jest.fn() },
    platformAnnouncementDelivery: { createMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  },
}))
jest.mock('../../../../src/services/announcements/audience.service', () => ({
  resolveAudience: jest.fn(),
}))
// La bitácora es nueva en este servicio: sin este mock, `logAction` real intenta escribir
// en un `prisma.activityLog` que este archivo no declara y truena en pruebas que no la miran.
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn().mockResolvedValue(undefined),
}))

const mockFind = prisma.platformAnnouncement.findUnique as unknown as jest.Mock
const mockUpdate = prisma.platformAnnouncement.update as unknown as jest.Mock
const mockUpdateMany = prisma.platformAnnouncement.updateMany as unknown as jest.Mock
const mockCreateMany = prisma.notification.createMany as unknown as jest.Mock
const mockAudience = resolveAudience as unknown as jest.Mock
const mockDelivCreate = prisma.platformAnnouncementDelivery.createMany as unknown as jest.Mock
const mockDelivCount = prisma.platformAnnouncementDelivery.count as unknown as jest.Mock
const mockFindMany = prisma.platformAnnouncement.findMany as unknown as jest.Mock
const mockGroupBy = prisma.platformAnnouncementDelivery.groupBy as unknown as jest.Mock

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

describe('publishAnnouncement — encola, no reparte', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFind.mockResolvedValue(anuncio)
    mockUpdate.mockResolvedValue({})
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockDelivCreate.mockResolvedValue({ count: 2 })
    mockDelivCount.mockResolvedValue(2)
    mockAudience.mockResolvedValue([
      { staffId: 's1', venueId: 'v1' },
      { staffId: 's2', venueId: 'v1' },
    ])
  })

  // ===== CASOS NUEVOS =====
  it('encola una entrega por persona, sin crear avisos', async () => {
    await publishAnnouncement('a1')
    const filas = mockDelivCreate.mock.calls[0][0].data
    expect(filas).toEqual([
      { announcementId: 'a1', staffId: 's1', venueId: 'v1' },
      { announcementId: 'a1', staffId: 's2', venueId: 'v1' },
    ])
    // el aviso lo crea el job del outbox, no esto
    expect(mockCreateMany).not.toHaveBeenCalled()
  })

  // 🔴 Lo que hace segura la concurrencia ya no es el claim: es que encolar sea
  // idempotente. Dos publicaciones simultaneas producen el MISMO conjunto de filas.
  it('encola con skipDuplicates, que aqui SI funciona por el unique', async () => {
    await publishAnnouncement('a1')
    expect(mockDelivCreate.mock.calls[0][0].skipDuplicates).toBe(true)
  })

  // Comprueba la PROPIEDAD (ARCHIVED nunca es reclamable), no la forma del `where`:
  // el claim tiene dos brazos y afirmar `where.status.in` ataba la prueba a uno solo.
  it('el claim excluye ARCHIVED: un archive concurrente no se pierde', async () => {
    await publishAnnouncement('a1')
    const where = mockUpdateMany.mock.calls[0][0].where
    expect(JSON.stringify(where)).not.toContain('ARCHIVED')
    const brazos = where.OR ?? [where]
    expect(brazos.some((b: any) => b.status?.in?.includes('DRAFT'))).toBe(true)
  })

  // 🔴 Un reparto que quedó a medias TIENE que poder reintentarse. El estado
  // (PUBLISHED, deliveredAt: null) lo produce cualquier fallo entre el claim y el
  // final: un `createMany` que truena, la cuenta, un redeploy. La guarda temprana
  // mira `deliveredAt` y el claim mira `status`, así que ese estado se cuela por la
  // primera y, sin este brazo, el claim lo rechaza: publicar de nuevo contesta
  // `alreadyPublished` sin encolar a nadie y NO hay otra vía de recuperación —el job
  // programado sólo toma SCHEDULED y el outbox sólo drena lo ya insertado—, así que
  // el anuncio llega a una fracción de la gente para siempre. Reintentar es seguro
  // porque el @@unique de las entregas hace idempotente el reencolado.
  it('🔴 reintenta un reparto a medias: PUBLISHED con deliveredAt nulo se vuelve a encolar', async () => {
    await publishAnnouncement('a1')
    const where = mockUpdateMany.mock.calls[0][0].where
    const brazos = where.OR ?? [where]
    const reintento = brazos.some((b: any) => b.status === 'PUBLISHED' && b.deliveredAt === null)
    expect(reintento).toBe(true)
  })

  it('el conteo sale de las filas encoladas de verdad, no de la audiencia', async () => {
    mockDelivCount.mockResolvedValue(7)
    const r = await publishAnnouncement('a1')
    expect(r.delivered).toBe(7)
    expect(mockUpdate.mock.calls[0][0].data.deliveredCount).toBe(7)
  })

  it('un anuncio ya encolado es no-op', async () => {
    mockFind.mockResolvedValue({ ...anuncio, deliveredAt: new Date(), deliveredCount: 2 })
    const r = await publishAnnouncement('a1')
    expect(r.alreadyPublished).toBe(true)
    expect(mockDelivCreate).not.toHaveBeenCalled()
  })

  it('el perdedor del claim no encola nada', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })
    const r = await publishAnnouncement('a1')
    expect(r.alreadyPublished).toBe(true)
    expect(mockDelivCreate).not.toHaveBeenCalled()
  })

  it('sin audiencia no truena', async () => {
    mockAudience.mockResolvedValue([])
    mockDelivCount.mockResolvedValue(0)
    await expect(publishAnnouncement('a1')).resolves.toMatchObject({ delivered: 0 })
  })

  // ===== REGRESION: maquina de estados =====
  it('un anuncio ARCHIVADO no se puede publicar', async () => {
    mockFind.mockResolvedValue({ ...anuncio, status: PlatformAnnouncementStatus.ARCHIVED })
    await expect(publishAnnouncement('a1')).rejects.toThrow(/archivado/i)
    expect(mockUpdateMany).not.toHaveBeenCalled()
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

// Actualizador del POS (r7, spec §4.7.5): los avisos de actualizar los crea y archiva «Versiones del POS». El compositor no
// los lista ni los toca: para él no existen (404), así nadie edita o reparte por error un aviso que no tiene audiencia.
describe('el compositor no ve ni toca los avisos de actualizar', () => {
  const aviso = {
    ...anuncio,
    id: 'aviso-android',
    status: PlatformAnnouncementStatus.PUBLISHED,
    publishedAt: new Date('2026-11-04'),
    deliveredAt: new Date('2026-11-04'),
    audienceRoles: [],
    posAppPlatform: 'ANDROID',
    posAppNoticeKind: 'REQUIRED',
    posAppBelowVersionCode: 100,
    posAppBelowVersionName: null,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockUpdate.mockResolvedValue({})
    mockUpdateMany.mockResolvedValue({ count: 1 })
    mockFindMany.mockResolvedValue([])
    mockGroupBy.mockResolvedValue([])
  })

  // ===== CASOS NUEVOS =====
  it('listAnnouncements filtra posAppPlatform: null', async () => {
    await listAnnouncements()
    expect(mockFindMany.mock.calls[0][0].where).toEqual({ posAppPlatform: null })
  })

  it('updateAnnouncement sobre un aviso da NotFoundError y no escribe', async () => {
    mockFind.mockResolvedValue({ ...aviso, status: PlatformAnnouncementStatus.DRAFT })
    await expect(updateAnnouncement('aviso-android', { title: 'Otro' })).rejects.toBeInstanceOf(NotFoundError)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('publishAnnouncement sobre un aviso da NotFoundError y no encola', async () => {
    mockFind.mockResolvedValue({ ...aviso, deliveredAt: null })
    await expect(publishAnnouncement('aviso-android')).rejects.toBeInstanceOf(NotFoundError)
    expect(mockUpdateMany).not.toHaveBeenCalled()
    expect(mockDelivCreate).not.toHaveBeenCalled()
  })

  it('scheduleAnnouncement sobre un aviso da NotFoundError y no escribe', async () => {
    mockFind.mockResolvedValue({ ...aviso, deliveredAt: null })
    await expect(scheduleAnnouncement('aviso-android', new Date('2026-12-01'))).rejects.toBeInstanceOf(NotFoundError)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('archiveAnnouncement sobre un aviso da NotFoundError y no escribe', async () => {
    mockFind.mockResolvedValue(aviso)
    await expect(archiveAnnouncement('aviso-android')).rejects.toBeInstanceOf(NotFoundError)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  // ===== REGRESION: los anuncios normales siguen igual =====
  it('listAnnouncements sigue ordenando por fecha de creación y devolviendo el alcance', async () => {
    mockFindMany.mockResolvedValue([{ ...anuncio, posAppPlatform: null }])
    mockGroupBy.mockResolvedValueOnce([{ announcementId: 'a1', venueId: 'v1' }]).mockResolvedValueOnce([
      { announcementId: 'a1', staffId: 's1' },
      { announcementId: 'a1', staffId: 's2' },
    ])
    const r = await listAnnouncements()
    expect(mockFindMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
    expect(r).toEqual([expect.objectContaining({ id: 'a1', reachedVenues: 1, reachedPeople: 2 })])
  })

  it('un anuncio normal se sigue archivando', async () => {
    mockFind.mockResolvedValue({ ...anuncio, posAppPlatform: null })
    await archiveAnnouncement('a1')
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { status: PlatformAnnouncementStatus.ARCHIVED } })
  })

  it('un anuncio normal en borrador se sigue editando', async () => {
    mockFind.mockResolvedValue({ ...anuncio, posAppPlatform: null })
    await updateAnnouncement('a1', { title: 'Nuevo' })
    expect(mockUpdate).toHaveBeenCalled()
  })

  it('un id que no existe sigue dando NotFoundError', async () => {
    mockFind.mockResolvedValue(null)
    await expect(archiveAnnouncement('no-existe')).rejects.toBeInstanceOf(NotFoundError)
  })
})
