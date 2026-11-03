/**
 * D10: una meta por unidades cuenta piezas, resta las devoluciones que nombran productos y, por persona, cada renglón es de quien lo
 * cobró. Corre contra Postgres porque la devolución se lee de `processorData` con SQL.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://…/<base desechable>' \
 *     npx jest --selectProjects integration --testPathPattern metas-por-unidades
 */

import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import { getEffectiveGoals, type ResolvedGoal } from '@/services/dashboard/commission/goal-resolution.service'
import { createSalesGoal, getSalesGoals } from '@/services/dashboard/commission/sales-goal.service'
import prisma from '@/utils/prismaClient'

const suffix = `d10-metas-${Date.now()}`
const CUARENTA_DIAS = 40 * 24 * 60 * 60 * 1000 // siempre antes del inicio de esta semana

let orgId: string
let venueId: string
let beto: string
let ana: string
let carla: string

let orderSeq = 0
async function cuenta(
  renglones: Array<{ piezas: number; peso?: number }>,
  opciones: { status?: 'COMPLETED' | 'CANCELLED'; createdAt?: Date } = {},
) {
  orderSeq += 1
  return prisma.order.create({
    data: {
      venueId,
      orderNumber: `D10-${orderSeq}-${suffix}`,
      createdAt: opciones.createdAt ?? new Date(),
      type: 'DINE_IN',
      subtotal: 100,
      discountAmount: 0,
      taxAmount: 0,
      total: 100,
      status: opciones.status ?? 'COMPLETED',
      paymentStatus: 'PAID',
      items: {
        create: renglones.map((r, i) => ({
          productName: `Producto ${i + 1}`,
          quantity: r.piezas,
          weightQuantity: r.peso,
          unitPrice: 10,
          discountAmount: 0,
          taxAmount: 0,
          total: 10,
        })),
      },
    },
    select: { id: true, items: { select: { id: true }, orderBy: { productName: 'asc' } } },
  })
}

/** Con `productos`, cobro por producto (una asignación por renglón). Sin ellos, cobro general (una asignación sin renglón). */
async function cobro(
  orden: { id: string },
  quien: string,
  opciones: { productos?: string[]; status?: 'COMPLETED' | 'FAILED'; createdAt?: Date } = {},
) {
  const pago = await prisma.payment.create({
    data: {
      venueId,
      orderId: orden.id,
      processedById: quien,
      amount: 10,
      tipAmount: 0,
      method: 'CASH',
      status: opciones.status ?? 'COMPLETED',
      type: 'REGULAR',
      splitType: opciones.productos ? 'PERPRODUCT' : 'FULLPAYMENT',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: 10,
      createdAt: opciones.createdAt ?? new Date(),
    },
    select: { id: true },
  })
  await prisma.paymentAllocation.createMany({
    data: opciones.productos
      ? opciones.productos.map(orderItemId => ({ paymentId: pago.id, orderId: orden.id, orderItemId, amount: 10 }))
      : [{ paymentId: pago.id, orderId: orden.id, amount: 10 }],
  })
  return pago
}

async function devolucion(
  orden: { id: string },
  original: { id: string },
  opera: string,
  refundedItems?: Array<{ orderItemId: string; quantity: number; amountCents: number }>,
) {
  await prisma.payment.create({
    data: {
      venueId,
      orderId: orden.id,
      processedById: opera,
      amount: -5,
      tipAmount: 0,
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REFUND',
      splitType: 'FULLPAYMENT',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: -5,
      processorData: { originalPaymentId: original.id, ...(refundedItems ? { refundedItems } : {}) },
    },
  })
}

