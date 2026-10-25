/**
 * El núcleo del abono extraído de `payCashOrder` (Tarea A7). Lo que NO estaba antes y fija esta suite: el gancho
 * `trasCandadoDeOrden` corre bajo el candado de la Order y antes de reclamar el turno, un tender ya resuelto no pasa por
 * `resolveTenderForCharge`, y si el gancho rechaza no se escribe nada. Lo que SÍ estaba lo fijan las suites de
 * `payCashOrder` (sin cambios).
 */
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue(null),
  applySalePosting: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  lockAreaTicketCheckoutForPayment: jest.fn().mockResolvedValue(null),
  finalizeAreaTicketPaymentInTransaction: jest.fn().mockResolvedValue({ areaTicketOrder: false }),
}))

import { Prisma } from '@prisma/client'
import { lockAreaTicketCheckoutForPayment } from '@/services/mobile/areaTicketV7.mobile.service'
import { registrarAbonoEnTx, type AbonoEnTxEntrada, type CuentaBajoCandado } from '@/services/mobile/order.mobile.service'
import type { ResolvedTenderCharge } from '@/services/dashboard/tenderType.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

const D = (v: number) => new Prisma.Decimal(v)
const CTX = {
  venueId: 'venue-1',
  orderId: 'order-1',
  effectiveStaffId: 'staff-1',
  marcarCocina: false,
  conSesionDeVales: false,
  rechazoDelPersonal: null,
}
// `reconciliationEnabled` va suelto (4º argumento), no dentro de `ctx`: la guardia AST de turnos lo sigue por parámetro.
const RECONCILIACION = false
const TENDER_DE_REGALO: ResolvedTenderCharge = {
  tenderTypeId: 'tt-gift',
  tenderRevision: 1,
  method: 'OTHER',
  tenderLabel: 'Tarjeta de regalo',
  tenderCountsAsCash: false,
  tenderCaptureTip: true,
  tenderSatFormaPago: '01',
  tenderCommissionPercent: null,
  fundsFlow: 'EXTERNAL_RECORDED',
}

const pasos: string[] = []

beforeEach(() => {
  jest.clearAllMocks()
  pasos.length = 0
  prismaMock.$queryRaw.mockReset().mockImplementation(async (query: TemplateStringsArray) => {
    if (query.join('').includes('AS "accountingAt"')) return [{ accountingAt: new Date() }]
    pasos.push('candado-de-la-orden')
    return [{ id: 'order-1' }]
  })
  prismaMock.order.findUnique.mockResolvedValue({
    id: 'order-1',
    orderNumber: 'ORD-1',
    paymentStatus: 'PENDING',
    subtotal: D(1000),
    discountAmount: D(0),
    serviceChargeAmount: D(0),
    status: 'CONFIRMED',
    contratoDePrecio: 'IVA_INCLUIDO',
    taxAmount: D(0),
    originSystem: 'AVOQADO',
    version: 3,
    areaTicketCode: null,
    tableId: null,
  })
  prismaMock.payment.findMany.mockResolvedValue([{ amount: D(200), tipAmount: D(0), type: 'REGULAR' }])
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.shift.findFirst.mockReset().mockImplementation(async () => {
    pasos.push('turno')
    return null
  })
  prismaMock.payment.create.mockImplementation(async ({ data }: any) => ({ id: 'payment-1', createdAt: new Date(), ...data }))
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.cashDrawerSession.findFirst.mockResolvedValue(null)
  prismaMock.venueTenderType.findFirst.mockReset()
})

describe('🔴 cierre (punto 17): qué le dice el abono a la sesión de vales sobre el dinero', () => {
  const capturadoAlPedir = () => (lockAreaTicketCheckoutForPayment as jest.Mock).mock.calls[0][1].dineroCapturado
  const abonar = (entrada: Partial<AbonoEnTxEntrada>) =>
    registrarAbonoEnTx(prismaMock, CTX, { amountCents: 30000, tipCents: 0, method: 'CASH', tender: null, ...entrada }, RECONCILIACION)

  it('el cobro con SALDO (tender de sistema ya resuelto) es un cobro NUEVO: dineroCapturado false, como el efectivo en vivo', async () => {
    await abonar({ method: 'OTHER', idempotencyKey: 'llave-saldo-1', tender: { resuelto: TENDER_DE_REGALO } })
    expect(capturadoAlPedir()).toBe(false)
  })

  it('regresión: el efectivo en vivo sigue siendo cobro NUEVO (false) y una tarjeta ajena ya cobrada, capturado (true)', async () => {
    await abonar({ idempotencyKey: 'llave-efectivo-1' })
    expect(capturadoAlPedir()).toBe(false)
    ;(lockAreaTicketCheckoutForPayment as jest.Mock).mockClear()
    await abonar({ method: 'CREDIT_CARD', externalSource: 'Terminal externa', idempotencyKey: 'llave-externa-1' })
    expect(capturadoAlPedir()).toBe(true)
  })
})

