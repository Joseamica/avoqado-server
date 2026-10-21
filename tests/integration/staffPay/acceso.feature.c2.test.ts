// tests/integration/staffPay/acceso.feature.c2.test.ts
// Pago al personal por plan (fase 3, Bloque C). C2: la puerta pasa del módulo a la función SERVICE_PAY del plan (con el
// resolver REAL de funciones) y lo de dinero exige además la activación explícita (spec fase 3 §7.1, §10; Review Focus 5).
// Separado de acceso.feature.test.ts (C1b) en la revisión de C2: el archivo pasaba de 600 líneas.
import prisma from '@/utils/prismaClient'

// C2: el permiso no es lo que se prueba (la vista previa del cierre lo pide en cada sede); el plan y la activación, REALES.
jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  tienePermisoEn: jest.fn(async () => true),
}))

import {
  organizacionActivada,
  organizacionDeLaSedeActivada,
  sedesConServicePay,
  venueHasServicePayAccess,
} from '@/services/dashboard/staffPay/acceso'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { borrarMundo, crearMundo, crearSede, Mundo } from './_mundo'
import { activar } from './_ventas'

const stamp = `${Date.now()}${process.pid}`

/** Un acceso de función SERVICE_PAY (la suelta de $199 o el plan) alrededor del reloj REAL: el resolver usa `new Date()`. */
const acceso = (venueId: string, sourceId: string) =>
  prisma.capabilityGrant.create({
    data: {
      venueId,
      featureCode: 'SERVICE_PAY',
      sourceId,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 86_400_000),
    },
  })

describe('C2 — activación explícita (spec fase 3 §7.1, §10, Review Focus 5)', () => {
  it('un negocio con el plan pero sin activar no tiene pago al personal prendido; al activar, sí', async () => {
    const key = `pf3a${stamp}`
    const org = await prisma.organization.create({ data: { name: key, email: `${key}@example.test`, phone: '5550000000' } })
    const venueId = (await prisma.venue.create({ data: { name: key, slug: key, organizationId: org.id } })).id
    await acceso(venueId, `qa-${key}`)
    try {
      await expect(venueHasServicePayAccess(venueId)).resolves.toBe(true) // el plan, sí
      await expect(organizacionActivada(org.id)).resolves.toBe(false) // pero no está activado
      await expect(organizacionDeLaSedeActivada(venueId)).resolves.toBe(false)
      await prisma.organization.update({ where: { id: org.id }, data: { staffPayStartDate: fechaComoDbDate('2026-10-01') } })
      await expect(organizacionActivada(org.id)).resolves.toBe(true)
      await expect(organizacionDeLaSedeActivada(venueId)).resolves.toBe(true)
      await expect(organizacionDeLaSedeActivada('no-existe')).resolves.toBe(false)
    } finally {
      await prisma.capabilityGrant.deleteMany({ where: { venueId } })
      await prisma.venue.delete({ where: { id: venueId } })
      await prisma.organization.delete({ where: { id: org.id } })
    }
  })
})

