import { uploadImage, create } from '../../../../src/controllers/superadmin/announcement.superadmin.controller'
import { uploadAnnouncementImage } from '../../../../src/services/announcements/announcementImage.service'
import { createAnnouncement } from '../../../../src/services/announcements/announcement.service'

jest.mock('@/services/announcements/announcementImage.service', () => ({ uploadAnnouncementImage: jest.fn() }))
jest.mock('../../../../src/services/announcements/announcementImage.service', () => ({ uploadAnnouncementImage: jest.fn() }))
jest.mock('../../../../src/services/announcements/announcement.service', () => ({
  listAnnouncements: jest.fn(),
  createAnnouncement: jest.fn(),
  updateAnnouncement: jest.fn(),
  scheduleAnnouncement: jest.fn(),
  archiveAnnouncement: jest.fn(),
  publishAnnouncement: jest.fn(),
}))
jest.mock('../../../../src/services/announcements/audience.service', () => ({ countAudience: jest.fn() }))
jest.mock('../../../../src/services/announcements/announcementRead.service', () => ({ getAnnouncementMetrics: jest.fn() }))
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { staff: { findUnique: jest.fn().mockResolvedValue({ firstName: 'A', lastName: 'B' }) } },
}))

const mockUpload = uploadAnnouncementImage as unknown as jest.Mock
const file = { buffer: Buffer.from([1]), mimetype: 'image/png', originalname: 'a.png' }

function run(body: Record<string, unknown>, withFile = true) {
  const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }
  const next = jest.fn()
  return uploadImage({ file: withFile ? file : undefined, body } as any, res, next).then(() => ({ res, next }))
}

describe('uploadImage — medidas del multipart', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUpload.mockResolvedValue({ url: 'https://x/y.png', width: 1600, height: 900 })
  })

  it('convierte las medidas (strings) en enteros y las devuelve', async () => {
    const { res } = await run({ width: '1600', height: '900' })
    expect(mockUpload).toHaveBeenCalledWith(file.buffer, 'image/png', 'a.png', { width: 1600, height: 900 })
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { url: 'https://x/y.png', width: 1600, height: 900 } })
  })

  it('sin medidas sigue funcionando', async () => {
    await run({})
    expect(mockUpload).toHaveBeenCalledWith(file.buffer, 'image/png', 'a.png', undefined)
  })

  it.each([['0', '10'], ['abc', '10'], ['10', '-5'], ['1.5', '10'], ['10001', '10'], ['10', undefined]])(
    'width %s / height %s inválidos → 400',
    async (width, height) => {
      const { next } = await run({ width, height })
      expect(next.mock.calls[0][0].statusCode).toBe(400)
      expect(mockUpload).not.toHaveBeenCalled()
    },
  )
})

describe('create — esquema', () => {
  it('acepta medidas en image y gallery y las banderas nuevas', async () => {
    const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() }
    const next = jest.fn()
    ;(createAnnouncement as jest.Mock).mockResolvedValue({ id: 'a1' })
    await create(
      {
        authContext: { userId: 'u1' },
        body: {
          title: 't',
          body: 'b',
          audienceRoles: ['OWNER'],
          showInInbox: true,
          sendEmail: true,
          contentBlocks: [
            { type: 'image', url: 'https://x/a.png', alt: 'a', width: 800, height: 600 },
            { type: 'gallery', images: [{ url: 'https://x/b.png', alt: 'b', width: 10, height: 20 }] },
          ],
        },
      } as any,
      res,
      next,
    )
    expect(next).not.toHaveBeenCalled()
    expect((createAnnouncement as jest.Mock).mock.calls[0][0]).toMatchObject({ showInInbox: true, sendEmail: true })
  })
})
