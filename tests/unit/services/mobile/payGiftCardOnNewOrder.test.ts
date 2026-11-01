/**
 * S2b (Q58): la venta de mostrador nace y se cobra con saldo en UNA transacción (`payGiftCardOnNewOrder`). Aquí: el orden de
 * los candados (Q91), quién queda en la cuenta y quién en el cobro (Q76/Q110), la propina del cuerpo (la del COBRO), el sello de
 * un rechazo de dentro y el gate de la auditoría del turno. Lo de Postgres real (nada a medias, la otra caja, la carrera) vive en
 * `tests/integration/giftCards/cobroEnCuentaNueva.integration.test.ts`.
 */
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({
  generateAndStoreReceipt: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
}))
jest.mock('@/services/tpv/payment.tpv.service', () => ({
  mapDigitalReceiptResponse: jest.fn(() => null),
  resolveAutofacturaAvailable: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue(null),
  applySalePosting: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/dashboard/autoReorder.service', () => ({ runAutoReorderForVenue: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({ awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  lockAreaTicketCheckoutForPayment: jest.fn().mockResolvedValue(null),
  finalizeAreaTicketPaymentInTransaction: jest.fn().mockResolvedValue({ areaTicketOrder: false }),
}))
jest.mock('@/services/giftCards/giftCardTender', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardTender'),
  ensureGiftCardTender: jest.fn().mockResolvedValue({ id: 'tt-gift', revision: 1 }),
  resolveGiftCardTenderForChargeInTx: jest.fn().mockResolvedValue({
    tenderTypeId: 'tt-gift',
    tenderRevision: 1,
    method: 'OTHER',
    tenderLabel: 'Tarjeta de regalo',
    tenderCountsAsCash: false,
    tenderCaptureTip: true,
    tenderSatFormaPago: '01',
    tenderCommissionPercent: null,
    fundsFlow: 'EXTERNAL_RECORDED',
  }),
}))
const lockGiftCardsMock = jest.fn()
const canjearMock = jest.fn()
jest.mock('@/services/giftCards/giftCardLedger', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardLedger'),
  lockGiftCardsForUpdate: (...a: unknown[]) => lockGiftCardsMock(...a),
  canjearSobresEnTx: (...a: unknown[]) => canjearMock(...a),
}))
const resolverPruebaMock = jest.fn()
jest.mock('@/services/giftCards/giftCardProof', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardProof'),
  resolverPrueba: (...a: unknown[]) => resolverPruebaMock(...a),
}))
const canjearPremioMock = jest.fn()
const avisarPremioMock = jest.fn()
jest.mock('@/services/wallet/redeemStampReward.service', () => ({
  ...jest.requireActual('@/services/wallet/redeemStampReward.service'),
  canjearPremioEnTx: (...a: unknown[]) => canjearPremioMock(...a),
  avisarPremioCanjeado: (...a: unknown[]) => avisarPremioMock(...a),
}))
// El gate de la auditoría del turno: se resuelve FUERA de la transacción y llega al auditor del núcleo (4.º argumento).
const mockResolverConciliacion = jest.fn()
const mockAuditorDelTurno = jest.fn()
jest.mock('@/services/shared/paymentShiftClaim', () => ({
  ...jest.requireActual('@/services/shared/paymentShiftClaim'),
  resolvePaymentShiftReconciliationEnabled: (...a: unknown[]) => mockResolverConciliacion(...a),
  recordPendingPaymentShiftReconciliation: (...a: unknown[]) => mockAuditorDelTurno(...a),
}))

import { Prisma } from '@prisma/client'
import { BadRequestError } from '@/errors/AppError'
import { generateGiftCardCode, hashGiftCardCode } from '@/services/giftCards/giftCardCode'
import { rechazoSellado, reiniciarSellosParaPruebas } from '@/services/giftCards/giftCardPayKey'
import { payGiftCardOnNewOrder } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const D = (v: number) => new Prisma.Decimal(v)
const codigo = generateGiftCardCode()
const RELOJ_DE_LA_BASE = Date.parse('2026-10-21T18:00:00.000Z')
const sqlDe = (a: any): string => (Array.isArray(a) ? a.join('?') : String(a?.sql ?? ''))
const LLAVE = 'nueva-0001'

