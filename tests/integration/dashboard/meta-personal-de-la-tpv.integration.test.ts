/**
 * D7: la meta PERSONAL que ve la TPV cuenta sólo lo de esa persona; la de toda la sucursal sigue sumando a todos.
 *
 * `getEffectiveGoals` (de ahí leen /tpv/sales-goal y /tpv/sales-goals) tenía su propia copia del cálculo, sin filtrar por persona:
 * con una meta personal de $100, Beto veía $110 de toda la tienda en la terminal y $50 en el panel. Corre contra Postgres porque la
 * regla de la devolución («cuenta para quien hizo la venta») es SQL.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://…/<base desechable>' \
 *     npx jest --selectProjects integration --testPathPattern meta-personal-de-la-tpv
 */

import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import { getEffectiveGoals, type ResolvedGoal } from '@/services/dashboard/commission/goal-resolution.service'
import {
  createSalesGoal,
  getSalesGoals,
  type SalesGoalPeriod,
  type SalesGoalType,
} from '@/services/dashboard/commission/sales-goal.service'
import prisma from '@/utils/prismaClient'

const suffix = `d7-meta-${Date.now()}`
const CUARENTA_DIAS = 40 * 24 * 60 * 60 * 1000 // siempre antes del inicio de este mes y de esta semana

let orgId: string
let venueId: string
let otraTienda: string
let beto: string
let ana: string

let orderSeq = 0
async function venta(tienda: string, vendedor: string, importe: number, renglones: number, createdAt: Date = new Date()) {
  orderSeq += 1
  return prisma.order.create({
    data: {
      venueId: tienda,
      orderNumber: `D7-${orderSeq}-${suffix}`,
      createdAt,
      createdById: vendedor,
      type: 'DINE_IN',
      subtotal: importe,
      discountAmount: 0,
      taxAmount: 0,
      total: importe,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      items: {
        create: Array.from({ length: renglones }, (_, i) => ({
          productName: `Producto ${i + 1}`,
          quantity: 1,
          unitPrice: importe / renglones,
          discountAmount: 0,
          taxAmount: 0,
          total: importe / renglones,
        })),
      },
      payments: {
        create: {
          venueId: tienda,
          amount: importe,
          tipAmount: 0,
          method: 'CASH',
          status: 'COMPLETED',
          processedById: vendedor,
          createdAt,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: importe,
        },
      },
    },
    select: { id: true, payments: { select: { id: true } } },
  })
}

const laMeta = (metas: ResolvedGoal[], staffId: string | null, goalType: SalesGoalType, period: SalesGoalPeriod) => {
  const meta = metas.find(m => m.staffId === staffId && m.goalType === goalType && m.period === period)
  if (!meta) throw new Error(`No salió la meta ${staffId} ${goalType} ${period}`)
  return meta
}

// Lo que le contesta el servidor a la terminal, con la sesión de esa persona.
const pedirComo = (staffId: string, ruta: string) =>
  request(app)
    .get(`/api/v1/tpv/${ruta}`)
    .set(
      'Authorization',
      `Bearer ${jwt.sign({ sub: staffId, orgId, venueId, role: 'CASHIER' }, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '15m' })}`,
    )

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id
  const tienda = (nombre: string) =>
    prisma.venue.create({
      data: {
        organizationId: orgId,
        name: `${nombre} ${suffix}`,
        slug: `${nombre}-${suffix}`,
        timezone: 'America/Mexico_City',
        status: 'ACTIVE',
      },
      select: { id: true },
    })
  venueId = (await tienda('centro')).id
  otraTienda = (await tienda('sur')).id

  const persona = (nombre: string) =>
    prisma.staff.create({
      data: { email: `${nombre}-${suffix}@example.test`, firstName: nombre, lastName: 'Prueba' },
      select: { id: true },
    })
  beto = (await persona('beto')).id
  ana = (await persona('ana')).id
  await prisma.staffVenue.createMany({
    data: [
      { staffId: beto, venueId, role: 'CASHIER' },
      { staffId: ana, venueId, role: 'CASHIER' },
      { staffId: beto, venueId: otraTienda, role: 'CASHIER' },
    ],
  })

  // Beto vende $80 (2 renglones) y Ana $60 (1 renglón); Ana le devuelve $30 a la venta de Beto.
  const deBeto = await venta(venueId, beto, 80, 2)
  const deAna = await venta(venueId, ana, 60, 1)
  // Un cobro viejo puede no traer tipo: sigue siendo una venta.
  await prisma.payment.updateMany({ where: { orderId: deAna.id }, data: { type: null } })
  await prisma.payment.create({
    data: {
      venueId,
      orderId: deBeto.id,
      processedById: ana,
      amount: -30,
      tipAmount: 0,
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REFUND',
      splitType: 'FULLPAYMENT',
      feeAmount: 0,
      netAmount: -30,
      feePercentage: 0,
      processorData: { originalPaymentId: deBeto.payments[0].id },
    },
  })
  // Ana también intentó cobrar esa venta de Beto y no se completó: tampoco la hace suya.
  await prisma.payment.create({
    data: {
      venueId,
      orderId: deBeto.id,
      processedById: ana,
      amount: 80,
      tipAmount: 0,
      method: 'CREDIT_CARD',
      status: 'FAILED',
      type: 'REGULAR',
      splitType: 'FULLPAYMENT',
      feeAmount: 0,
      netAmount: 80,
      feePercentage: 0,
    },
  })
  // No cuentan para sus metas de esta tienda: una venta de hace 40 días y una de Beto en otra tienda.
  await venta(venueId, beto, 1000, 5, new Date(Date.now() - CUARENTA_DIAS))
  await venta(otraTienda, beto, 40, 1)

  // Las metas nacen por el mismo camino que usa el panel. Por persona y periodo sólo cabe una, por eso las de unidades son semanales.
  await createSalesGoal(venueId, { staffId: beto, goal: 100, goalType: 'AMOUNT', period: 'MONTHLY' })
  await createSalesGoal(venueId, { staffId: ana, goal: 100, goalType: 'AMOUNT', period: 'MONTHLY' })
  await createSalesGoal(venueId, { staffId: null, goal: 500, goalType: 'AMOUNT', period: 'MONTHLY' })
  await createSalesGoal(venueId, { staffId: beto, goal: 10, goalType: 'QUANTITY', period: 'WEEKLY' })
  await createSalesGoal(venueId, { staffId: ana, goal: 10, goalType: 'QUANTITY', period: 'WEEKLY' })
  await createSalesGoal(venueId, { staffId: null, goal: 10, goalType: 'QUANTITY', period: 'WEEKLY' })

  // La otra tienda no tiene metas propias: hereda la de la organización.
  await prisma.organizationSalesGoalConfig.create({
    data: { organizationId: orgId, goal: 200, goalType: 'AMOUNT', period: 'MONTHLY' },
  })
})

