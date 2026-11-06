/**
 * Aviso de que se acaba una prueba REGALADA del plan (D2, 5-nov-2026) contra Postgres REAL. Las de unit no pueden probar
 * lo que sólo contesta la base: que la comparación columna contra columna (`freeTrialNoticeFor` ≠ `endDate`) deja fuera a
 * las ya avisadas, que `getPlanState` ve esta prueba como cortesía, que el sello es la FECHA anunciada y que alargar la
 * prueba vuelve a avisar.
 *
 * La base puede traer pruebas de otras suites: todo se lee por el correo de ESTE archivo.
 *
 * Correr (base desechable; nunca av-db-25):
 *   TEST_DATABASE_URL='postgresql://<user>:<password>@localhost:5432/<base desechable>' \
 *     npx jest --selectProjects=integration --runTestsByPath tests/integration/jobs/aviso-prueba-regalada.integration.test.ts --ci
 */
import { VenueStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import emailService from '@/services/email.service'
import { PlanRenewalReminderJob } from '@/jobs/plan-renewal-reminder.job'

const suffix = `prg${Date.now()}`
const DIA = 86400000
const organizationIds: string[] = []
const venueIds: string[] = []
let planProId: string
let n = 0

const enviados: { to: string; subject: string }[] = []
let sendSpy: jest.SpyInstance

const job = new PlanRenewalReminderJob() as unknown as { avisarPruebasSinTarjeta(): Promise<void> }
const correosA = (to: string) => enviados.filter(e => e.to === to)

async function negocioConPrueba(status: VenueStatus, finEnDias: number) {
  const key = `${suffix}${++n}`
  const org = await prisma.organization.create({ data: { name: `Org ${key}`, email: `org-${key}@test.mx`, phone: '5555555555' } })
  organizationIds.push(org.id)
  const email = `dueno-${key}@test.mx`
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: `Taqueria ${key}`, slug: `prg-${key}`, status, email, timezone: 'America/Mexico_City' },
  })
  venueIds.push(venue.id)
  const fin = new Date(Date.now() + finEnDias * DIA)
  const vf = await prisma.venueFeature.create({
    data: {
      venueId: venue.id,
      featureId: planProId,
      monthlyPrice: 999,
      active: true,
      startDate: new Date(Date.now() - 22 * DIA),
      endDate: fin,
    },
    select: { id: true },
  })
  return { email, fin, vfId: vf.id }
}

const sello = async (vfId: string) =>
  (await prisma.venueFeature.findUniqueOrThrow({ where: { id: vfId }, select: { freeTrialNoticeFor: true } })).freeTrialNoticeFor

beforeAll(async () => {
  planProId = (
    await prisma.feature.upsert({
      where: { code: 'PLAN_PRO' },
      update: {},
      create: { code: 'PLAN_PRO', name: 'Plan Pro', category: 'OPERATIONS', monthlyPrice: 999 },
    })
  ).id
  sendSpy = jest.spyOn(emailService, 'sendEmail').mockImplementation(async o => {
    enviados.push({ to: String(o.to), subject: o.subject })
    return true
  })
})

afterAll(async () => {
  sendSpy.mockRestore()
  // Todo borrado va por ids de ESTE archivo: un `where` con un valor undefined vaciaría la tabla.
  if (venueIds.length) {
    await prisma.venueFeature.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
  }
  if (organizationIds.length) await prisma.organization.deleteMany({ where: { id: { in: organizationIds }, venues: { none: {} } } })
})

describe('aviso de prueba regalada contra Postgres', () => {
  it('avisa una vez, sella la fecha anunciada, no repite y vuelve a avisar si se alarga', async () => {
    const { email, fin, vfId } = await negocioConPrueba(VenueStatus.ACTIVE, 8)

    await job.avisarPruebasSinTarjeta()
    expect(correosA(email)).toHaveLength(1)
    expect(correosA(email)[0].subject).toMatch(/^Tu prueba gratis de Avoqado Pro termina el /)
    expect((await sello(vfId))?.getTime()).toBe(fin.getTime())

    // Ya avisada: la consulta (columna contra columna) la deja fuera.
    await job.avisarPruebasSinTarjeta()
    expect(correosA(email)).toHaveLength(1)

    // El SUPERADMIN la alarga medio día (una prueba corta ya avisada): la fecha anunciada ya no es la de la prueba → aviso nuevo con la fecha nueva.
    const nuevoFin = new Date(fin.getTime() + 0.5 * DIA)
    await prisma.venueFeature.update({ where: { id: vfId }, data: { endDate: nuevoFin } })
    await job.avisarPruebasSinTarjeta()
    expect(correosA(email)).toHaveLength(2)
    expect((await sello(vfId))?.getTime()).toBe(nuevoFin.getTime())
  })

  it('un negocio cerrado no recibe «sigue funcionando con el plan Gratis»', async () => {
    const { email, vfId } = await negocioConPrueba(VenueStatus.CLOSED, 8)
    await job.avisarPruebasSinTarjeta()
    expect(correosA(email)).toHaveLength(0)
    expect(await sello(vfId)).toBeNull()
  })

  it('una prueba que vence en más de 9 días no se avisa todavía', async () => {
    const { email } = await negocioConPrueba(VenueStatus.ACTIVE, 12)
    await job.avisarPruebasSinTarjeta()
    expect(correosA(email)).toHaveLength(0)
  })
})
