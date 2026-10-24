/**
 * Cambio de producto contra un Postgres real (spec `docs/superpowers/specs/2026-10-20-cambio-de-producto-design.md` §6.2 y §6.7):
 * - el tender de sistema «Crédito de cambio» nace una vez, con su revisión 1;
 * - las marcas del crédito preguntan por el kind EXACTO `EXCHANGE_CREDIT` y son NULL-safe: un cobro sin tender sigue contando;
 * - el resolvedor del origen económico de una devolución (raíz antes que original) dice lo mismo en TS, en SQL y en `where`;
 * - el dinero de un cambio (el cobro con crédito y su reembolso gemelo, las filas de la diferencia y la raíz ya ligada) no se
 *   edita ni se borra a mano desde el panel ni desde la verificación de venta; los datos de referencia sí se corrigen.
 *
 * Correr (sólo en una base DESECHABLE, nunca av-db-25): exporta TEST_DATABASE_URL hacia ella y luego
 *   TZ=UTC npx jest --selectProjects=integration --runTestsByPath tests/integration/exchanges/exchangeMarks.integration.test.ts --runInBand --ci
 *
 * Cada corrida usa su propio negocio con nombres únicos y sólo limpia lo de ese negocio.
 */
import { Prisma, type Payment } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { EXCHANGE_CREDIT_TENDER_NAME, ensureExchangeCreditTender } from '@/services/exchanges/exchangeCreditTender'
import {
  WHERE_PAYMENT_IS_EXCHANGE_CREDIT,
  WHERE_PAYMENT_IS_NOT_EXCHANGE_CREDIT,
  origenEconomicoDeDevolucion,
  sqlOrigenEconomico,
  sqlPaymentIsNotExchangeCredit,
  whereDevolucionConOrigen,
} from '@/services/exchanges/exchangeMarks'
import { deletePayment, updatePayment } from '@/services/dashboard/payment.dashboard.service'
import { editOrgSaleVerification } from '@/services/dashboard/sale-verification.org.dashboard.service'
import { crearNegocioDePrueba, limpiarNegocioDePrueba } from '../giftCards/sembrarTarjetasDeRegalo'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn(async () => undefined) }))

const D = (pesos: number) => new Prisma.Decimal(pesos)
const SUF = `cambio-marcas-${process.pid}-${Date.now()}`
let organizationId: string
let venueId: string
let staffId: string
let ecTenderId: string
let n = 0

beforeAll(async () => {
  ;({ organizationId, venueId, staffId } = await crearNegocioDePrueba('cambio-marcas'))
  ecTenderId = (await ensureExchangeCreditTender(prisma, venueId)).id
})

afterAll(async () => {
  // Sin negocio no se borra NADA: un filtro con `venueId` indefinido vaciaría tablas enteras.
  if (!venueId) return
  await prisma.saleVerification.deleteMany({ where: { venueId } })
  await prisma.exchange.deleteMany({ where: { venueId } }) // sus ligas del crédito se van en cascada
  await limpiarNegocioDePrueba(venueId)
})

async function orden(): Promise<string> {
  n += 1
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `${SUF}-${n}`,
      type: 'TAKEOUT',
      source: 'TPV',
      status: 'COMPLETED',
      completedAt: new Date(),
      subtotal: D(100),
      taxAmount: D(0),
      tipAmount: D(0),
      total: D(100),
      paidAmount: D(100),
      remainingBalance: D(0),
      paymentStatus: 'PAID',
      contratoDePrecio: 'IVA_INCLUIDO',
      createdById: staffId,
    },
  })
  return order.id
}

function cobro(orderId: string, extra: Partial<Prisma.PaymentUncheckedCreateInput> = {}): Promise<Payment> {
  return prisma.payment.create({
    data: {
      venueId,
      orderId,
      amount: D(100),
      tipAmount: D(0),
      netAmount: D(100),
      feePercentage: 0,
      feeAmount: D(0),
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REGULAR',
      splitType: 'FULLPAYMENT',
      source: 'POS',
      fundsFlow: 'CASH_DRAWER',
      processedById: staffId,
      ...extra,
    },
  })
}