afterAll(async () => {
  const tiendas = [venueId, otraTienda].filter(Boolean)
  if (tiendas.length === 0) return
  await prisma.payment.deleteMany({ where: { venueId: { in: tiendas } } })
  await prisma.order.deleteMany({ where: { venueId: { in: tiendas } } })
  await prisma.staffVenue.deleteMany({ where: { venueId: { in: tiendas } } })
  await prisma.venue.deleteMany({ where: { id: { in: tiendas } } })
  await prisma.staff.deleteMany({ where: { id: { in: [beto, ana].filter(Boolean) } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('D7: lo que recibe la terminal', () => {
  it('GET /tpv/sales-goals: cada quien recibe su meta con lo suyo y la de la sucursal, nunca la de otra persona', async () => {
    const deBeto = await pedirComo(beto, 'sales-goals').expect(200)
    const deAna = await pedirComo(ana, 'sales-goals').expect(200)
    const resumen = (metas: Array<{ staffId: string | null; goalType: string; currentSales: string }>) =>
      metas.map(m => `${m.staffId === null ? 'sucursal' : 'personal'} ${m.goalType} ${m.currentSales}`).sort()

    expect(deBeto.body.salesGoals.every((m: { staffId: string | null }) => m.staffId === null || m.staffId === beto)).toBe(true)
    expect(resumen(deBeto.body.salesGoals)).toEqual([
      'personal AMOUNT 50',
      'personal QUANTITY 2',
      'sucursal AMOUNT 110',
      'sucursal QUANTITY 3',
    ])
    expect(deAna.body.salesGoals.every((m: { staffId: string | null }) => m.staffId === null || m.staffId === ana)).toBe(true)
    expect(resumen(deAna.body.salesGoals)).toEqual([
      'personal AMOUNT 60',
      'personal QUANTITY 1',
      'sucursal AMOUNT 110',
      'sucursal QUANTITY 3',
    ])
  })

  it('GET /tpv/sales-goal (terminales viejas): la meta personal gana y trae lo de esa persona', async () => {
    const { body } = await pedirComo(beto, 'sales-goal').expect(200)

    expect(body.salesGoal).toMatchObject({ staffId: beto, goalType: 'AMOUNT', period: 'MONTHLY', currentSales: '50' })
  })
})

describe('D7: el avance de cada meta que lee la TPV', () => {
  it('la meta personal por importe cuenta sólo lo de esa persona, y la devolución es de quien hizo la venta', async () => {
    const metas = await getEffectiveGoals(venueId)

    expect(laMeta(metas, beto, 'AMOUNT', 'MONTHLY').currentSales).toBe(50) // 80 - 30; antes decía 110, toda la tienda
    expect(laMeta(metas, ana, 'AMOUNT', 'MONTHLY').currentSales).toBe(60) // la devolución que operó no es suya
  })

  it('la meta personal por unidades cuenta sólo los renglones de esa persona', async () => {
    const metas = await getEffectiveGoals(venueId)

    expect(laMeta(metas, beto, 'QUANTITY', 'WEEKLY').currentSales).toBe(2)
    expect(laMeta(metas, ana, 'QUANTITY', 'WEEKLY').currentSales).toBe(1) // ni la venta que devolvió ni el cobro que no se completó
  })

  it('el panel y la TPV dicen lo mismo de cada meta', async () => {
    const delPanel = await getSalesGoals(venueId)
    const deLaTpv = await getEffectiveGoals(venueId)

    expect(deLaTpv).toHaveLength(6)
    expect(deLaTpv.map(m => [m.id, m.currentSales]).sort()).toEqual(delPanel.map(m => [m.id, m.currentSales]).sort())
  })

  // Lo que no debe cambiar.
  it('la meta de toda la sucursal sigue sumando a todos', async () => {
    const metas = await getEffectiveGoals(venueId)

    expect(laMeta(metas, null, 'AMOUNT', 'MONTHLY').currentSales).toBe(110) // 80 + 60 - 30
    expect(laMeta(metas, null, 'QUANTITY', 'WEEKLY').currentSales).toBe(3)
  })

  it('sin metas propias, la tienda hereda la de la organización y suma toda la tienda', async () => {
    const metas = await getEffectiveGoals(otraTienda)

    expect(metas).toHaveLength(1)
    expect(metas[0]).toMatchObject({ source: 'organization', staffId: null, currentSales: 40 })
  })
})
