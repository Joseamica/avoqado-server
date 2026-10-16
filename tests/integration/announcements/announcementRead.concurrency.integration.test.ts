import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import { recordDismiss, recordOpen } from '@/services/announcements/announcementRead.service'
import { ForbiddenError } from '@/errors/AppError'

const url = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(url.pathname)) {
  throw new Error('Exige una base de prueba local y desechable.')
}

const tag = `announcement-open-${Date.now()}`
let organizationId: string
const venueIds: string[] = []
const staffIds: string[] = []
const announcementIds: string[] = []

async function deliveredAnnouncement() {
  const announcement = await prisma.platformAnnouncement.create({
    data: { title: `FULLTEST ${tag}`, body: 'Prueba de aperturas', createdBy: staffIds[0], createdByName: 'Prueba' },
  })
  announcementIds.push(announcement.id)
  await prisma.platformAnnouncementDelivery.create({
    data: { announcementId: announcement.id, staffId: staffIds[0], venueId: venueIds[0] },
  })
  return announcement.id
}

beforeAll(async () => {
  const organization = await prisma.organization.create({
    data: { name: tag, email: `${tag}@test.local`, phone: '5555555555' },
  })
  organizationId = organization.id
  for (const index of [0, 1]) {
    const venue = await prisma.venue.create({
      data: { organizationId, name: `${tag}-${index}`, slug: `${tag}-${index}` },
    })
    venueIds.push(venue.id)
    const staff = await prisma.staff.create({
      data: { email: `${tag}-${index}@test.local`, firstName: 'Prueba', lastName: `${index}` },
    })
    staffIds.push(staff.id)
  }
})

afterAll(async () => {
  if (!organizationId) return
  if (announcementIds.length) await prisma.platformAnnouncement.deleteMany({ where: { id: { in: announcementIds } } })
  if (staffIds.length) await prisma.staff.deleteMany({ where: { id: { in: staffIds } } })
  if (venueIds.length) await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
})

describe('aperturas de anuncios concurrentes (Postgres real)', () => {
  it('acepta todas las primeras aperturas simultáneas y devuelve un único registro', async () => {
    const announcementId = await deliveredAnnouncement()
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => recordOpen(announcementId, staffIds[0], venueIds[0])))

    expect(attempts.filter(attempt => attempt.status === 'rejected')).toEqual([])
    const ids = attempts.flatMap(attempt => (attempt.status === 'fulfilled' ? [attempt.value.id] : []))
    expect(new Set(ids).size).toBe(1)
    expect(await prisma.platformAnnouncementClick.count({ where: { announcementId, staffId: staffIds[0] } })).toBe(1)
  })

  it('reabrir conserva las fechas y la sucursal de la primera interacción', async () => {
    const announcementId = await deliveredAnnouncement()
    const openedAt = new Date(Date.now() - 60_000)
    const ctaAt = new Date(openedAt.getTime() + 1000)
    const dismissedAt = new Date(openedAt.getTime() + 2000)
    const original = await prisma.platformAnnouncementClick.create({
      data: { announcementId, staffId: staffIds[0], venueId: venueIds[0], openedAt, ctaAt, dismissedAt },
    })

    const reopened = await recordOpen(announcementId, staffIds[0], venueIds[1])

    expect(reopened).toEqual(original)
    expect(await prisma.platformAnnouncementClick.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original)
  })

  it('abrir y cerrar por primera vez a la vez conserva el cierre y una sola fila', async () => {
    const announcementId = await deliveredAnnouncement()
    const attempts = await Promise.allSettled([
      recordOpen(announcementId, staffIds[0], venueIds[0]),
      recordDismiss(announcementId, staffIds[0], venueIds[0]),
    ])

    expect(attempts.filter(attempt => attempt.status === 'rejected')).toEqual([])
    expect(await prisma.platformAnnouncementClick.count({ where: { announcementId, staffId: staffIds[0] } })).toBe(1)
    const click = await prisma.platformAnnouncementClick.findUniqueOrThrow({
      where: { announcementId_staffId: { announcementId, staffId: staffIds[0] } },
    })
    expect(click.dismissedAt).not.toBeNull()
  })

  it('sigue rechazando a una persona sin entrega y no crea su apertura', async () => {
    const announcementId = await deliveredAnnouncement()

    await expect(recordOpen(announcementId, staffIds[1], venueIds[0])).rejects.toBeInstanceOf(ForbiddenError)

    expect(await prisma.platformAnnouncementClick.count({ where: { announcementId, staffId: staffIds[1] } })).toBe(0)
  })
})