describe('C2 — el lote de sedes con el plan, con el resolver REAL de funciones (pre-flight filas 12 y 14)', () => {
  it('entran: la del acceso de función, la exenta, la demo y la de prueba; no entran: la sin plan ni la del grant revocado', async () => {
    const key = `pf3l${stamp}`
    const org = await prisma.organization.create({ data: { name: key, email: `${key}@example.test`, phone: '5550000000' } })
    const sede = async (s: string, data: Record<string, unknown> = {}) =>
      (await prisma.venue.create({ data: { name: `${key}${s}`, slug: `${key}${s}`, organizationId: org.id, ...data } })).id
    const plano = await sede('plano')
    const conAcceso = await sede('acceso')
    const exenta = await sede('exenta', { seatCapExempt: true })
    const demo = await sede('demo', { status: 'LIVE_DEMO' })
    const prueba = await sede('prueba', { status: 'TRIAL' })
    const revocada = await sede('revocada')
    await acceso(conAcceso, `qa-${key}`)
    await acceso(revocada, `qa-${key}`)
    await prisma.capabilityGrant.updateMany({ where: { venueId: revocada }, data: { revokedAt: new Date() } })
    // Una organización exenta: TODAS sus sedes, también las que abra después.
    const orgExenta = await prisma.organization.create({
      data: { name: `${key}x`, email: `${key}x@example.test`, phone: '5550000000', seatCapExempt: true },
    })
    const deLaExenta = (await prisma.venue.create({ data: { name: `${key}x1`, slug: `${key}x1`, organizationId: orgExenta.id } })).id
    try {
      const esperadas = [conAcceso, exenta, demo, prueba].sort()
      await expect(sedesConServicePay(org.id)).resolves.toEqual(esperadas)
      // La regla de UNA sede contesta lo mismo que el lote, sede por sede.
      for (const v of [plano, conAcceso, exenta, demo, prueba, revocada])
        await expect(venueHasServicePayAccess(v).then(tiene => ({ v, tiene }))).resolves.toEqual({ v, tiene: esperadas.includes(v) })
      await expect(sedesConServicePay(orgExenta.id)).resolves.toEqual([deLaExenta])
    } finally {
      await prisma.capabilityGrant.deleteMany({ where: { venueId: { in: [conAcceso, revocada] } } })
      await prisma.venue.deleteMany({ where: { organizationId: { in: [org.id, orgExenta.id] } } })
      await prisma.organization.deleteMany({ where: { id: { in: [org.id, orgExenta.id] } } })
    }
  })
})

describe('C2 — SEDE_ACTIVA_SIN_PLAN con el resolver REAL de funciones (r3.10, r6.8; pre-flight fila 11)', () => {
  const OCT2 = new Date('2026-10-02T12:00:00Z') // septiembre ya terminó en CDMX
  let m: Mundo
  let A: string
  let B: string
  beforeEach(async () => {
    m = await crearMundo('pf3-sinplan')
    A = m.venueId
    B = (await crearSede(m.orgId, m.key, 'b')).venueId
    // Activadas las dos desde el 1-sep (ventanas abiertas). A tiene el plan por un acceso de función; B es exenta.
    await activar(m, { desde: '2026-09-01', sedes: [A, B], propinasDesde: null })
    await acceso(A, `qa-${m.key}`)
    await prisma.venue.update({ where: { id: B }, data: { seatCapExempt: true } })
  })
  afterEach(async () => {
    await prisma.capabilityGrant.deleteMany({ where: { venueId: { in: [A, B] } } })
    await borrarMundo(m)
  })
  const preview = () => previewCierre({ userId: m.owner, venueId: A, fecha: '2026-09-15', ahora: OCT2 })

  it('con el acceso vigente y la exención, el cierre de septiembre no se bloquea', async () => {
    expect(await preview()).toMatchObject({ puedeCerrar: true, bloqueos: [], periodo: { venueIds: [A, B].sort() } })
  })

  it('se revoca el acceso de A (p. ej. el reembolso de su plan) ⇒ A bloquea; B, exenta, sigue con el plan', async () => {
    await prisma.capabilityGrant.updateMany({ where: { venueId: A }, data: { revokedAt: new Date() } })
    expect(await preview()).toMatchObject({
      puedeCerrar: false,
      bloqueos: [{ codigo: 'SEDE_ACTIVA_SIN_PLAN', venueIds: [A], otrasConPlan: true }],
    })
  })

  it('además se retira la exención de B ⇒ las dos bloquean y ninguna otra tiene el plan', async () => {
    await prisma.capabilityGrant.updateMany({ where: { venueId: A }, data: { revokedAt: new Date() } })
    await prisma.venue.update({ where: { id: B }, data: { seatCapExempt: false } })
    expect(await preview()).toMatchObject({
      puedeCerrar: false,
      bloqueos: [{ codigo: 'SEDE_ACTIVA_SIN_PLAN', venueIds: [A, B].sort(), otrasConPlan: false }],
    })
  })

  it('un acceso VENCIDO (no revocado) también deja a la sede sin el plan', async () => {
    await prisma.capabilityGrant.updateMany({ where: { venueId: A }, data: { endsAt: new Date(Date.now() - 1000) } })
    expect((await preview()).bloqueos).toEqual([{ codigo: 'SEDE_ACTIVA_SIN_PLAN', venueIds: [A], otrasConPlan: true }])
  })
})