const sobreBloqueado = (over: Record<string, unknown> = {}) => ({
  id: 'gc-1',
  venueId: 'venue-1',
  codeHash: hashGiftCardCode(codigo.normalized),
  pageToken: 'liga-de-la-tarjeta-000000000',
  recipientPhone: null,
  deliveryChannel: 'PRINTED',
  status: 'ACTIVE',
  balance: D(1000),
  initialAmount: D(1000),
  expiresAt: null,
  activatedAt: new Date('2026-09-01T18:00:00Z'),
  validityMonths: null,
  customerId: null,
  ...over,
})

const venta = (over: Record<string, unknown> = {}) =>
  ({
    items: [{ name: 'Blusa', quantity: 1, unitPrice: 100000 }],
    staffId: 'staff-A',
    orderType: 'TAKEOUT',
    source: 'AVOQADO_ANDROID',
    idempotencyKey: LLAVE,
    proof: { kind: 'CODE', code: codigo.display },
    amount: D(400),
    tip: D(0),
    deviceId: 'dev-1',
    procesadoPor: 'staff-A',
    ...over,
  }) as unknown as Parameters<typeof payGiftCardOnNewOrder>[1]

/** Lo que pasó, en orden: el candado de la llave, el de `externalId`, la cuenta, el premio, el cobro. */
let pasos: string[]

beforeEach(() => {
  jest.clearAllMocks()
  reiniciarSellosParaPruebas()
  pasos = []
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.$executeRaw.mockImplementation(async (plantilla: any) => {
    if (sqlDe(plantilla).includes('pg_advisory_xact_lock')) pasos.push('llave')
    return 1
  })
  prismaMock.$queryRaw.mockImplementation(async (plantilla: any) => {
    const sql = sqlDe(plantilla)
    if (sql.includes('clock_timestamp')) return [{ ms: BigInt(RELOJ_DE_LA_BASE) }]
    if (sql.includes('hashtextextended')) {
      pasos.push('externalId')
      return [{ pg_advisory_xact_lock: '' }]
    }
    return [{ id: 'order-1' }]
  })
  resolverPruebaMock.mockImplementation(jest.requireActual('@/services/giftCards/giftCardProof').resolverPrueba)
  prismaMock.giftCard.findFirst.mockReset().mockResolvedValue({ id: 'gc-1', codeLast4: codigo.last4 })
  prismaMock.staffVenue.findFirst.mockImplementation(async (a: any) => ({
    id: `sv-${a?.where?.staffId}`,
    staffId: a?.where?.staffId,
    venueId: 'venue-1',
    active: true,
  }))
  prismaMock.payment.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.payment.findMany.mockResolvedValue([])
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.orderItem.findFirst.mockReset().mockResolvedValue(null)
  prismaMock.orderItem.findMany.mockResolvedValue([])
  // La cuenta recién creada: `findUnique` por llave de la venta no existe todavía; por id, la relee el núcleo del cobro.
  prismaMock.order.findUnique.mockImplementation(async (a: any) =>
    a?.where?.venueId_externalId
      ? null
      : {
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
          version: 1,
          areaTicketCode: null,
          tableId: null,
          total: D(1000),
          paidAmount: D(0),
          remainingBalance: D(1000),
        },
  )
  prismaMock.order.create.mockImplementation(async ({ data }: any) => {
    pasos.push('order.create')
    return {
      id: 'order-1',
      orderNumber: data.orderNumber,
      type: data.type,
      source: data.source,
      total: data.total,
      items: [],
      promotions: [],
    }
  })
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.payment.create.mockImplementation(async ({ data }: any) => {
    pasos.push('payment.create')
    return { id: 'payment-1', createdAt: new Date(), receipts: [], ...data }
  })
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.cashDrawerSession.findFirst.mockResolvedValue(null)
  lockGiftCardsMock.mockResolvedValue([sobreBloqueado()])
  canjearMock.mockResolvedValue([{ giftCardId: 'gc-1', amount: D(400), balanceAfter: D(600) }])
  canjearPremioMock.mockImplementation(async () => {
    pasos.push('premio')
    return {
      reward: { id: 'rw-1', customerId: 'cus-1', rewardType: 'FIXED_AMOUNT', rewardLabel: '$100 de premio' },
      discountAmount: 100,
      totals: {},
    }
  })
  mockResolverConciliacion.mockResolvedValue(true)
  mockAuditorDelTurno.mockResolvedValue(undefined)
})