const conTender = (tenderTypeId: string): Partial<Prisma.PaymentUncheckedCreateInput> => ({
  method: 'OTHER',
  fundsFlow: 'EXTERNAL_RECORDED',
  tenderTypeId,
  tenderRevision: 1,
})

const idsDe = (filas: Array<{ id: string }>) => filas.map(f => f.id).sort()

describe('the «Crédito de cambio» tender and its marks', () => {
  let ids: string[]
  let sinTender: Payment
  let conVale: Payment
  let conRegalo: Payment
  let conCredito: Payment

  beforeAll(async () => {
    const vale = await prisma.venueTenderType.create({
      data: { venueId, name: 'Vale', normalizedName: `vale ${SUF}`, baseMethod: 'OTHER', revision: 1 },
    })
    const regalo = await ensureGiftCardTender(prisma, venueId)
    const orderId = await orden()
    sinTender = await cobro(orderId)
    conVale = await cobro(orderId, conTender(vale.id))
    conRegalo = await cobro(orderId, conTender(regalo.id))
    conCredito = await cobro(orderId, conTender(ecTenderId))
    ids = [sinTender.id, conVale.id, conRegalo.id, conCredito.id]
  })

  it('ensureExchangeCreditTender writes the tender with its revision 1 once in a real database', async () => {
    await expect(ensureExchangeCreditTender(prisma, venueId)).resolves.toEqual({ id: ecTenderId, revision: 1 })
    const tenders = await prisma.venueTenderType.findMany({
      where: { venueId, systemKind: 'EXCHANGE_CREDIT' },
      include: { revisions: { take: 5 } },
      take: 5,
    })
    expect(tenders).toHaveLength(1)
    expect(tenders[0]).toMatchObject({
      name: EXCHANGE_CREDIT_TENDER_NAME,
      baseMethod: 'OTHER',
      isSystem: true,
      countsAsPhysicalCash: false,
      captureTip: false,
      showOnPos: false,
      satFormaPago: '17',
      commissionPercent: null,
      revision: 1,
    })
    expect(tenders[0].revisions).toEqual([
      expect.objectContaining({ revision: 1, name: EXCHANGE_CREDIT_TENDER_NAME, satFormaPago: '17', commissionPercent: null }),
    ])
  })

  it('WHERE_PAYMENT_IS_NOT_EXCHANGE_CREDIT keeps the three non-credit payments, including the one without tender', async () => {
    const filas = await prisma.payment.findMany({
      where: { AND: [{ venueId, id: { in: ids } }, WHERE_PAYMENT_IS_NOT_EXCHANGE_CREDIT] },
      select: { id: true },
      take: ids.length,
    })
    expect(idsDe(filas)).toEqual([sinTender.id, conVale.id, conRegalo.id].sort())
  })

  it('WHERE_PAYMENT_IS_EXCHANGE_CREDIT and sqlPaymentIsNotExchangeCredit agree with the Prisma mark row by row', async () => {
    const esCredito = new Set(
      idsDe(
        await prisma.payment.findMany({
          where: { AND: [{ venueId, id: { in: ids } }, WHERE_PAYMENT_IS_EXCHANGE_CREDIT] },
          select: { id: true },
          take: ids.length,
        }),
      ),
    )
    expect([...esCredito]).toEqual([conCredito.id])

    const noCreditoPrisma = new Set(
      idsDe(
        await prisma.payment.findMany({
          where: { AND: [{ venueId, id: { in: ids } }, WHERE_PAYMENT_IS_NOT_EXCHANGE_CREDIT] },
          select: { id: true },
          take: ids.length,
        }),
      ),
    )
    const noCreditoP = new Set(
      idsDe(
        await prisma.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT p.id FROM "Payment" p WHERE p.id IN (${Prisma.join(ids)}) AND ${sqlPaymentIsNotExchangeCredit('p')}`,
        ),
      ),
    )
    const noCreditoR = new Set(
      idsDe(
        await prisma.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT r.id FROM "Payment" r WHERE r.id IN (${Prisma.join(ids)}) AND ${sqlPaymentIsNotExchangeCredit('r')}`,
        ),
      ),
    )
    for (const id of ids) {
      expect({ id, prisma: noCreditoPrisma.has(id), p: noCreditoP.has(id), r: noCreditoR.has(id) }).toEqual({
        id,
        prisma: !esCredito.has(id),
        p: !esCredito.has(id),
        r: !esCredito.has(id),
      })
    }
  })

  it('origenEconomicoDeDevolucion, sqlOrigenEconomico and whereDevolucionConOrigen take the root first and agree row by row', async () => {
    const raiz = sinTender.id
    const otro = conVale.id
    const orderId = await orden()
    const devolucion = (processorData: Prisma.InputJsonValue | typeof Prisma.DbNull) =>
      cobro(orderId, { type: 'REFUND', amount: D(-10), netAmount: D(-10), processorData })
    const directa = await devolucion({ originalPaymentId: raiz })
    const deCadena = await devolucion({ originalPaymentId: conCredito.id, rootPaymentId: raiz })
    const raizNula = await devolucion({ originalPaymentId: raiz, rootPaymentId: null })
    const deOtro = await devolucion({ originalPaymentId: otro })
    const sinPuntero = await devolucion({})
    const sinDatos = await devolucion(Prisma.DbNull)
    const devoluciones = [directa, deCadena, raizNula, deOtro, sinPuntero, sinDatos].map(d => d.id)

    const filas = await prisma.payment.findMany({
      where: { id: { in: devoluciones } },
      select: { id: true, processorData: true },
      take: devoluciones.length,
    })
    expect(Object.fromEntries(filas.map(f => [f.id, origenEconomicoDeDevolucion(f.processorData)]))).toEqual({
      [directa.id]: raiz,
      [deCadena.id]: raiz,
      [raizNula.id]: raiz,
      [deOtro.id]: otro,
      [sinPuntero.id]: null,
      [sinDatos.id]: null,
    })

    for (const origen of [raiz, otro]) {
      const enTs = idsDe(filas.filter(f => origenEconomicoDeDevolucion(f.processorData) === origen))
      const enSqlP = idsDe(
        await prisma.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT p.id FROM "Payment" p WHERE p.id IN (${Prisma.join(devoluciones)}) AND ${sqlOrigenEconomico('p')} = ${origen}`,
        ),
      )
      const enSqlR = idsDe(
        await prisma.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT r.id FROM "Payment" r WHERE r.id IN (${Prisma.join(devoluciones)}) AND ${sqlOrigenEconomico('r')} = ${origen}`,
        ),
      )
      const enWhere = idsDe(
        await prisma.payment.findMany({
          where: { AND: [{ venueId, id: { in: devoluciones } }, whereDevolucionConOrigen(origen)] },
          select: { id: true },
          take: devoluciones.length,
        }),
      )
      expect({ enSqlP, enSqlR, enWhere }).toEqual({ enSqlP: enTs, enSqlR: enTs, enWhere: enTs })
    }
    expect(idsDe(filas.filter(f => origenEconomicoDeDevolucion(f.processorData) === raiz))).toEqual(
      [directa.id, deCadena.id, raizNula.id].sort(),
    )
  })
})

