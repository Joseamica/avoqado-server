import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import { updateAnnouncement } from '@/services/announcements/announcement.service'

const url = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(url.pathname)) {
  throw new Error('Exige una base de prueba local y desechable.')
}

const ids: string[] = []

afterAll(async () => {
  if (ids.length) await prisma.platformAnnouncement.deleteMany({ where: { id: { in: ids } } })
})

describe('anuncio visible: dos parciales simultáneos (Postgres real)', () => {
  it('uno apaga el banner y otro la campana: uno falla y el anuncio queda visible', async () => {
    const a = await prisma.platformAnnouncement.create({
      data: {
        title: 'FULLTEST visible',
        body: 'x',
        createdBy: 'test',
        createdByName: 'Prueba',
        showAsBanner: true,
        showAsModal: false,
        showInInbox: true,
        sendEmail: false,
      },
    })
    ids.push(a.id)

    const r = await Promise.allSettled([
      updateAnnouncement(a.id, { showAsBanner: false }),
      updateAnnouncement(a.id, { showInInbox: false }),
    ])

    expect(r.filter(x => x.status === 'fulfilled')).toHaveLength(1)
    const fallo = r.find(x => x.status === 'rejected') as PromiseRejectedResult
    expect(String(fallo.reason.message)).toMatch(/no se vería en ningún lado/)
    const final = await prisma.platformAnnouncement.findUniqueOrThrow({ where: { id: a.id } })
    expect(final.showAsBanner || final.showAsModal || final.showInInbox || final.sendEmail).toBe(true)
  })
})
