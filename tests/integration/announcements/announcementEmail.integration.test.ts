/**
 * Correo de los anuncios contra Postgres REAL: el SQL del encolado (ventana de 24 h desde `deliveredAt`, selección que avanza
 * sola), `SKIP LOCKED` con dos trabajadores, y el candado del tope del día (dos trabajadores con 39 de 40 reservados).
 * Resend es un doble: lo que se mide es cuántas veces se le llama por persona.
 *
 * Base desechable (nunca av-db-25): en la nube la crea avq-verify, como el CI.
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import { env } from '@/config/env'
import emailService from '@/services/email.service'
import {
  claimAnnouncementEmails,
  enqueuePendingAnnouncementEmails,
  sendClaimedAnnouncementEmails,
} from '@/services/announcements/announcementEmail.service'
import { publishAnnouncement } from '@/services/announcements/announcement.service'
import { publishScheduledAnnouncements } from '@/jobs/publishScheduledAnnouncements.job'

jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmailWithResult: jest.fn() } }))
const mockSend = emailService.sendEmailWithResult as unknown as jest.Mock

const url = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(url.pathname)) {
  throw new Error('Exige una base de prueba local y desechable.')
}

const HORA = 60 * 60 * 1000
const tag = `aemail-${Date.now()}`
let organizationId: string
const venueIds: string[] = []
const staffIds: string[] = []
const announcementIds: string[] = []

async function anuncio(over: Record<string, unknown> = {}): Promise<string> {
  const a = await prisma.platformAnnouncement.create({
    data: {
      title: `Anuncio ${tag}`,
      body: 'Cuerpo',
      createdBy: 'test',
      createdByName: 'Prueba',
      status: 'PUBLISHED',
      sendEmail: true,
      publishedAt: new Date(),
      deliveredAt: new Date(),
      ...over,
    },
  })
  announcementIds.push(a.id)
  return a.id
}

/** Entregas del buzón (persona × negocio), creadas en orden: la primera de cada persona es su negocio del correo. */
async function entregas(announcementId: string, pares: Array<[number, number]>) {
  for (const [s, v] of pares) {
    await prisma.platformAnnouncementDelivery.create({ data: { announcementId, staffId: staffIds[s], venueId: venueIds[v] } })
  }
}

const correosDe = (announcementId: string) =>
  prisma.platformAnnouncementEmail.findMany({ where: { announcementId }, orderBy: { staffId: 'asc' }, take: 100 })

/** Deja vacía la cola de lo que otras pruebas encolaron, para que cada una cuente sólo lo suyo. */
async function vaciarPendientes() {
  await prisma.platformAnnouncementEmail.updateMany({ where: { status: 'PENDING' }, data: { status: 'FAILED' } })
}

beforeAll(async () => {
  env.BASE_URL = 'https://api.test.local'
  const org = await prisma.organization.create({ data: { name: `Org ${tag}`, email: `${tag}@correo-anuncios.mx`, phone: '5555555555' } })
  organizationId = org.id
  for (const v of [1, 2]) {
    const venue = await prisma.venue.create({ data: { organizationId, name: `Venue ${tag} ${v}`, slug: `${tag}-v${v}` } })
    venueIds.push(venue.id)
  }
  for (let i = 0; i < 4; i++) {
    const s = await prisma.staff.create({ data: { email: `${tag}-${i}@correo-anuncios.mx`, firstName: 'Persona', lastName: `${i}` } })
    staffIds.push(s.id)
  }
  process.env.CRM_CORREO_PRUEBAS = staffIds.map((_, i) => `${tag}-${i}@correo-anuncios.mx`).join(',')
})

beforeEach(() => {
  mockSend.mockReset()
  mockSend.mockResolvedValue({ ok: true, resendId: 'r', transient: false })
})

afterAll(async () => {
  delete process.env.CRM_CORREO_PRUEBAS
  if (!organizationId) return
  if (announcementIds.length) {
    await prisma.platformAnnouncement.deleteMany({ where: { id: { in: announcementIds } } })
  }
  if (staffIds.length) await prisma.staff.deleteMany({ where: { id: { in: staffIds } } })
  if (venueIds.length) await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
})

