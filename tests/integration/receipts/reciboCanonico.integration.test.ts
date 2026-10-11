/**
 * IVA por producto, plan 7a (r4 R4-A1): con dos recibos del MISMO cobro y snapshots distintos, todos los caminos que reutilizan un
 * recibo por paymentId eligen el mismo: el más antiguo por (createdAt, id). Los dos accessKey siguen abriéndose.
 *
 * 🔴 El canónico se inserta AL ÚLTIMO: así el orden físico de la tabla (el que devuelve un `findFirst`/`findMany` sin `orderBy`)
 * es el contrario del canónico, y una lectura sin orden cae por aserción en vez de acertar por casualidad.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { RECIBO_CANONICO, reciboCanonicoDelPago } from '@/services/shared/reciboCanonico'
import { totalesDelComprobante } from '@/services/shared/ticketTotals'
import { generateDigitalReceipt } from '@/services/tpv/digitalReceipt.tpv.service'
import * as receiptDashboard from '@/services/dashboard/receipt.dashboard.service'

const fixture = 'reciboc-' + randomUUID()
let venueId: string
let staffId: string
let orderId: string

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(url.hostname)
  // La base de este trabajo en la Mac, o la de CI (`avoqado_*_test_*`): nunca otra.
  expect(url.pathname).toMatch(/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/)
  await prisma.organization.create({ data: { id: fixture, name: fixture, email: fixture + '@example.test', phone: '5500000000' } })
  const venue = await prisma.venue.create({ data: { organizationId: fixture, name: fixture, slug: fixture } })
  venueId = venue.id
  const staff = await prisma.staff.create({ data: { email: fixture + '@example.test', firstName: 'Recibo', lastName: 'Canonico' } })
  staffId = staff.id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'CASHIER' } })
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: randomUUID(),
      source: 'TPV',
      createdById: staffId,
      subtotal: new Prisma.Decimal(116),
      taxAmount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(116),
      remainingBalance: new Prisma.Decimal(116),
    },
  })
  orderId = order.id
})

afterAll(async () => {
  // Sólo el inquilino de esta suite. Sin venue (el fixture no llegó a crearse) no se limpia nada: un filtro undefined borraría tablas.
  if (venueId) {
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.organization.deleteMany({ where: { id: fixture } })
})

async function cobroConDosRecibos(empate: boolean) {
  const pago = await prisma.payment.create({
    data: {
      venueId,
      orderId,
      amount: new Prisma.Decimal(116),
      tipAmount: new Prisma.Decimal(10),
      method: 'CASH',
      status: 'COMPLETED',
      processedById: staffId,
      feePercentage: new Prisma.Decimal(0),
      feeAmount: new Prisma.Decimal(0),
      netAmount: new Prisma.Decimal(116),
    },
  })
  const t = new Date('2026-10-05T18:00:00.000Z')
  const snap = (total: number) => ({
    payment: { amount: total - 10, tipAmount: 10 },
    ticketTotals: { kind: 'COBRO', desglosado: false, subtotal: total - 10, serviceCharge: 0, addedTax: 0, tip: 10, total },
  })
  // ids elegidos para que el orden por id sea conocido: 'r-a…' < 'r-b…'. El NUEVO se inserta primero (ver la cabecera).
  const nuevo = await prisma.digitalReceipt.create({
    data: {
      id: 'r-b-' + randomUUID(),
      paymentId: pago.id,
      dataSnapshot: snap(999),
      createdAt: empate ? t : new Date(t.getTime() + 60_000),
    },
  })
  const viejo = await prisma.digitalReceipt.create({
    data: { id: 'r-a-' + randomUUID(), paymentId: pago.id, dataSnapshot: snap(126), createdAt: t },
  })
  return { pago, viejo, nuevo }
}

it.each([false, true])('🔴 r4 R4-A1: todos los caminos eligen el mismo recibo (empate de createdAt: %s)', async empate => {
  const { pago, viejo, nuevo } = await cobroConDosRecibos(empate)
  expect((await reciboCanonicoDelPago(prisma, pago.id))?.id).toBe(viejo.id)
  expect((await totalesDelComprobante(prisma, pago.id))?.total).toBe(126) // la reimpresión del POS
  expect((await generateDigitalReceipt(pago.id)).id).toBe(viejo.id) // la respuesta idempotente del TPV
  expect((await receiptDashboard.generateAndStoreReceipt(venueId, pago.id)).id).toBe(viejo.id) // el correo / dashboard
  // los replays (`include: { receipts: RECIBO_CANONICO }` + `receipts[0]`) traen sólo el canónico
  const conRecibo = await prisma.payment.findUnique({ where: { id: pago.id }, include: { receipts: RECIBO_CANONICO } })
  expect(conRecibo?.receipts.map(r => r.id)).toEqual([viejo.id])
  // la lista completa del cobro, en el orden canónico
  expect((await receiptDashboard.getReceiptsByPaymentId(pago.id)).map(r => r.id)).toEqual([viejo.id, nuevo.id])
  // los enlaces históricos siguen valiendo
  expect(await prisma.digitalReceipt.findUnique({ where: { accessKey: nuevo.accessKey } })).not.toBeNull()
})
