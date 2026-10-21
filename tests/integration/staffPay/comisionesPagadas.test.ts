import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getVenueCommissionStats } from '@/services/dashboard/commission/commission-calculation.service'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { borrarMundo, crearMundo, crearSede, Mundo, periodoCerrado } from './_mundo'
import { sedeActiva } from './_ventas'

// El plan no es el tema: se prende o se apaga por prueba. La activación (`organizacionActivada`) es la real.
jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  venueHasServicePayAccess: jest.fn(async () => (global as any).__plan !== false),
}))

let m: Mundo
let n = 0
const linea = (p: {
  periodId: string
  staffId: string
  venueId?: string
  concept?: 'SERVICE' | 'RECONCILE'
  sourceType: 'COMMISSION' | 'TIP' | 'CLASS_SESSION'
  amount: number
}) =>
  prisma.serviceEarning.create({
    data: {
      organizationId: m.orgId,
      venueId: p.venueId ?? m.venueId,
      periodId: p.periodId,
      staffId: p.staffId,
      concept: p.concept ?? 'SERVICE',
      sourceType: p.sourceType,
      sourceId: `${m.key}-src-${++n}`,
      amount: new Prisma.Decimal(p.amount),
      descriptor: {},
    },
  })
const recibo = (periodId: string, staffId: string, total: number, pagado: boolean) =>
  prisma.staffPayStatement.create({
    data: { periodId, staffId, total: new Prisma.Decimal(total), paidAt: pagado ? new Date('2026-09-05T18:00:00Z') : null },
  })

beforeEach(async () => {
  m = await crearMundo('comisiones-pagadas')
  ;(global as any).__plan = true
  await prisma.organization.update({ where: { id: m.orgId }, data: { staffPayStartDate: fechaComoDbDate('2026-08-01') } })
  await sedeActiva(m, m.venueId, '2026-08-01') // la sede entra al sobre sólo con ventana (B9-B11)
})
afterEach(async () => {
  await prisma.commissionCalculation.deleteMany({ where: { venueId: m.venueId } })
  await prisma.commissionConfig.deleteMany({ where: { venueId: m.venueId } })
  await borrarMundo(m)
})

describe('KPI «Calculado» de Comisiones (decisión 13 del plan)', () => {
  it('suma lo que el motor calculó en la sede, sin las anuladas; no depende del sobre', async () => {
    ;(global as any).__plan = false
    const config = await prisma.commissionConfig.create({
      data: { venueId: m.venueId, name: 'Comisión 10 %', defaultRate: 0.1, createdById: m.owner, aggregationPeriod: 'MONTHLY' },
    })
    const calculo = (staffId: string, neto: number, extra: Record<string, unknown> = {}) =>
      prisma.commissionCalculation.create({
        data: {
          venueId: m.venueId,
          staffId,
          configId: config.id,
          baseAmount: neto * 10,
          effectiveRate: 0.1,
          grossCommission: neto,
          netCommission: neto,
          calcType: 'PERCENTAGE',
          ...extra,
        },
      })
    await calculo(m.ana, 90)
    await calculo(m.sofia, -15) // reverso de una devolución
    await calculo(m.ana, 40, { status: 'VOIDED', voidedAt: new Date() })
    expect(await getVenueCommissionStats(m.venueId)).toMatchObject({ totalCalculated: 75, staffPayActive: false })
  })
})