describe('correo de anuncios: encolar (Postgres real)', () => {
  it('encolar crea una fila por persona aunque tenga dos entregas, con el negocio de su primera entrega', async () => {
    const a = await anuncio()
    await entregas(a, [
      [0, 1],
      [0, 0],
      [1, 0],
    ])
    await enqueuePendingAnnouncementEmails(new Date())
    const filas = await correosDe(a)
    expect(filas).toHaveLength(2)
    expect(filas.find(f => f.staffId === staffIds[0])?.venueId).toBe(venueIds[1])
    expect(filas.every(f => /^c[a-z0-9]{24}$/.test(f.id))).toBe(true)
  })

  it('encolar dos veces no duplica', async () => {
    const a = await anuncio()
    await entregas(a, [
      [0, 0],
      [1, 0],
    ])
    await enqueuePendingAnnouncementEmails(new Date())
    await enqueuePendingAnnouncementEmails(new Date())
    expect(await correosDe(a)).toHaveLength(2)
  })

  it('un anuncio con deliveredAt null no se encola', async () => {
    const a = await anuncio({ deliveredAt: null })
    await entregas(a, [[0, 0]])
    await enqueuePendingAnnouncementEmails(new Date())
    expect(await correosDe(a)).toHaveLength(0)
  })

  it('una entrega añadida después de la primera vuelta también recibe correo', async () => {
    const a = await anuncio()
    await entregas(a, [[0, 0]])
    await enqueuePendingAnnouncementEmails(new Date())
    expect(await correosDe(a)).toHaveLength(1)
    await entregas(a, [[2, 0]])
    await enqueuePendingAnnouncementEmails(new Date())
    expect((await correosDe(a)).map(f => f.staffId).sort()).toEqual([staffIds[0], staffIds[2]].sort())
  })

  it('un anuncio repartido hace 25 h ya no se revisa', async () => {
    const a = await anuncio({ publishedAt: new Date(Date.now() - 25 * HORA), deliveredAt: new Date(Date.now() - 25 * HORA) })
    await entregas(a, [[0, 0]])
    await enqueuePendingAnnouncementEmails(new Date())
    expect(await correosDe(a)).toHaveLength(0)
  })

  it('uno publicado hace 30 h pero recuperado (deliveredAt) hace 1 h sí se encola', async () => {
    const a = await anuncio({ publishedAt: new Date(Date.now() - 30 * HORA), deliveredAt: new Date(Date.now() - HORA) })
    await entregas(a, [[0, 0]])
    await enqueuePendingAnnouncementEmails(new Date())
    expect(await correosDe(a)).toHaveLength(1)
  })

  it('con 21 anuncios pendientes, dos vueltas encolan los 21', async () => {
    const ids: string[] = []
    for (let i = 0; i < 21; i++) {
      const a = await anuncio()
      await entregas(a, [[3, 0]])
      ids.push(a)
    }
    await enqueuePendingAnnouncementEmails(new Date())
    const primera = await prisma.platformAnnouncementEmail.count({ where: { announcementId: { in: ids } } })
    expect(primera).toBe(20)
    await enqueuePendingAnnouncementEmails(new Date())
    expect(await prisma.platformAnnouncementEmail.count({ where: { announcementId: { in: ids } } })).toBe(21)
  })

  it('los destinatarios son los de las entregas, aunque la audiencia haya cambiado', async () => {
    const a = await anuncio({ audienceRoles: ['OWNER'], targetVenueIds: [venueIds[0]] })
    await entregas(a, [[1, 1]])
    // La audiencia cambia después del reparto: ya no alcanzaría a esa persona ni a ese negocio.
    await prisma.platformAnnouncement.update({ where: { id: a }, data: { audienceRoles: ['WAITER'], targetVenueIds: ['otro'] } })
    await enqueuePendingAnnouncementEmails(new Date())
    const filas = await correosDe(a)
    expect(filas.map(f => [f.staffId, f.venueId])).toEqual([[staffIds[1], venueIds[1]]])
  })

  it('publicar con sendEmail=false no encola', async () => {
    const a = await anuncio({ status: 'DRAFT', sendEmail: false, publishedAt: null, deliveredAt: null, targetVenueIds: [venueIds[0]] })
    await publishAnnouncement(a)
    await entregas(a, [[0, 0]])
    await enqueuePendingAnnouncementEmails(new Date())
    expect(await correosDe(a)).toHaveLength(0)
  })

  it('publicar con sendEmail=true tampoco encola por sí mismo: lo encola el job', async () => {
    const a = await anuncio({ status: 'DRAFT', publishedAt: null, deliveredAt: null, targetVenueIds: [venueIds[0]] })
    await publishAnnouncement(a)
    expect(await correosDe(a)).toHaveLength(0)
  })

  it('el job recupera un PUBLISHED con deliveredAt null de hace 11 min y no uno de hace 5 ni uno de hace 8 días', async () => {
    const viejo = await anuncio({ deliveredAt: null, publishedAt: new Date(Date.now() - 11 * 60 * 1000), targetVenueIds: [venueIds[0]] })
    const reciente = await anuncio({ deliveredAt: null, publishedAt: new Date(Date.now() - 5 * 60 * 1000), targetVenueIds: [venueIds[0]] })
    const muyViejo = await anuncio({ deliveredAt: null, publishedAt: new Date(Date.now() - 8 * 24 * HORA), targetVenueIds: [venueIds[0]] })
    await publishScheduledAnnouncements(new Date())
    const [v, r] = await Promise.all(
      [viejo, reciente].map(id => prisma.platformAnnouncement.findUniqueOrThrow({ where: { id }, select: { deliveredAt: true } })),
    )
    expect(v.deliveredAt).not.toBeNull()
    expect(r.deliveredAt).toBeNull()
    // Uno de hace 8 días no se recupera: se repartiría a la audiencia de hoy.
    const mv = await prisma.platformAnnouncement.findUniqueOrThrow({ where: { id: muyViejo }, select: { deliveredAt: true } })
    expect(mv.deliveredAt).toBeNull()
  })
})

