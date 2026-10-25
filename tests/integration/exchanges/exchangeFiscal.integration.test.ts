import prisma from '@/utils/prismaClient'
import { createExchange } from '@/services/exchanges/exchange.service'
import { loadOrderForCfdiFromDb } from '@/services/fiscal/cfdi.service'
import { dondePertenece } from '@/services/fiscal/cfdiGlobal.service'
import { pertenenciaAlEmisor, type Pertenencia } from '@/services/fiscal/globalPorTratamiento'
import { WHERE_PAGO_CONTABILIZABLE_SIN_ESTADO_DE_ORDEN, isEligible } from '@/services/fiscal/autoPosting.service'
import { getIncomeStatement } from '@/services/dashboard/accounting.dashboard.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { seedClothingSale } from './seedExchange'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.setTimeout(60000)
type Seed = Awaited<ReturnType<typeof seedClothingSale>>
const fixtures: Seed[] = []
async function seed(card = false, payments?: number[]) {
  const s = await seedClothingSale({ card, payments })
  fixtures.push(s)
  return s
}
async function issuer(s: Seed, rfc = 'AAA010101AAA', merchantId?: string) {
  const e = await prisma.fiscalEmisor.create({
    data: {
      venueId: s.venueId,
      rfc,
      legalName: 'Fiscal de prueba',
      regimenFiscal: '601',
      lugarExpedicion: '01000',
      invoiceCashSales: false,
      includeCashInAccounting: true,
      includeOffTerminalSalesInGlobal: true,
    },
  })
  if (merchantId)
    await prisma.merchantFiscalConfig.create({
      data: {
        merchantAccountId: merchantId,
        fiscalEmisorId: e.id,
        facturacionEnabled: true,
        autofacturaEnabled: true,
        includeInGlobal: true,
      },
    })
  return e
}
afterAll(async () => {
  for (const f of fixtures) {
    await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisor: { venueId: f.venueId } } })
    await prisma.fiscalEmisor.deleteMany({ where: { venueId: f.venueId } })
    await f.cleanup()
  }
  await prisma.$disconnect()
})
describe('exchange fiscal treatment against Postgres', () => {
  beforeAll(() => expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_cambio_(r5_)?test_202610(20|24)$/))
  it('new order paid with exchange credit resolves the issuer through the root merchant with two RFCs', async () => {
    const s = await seed(true)
    const other = await issuer(s, 'BBB010101BBB')
    const e = await issuer(s, 'AAA010101AAA', s.payments[0].merchantAccountId!)
    const x = await createExchange(s.input())
    const bundle = await loadOrderForCfdiFromDb(x.exchange.newOrderId)
    expect(bundle?.emisor.id).toBe(e.id)
    expect(bundle?.tenderSatFormaPago).toBe('17')
    expect(bundle?.unsupportedReasons).toBeUndefined()
    expect(await prisma.order.count({ where: { AND: [{ id: x.exchange.newOrderId }, dondePertenece(e, false, 'CANDIDATA')] } })).toBe(1)
    expect(await prisma.order.count({ where: { AND: [{ id: x.exchange.newOrderId }, dondePertenece(other, false, 'AJENA')] } })).toBe(1)
    expect(await prisma.payment.findFirst({ where: { orderId: x.exchange.newOrderId }, select: { merchantAccountId: true } })).toEqual({
      merchantAccountId: null,
    })
  })
  it('mixed roots from two different RFCs keep the existing mismatch error', async () => {
    const s = await seed(true, [250, 250])
    const first = s.payments[0].merchantAccountId!
    const merchant = await prisma.merchantAccount.findUniqueOrThrow({ where: { id: first } })
    const second = await prisma.merchantAccount.create({
      data: { providerId: merchant.providerId, externalMerchantId: s.venueId + '-second', alias: 'Segundo RFC', credentialsEncrypted: {} },
    })
    // El comercio extra sólo se creó para esta fixture; su limpieza va después de los cobros.
    const cleanup = s.cleanup.bind(s)
    s.cleanup = async () => {
      await cleanup()
      await prisma.merchantAccount.delete({ where: { id: second.id } })
    }
    await prisma.payment.update({ where: { id: s.payments[1].id }, data: { merchantAccountId: second.id } })
    await issuer(s, 'AAA010101AAA', first)
    await issuer(s, 'BBB010101BBB', second.id)
    const x = await createExchange(s.input())
    const b = await loadOrderForCfdiFromDb(x.exchange.newOrderId)
    expect(b).not.toBeNull()
    expect(b!.unsupportedReasons).toContain('La cuenta se cobró con comercios de RFC distinto; factúrala por separado.')
  })
  it.each([false, true])('global SQL parity uses the root method (card=%s), never the gift-card exception', async card => {
    const s = await seed(card)
    const e = await issuer(s, 'AAA010101AAA', s.payments[0].merchantAccountId ?? undefined)
    const x = await createExchange(s.input())
    const origin = {
      method: card ? 'CREDIT_CARD' : 'CASH',
      conComercio: card,
      config: card ? { fiscalEmisorId: e.id, facturacionEnabled: true, includeInGlobal: true } : null,
    }
    const payments = [{ method: 'OTHER', conComercio: false, config: null, systemKind: 'EXCHANGE_CREDIT', origenDelCredito: origin }]
    const classes: Pertenencia[] = ['CANDIDATA', 'AJENA', 'EFECTIVO', 'COMERCIO_FUERA', 'SIN_EMISOR', 'SIN_TERMINAL']
    const expected = card ? 'CANDIDATA' : 'EFECTIVO'
    expect(pertenenciaAlEmisor(payments, e, true)).toBe(expected)
    for (const c of classes)
      expect(await prisma.order.count({ where: { AND: [{ id: x.exchange.newOrderId }, dondePertenece(e, true, c)] } })).toBe(
        c === expected ? 1 : 0,
      )
    await prisma.fiscalEmisor.update({ where: { id: e.id }, data: { includeOffTerminalSalesInGlobal: false } })
    const off = { ...e, includeOffTerminalSalesInGlobal: false }
    expect(await prisma.order.count({ where: { AND: [{ id: x.exchange.newOrderId }, dondePertenece(off, true, 'CANDIDATA')] } })).toBe(
      card ? 1 : 0,
    )
  })
  it.each(['missing', 'foreign'])('does not admit a credit with a %s root as an off-terminal sale', async state => {
    const s = await seed()
    const e = await issuer(s)
    const x = await createExchange(s.input())
    if (state === 'missing') await prisma.exchangeCreditLink.deleteMany({ where: { venueId: s.venueId, exchangeId: x.exchange.id } })
    else {
      const other = await seed()
      await prisma.exchangeCreditLink.updateMany({
        where: { exchangeId: x.exchange.id, venueId: s.venueId },
        data: { originPaymentId: other.payments[0].id },
      })
    }
    expect(await prisma.order.count({ where: { AND: [{ id: x.exchange.newOrderId }, dondePertenece(e, true, 'CANDIDATA')] } })).toBe(0)
    expect(await prisma.order.count({ where: { AND: [{ id: x.exchange.newOrderId }, dondePertenece(e, true, 'SIN_EMISOR')] } })).toBe(1)
  })
  it('a second exchange preserves root cash eligibility through the stored root link', async () => {
    const s = await seed()
    const e = await issuer(s)
    const first = await createExchange(s.input())
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: first.exchange.newOrderId } })
    const second = await createExchange(
      s.input(
        s.body({
          originalPaymentId: first.exchange.paymentIds[0],
          returned: [{ orderItemId: item.id, quantity: 1, restock: true, reason: 'SIZE' }],
          taken: [{ productId: s.products[2].id, quantity: 1, inheritsFromOrderItemId: item.id }],
        }),
      ),
    )
    const link = await prisma.exchangeCreditLink.findFirstOrThrow({ where: { exchangeId: second.exchange.id } })
    expect(link.originPaymentId).toBe(s.payments[0].id)
    expect(await prisma.order.count({ where: { AND: [{ id: second.exchange.newOrderId }, dondePertenece(e, true, 'EFECTIVO')] } })).toBe(1)
    expect(await prisma.order.count({ where: { AND: [{ id: second.exchange.newOrderId }, dondePertenece(e, true, 'CANDIDATA')] } })).toBe(0)
  })
  it('excludes only the EC pair from fiscal income and autoposting, retaining a chain cash refund', async () => {
    const s = await seed()
    const e = await issuer(s)
    const x = await createExchange(s.input())
    const before = await getIncomeStatement(s.venueId, {
      from: new Date(Date.now() - 864e5).toISOString().slice(0, 10),
      to: new Date(Date.now() + 864e5).toISOString().slice(0, 10),
    })
    expect(before.revenue).toMatchObject({ grossSalesCents: 100000, refundsCents: 50000, netRevenueCents: 50000 })
    expect(before.fiscalRevenue).toMatchObject({ grossSalesCents: 50000, refundsCents: 0, netRevenueCents: 50000 })
    const rows = await prisma.payment.findMany({
      where: { venueId: s.venueId },
      take: 10,
      include: {
        tenderType: true,
        merchantAccount: { include: { fiscalConfig: true } },
        ecommerceMerchant: { include: { fiscalConfig: true } },
        order: true,
      },
    })
    const mirror = await prisma.payment.findMany({
      where: { venueId: s.venueId, AND: [WHERE_PAGO_CONTABILIZABLE_SIN_ESTADO_DE_ORDEN] },
      take: 10,
    })
    expect(
      rows
        .filter(isEligible)
        .map(p => p.id)
        .sort(),
    ).toEqual(mirror.map(p => p.id).sort())
    expect(mirror.map(p => p.id)).toEqual([s.payments[0].id])
    await issueRefund({
      venueId: s.venueId,
      staffId: s.staffId,
      paymentId: x.exchange.paymentIds[0],
      amount: 20000,
      reason: 'RETURNED_GOODS',
    })
    const filters = {
      from: new Date(Date.now() - 864e5).toISOString().slice(0, 10),
      to: new Date(Date.now() + 864e5).toISOString().slice(0, 10),
    }
    expect((await getIncomeStatement(s.venueId, filters)).fiscalRevenue).toMatchObject({
      grossSalesCents: 50000,
      refundsCents: 20000,
      netRevenueCents: 30000,
    })
    await prisma.fiscalEmisor.update({ where: { id: e.id }, data: { includeCashInAccounting: false } })
    expect((await getIncomeStatement(s.venueId, filters)).fiscalRevenue).toMatchObject({
      grossSalesCents: 0,
      refundsCents: 0,
      netRevenueCents: 0,
    })
  })
  it('restricts deletion of a root or credited payment until its links are removed', async () => {
    const s = await seed()
    const x = await createExchange(s.input())
    await expect(prisma.payment.delete({ where: { id: s.payments[0].id } })).rejects.toMatchObject({ code: 'P2003' })
    await expect(prisma.payment.delete({ where: { id: x.exchange.paymentIds[0] } })).rejects.toMatchObject({ code: 'P2003' })
  })
})