describe('KPI «Pagado» de Comisiones: lo pagado en recibos (spec §8)', () => {
  it('suma venta, devolución y reverso por anulación de recibos pagados; sólo comisiones y sólo de esta sede', async () => {
    const agosto = await periodoCerrado(m, '2026-08-01', '2026-08-31')
    const septiembre = await periodoCerrado(m, '2026-09-01', '2026-09-30')
    const otra = await crearSede(m.orgId, m.key, 'bsf')
    await linea({ periodId: agosto.id, staffId: m.ana, sourceType: 'COMMISSION', amount: 90 })
    await linea({ periodId: agosto.id, staffId: m.ana, sourceType: 'COMMISSION', amount: -15 }) // devolución
    await linea({ periodId: agosto.id, staffId: m.ana, sourceType: 'CLASS_SESSION', amount: 570 }) // clase: no es comisión
    await linea({ periodId: agosto.id, staffId: m.ana, sourceType: 'TIP', amount: 20 }) // propina: tampoco
    await linea({ periodId: agosto.id, staffId: m.ana, venueId: otra.venueId, sourceType: 'COMMISSION', amount: 999 }) // otra sede
    await linea({ periodId: agosto.id, staffId: m.sofia, sourceType: 'COMMISSION', amount: 50 }) // recibo sin pagar
    await linea({ periodId: septiembre.id, staffId: m.ana, concept: 'RECONCILE', sourceType: 'COMMISSION', amount: -30 }) // anulación
    await recibo(agosto.id, m.ana, 1664, true)
    await recibo(agosto.id, m.sofia, 50, false)
    await recibo(septiembre.id, m.ana, -30, true)

    expect(await getVenueCommissionStats(m.venueId)).toMatchObject({ staffPayActive: true, totalPaid: 45 })
  })

  it('sin el plan, o sin activar pago al personal, no aplica: staffPayActive false y 0 pagado', async () => {
    const agosto = await periodoCerrado(m, '2026-08-01', '2026-08-31')
    await linea({ periodId: agosto.id, staffId: m.ana, sourceType: 'COMMISSION', amount: 90 })
    await recibo(agosto.id, m.ana, 90, true)
    ;(global as any).__plan = false
    expect(await getVenueCommissionStats(m.venueId)).toMatchObject({ staffPayActive: false, totalPaid: 0 })
    ;(global as any).__plan = true
    await prisma.organization.update({ where: { id: m.orgId }, data: { staffPayStartDate: null } })
    expect(await getVenueCommissionStats(m.venueId)).toMatchObject({ staffPayActive: false, totalPaid: 0 })
  })

  it('organización activada pero la sede sin ninguna ventana: staffPayActive false y 0 pagado', async () => {
    const otra = await crearSede(m.orgId, m.key, 'sv')
    const agosto = await periodoCerrado(m, '2026-08-01', '2026-08-31')
    await linea({ periodId: agosto.id, staffId: m.ana, venueId: otra.venueId, sourceType: 'COMMISSION', amount: 90 })
    await recibo(agosto.id, m.ana, 90, true)
    expect(await getVenueCommissionStats(otra.venueId)).toMatchObject({ staffPayActive: false, totalPaid: 0 })
  })

  it('sede con una ventana ya cerrada: sigue activa y lo pagado sigue siendo verdad', async () => {
    const otra = await crearSede(m.orgId, m.key, 'vc')
    await sedeActiva(m, otra.venueId, '2026-08-01', '2026-08-31')
    const agosto = await periodoCerrado(m, '2026-08-01', '2026-08-31')
    await linea({ periodId: agosto.id, staffId: m.ana, venueId: otra.venueId, sourceType: 'COMMISSION', amount: 90 })
    await recibo(agosto.id, m.ana, 90, true)
    expect(await getVenueCommissionStats(otra.venueId)).toMatchObject({ staffPayActive: true, totalPaid: 90 })
  })

  it('sede trasladada a otra organización activada, sin ventana en la nueva: la ventana de la anterior no cuenta (E1b-fix)', async () => {
    const otra = await crearSede(m.orgId, m.key, 'tr')
    await sedeActiva(m, otra.venueId, '2026-08-01') // ventana en O1
    const key2 = `${m.key}-o2`
    const org2 = await prisma.organization.create({
      data: {
        name: key2,
        slug: key2,
        email: `${key2}@example.test`,
        phone: '5500000000',
        staffPayStartDate: fechaComoDbDate('2026-08-01'),
      },
    })
    try {
      await prisma.venue.update({ where: { id: otra.venueId }, data: { organizationId: org2.id } }) // O2 activada; la sede nunca, en O2
      expect(await getVenueCommissionStats(otra.venueId)).toMatchObject({ staffPayActive: false, totalPaid: 0 })
    } finally {
      await prisma.venue.update({ where: { id: otra.venueId }, data: { organizationId: m.orgId } })
      await prisma.organization.delete({ where: { id: org2.id } })
    }
  })
})
