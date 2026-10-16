/**
 * La bandeja de anuncios contra Postgres REAL.
 *
 * Por qué existe: el experimento pg-boss vs colas caseras (16-oct-2026,
 * `docs/investigaciones/pgboss-vs-colas-caseras/veredicto.md` del workspace) encontró dos defectos que las pruebas
 * unitarias con mocks no podían ver:
 *   1. `deliverClaimed` hace findFirst→create del aviso sin candado: dos workers sobre la misma persona (lease vencido,
 *      deploy solapado) crean DOS avisos del mismo anuncio.
 *   2. Una entrega cuyo proceso muere 5 veces queda PENDING con attempts=5 para siempre: el reclamo ya no la toma y
 *      nada la marca como fallida, así que el alcance del anuncio nunca la cuenta.
 *
 * Correr (base desechable; nunca av-db-25):
 *   TEST_DATABASE_URL='postgresql://…/avoqado_anuncios_test_20261016' \
 *   npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/announcements/announcementOutbox.integration.test.ts
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import { claimDeliveries, deliverClaimed } from '@/services/announcements/announcementOutbox.service'
import { AnnouncementOutboxJob } from '@/jobs/announcementOutbox.job'

// Crea y borra datos reales: sólo corre en una base de prueba local y desechable.
const url = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(url.pathname)) {
  throw new Error('Exige una base de prueba local y desechable (p. ej. avoqado_anuncios_test_20261016).')
}

const PERSONAS = 20
const tag = `outbox-${Date.now()}`

let organizationId: string
const venueIds: string[] = []
const staffIds: string[] = []
const announcementIds: string[] = []

async function anuncio(clave: string): Promise<string> {
  const a = await prisma.platformAnnouncement.create({
    data: { title: `Anuncio ${clave}`, body: 'Cuerpo', createdBy: 'test', createdByName: 'Prueba' },
  })
  announcementIds.push(a.id)
  return a.id
}

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `Org ${tag}`, email: `${tag}@test.local`, phone: '5555555555' } })
  organizationId = org.id
  for (const v of [1, 2]) {
    const venue = await prisma.venue.create({ data: { organizationId, name: `Venue ${tag} ${v}`, slug: `${tag}-v${v}` } })
    venueIds.push(venue.id)
  }
  for (let i = 0; i < PERSONAS; i++) {
    const s = await prisma.staff.create({ data: { email: `${tag}-${i}@test.local`, firstName: 'Persona', lastName: `${i}` } })
    staffIds.push(s.id)
  }
})

afterAll(async () => {
  if (!organizationId) return
  if (announcementIds.length) {
    await prisma.notification.deleteMany({ where: { entityType: 'PlatformAnnouncement', entityId: { in: announcementIds } } })
    await prisma.platformAnnouncement.deleteMany({ where: { id: { in: announcementIds } } })
  }
  if (staffIds.length) await prisma.staff.deleteMany({ where: { id: { in: staffIds } } })
  if (venueIds.length) await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
})

describe('bandeja de anuncios (Postgres real)', () => {
  /**
   * Cada persona recibe el anuncio en sus dos sucursales; devuelve la hora del reclamo y las entregas reclamadas, por
   * sucursal y en el orden de las personas. La hora se toma DESPUÉS de crear las filas: `nextAttemptAt` nace con la hora
   * de su creación y una hora anterior no las encuentra listas.
   */
  async function entregasReclamadas(announcementId: string): Promise<{ now: Date; porSucursal: string[][] }> {
    await prisma.platformAnnouncementDelivery.createMany({
      data: staffIds.flatMap(staffId => venueIds.map(venueId => ({ announcementId, staffId, venueId }))),
    })
    const now = new Date()
    const ids = await claimDeliveries({ limit: 200, now })
    expect(ids).toHaveLength(PERSONAS * 2)
    const filas = await prisma.platformAnnouncementDelivery.findMany({
      where: { id: { in: ids } },
      select: { id: true, staffId: true, venueId: true },
    })
    const porSucursal = venueIds.map(venueId =>
      staffIds.map(staffId => filas.find(f => f.staffId === staffId && f.venueId === venueId)!.id),
    )
    return { now, porSucursal }
  }

  /** UN aviso por persona, y todas sus entregas SENT apuntando a ese aviso. */
  async function esperaUnAvisoPorPersona(announcementId: string) {
    const avisos = await prisma.notification.groupBy({
      by: ['recipientId'],
      where: { entityType: 'PlatformAnnouncement', entityId: announcementId },
      _count: { _all: true },
    })
    expect(avisos).toHaveLength(PERSONAS)
    expect(avisos.filter(a => a._count._all !== 1)).toEqual([])

    const entregas = await prisma.platformAnnouncementDelivery.findMany({ where: { announcementId } })
    expect(entregas.every(e => e.status === 'SENT')).toBe(true)
    const avisoDe = new Map(
      (
        await prisma.notification.findMany({
          where: { entityType: 'PlatformAnnouncement', entityId: announcementId },
          select: { id: true, recipientId: true },
        })
      ).map(n => [n.recipientId, n.id]),
    )
    expect(entregas.filter(e => e.notificationId !== avisoDe.get(e.staffId))).toEqual([])
  }

  // 🔴 Defecto 1, la carrera que sólo cierra el CANDADO. Dos workers, cada uno con las entregas de UNA sucursal, llegan
  // a la vez a la misma persona: filas distintas, así que los dos CAS casan, y sin candado los dos pasan el findFirst
  // y crean dos avisos (sabotaje del 16-oct: sin el candado, esta prueba truena).
  it('dos workers con sucursales distintas de la misma persona no duplican su aviso', async () => {
    const announcementId = await anuncio('dos-sucursales')
    const {
      now,
      porSucursal: [deLaSucursal1, deLaSucursal2],
    } = await entregasReclamadas(announcementId)

    await Promise.all([deliverClaimed(deLaSucursal1, { now }), deliverClaimed(deLaSucursal2, { now })])

    await esperaUnAvisoPorPersona(announcementId)
  })

  // 🔴 Defecto 1, el lease vencido con el primer worker vivo: los dos entregan la MISMA fila. Lo cubren dos capas: el
  // candado (el segundo espera y reusa el aviso del primero) y la transacción (si su CAS no casa, el aviso que creó se
  // deshace). Sin ninguna de las dos se duplica: era el RED del 16-oct.
  it('dos workers con la misma entrega no duplican el aviso', async () => {
    const announcementId = await anuncio('misma-fila')
    const { now, porSucursal } = await entregasReclamadas(announcementId)
    const ids = porSucursal.flat()

    await Promise.all([deliverClaimed(ids, { now }), deliverClaimed(ids, { now })])

    await esperaUnAvisoPorPersona(announcementId)
  })

  // 🔴 Defecto 2. El proceso murió a media entrega en los 5 intentos: la fila quedó PENDING, attempts=5 y el lease
  // vencido. Nadie la va a volver a tomar; tiene que quedar FAILED con la razón, no «pendiente» para siempre.
  it('una entrega que agotó sus intentos sin respuesta queda FAILED, no PENDING para siempre', async () => {
    const announcementId = await anuncio('agotada')
    const haceRato = new Date(Date.now() - 10 * 60 * 1000)
    const agotada = await prisma.platformAnnouncementDelivery.create({
      data: {
        announcementId,
        staffId: staffIds[0],
        venueId: venueIds[0],
        status: 'PENDING',
        attempts: 5,
        nextAttemptAt: haceRato,
        leaseUntil: haceRato,
      },
    })

    await new AnnouncementOutboxJob().processNow(new Date())

    const despues = await prisma.platformAnnouncementDelivery.findUniqueOrThrow({ where: { id: agotada.id } })
    expect(despues.status).toBe('FAILED')
    expect(despues.leaseUntil).toBeNull()
    expect(despues.lastError).toMatch(/intentos/)
  })

  // Con el lease todavía vigente, el quinto intento sigue vivo: no se le marca como fallido a media entrega.
  it('no retira una entrega cuyo quinto intento sigue con lease vigente', async () => {
    const announcementId = await anuncio('quinto-vivo')
    const enCinco = new Date(Date.now() + 5 * 60 * 1000)
    const viva = await prisma.platformAnnouncementDelivery.create({
      data: {
        announcementId,
        staffId: staffIds[1],
        venueId: venueIds[0],
        status: 'PENDING',
        attempts: 5,
        nextAttemptAt: new Date(Date.now() - 60 * 1000),
        leaseUntil: enCinco,
      },
    })

    await new AnnouncementOutboxJob().processNow(new Date())

    const despues = await prisma.platformAnnouncementDelivery.findUniqueOrThrow({ where: { id: viva.id } })
    expect(despues.status).toBe('PENDING')
    expect(despues.leaseUntil).toEqual(viva.leaseUntil)
  })
})
