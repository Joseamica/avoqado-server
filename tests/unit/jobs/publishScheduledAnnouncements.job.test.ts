import { PlatformAnnouncementStatus } from '@prisma/client'
import prisma from '../../../src/utils/prismaClient'
import { publishAnnouncement } from '../../../src/services/announcements/announcement.service'
import { publishScheduledAnnouncements } from '../../../src/jobs/publishScheduledAnnouncements.job'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { platformAnnouncement: { findMany: jest.fn() } },
}))
jest.mock('../../../src/services/announcements/announcement.service', () => ({
  publishAnnouncement: jest.fn(),
}))

const mockFindMany = prisma.platformAnnouncement.findMany as unknown as jest.Mock
const mockPublish = publishAnnouncement as unknown as jest.Mock

describe('publishScheduledAnnouncements', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPublish.mockResolvedValue({ delivered: 3, alreadyPublished: false })
  })

  // ===== CASOS NUEVOS =====
  it('solo toma los SCHEDULED cuya hora ya paso', async () => {
    mockFindMany.mockResolvedValue([])
    const now = new Date('2026-11-04T12:00:00.000Z')
    await publishScheduledAnnouncements(now)
    const { where, take } = mockFindMany.mock.calls[0][0]
    expect(where.OR).toContainEqual({ status: PlatformAnnouncementStatus.SCHEDULED, scheduledFor: { lte: now } })
    expect(take).toBeGreaterThan(0)
  })

  // Un PUBLISHED con deliveredAt nulo es un reparto que murió a la mitad (codex r2 #1): nadie más lo retoma. Se le
  // dan 10 min para no pisar una publicación que sigue en curso.
  it('el job recupera un PUBLISHED con deliveredAt null de hace más de 10 min, y no uno más reciente', async () => {
    mockFindMany.mockResolvedValue([])
    const now = new Date('2026-11-04T12:00:00.000Z')
    await publishScheduledAnnouncements(now)
    const { where } = mockFindMany.mock.calls[0][0]
    expect(where.OR).toContainEqual({
      status: PlatformAnnouncementStatus.PUBLISHED,
      deliveredAt: null,
      publishedAt: { gte: new Date('2026-10-28T12:00:00.000Z'), lte: new Date('2026-11-04T11:50:00.000Z') },
    })
  })

  it('publica cada uno y devuelve cuantos', async () => {
    mockFindMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }])
    await expect(publishScheduledAnnouncements()).resolves.toBe(2)
    expect(mockPublish).toHaveBeenCalledTimes(2)
  })

  it('si uno falla, los demas se publican igual', async () => {
    mockFindMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }])
    mockPublish.mockRejectedValueOnce(new Error('boom'))
    await expect(publishScheduledAnnouncements()).resolves.toBe(1)
    expect(mockPublish).toHaveBeenCalledTimes(2)
  })

  // ===== REGRESION =====
  it('sin nada programado no llama a publicar', async () => {
    mockFindMany.mockResolvedValue([])
    await expect(publishScheduledAnnouncements()).resolves.toBe(0)
    expect(mockPublish).not.toHaveBeenCalled()
  })
})
