/**
 * Tarea B3 r1 (fix 5), contra Postgres REAL: el canje CON propina, escrito por el camino real de A8 (`payGiftCardBalanceOnOrder`),
 * pasa el cuadre de la factura individual y se factura por la VENTA ($200, sin la propina) con forma 01. El `Payment` lleva
 * `amount` = venta y `tipAmount` = propina; la propina nunca va en el CFDI.
 * B3 r1 (fix 2, opción A): el canje sólo con saldo en la factura GLOBAL. El `where` de cada clase (`dondePertenece`) dice exactamente lo
 * mismo que la función pura (`pertenenciaAlEmisor`) con los cobros REALES (molde de `globalVariasTasas.test.ts`): con la global de Avoqado
 * encendida para el RFC el canje es CANDIDATA con forma 01; apagada (Testarudo) sigue SIN_TERMINAL y `globalApagada` sigue en true; una
 * venta sin saldo fuera de la terminal no cambia en ningún estado.
 *
 * Correr: source ../urls-tarjetas.sh && TZ=UTC npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/giftCards/facturaDelCanje.integration.test.ts --ci --runInBand
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  ...jest.requireActual('@/services/shared/cashDrawerPosting'),
  postCashSaleToDrawer: jest.fn().mockResolvedValue(undefined),
  postCashRefundToDrawer: jest.fn().mockResolvedValue('NOT_DRAWER_CASH'),
}))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { encryptGiftCardCode, generateGiftCardCode, generateOpaqueToken, hashGiftCardCode } from '@/services/giftCards/giftCardCode'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { payGiftCardBalanceOnOrder } from '@/services/mobile/order.mobile.service'
import { loadOrderForCfdiFromDb } from '@/services/fiscal/cfdi.service'
import { assembleSaleInput } from '@/services/fiscal/assembleSaleInput'
import {
  ORDER_SELECT,
  configQueEntraALaGlobal,
  dondePertenece,
  periodosDeLaGlobal,
  ticketParaGlobal,
  ventanaFiscal,
} from '@/services/fiscal/cfdiGlobal.service'
import { pertenenciaAlEmisor, type Pertenencia } from '@/services/fiscal/globalPorTratamiento'
import { buildCreateInvoiceParams } from '@/services/fiscal/cfdiPayloadBuilder'
import { crearCuentaDeMercancia, crearNegocioDePrueba, limpiarEfectosDePagoDelNegocio } from './sembrarTarjetasDeRegalo'

jest.setTimeout(90000)

const D = (v: number) => new Prisma.Decimal(v)
let organizationId: string
let venueId: string
let staffId: string
let emisorId: string

beforeAll(async () => {
  ;({ organizationId, venueId, staffId } = await crearNegocioDePrueba('factura-canje'))
  await prisma.giftCardSettings.create({ data: { venueId, enabled: true, suggestedAmounts: [500, 1000, 2000] } })
  await ensureGiftCardTender(prisma, venueId)
  // UN solo RFC en el negocio: el canje sin comercio se factura con él (como el efectivo o la transferencia).
  emisorId = (
    await prisma.fiscalEmisor.create({
      data: {
        venueId,
        rfc: 'EKU9003173C9',
        legalName: 'ESCUELA KEMPER URGATE',
        regimenFiscal: '601',
        lugarExpedicion: '64000',
        csdStatus: 'ACTIVE',
      },
    })
  ).id
})

afterAll(async () => {
  await limpiarEfectosDePagoDelNegocio(venueId)
})

/** Un sobre ACTIVE con su código real y su ACTIVATE (molde de `cobroConSaldo.integration.test.ts`). */
async function tarjeta(monto: number) {
  const c = generateGiftCardCode()
  const s = await prisma.giftCard.create({
    data: {
      venueId,
      organizationId,
      codeHash: hashGiftCardCode(c.normalized),
      codeEnc: encryptGiftCardCode(c.normalized),
      codeLast4: c.last4,
      pageToken: generateOpaqueToken(),
      initialAmount: D(monto),
      balance: D(monto),
      status: 'ACTIVE',
      activatedAt: new Date(),
      termsVersion: '2026-10-14',
      deliveryChannel: 'PRINTED',
    },
  })
  await prisma.giftCardActivity.create({ data: { giftCardId: s.id, venueId, type: 'ACTIVATE', amount: D(monto), balanceAfter: D(monto) } })
  return { id: s.id, codigo: c.display }
}