describe('registrarAbonoEnTx', () => {
  it('trasCandadoDeOrden corre DESPUÉS del candado de la Order y ANTES del turno, con la cuenta releída y sus pagos previos', async () => {
    let vista: CuentaBajoCandado | undefined
    await registrarAbonoEnTx(
      prismaMock,
      CTX,
      {
        amountCents: 30000,
        tipCents: 0,
        method: 'OTHER',
        idempotencyKey: 'llave-0001',
        tender: { resuelto: TENDER_DE_REGALO },
        trasCandadoDeOrden: async (_tx, cuenta) => {
          pasos.push('gancho')
          vista = cuenta
        },
      },
      RECONCILIACION,
    )

    expect(pasos).toEqual(['candado-de-la-orden', 'gancho', 'turno'])
    expect(vista?.fresh).toMatchObject({ id: 'order-1', version: 3, status: 'CONFIRMED' })
    expect(vista?.previousPayments).toEqual([{ amount: D(200), tipAmount: D(0), type: 'REGULAR' }])
  })

  it('un tender YA resuelto no pasa por resolveTenderForCharge y queda congelado en el Payment, sin cambio', async () => {
    const r = await registrarAbonoEnTx(
      prismaMock,
      CTX,
      {
        amountCents: 30000,
        tipCents: 5000,
        method: 'OTHER',
        idempotencyKey: 'llave-0002',
        tender: { resuelto: TENDER_DE_REGALO },
      },
      RECONCILIACION,
    )

    expect(prismaMock.venueTenderType.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.payment.create.mock.calls[0][0].data).toMatchObject({
      amount: 300,
      tipAmount: 50,
      method: 'OTHER',
      source: 'OTHER',
      fundsFlow: 'EXTERNAL_RECORDED',
      tenderTypeId: 'tt-gift',
      tenderRevision: 1,
      tenderLabel: 'Tarjeta de regalo',
      tenderSatFormaPago: '01',
      idempotencyKey: 'llave-0002',
    })
    expect(r).toMatchObject({ aplicadoCents: 30000, cambioCents: 0, isFullyPaid: false, tenderResuelto: TENDER_DE_REGALO })
    expect(r.balance).toMatchObject({ orderPaymentStatus: 'PARTIAL', remainingBalanceCents: 50000 })
  })

  it('si el gancho rechaza, no se escribe nada (ni la Order, ni el turno, ni el Payment)', async () => {
    await expect(
      registrarAbonoEnTx(
        prismaMock,
        CTX,
        {
          amountCents: 30000,
          tipCents: 0,
          method: 'OTHER',
          tender: { resuelto: TENDER_DE_REGALO },
          trasCandadoDeOrden: async () => {
            throw new Error('rechazado bajo el candado')
          },
        },
        RECONCILIACION,
      ),
    ).rejects.toThrow('rechazado bajo el candado')
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.shift.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('regresión: un tender por REFERENCIA sigue resolviéndose con resolveTenderForCharge (en vivo)', async () => {
    prismaMock.venueTenderType.findFirst.mockResolvedValue({
      id: 'tt-vale',
      baseMethod: 'OTHER',
      active: true,
      revision: 2,
      name: 'Vale',
      systemKind: null,
    })
    prismaMock.venueTenderTypeRevision.findFirst.mockResolvedValue({
      revision: 2,
      name: 'Vale',
      countsAsPhysicalCash: false,
      captureTip: true,
      commissionPercent: null,
      satFormaPago: '08',
    })

    const r = await registrarAbonoEnTx(
      prismaMock,
      CTX,
      {
        amountCents: 30000,
        tipCents: 0,
        method: 'CASH',
        tender: { ref: { id: 'tt-vale', revision: 2 } },
      },
      RECONCILIACION,
    )

    expect(prismaMock.venueTenderType.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'tt-vale', venueId: 'venue-1' } }),
    )
    expect(r.tenderResuelto).toMatchObject({ tenderTypeId: 'tt-vale', tenderSatFormaPago: '08' })
  })

  // Tarea A8 (ruling 3 del coordinador): la auditoría dice QUIÉN registró el abono. Sin `canal`, los textos de
  // `payCashOrder` de siempre, byte por byte; con él, los del llamador (el cobro con saldo no se atribuye al efectivo).
  describe('canal de auditoría', () => {
    const cancelada = () =>
      prismaMock.order.findUnique.mockResolvedValue({
        id: 'order-1',
        orderNumber: 'ORD-1',
        paymentStatus: 'PENDING',
        subtotal: D(1000),
        discountAmount: D(0),
        serviceChargeAmount: D(0),
        status: 'CANCELLED',
        contratoDePrecio: 'IVA_INCLUIDO',
        taxAmount: D(0),
        originSystem: 'AVOQADO',
        version: 3,
        areaTicketCode: null,
        tableId: null,
      })
    const datosDe = (accion: string) =>
      prismaMock.activityLog.create.mock.calls.map((c: any) => c[0].data).find((d: any) => d.action === accion)?.data

    it('sin `canal`: PAYMENT_WITHOUT_SHIFT y la reapertura siguen diciendo payCashOrder (registro en vivo)', async () => {
      cancelada()
      prismaMock.order.update.mockResolvedValue({ id: 'order-1' })
      await registrarAbonoEnTx(prismaMock, CTX, { amountCents: 30000, tipCents: 0, method: 'CREDIT_CARD', tender: null }, true)

      expect(datosDe('PAYMENT_WITHOUT_SHIFT')).toMatchObject({ channel: 'payCashOrder', reason: 'NO_SHIFT' })
      expect(datosDe('ORDER_REOPENED_BY_CAPTURED_PAYMENT')).toMatchObject({ canal: 'payCashOrder:registro' })
    })

    it('sin `canal` y desde la cola sin red: la reapertura dice payCashOrder:cola', async () => {
      cancelada()
      prismaMock.order.update.mockResolvedValue({ id: 'order-1' })
      await registrarAbonoEnTx(
        prismaMock,
        CTX,
        { amountCents: 30000, tipCents: 0, method: 'CREDIT_CARD', tender: null, isOfflineReplay: true },
        true,
      )
      expect(datosDe('ORDER_REOPENED_BY_CAPTURED_PAYMENT')).toMatchObject({ canal: 'payCashOrder:cola' })
    })

    it('con `canal`: los dos registros llevan el canal del llamador', async () => {
      cancelada()
      prismaMock.order.update.mockResolvedValue({ id: 'order-1' })
      await registrarAbonoEnTx(
        prismaMock,
        CTX,
        {
          amountCents: 30000,
          tipCents: 0,
          method: 'CREDIT_CARD',
          tender: null,
          canal: { turno: 'payGiftCardBalanceOnOrder', reapertura: 'payGiftCardBalanceOnOrder' },
        },
        true,
      )
      expect(datosDe('PAYMENT_WITHOUT_SHIFT')).toMatchObject({ channel: 'payGiftCardBalanceOnOrder' })
      expect(datosDe('ORDER_REOPENED_BY_CAPTURED_PAYMENT')).toMatchObject({ canal: 'payGiftCardBalanceOnOrder' })
    })
  })

  // Tarea A8 (ruling 4 del coordinador): el gancho recibe objetos VIVOS que el núcleo usa después (`fresh.version` en la CAS,
  // `previousPayments` en la aritmética). Su tipo es de sólo lectura: una mutación no compila. Lo hace cumplir
  // `npm run typecheck` (cada `@ts-expect-error` sin error que esperar truena el typecheck).
  it('el gancho trasCandadoDeOrden recibe la cuenta de SÓLO lectura (lo verifica el typecheck)', async () => {
    const gancho: NonNullable<AbonoEnTxEntrada['trasCandadoDeOrden']> = async (_tx, cuenta) => {
      // @ts-expect-error — la versión que usa la CAS no se reescribe
      cuenta.fresh.version = 99
      // @ts-expect-error — el estado leído bajo el candado no se reescribe
      cuenta.fresh.status = 'CANCELLED'
      // @ts-expect-error — los pagos previos no se alteran
      cuenta.previousPayments.push({ amount: D(1), tipAmount: D(0), type: 'REGULAR' })
      // @ts-expect-error — ni un pago previo por dentro
      cuenta.previousPayments[0].amount = D(0)
      // @ts-expect-error — ni se reemplaza la cuenta
      cuenta.fresh = { ...cuenta.fresh }
    }
    expect(typeof gancho).toBe('function')
  })
})

describe('exchange deferred close', () => {
  it('keeps the order partial until the last exchange installment, even within one cent', async () => {
    const result = await registrarAbonoEnTx(
      prismaMock,
      CTX,
      {
        amountCents: 79999,
        tipCents: 0,
        method: 'OTHER',
        tender: { resuelto: TENDER_DE_REGALO },
        cierreDiferido: true,
      },
      RECONCILIACION,
    )
    expect(result.isFullyPaid).toBe(false)
    expect(result.paymentStatus).toBe('PARTIAL')
    expect(result.postingId).toBeNull()
  })
})