describe('the money of an exchange is not edited nor deleted by hand (spec §6.2, §6.7)', () => {
  const CODIGO = 'PAYMENT_PROTECTED_BY_EXCHANGE'
  let raiz: Payment
  let sinCredito: Payment
  let gemelo: Payment
  let devolucionDeDiferencia: Payment
  let conCredito: Payment
  let cobroDeDiferencia: Payment
  let devolucionDeCadena: Payment

  const pago = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } })
  const rechazo = (promesa: Promise<unknown>, paymentId: string, fields: string[]) =>
    expect(promesa).rejects.toMatchObject({ statusCode: 409, code: CODIGO, details: { paymentId, fields } })

  beforeAll(async () => {
    const original = await orden()
    const nueva = await orden()
    raiz = await cobro(original)
    sinCredito = await cobro(original)
    const exchange = await prisma.exchange.create({
      data: {
        venueId,
        idempotencyKey: `${SUF}-x`,
        requestHash: 'a'.repeat(64),
        status: 'COMPLETED',
        originalOrderId: original,
        originalPaymentId: raiz.id,
        newOrderId: nueva,
        returnedAmount: D(100),
        takenAmount: D(130),
        differenceAmount: D(30),
        settlementKind: 'COLLECT',
        settlementMethod: 'CASH',
        lines: [],
        staffId,
      },
    })
    const marca = (role: 'CREDIT' | 'DIFFERENCE') => ({
      originalPaymentId: raiz.id,
      exchange: { exchangeId: exchange.id, role, rootPaymentId: raiz.id },
    })
    gemelo = await cobro(original, {
      ...conTender(ecTenderId),
      type: 'REFUND',
      amount: D(-60),
      netAmount: D(-60),
      processorData: marca('CREDIT'),
    })
    devolucionDeDiferencia = await cobro(original, {
      type: 'REFUND',
      amount: D(-40),
      netAmount: D(-40),
      processorData: marca('DIFFERENCE'),
    })
    conCredito = await cobro(nueva, { ...conTender(ecTenderId), amount: D(60), netAmount: D(60) })
    cobroDeDiferencia = await cobro(nueva, { amount: D(30), netAmount: D(30) })
    // La cadena (§6.7): lo que se devuelve de algo pagado con crédito apunta al cobro con crédito y sale por el medio de la raíz.
    // Se siembra a mano con la marca que escribirá el reembolso de cadena.
    devolucionDeCadena = await cobro(nueva, {
      type: 'REFUND',
      amount: D(-20),
      netAmount: D(-20),
      processorData: {
        originalPaymentId: conCredito.id,
        rootPaymentId: raiz.id,
        exchange: { exchangeId: exchange.id, role: 'CHAIN', rootPaymentId: raiz.id },
      },
    })
    await prisma.exchangeCreditLink.create({
      data: {
        venueId,
        exchangeId: exchange.id,
        originPaymentId: raiz.id,
        creditRefundPaymentId: gemelo.id,
        creditPaymentId: conCredito.id,
        amount: D(60),
      },
    })
  })

  it('PUT inflating an EXCHANGE_CREDIT payment is 409 PAYMENT_PROTECTED_BY_EXCHANGE', async () => {
    await rechazo(updatePayment(venueId, conCredito.id, { amount: 600 }), conCredito.id, ['amount'])
    expect(Number((await pago(conCredito.id)).amount)).toBe(60)
  })

  it('DELETE of an EXCHANGE_CREDIT payment is 409', async () => {
    await rechazo(deletePayment(venueId, conCredito.id), conCredito.id, ['delete'])
    await expect(prisma.payment.findUnique({ where: { id: conCredito.id } })).resolves.not.toBeNull()
  })

  it('changing the amount of a root already linked to an exchange is 409', async () => {
    await rechazo(updatePayment(venueId, raiz.id, { amount: 250 }), raiz.id, ['amount'])

    // La verificación de venta (back-office) tampoco le cambia el dinero, ni deja a medias la verificación.
    const sv = await prisma.saleVerification.create({
      data: { venueId, paymentId: raiz.id, staffId, photos: [], status: 'PENDING', isPortabilidad: false },
    })
    await rechazo(
      editOrgSaleVerification(organizationId, {
        saleVerificationId: sv.id,
        editedById: staffId,
        amount: 250,
        paymentForm: 'OTHER',
        status: 'COMPLETED',
        reason: 'corrección de prueba del cambio',
      }),
      raiz.id,
      ['amount', 'method'],
    )
    const tras = await pago(raiz.id)
    expect({ amount: Number(tras.amount), method: tras.method }).toEqual({ amount: 100, method: 'CASH' })
    await expect(prisma.saleVerification.findUniqueOrThrow({ where: { id: sv.id } })).resolves.toMatchObject({ status: 'PENDING' })
  })

  it('metadata edit of an exchange payment still works', async () => {
    await expect(updatePayment(venueId, conCredito.id, { referenceNumber: 'REF-CAMBIO', amount: 60 })).resolves.toMatchObject({
      referenceNumber: 'REF-CAMBIO',
    })
    const tras = await pago(conCredito.id)
    expect({ referenceNumber: tras.referenceNumber, amount: Number(tras.amount) }).toEqual({ referenceNumber: 'REF-CAMBIO', amount: 60 })
  })

  it.each([
    ['its REFUND twin on the original sale', () => gemelo],
    ['the refund of the difference', () => devolucionDeDiferencia],
    ['the difference collected on the new sale', () => cobroDeDiferencia],
  ])('%s cannot change its money nor be deleted either', async (_fila, fila) => {
    const { id, amount } = fila()
    await rechazo(updatePayment(venueId, id, { amount: 1 }), id, ['amount'])
    await rechazo(deletePayment(venueId, id), id, ['delete'])
    expect(Number((await pago(id)).amount)).toBe(Number(amount))
  })

  it('a CHAIN refund cannot change its amount by hand (409), and its metadata edit still works', async () => {
    await rechazo(updatePayment(venueId, devolucionDeCadena.id, { amount: -50 }), devolucionDeCadena.id, ['amount'])
    expect(Number((await pago(devolucionDeCadena.id)).amount)).toBe(-20)

    await updatePayment(venueId, devolucionDeCadena.id, { referenceNumber: 'REF-CADENA' })
    const tras = await pago(devolucionDeCadena.id)
    expect({ referenceNumber: tras.referenceNumber, amount: Number(tras.amount) }).toEqual({ referenceNumber: 'REF-CADENA', amount: -20 })
  })

  it('tip, status and method of an exchange payment count as money too', async () => {
    await rechazo(updatePayment(venueId, conCredito.id, { tipAmount: 5 }), conCredito.id, ['tipAmount'])
    await rechazo(updatePayment(venueId, conCredito.id, { status: 'FAILED' }), conCredito.id, ['status'])
    await rechazo(updatePayment(venueId, conCredito.id, { method: 'CASH' }), conCredito.id, ['method'])
    const tras = await pago(conCredito.id)
    expect({ tip: Number(tras.tipAmount), status: tras.status, method: tras.method }).toEqual({
      tip: 0,
      status: 'COMPLETED',
      method: 'OTHER',
    })
  })

  it('control: a completed payment without exchange credit keeps the settled guard and editable metadata', async () => {
    await expect(updatePayment(venueId, sinCredito.id, { amount: 90 })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PAYMENT_SETTLED_USE_REFUND',
    })
    await expect(deletePayment(venueId, sinCredito.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PAYMENT_SETTLED_USE_REFUND',
    })
    await updatePayment(venueId, sinCredito.id, { referenceNumber: 'REF-SIN-CREDITO' })
    const tras = await pago(sinCredito.id)
    expect({ amount: Number(tras.amount), referenceNumber: tras.referenceNumber }).toEqual({
      amount: 100,
      referenceNumber: 'REF-SIN-CREDITO',
    })
  })

  it('control: an unlinked pending payment on the original sale remains editable', async () => {
    const pendiente = await cobro(sinCredito.orderId!, { status: 'PENDING' })
    await updatePayment(venueId, pendiente.id, { amount: 90 })
    expect(Number((await pago(pendiente.id)).amount)).toBe(90)
  })
})
