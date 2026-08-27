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
    await publishScheduledAnnouncements()
    const where = mockFindMany.mock.calls[0][0].where
    expect(where.status).toBe(PlatformAnnouncementStatus.SCHEDULED)
    expect(where.scheduledFor.lte).toBeInstanceOf(Date)
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