describe('payGiftCardOnNewOrder', () => {
  it('🔴 el tip del cuerpo es la propina del COBRO (pesos), no la de la orden: la cuenta nace con tipAmount 0', async () => {
    await payGiftCardOnNewOrder('venue-1', venta({ tip: D(20) }))
    expect(prismaMock.order.create.mock.calls[0][0].data.tipAmount).toEqual(D(0))
    expect(prismaMock.payment.create.mock.calls[0][0].data).toMatchObject({ amount: 400, tipAmount: 20, idempotencyKey: LLAVE })
    expect(canjearMock.mock.calls[0][1].amount).toEqual(D(420))
  })

  it('🔴 Q76: cajera A elige al vendedor B ⇒ la cuenta queda de B y el cobro (y su REDEEM) lo procesó A', async () => {
    await payGiftCardOnNewOrder('venue-1', venta({ staffId: 'staff-B', procesadoPor: 'staff-A' }))
    expect(prismaMock.order.create.mock.calls[0][0].data).toMatchObject({ servedById: 'staff-B', createdById: 'staff-B' })
    expect(prismaMock.payment.create.mock.calls[0][0].data).toMatchObject({ processedById: 'staff-A' })
    expect(canjearMock.mock.calls[0][1]).toMatchObject({ staffId: 'staff-A' })
  })

  it('sin otro vendedor (la app manda la sesión, como `POST /orders`) los dos son A', async () => {
    await payGiftCardOnNewOrder('venue-1', venta())
    expect(prismaMock.order.create.mock.calls[0][0].data).toMatchObject({ servedById: 'staff-A', createdById: 'staff-A' })
    expect(prismaMock.payment.create.mock.calls[0][0].data).toMatchObject({ processedById: 'staff-A' })
  })

  it('la cuenta nace con la llave del cobro (`giftpay:` + llave), del tipo pedido y sin mesa', async () => {
    const r = await payGiftCardOnNewOrder('venue-1', venta())
    expect(prismaMock.order.create.mock.calls[0][0].data).toMatchObject({
      externalId: `giftpay:${LLAVE}`,
      tableId: null,
      type: 'TAKEOUT',
      source: 'AVOQADO_ANDROID',
    })
    expect(r).toMatchObject({ paymentId: 'payment-1', orderId: 'order-1', amount: 400, replay: false })
  })

  it('segunda red: si mesa, externalId o splitType llegaran al servicio (el esquema rechaza los dos primeros con 400), los pisa', async () => {
    const r = await payGiftCardOnNewOrder('venue-1', venta({ tableId: 'mesa-9', splitType: 'EQUAL', externalId: 'otra' } as any))
    expect(prismaMock.order.create.mock.calls[0][0].data).toMatchObject({
      externalId: `giftpay:${LLAVE}`,
      tableId: null,
      type: 'TAKEOUT',
      source: 'AVOQADO_ANDROID',
    })
    expect(r).toMatchObject({ paymentId: 'payment-1', orderId: 'order-1', amount: 400, replay: false })
  })

  it('🔴 Q91: lo PRIMERO de la transacción es el candado de la llave, antes del de `externalId` y de cualquier escritura', async () => {
    await payGiftCardOnNewOrder('venue-1', venta({ stampRewardId: 'rw-1' }))
    expect(pasos).toEqual(['llave', 'externalId', 'order.create', 'premio', 'payment.create'])
    expect(canjearPremioMock).toHaveBeenCalledWith(prismaMock, 'venue-1', 'order-1', 'rw-1')
  })

  it('🔴 Q91: `vigente` de la prueba se juzga con la hora que leyó el candado de la llave (la MISMA llamada)', async () => {
    const vigente = jest.fn(() => true)
    resolverPruebaMock.mockResolvedValue({ giftCardId: 'gc-1', last4: codigo.last4, vigente, rechazo: jest.fn() })
    await payGiftCardOnNewOrder('venue-1', venta())
    expect(vigente).toHaveBeenCalledWith(sobreBloqueado(), new Date(RELOJ_DE_LA_BASE))
  })

  it('🔴 el gate de la auditoría del turno se resuelve FUERA de la transacción y llega al auditor del núcleo', async () => {
    mockResolverConciliacion.mockResolvedValue(false)
    await payGiftCardOnNewOrder('venue-1', venta())
    expect(mockResolverConciliacion).toHaveBeenCalledWith(prismaMock, 'venue-1')
    expect(mockResolverConciliacion.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.$transaction.mock.invocationCallOrder[0])
    expect(mockAuditorDelTurno).toHaveBeenCalledWith(prismaMock, expect.objectContaining({ reconciliationEnabled: false }))
  })

  describe('Q91: la llave ya tiene su cobro cuando el candado se suelta', () => {
    /** El primer `findUnique` (el atajo) no ve nada; el de dentro del candado ve el cobro de la ganadora. */
    function ganadoraConHuella(huella: string | null) {
      let llamadasPorId = 0
      prismaMock.payment.findUnique.mockImplementation(async (a: any) => {
        if (a?.select?.tenderType)
          return {
            id: 'pay-ganador',
            orderId: 'order-ganadora',
            amount: D(400),
            tipAmount: D(0),
            tenderType: { systemKind: 'GIFT_CARD' },
            order: { orderNumber: 'ORD-G' },
            receipts: [],
          }
        llamadasPorId += 1
        return llamadasPorId === 1 ? null : { id: 'pay-ganador' }
      })
      prismaMock.payment.findFirst.mockResolvedValue({ order: { externalId: `giftpay:${LLAVE}` } })
      prismaMock.giftCardActivity.findMany.mockResolvedValue([
        { giftCardId: 'gc-1', amount: D(400), balanceAfter: D(600), giftCard: { codeLast4: codigo.last4 } },
      ])
      prismaMock.giftCardActivity.findFirst.mockResolvedValue(huella === null ? null : { operationHash: huella })
    }

    /** La huella del cuerpo, tal como la guardó el primer envío en su REDEEM. */
    async function huellaDe(over: Record<string, unknown> = {}): Promise<string> {
      await payGiftCardOnNewOrder('venue-1', venta(over))
      const huella = canjearMock.mock.calls[0][1].operationHash
      expect(typeof huella).toBe('string')
      jest.clearAllMocks()
      reiniciarSellosParaPruebas()
      pasos = []
      return huella
    }

    it('mismo cuerpo ⇒ ni cuenta ni premio: responde la ganadora como `replay`', async () => {
      const huella = await huellaDe({ stampRewardId: 'rw-1' })
      ganadoraConHuella(huella)
      const r = await payGiftCardOnNewOrder('venue-1', venta({ stampRewardId: 'rw-1' }))
      expect(r).toMatchObject({ paymentId: 'pay-ganador', orderId: 'order-ganadora', replay: true })
      expect(pasos).toEqual(['llave'])
      expect(prismaMock.order.create).not.toHaveBeenCalled()
      expect(canjearPremioMock).not.toHaveBeenCalled()
    })

    it('🔴 otro cuerpo con la misma llave ⇒ 409 IDEMPOTENCY_KEY_REUSED, nunca la venta ganadora como `replay`', async () => {
      const huella = await huellaDe()
      ganadoraConHuella(huella)
      await expect(
        payGiftCardOnNewOrder('venue-1', venta({ items: [{ name: 'Falda', quantity: 1, unitPrice: 100000 }] })),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 })
      expect(prismaMock.order.create).not.toHaveBeenCalled()
    })

    // Unión con develop: el descuento de catálogo de la cuenta (`orderDiscountId`) cambia lo que la venta debe, así que es OTRO
    // cuerpo. Sin él en la huella, la misma llave con otro descuento salía como `replay` de la primera venta.
    it('🔴 unión: el mismo cuerpo con otro descuento de catálogo de la cuenta ⇒ 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const huella = await huellaDe()
      ganadoraConHuella(huella)
      await expect(payGiftCardOnNewOrder('venue-1', venta({ orderDiscountId: 'desc-1' }))).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
        statusCode: 409,
      })
      expect(prismaMock.order.create).not.toHaveBeenCalled()
    })

    // Codex unión r1 #2: «Pagar después» decide si el resto es deuda del cliente; la misma llave con otra decisión es otro cuerpo.
    it('🔴 unión: el mismo cuerpo con otro «Pagar después» ⇒ 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const huella = await huellaDe({ payLater: false })
      ganadoraConHuella(huella)
      await expect(payGiftCardOnNewOrder('venue-1', venta({ payLater: true }))).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
        statusCode: 409,
      })
      expect(prismaMock.order.create).not.toHaveBeenCalled()
    })

    it('la huella NO lleva quién lo empezó ni quién vende (Q110): el reenvío de otra sesión es el mismo cuerpo', async () => {
      const huella = await huellaDe()
      ganadoraConHuella(huella)
      const r = await payGiftCardOnNewOrder('venue-1', venta({ staffId: 'staff-B', procesadoPor: 'staff-B' }))
      expect(r.replay).toBe(true)
    })
  })

  it('🔴 Q60: un premio que ya no aplica rechaza TODO con 409 GIFT_CARD_STAMP_REWARD_NOT_APPLIED, y el rechazo se SELLA', async () => {
    canjearPremioMock.mockRejectedValue(new BadRequestError('Este premio ya fue canjeado.'))
    const error = await payGiftCardOnNewOrder('venue-1', venta({ stampRewardId: 'rw-1' })).catch(e => e)
    expect(error).toMatchObject({
      code: 'GIFT_CARD_STAMP_REWARD_NOT_APPLIED',
      statusCode: 409,
      message: 'Ese premio ya no aplica a esta venta. Quítalo y vuelve a cobrar.',
    })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(rechazoSellado('venue-1', LLAVE)).toBe(error)
  })

  it('🔴 un error que no es del premio (la base) al canjearlo sube tal cual: ni se vuelve 409 ni se sella', async () => {
    const deLaBase = new Error('la base no contesta')
    canjearPremioMock.mockRejectedValue(deLaBase)
    await expect(payGiftCardOnNewOrder('venue-1', venta({ stampRewardId: 'rw-1' }))).rejects.toBe(deLaBase)
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(rechazoSellado('venue-1', LLAVE)).toBeNull()
  })

  it('🔴 segunda red: la cuenta `giftpay:<llave>` ya existe sin su cobro ⇒ 409 IDEMPOTENCY_KEY_REUSED, sin crear nada y sin sellar', async () => {
    prismaMock.order.findUnique.mockImplementation(async (a: any) =>
      a?.where?.venueId_externalId?.externalId === `giftpay:${LLAVE}` ? { id: 'order-huerfana', items: [], promotions: [] } : null,
    )
    await expect(payGiftCardOnNewOrder('venue-1', venta())).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(rechazoSellado('venue-1', LLAVE)).toBeNull()
  })

  it('un saldo que no alcanza (dentro de la transacción) también se sella', async () => {
    lockGiftCardsMock.mockResolvedValue([sobreBloqueado({ balance: D(100) })])
    const error = await payGiftCardOnNewOrder('venue-1', venta()).catch(e => e)
    expect(error).toMatchObject({ code: 'GIFT_CARD_INSUFFICIENT_BALANCE' })
    expect(rechazoSellado('venue-1', LLAVE)).toBe(error)
  })

  it('una llave sellada responde su rechazo sin abrir transacción', async () => {
    canjearPremioMock.mockRejectedValue(new BadRequestError('Este premio ya fue canjeado.'))
    const primero = await payGiftCardOnNewOrder('venue-1', venta({ stampRewardId: 'rw-1' })).catch(e => e)
    prismaMock.$transaction.mockClear()
    await expect(payGiftCardOnNewOrder('venue-1', venta({ stampRewardId: 'rw-1' }))).rejects.toBe(primero)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('llave, prueba o monto mal formados: 400 antes de leer nada', async () => {
    await expect(payGiftCardOnNewOrder('venue-1', venta({ idempotencyKey: 'corta' }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(payGiftCardOnNewOrder('venue-1', venta({ amount: new Prisma.Decimal('10.001') }))).rejects.toMatchObject({
      statusCode: 400,
    })
    await expect(payGiftCardOnNewOrder('venue-1', venta({ proof: { kind: 'WALLET_PASS', qrToken: 'qr' } }))).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('el premio aplicado deja su bitácora y su aviso DESPUÉS del commit (como la creación de hoy)', async () => {
    await payGiftCardOnNewOrder('venue-1', venta({ stampRewardId: 'rw-1', staffId: 'staff-B' }))
    expect(avisarPremioMock).toHaveBeenCalledWith('venue-1', 'order-1', 'rw-1', expect.objectContaining({ id: 'rw-1' }), 100, 'staff-B')
    expect(avisarPremioMock.mock.invocationCallOrder[0]).toBeGreaterThan(prismaMock.payment.create.mock.invocationCallOrder[0])
  })
})