describe('correo de anuncios: reclamar y mandar (Postgres real)', () => {
  it('dos trabajadores reclaman a la vez → cada fila se manda una sola vez', async () => {
    await vaciarPendientes()
    const a = await anuncio()
    await entregas(a, [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ])
    await enqueuePendingAnnouncementEmails(new Date())
    const now = new Date(Date.now() + 1000)
    const reloj = () => new Date('2030-01-01T12:00:00.000Z')
    const trabajador = async () =>
      sendClaimedAnnouncementEmails(await claimAnnouncementEmails({ limit: 20, now }), { now, reloj, pausaMs: 0 })

    const [r1, r2] = await Promise.all([trabajador(), trabajador()])

    expect(r1.sent + r2.sent).toBe(4)
    expect(mockSend.mock.calls.map(([o]) => o.to).sort()).toEqual(staffIds.map((_, i) => `${tag}-${i}@correo-anuncios.mx`).sort())
    expect((await correosDe(a)).every(f => f.status === 'SENT')).toBe(true)
  })

  // El lease venció con el primer trabajador vivo: los dos tienen las MISMAS filas. La marca `sendStartedAt` (escrita con CAS
  // bajo el candado) deja pasar a uno solo por fila.
  it('dos trabajadores con las mismas filas reclamadas mandan cada una una sola vez', async () => {
    await vaciarPendientes()
    const a = await anuncio()
    await entregas(a, [
      [0, 0],
      [1, 0],
      [2, 0],
    ])
    await enqueuePendingAnnouncementEmails(new Date())
    const now = new Date(Date.now() + 1000)
    const reloj = () => new Date('2030-01-02T12:00:00.000Z')
    const ids = await claimAnnouncementEmails({ limit: 20, now })
    expect(ids).toHaveLength(3)

    const [r1, r2] = await Promise.all([
      sendClaimedAnnouncementEmails(ids, { now, reloj, pausaMs: 0 }),
      sendClaimedAnnouncementEmails(ids, { now, reloj, pausaMs: 0 }),
    ])

    expect(r1.sent + r2.sent).toBe(3)
    expect(mockSend).toHaveBeenCalledTimes(3)
    expect(new Set(mockSend.mock.calls.map(([o]) => o.to)).size).toBe(3)
  })

  it('dos trabajadores con 39 reservados y tope 40: sólo uno reserva', async () => {
    await vaciarPendientes()
    env.ANNOUNCEMENT_EMAIL_DAILY_CAP = 40
    const DIA = '2031-02-03'
    const reloj = () => new Date(`${DIA}T15:00:00.000Z`)
    // 39 ya reservados ese día, en otros anuncios (una fila por persona y anuncio).
    for (let reservados = 0; reservados < 39; reservados += 4) {
      const otro = await anuncio({ deliveredAt: null })
      await prisma.platformAnnouncementEmail.createMany({
        data: staffIds
          .slice(0, Math.min(4, 39 - reservados))
          .map(staffId => ({ announcementId: otro, staffId, venueId: venueIds[0], status: 'SENT' as const, capDay: DIA })),
      })
    }
    expect(await prisma.platformAnnouncementEmail.count({ where: { capDay: DIA } })).toBe(39)

    const a = await anuncio({ deliveredAt: null })
    await prisma.platformAnnouncementEmail.createMany({
      data: [0, 1].map(i => ({ announcementId: a, staffId: staffIds[i], venueId: venueIds[0] })),
    })
    const now = new Date(Date.now() + 1000)
    const [ids1, ids2] = await Promise.all([claimAnnouncementEmails({ limit: 1, now }), claimAnnouncementEmails({ limit: 1, now })])
    expect(new Set([...ids1, ...ids2].map(c => c.id)).size).toBe(2)

    await Promise.all([
      sendClaimedAnnouncementEmails(ids1, { now, reloj, pausaMs: 0 }),
      sendClaimedAnnouncementEmails(ids2, { now, reloj, pausaMs: 0 }),
    ])

    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(await prisma.platformAnnouncementEmail.count({ where: { capDay: DIA } })).toBe(40)
    const filas = await correosDe(a)
    expect(filas.map(f => f.status).sort()).toEqual(['PENDING', 'SENT'])
    const esperando = filas.find(f => f.status === 'PENDING')!
    expect(esperando.attempts).toBe(0)
    expect(esperando.nextAttemptAt.toISOString()).toBe('2031-02-04T00:00:00.000Z')
  })

  // B1: A se retrasó hasta vencer su lease y B reclamó la misma fila. A, con su tupla vieja, no puede escribir nada sobre
  // la fila de B (si la adoptara, su «baja» o su reintento borrarían el envío de B).
  it('un trabajador rezagado no escribe sobre la fila que ya reclamó otro', async () => {
    await vaciarPendientes()
    const a = await anuncio({ deliveredAt: null })
    await prisma.platformAnnouncementEmail.create({ data: { announcementId: a, staffId: staffIds[0], venueId: venueIds[0] } })
    const t0 = new Date(Date.now() + 1000)
    const deA = await claimAnnouncementEmails({ limit: 20, now: t0 })
    expect(deA).toHaveLength(1)
    // Vence el lease de A (5 min) y B reclama.
    const t1 = new Date(t0.getTime() + 6 * 60 * 1000)
    const deB = await claimAnnouncementEmails({ limit: 20, now: t1 })
    expect(deB.map(c => c.id)).toEqual(deA.map(c => c.id))
    expect(deB[0].attempts).toBe(2)
    const antes = await prisma.platformAnnouncementEmail.findUniqueOrThrow({ where: { id: deA[0].id } })

    // A llega tarde con un error de configuración: si adoptara la fila, la devolvería a PENDING sin lease.
    const base = env.BASE_URL
    env.BASE_URL = undefined
    await expect(sendClaimedAnnouncementEmails(deA, { now: t1, reloj: () => t1, pausaMs: 0 })).resolves.toEqual({
      sent: 0,
      skipped: 0,
      failed: 0,
    })
    env.BASE_URL = base
    expect(await prisma.platformAnnouncementEmail.findUniqueOrThrow({ where: { id: deA[0].id } })).toEqual(antes)

    // B sigue con su reclamo intacto y manda una sola vez.
    await expect(sendClaimedAnnouncementEmails(deB, { now: t1, reloj: () => t1, pausaMs: 0 })).resolves.toMatchObject({ sent: 1 })
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('una fila con sendStartedAt y el lease vencido queda FAILED INCIERTO al reclamar, sin mandarse', async () => {
    await vaciarPendientes()
    const a = await anuncio({ deliveredAt: null })
    const hace = new Date(Date.now() - 10 * 60 * 1000)
    const fila = await prisma.platformAnnouncementEmail.create({
      data: { announcementId: a, staffId: staffIds[0], venueId: venueIds[0], attempts: 1, leaseUntil: hace, sendStartedAt: hace },
    })
    const ids = await claimAnnouncementEmails({ limit: 20, now: new Date() })
    expect(ids.map(c => c.id)).not.toContain(fila.id)
    const despues = await prisma.platformAnnouncementEmail.findUniqueOrThrow({ where: { id: fila.id } })
    expect(despues.status).toBe('FAILED')
    expect(despues.lastError).toContain('INCIERTO')
    expect(mockSend).not.toHaveBeenCalled()
  })
})