describe('factura del canje · Postgres real', () => {
  it('🔴 venta $200 + propina $20 pagadas con saldo (A8 real) ⇒ la factura cuadra y es de $200 con forma 01; la propina no entra', async () => {
    const t = await tarjeta(1000)
    const { orderId } = await crearCuentaDeMercancia({ venueId, staffId, total: 200 })

    const r = await payGiftCardBalanceOnOrder(venueId, orderId, {
      idempotencyKey: `canje-propina-${process.pid}-${Date.now()}`,
      proof: { kind: 'CODE', code: t.codigo },
      amount: D(200),
      tip: D(20),
      staffId,
      deviceId: null,
    })
    // La forma del Payment que escribe A8: amount = venta, tipAmount = propina, tender de sistema con forma 01.
    const pago = await prisma.payment.findUniqueOrThrow({ where: { id: r.paymentId } })
    expect([pago.method, pago.amount.toFixed(2), pago.tipAmount.toFixed(2), pago.tenderSatFormaPago, pago.type]).toEqual([
      'OTHER',
      '200.00',
      '20.00',
      '01',
      'REGULAR',
    ])
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PAID')

    const bundle = await loadOrderForCfdiFromDb(orderId)
    expect(bundle).not.toBeNull()
    expect(bundle!.unsupportedReasons).toBeUndefined() // pasó el cuadre (lo cobrado = $200, sin la propina)
    expect(bundle!.emisor.id).toBe(emisorId)
    expect([bundle!.paymentMethod, bundle!.tenderSatFormaPago]).toEqual(['OTHER', '01'])
    expect([bundle!.paidCents, bundle!.totalCents]).toEqual([20000, 20000])

    const payload = buildCreateInvoiceParams(
      assembleSaleInput(bundle!.order, {
        receptor: { rfc: 'XEXX010101000', razonSocial: 'CLIENTE', regimenFiscal: '616', codigoPostal: '64000', usoCfdi: 'S01' },
        paymentMethod: bundle!.paymentMethod,
        tenderSatFormaPago: bundle!.tenderSatFormaPago,
        metodoPago: bundle!.metodoPago,
        idempotencyKey: `cfdi-order-${orderId}`,
      }),
    )
    expect(payload.formaPago).toBe('01')
    expect(payload.items.map(it => [it.quantity, it.unitPriceCents, it.discountCents, it.taxIncluded])).toEqual([[1, 20000, 0, true]])
  })
})

