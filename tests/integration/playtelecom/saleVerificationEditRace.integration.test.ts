/**
 * Codex r1 C1 (A11b punto 1), contra Postgres real: la edición del back-office leía el estado ANTES de su transacción y lo
 * volvía a escribir. Si otro proceso reabría la venta en medio (COMPLETED → PENDING), una edición de monto la dejaba
 * COMPLETED otra vez sin pasar por `sale-verifications:approve`. Ahora: sin `status` pedido no se escribe el estado; con
 * `status`, el UPDATE va condicionado al estado leído y, si cambió, 409 `SALE_VERIFICATION_CHANGED` sin escribir NADA (ni el
 * cobro, ni la cuenta, ni la bitácora: todo va en la misma transacción).
 *   TEST_DATABASE_URL='postgresql://…/avoqado_<tarea>_test_<fecha>' \
 *     npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/playtelecom/saleVerificationEditRace.integration.test.ts
 */
import { Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import { editOrgSaleVerification } from '@/services/dashboard/sale-verification.org.dashboard.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { broadcastToUser: jest.fn() } }))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

const tag = `edicion-carrera-${randomUUID()}`
const ORG = cuid()
let venueId = ''
let staffId = ''
const d = (n: number) => new Prisma.Decimal(n)

beforeAll(async () => {
  await prisma.organization.create({ data: { id: ORG, name: tag, email: `${ORG}@example.test`, phone: '5500000000' } })
  venueId = (await prisma.venue.create({ data: { organizationId: ORG, name: tag, slug: tag } })).id
  staffId = (await prisma.staff.create({ data: { email: `${tag}@example.test`, firstName: 'Back', lastName: 'Office' } })).id
})

afterAll(async () => {
  if (venueId) {
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.saleVerification.deleteMany({ where: { venueId } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.organization.deleteMany({ where: { id: ORG } })
  await prisma.$disconnect()
})

afterEach(() => jest.restoreAllMocks())

/** Una venta de SIM aprobada, simple (1 artículo, un cobro en efectivo): su importe se puede corregir. */
async function ventaAprobada() {
  const orden = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `${tag}-${randomUUID().slice(0, 8)}`,
      type: 'TAKEOUT',
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      subtotal: d(100),
      taxAmount: d(0),
      total: d(100),
      paidAmount: d(100),
      remainingBalance: d(0),
    },
  })
  await prisma.orderItem.create({
    data: { orderId: orden.id, productName: 'SIM', quantity: 1, unitPrice: d(100), taxAmount: d(0), total: d(100) },
  })
  const pago = await prisma.payment.create({
    data: {
      venueId,
      orderId: orden.id,
      amount: d(100),
      tipAmount: d(0),
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REGULAR',
      feePercentage: d(0),
      feeAmount: d(0),
      netAmount: d(100),
    },
  })
  const sv = await prisma.saleVerification.create({
    data: {
      venueId,
      paymentId: pago.id,
      staffId,
      photos: ['f1'],
      status: 'COMPLETED',
      reviewedAt: new Date(),
      reviewedById: staffId,
      isPortabilidad: false,
    },
  })
  return { orden, pago, sv }
}

/** La edición lee la venta; antes de que abra su transacción, otro proceso la reabre (COMPLETED → PENDING). */
function reabrirTrasLaLectura(svId: string) {
  const leer = prisma.saleVerification.findUnique.bind(prisma.saleVerification)
  jest.spyOn(prisma.saleVerification, 'findUnique').mockImplementationOnce((async (args: unknown) => {
    const leida = await leer(args as never)
    await prisma.saleVerification.update({
      where: { id: svId },
      data: { status: 'PENDING', reviewedAt: null, reviewedById: null, reviewNotes: null, rejectionReasons: [] },
    })
    return leida
  }) as never)
}

const fila = (id: string) => prisma.saleVerification.findUniqueOrThrow({ where: { id }, select: { status: true, reviewedAt: true } })
const bitacora = (id: string) =>
  prisma.activityLog.findMany({ where: { entityId: id, action: 'SALE_VERIFICATION_EDIT' }, select: { data: true }, take: 5 })

describe('editar una venta mientras otro la reabre', () => {
  it('edición de monto sin estado: el cobro cambia, la venta se queda PENDING y la bitácora no inventa la transición', async () => {
    const { pago, orden, sv } = await ventaAprobada()
    reabrirTrasLaLectura(sv.id)

    await editOrgSaleVerification(ORG, { saleVerificationId: sv.id, editedById: staffId, amount: 150, reason: 'Ajuste de monto' })

    expect(await fila(sv.id)).toEqual({ status: 'PENDING', reviewedAt: null })
    expect(Number((await prisma.payment.findUniqueOrThrow({ where: { id: pago.id } })).amount)).toBe(150)
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: orden.id } })).total)).toBe(150)
    const [log] = await bitacora(sv.id)
    expect(log.data).toMatchObject({ before: { status: 'PENDING' }, after: { status: 'PENDING', amount: 150 } })
  })

  it('con estado pedido y la venta cambiada: 409 SALE_VERIFICATION_CHANGED y no se escribe nada', async () => {
    const { pago, orden, sv } = await ventaAprobada()
    reabrirTrasLaLectura(sv.id)

    await expect(
      editOrgSaleVerification(ORG, {
        saleVerificationId: sv.id,
        editedById: staffId,
        status: 'COMPLETED', // el diálogo del dashboard manda el estado que leyó
        amount: 150,
        reason: 'Ajuste de monto',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SALE_VERIFICATION_CHANGED' })

    expect((await fila(sv.id)).status).toBe('PENDING')
    expect(Number((await prisma.payment.findUniqueOrThrow({ where: { id: pago.id } })).amount)).toBe(100)
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: orden.id }, include: { items: true } })
    expect([Number(cuenta.total), Number(cuenta.items[0].unitPrice), cuenta.version]).toEqual([100, 100, orden.version])
    expect(await bitacora(sv.id)).toEqual([])
  })

  // Concurrente de verdad: la reapertura tiene la fila tomada (sin confirmar) cuando la edición lee y luego escribe. Si el UPDATE
  // condicionado no fuera una sola sentencia (leer el id y luego escribir por id), la edición esperaría el candado y escribiría
  // COMPLETED encima; con la condición en el mismo UPDATE, Postgres la vuelve a evaluar al soltarse el candado y no encuentra fila.
  it('la reapertura sin confirmar cuando llega el UPDATE: al confirmarse, la edición sale 409 y nada se escribe', async () => {
    const { pago, sv } = await ventaAprobada()
    let soltar: () => void = () => undefined
    const suelta = new Promise<void>(r => (soltar = r))
    let avisar: () => void = () => undefined
    const tomada = new Promise<void>(r => (avisar = r))
    const reapertura = prisma.$transaction(
      async t => {
        await t.saleVerification.update({ where: { id: sv.id }, data: { status: 'PENDING', reviewedAt: null, reviewedById: null } })
        avisar()
        await suelta
      },
      { timeout: 20_000 },
    )
    await tomada

    const edicion = editOrgSaleVerification(ORG, {
      saleVerificationId: sv.id,
      editedById: staffId,
      status: 'COMPLETED',
      amount: 150,
      reason: 'Ajuste de monto',
    })
    const resultado = edicion.then(
      () => 'aplicada',
      (e: { code?: string }) => e.code,
    )
    await new Promise(r => setTimeout(r, 1_500)) // la edición ya leyó COMPLETED y espera el candado de la fila
    soltar()
    await reapertura

    expect(await resultado).toBe('SALE_VERIFICATION_CHANGED')
    expect((await fila(sv.id)).status).toBe('PENDING')
    expect(Number((await prisma.payment.findUniqueOrThrow({ where: { id: pago.id } })).amount)).toBe(100)
    expect(await bitacora(sv.id)).toEqual([])
  }, 30_000)

  it('sin carrera, con estado pedido: se aplica como siempre', async () => {
    const { sv } = await ventaAprobada()

    await editOrgSaleVerification(ORG, {
      saleVerificationId: sv.id,
      editedById: staffId,
      status: 'COMPLETED',
      amount: 120,
      reason: 'Ajuste de monto',
    })

    expect((await fila(sv.id)).status).toBe('COMPLETED')
    expect(await bitacora(sv.id)).toHaveLength(1)
  })
})