const unidades = (metas: ResolvedGoal[], staffId: string | null) => {
  const meta = metas.find(m => m.staffId === staffId && m.goalType === 'QUANTITY')
  if (!meta) throw new Error(`No salió la meta por unidades de ${staffId}`)
  return meta.currentSales
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id
  const tienda = await prisma.venue.create({
    data: { organizationId: orgId, name: `Centro ${suffix}`, slug: `centro-${suffix}`, timezone: 'America/Mexico_City', status: 'ACTIVE' },
    select: { id: true },
  })
  venueId = tienda.id
  const persona = async (nombre: string) =>
    (
      await prisma.staff.create({
        data: { email: `${nombre}-${suffix}@example.test`, firstName: nombre, lastName: 'Prueba' },
        select: { id: true },
      })
    ).id
  beto = await persona('beto')
  ana = await persona('ana')
  carla = await persona('carla')
  await prisma.staffVenue.createMany({
    data: [beto, ana, carla].map(staffId => ({ staffId, venueId, role: 'CASHIER' as const })),
  })

  // A: Beto cobra toda la cuenta: un renglón de 3 piezas y otro de 1. Ana le devuelve 2 piezas por artículos.
  const a = await cuenta([{ piezas: 3 }, { piezas: 1 }])
  const cobroA = await cobro(a, beto)
  await devolucion(a, cobroA, ana, [{ orderItemId: a.items[0].id, quantity: 2, amountCents: 500 }])

  // B: Ana cobra 2 piezas y un producto por peso (cantidad 1, 0.350 kg). Le devuelven por importe, sin decir qué productos.
  const b = await cuenta([{ piezas: 2 }, { piezas: 1, peso: 0.35 }])
  const cobroB = await cobro(b, ana)
  await devolucion(b, cobroB, ana)

  // C: cuenta por producto: Beto paga 1 pieza y Ana el renglón de 2.
  const c = await cuenta([{ piezas: 1 }, { piezas: 2 }])
  await cobro(c, beto, { productos: [c.items[0].id] })
  await cobro(c, ana, { productos: [c.items[1].id] })

  // D: mixta: Beto paga un producto y Ana cubre lo que falta con un cobro general.
  const d = await cuenta([{ piezas: 1 }, { piezas: 1 }])
  await cobro(d, beto, { productos: [d.items[0].id] })
  await cobro(d, ana)

  // E: por importe entre dos: no hay dato de qué pagó cada quien, así que cuenta para los dos.
  const e = await cuenta([{ piezas: 1 }, { piezas: 1 }])
  await cobro(e, beto)
  await cobro(e, ana)

  // F: Ana intenta cobrar el producto y falla; Beto cobra la cuenta.
  const f = await cuenta([{ piezas: 1 }])
  await cobro(f, ana, { productos: [f.items[0].id], status: 'FAILED' })
  await cobro(f, beto)

  // G: cuenta cancelada con una devolución: ni sus piezas ni su devolución cuentan.
  const g = await cuenta([{ piezas: 5 }], { status: 'CANCELLED' })
  const cobroG = await cobro(g, beto)
  await devolucion(g, cobroG, ana, [{ orderItemId: g.items[0].id, quantity: 1, amountCents: 500 }])

  // H: Carla vendió hace 40 días y hoy le devuelven 1 pieza: la venta queda fuera de la semana y la devolución dentro.
  const hace40 = new Date(Date.now() - CUARENTA_DIAS)
  const h = await cuenta([{ piezas: 4 }], { createdAt: hace40 })
  const cobroH = await cobro(h, carla, { createdAt: hace40 })
  await devolucion(h, cobroH, ana, [{ orderItemId: h.items[0].id, quantity: 1, amountCents: 500 }])

  await createSalesGoal(venueId, { staffId: beto, goal: 10, goalType: 'QUANTITY', period: 'WEEKLY' })
  await createSalesGoal(venueId, { staffId: ana, goal: 10, goalType: 'QUANTITY', period: 'WEEKLY' })
  await createSalesGoal(venueId, { staffId: carla, goal: 10, goalType: 'QUANTITY', period: 'WEEKLY' })
  await createSalesGoal(venueId, { staffId: null, goal: 50, goalType: 'QUANTITY', period: 'WEEKLY' })
})

afterAll(async () => {
  if (!venueId) return
  await prisma.paymentAllocation.deleteMany({ where: { payment: { venueId } } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.staff.deleteMany({ where: { id: { in: [beto, ana, carla].filter(Boolean) } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('D10: el avance de una meta por unidades', () => {
  it('la meta de la sucursal cuenta piezas y resta las devoluciones que nombran productos', async () => {
    // A 4 + B 3 + C 3 + D 2 + E 2 + F 1 = 15 piezas, menos 2 de A y 1 de H. G no cuenta y la devolución de B no dice qué productos.
    expect(unidades(await getEffectiveGoals(venueId), null)).toBe(12)
  })

  it('a Beto: sus piezas, los productos que pagó, la cuenta entre dos, y la devolución de su venta aunque la operara Ana', async () => {
    // A 4 + C 1 + D 1 + E 2 + F 1 = 9, menos 2.
    expect(unidades(await getEffectiveGoals(venueId), beto)).toBe(7)
  })

  it('a Ana: lo suyo, sin la devolución que operó sobre una venta ajena ni el cobro que le falló', async () => {
    // B 3 + C 2 + D 1 + E 2 = 8. El producto por peso cuenta 1.
    expect(unidades(await getEffectiveGoals(venueId), ana)).toBe(8)
  })

  it('a Carla: una devolución de una venta vieja resta en la semana en que se hace, igual que el dinero', async () => {
    expect(unidades(await getEffectiveGoals(venueId), carla)).toBe(-1)
  })

  it('el panel y la TPV dicen lo mismo de cada meta', async () => {
    const delPanel = await getSalesGoals(venueId)
    const deLaTpv = await getEffectiveGoals(venueId)

    expect(deLaTpv).toHaveLength(4)
    expect(deLaTpv.map(m => [m.id, m.currentSales]).sort()).toEqual(delPanel.map(m => [m.id, m.currentSales]).sort())
  })

  it('GET /tpv/sales-goals: la terminal recibe ese mismo número', async () => {
    const token = jwt.sign({ sub: beto, orgId, venueId, role: 'CASHIER' }, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '15m' })

    const { body } = await request(app).get('/api/v1/tpv/sales-goals').set('Authorization', `Bearer ${token}`).expect(200)

    const resumen = body.salesGoals.map(
      (m: { staffId: string | null; currentSales: string }) => `${m.staffId === null ? 'sucursal' : 'personal'} ${m.currentSales}`,
    )
    expect(resumen.sort()).toEqual(['personal 7', 'sucursal 12'])
  })
})