describe('B3 r1 (fix 2) · el canje sólo con saldo en la global: SQL = función pura', () => {
  const CLASES: readonly Pertenencia[] = ['CANDIDATA', 'AJENA', 'EFECTIVO', 'COMERCIO_FUERA', 'SIN_EMISOR', 'SIN_TERMINAL']
  // Un periodo que contiene los cobros de la prueba (la ventana es la del ÚLTIMO cobro elegible).
  const periodo = { periodStart: new Date(Date.now() - 86_400_000), periodEnd: new Date(Date.now() + 86_400_000) }
  const sufijo = `canje-global-${process.pid}-${Date.now()}`
  const comercio = sufijo
  let canjeId: string
  let efectivoId: string

  const emisor = () => prisma.fiscalEmisor.findUniqueOrThrow({ where: { id: emisorId } })
  /** Encender o apagar la global de Avoqado para el RFC: su ÚNICO comercio entra o no a la global. */
  const globalDeAvoqado = (encendida: boolean) =>
    prisma.merchantFiscalConfig.update({ where: { merchantAccountId: comercio }, data: { includeInGlobal: encendida } })

  /** Las clases cuyo `where` encuentra la venta (debe ser exactamente una). */
  async function clasesEnSql(orderId: string) {
    const e = await emisor()
    const encontradas: Pertenencia[] = []
    for (const clase of CLASES) {
      const n = await prisma.order.count({
        where: { AND: [{ id: orderId }, ventanaFiscal(venueId, periodo), dondePertenece(e, true, clase)] },
      })
      if (n) encontradas.push(clase)
    }
    return encontradas
  }
  /** La función pura con los cobros REALES de la venta y el estado real de la global del RFC. */
  async function claseEnLaFuncion(orderId: string) {
    const cfg = { select: { fiscalEmisorId: true, facturacionEnabled: true, includeInGlobal: true } }
    const pagos = await prisma.payment.findMany({
      where: { orderId, status: 'COMPLETED' },
      select: {
        method: true,
        merchantAccountId: true,
        ecommerceMerchantId: true,
        merchantAccount: { select: { fiscalConfig: cfg } },
        ecommerceMerchant: { select: { fiscalConfig: cfg } },
        tenderType: { select: { systemKind: true } },
      },
      take: 20,
    })
    const comercioEnLaGlobal = !!(await prisma.merchantFiscalConfig.findFirst({
      where: configQueEntraALaGlobal(emisorId),
      select: { id: true },
    }))
    return pertenenciaAlEmisor(
      pagos.map(p => ({
        method: p.method,
        conComercio: p.merchantAccountId !== null || p.ecommerceMerchantId !== null,
        config: p.merchantAccount?.fiscalConfig ?? p.ecommerceMerchant?.fiscalConfig ?? null,
        saldoDeRegalo: p.tenderType?.systemKind === 'GIFT_CARD',
      })),
      { ...(await emisor()), comercioEnLaGlobal },
      true,
    )
  }
  const globalApagada = async () => (await periodosDeLaGlobal({ venueId, emisorId, now: new Date() })).globalApagada

  beforeAll(async () => {
    // El comercio del RFC (con su configuración fiscal); empieza FUERA de la global: Testarudo.
    await prisma.paymentProvider.create({
      data: { id: sufijo, code: sufijo, name: sufijo, type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
    await prisma.merchantAccount.create({
      data: { id: comercio, providerId: sufijo, externalMerchantId: comercio, credentialsEncrypted: {} },
    })
    await prisma.merchantFiscalConfig.create({
      data: {
        merchantAccountId: comercio,
        fiscalEmisorId: emisorId,
        facturacionEnabled: true,
        autofacturaEnabled: false,
        includeInGlobal: false,
      },
    })
    // El canje sólo con saldo, por el camino real de A8.
    const t = await tarjeta(1000)
    canjeId = (await crearCuentaDeMercancia({ venueId, staffId, total: 200 })).orderId
    await payGiftCardBalanceOnOrder(venueId, canjeId, {
      idempotencyKey: `canje-global-${process.pid}-${Date.now()}`,
      proof: { kind: 'CODE', code: t.codigo },
      amount: D(200),
      tip: D(0),
      staffId,
      deviceId: null,
    })
    // El control: una venta SIN saldo cobrada fuera de la terminal (efectivo, sin comercio).
    efectivoId = (
      await prisma.order.create({
        data: {
          venueId,
          orderNumber: `${sufijo}-efectivo`,
          subtotal: D(116),
          taxAmount: D(0),
          total: D(116),
          paymentStatus: 'PAID',
          contratoDePrecio: 'IVA_INCLUIDO',
          items: { create: [{ productName: 'Playera', quantity: 1, unitPrice: D(116), taxAmount: D(0), total: D(116) }] },
          payments: {
            create: [
              {
                venueId,
                amount: D(116),
                feePercentage: 0,
                feeAmount: D(0),
                netAmount: D(116),
                method: 'CASH',
                status: 'COMPLETED',
                type: 'REGULAR',
              },
            ],
          },
        },
      })
    ).id
  })

  afterAll(async () => {
    await prisma.merchantFiscalConfig.deleteMany({ where: { merchantAccountId: comercio } })
    await prisma.merchantAccount.deleteMany({ where: { id: comercio } })
    await prisma.paymentProvider.deleteMany({ where: { id: sufijo } })
  })

  it('🔴 (b) global APAGADA (1 RFC, su comercio fuera de la global, interruptor de fábrica): el canje sigue SIN_TERMINAL y globalApagada sigue en true', async () => {
    await globalDeAvoqado(false)
    expect((await emisor()).includeOffTerminalSalesInGlobal).toBe(false)
    expect(await globalApagada()).toBe(true)
    expect(await clasesEnSql(canjeId)).toEqual(['SIN_TERMINAL'])
    expect(await claseEnLaFuncion(canjeId)).toBe('SIN_TERMINAL')
  })

  it('🔴 (a) global ENCENDIDA (su comercio en la global): el canje es CANDIDATA (SQL = función pura) y entra con forma 01', async () => {
    await globalDeAvoqado(true)
    try {
      expect(await globalApagada()).toBe(false)
      expect(await clasesEnSql(canjeId)).toEqual(['CANDIDATA'])
      expect(await claseEnLaFuncion(canjeId)).toBe('CANDIDATA')
      const ticket = ticketParaGlobal(await prisma.order.findUniqueOrThrow({ where: { id: canjeId }, select: ORDER_SELECT }))
      expect(ticket).toMatchObject({ ok: true, orden: { formaPago: '01', paidCents: 20000, porTratamiento: { IVA_16: 20000 } } })
    } finally {
      await globalDeAvoqado(false)
    }
  })

  it('🔴 (c) una venta SIN saldo fuera de la terminal, con el interruptor apagado, no cambia: SIN_TERMINAL con la global apagada y encendida', async () => {
    for (const encendida of [false, true]) {
      await globalDeAvoqado(encendida)
      expect([encendida, await clasesEnSql(efectivoId)]).toEqual([encendida, ['SIN_TERMINAL']])
      expect([encendida, await claseEnLaFuncion(efectivoId)]).toEqual([encendida, 'SIN_TERMINAL'])
    }
    await globalDeAvoqado(false)
  })
})
