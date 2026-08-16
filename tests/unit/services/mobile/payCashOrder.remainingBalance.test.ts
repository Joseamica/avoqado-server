/**
 * 🔴 EL SALDO AUTORITATIVO — el server deja de callarse cuánto falta, y deja de mentir.
 *
 * Descubierto auditando una venta de mostrador pagada en varias partes. `payCashOrder`
 * YA calcula dentro de la transacción todo lo necesario:
 *
 *     const remainingAfterPayment = newTotal - totalPaidIncludingTip
 *     const isFullyPaid = remainingAfterPayment <= 0.01
 *
 * …y ese resultado NO salía de la transacción. Tres defectos objetivos de estado/dinero:
 *
 *   1. La respuesta no decía cuánto falta → el POS lo adivinaba con aritmética local del
 *      carrito, que se desvía hasta centavos con promociones y cargos por servicio.
 *   2. `ORDER_UPDATED` emitía literal `paymentStatus: 'PAID'` aunque la orden quedara
 *      PARTIAL → el dashboard y cualquier otro cliente veían pagada una cuenta que debe.
 *   3. `onOrderPaid` (referidos) corría tras CUALQUIER abono. `referralQualification`
 *      pasa el referido de PENDING a QUALIFIED sin revalidar la orden → un referido se
 *      calificaba —y se emitían sus recompensas— con un pago PARCIAL.
 *
 * ── Unidades ──────────────────────────────────────────────────────────────────────
 * 🔴 TODA esta respuesta va en CENTAVOS ENTEROS. Es una frontera externa y ya hablaba
 * centavos en las dos direcciones (el controller exige `amount` "en centavos" y el
 * servicio hace `amount / 100`); el cálculo interno sigue en pesos/`Decimal` como manda
 * `.claude/rules/critical-warnings.md`, y la conversión ocurre sólo al serializar.
 * Los campos nuevos llevan el sufijo `Cents`; `amount`/`tipAmount` son centavos TAMBIÉN
 * aunque su nombre no lo diga (legado intocable: hay APKs viejos en la calle).
 * Los tests de abajo fijan las dos cosas para que nadie "uniforme" ninguna a pesos.
 *
 * ── Cómo se prueba ────────────────────────────────────────────────────────────────
 * Base FALSA con semántica CAS real (mismo patrón que payCashOrder.concurrency.test.ts):
 * `order.updateMany` sólo aplica si la versión coincide, y guarda lo escrito en la fila.
 * Eso permite el assert que de verdad importa: **la respuesta dice EXACTAMENTE lo mismo
 * que se persistió**, no un número parecido calculado aparte.
 */

jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

const mockBroadcastToVenue = jest.fn()
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: {
    getBroadcastingService: jest.fn(() => ({ broadcastToVenue: mockBroadcastToVenue })),
  },
}))

jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({
  generateAndStoreReceipt: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
}))

jest.mock('@/services/tpv/payment.tpv.service', () => ({
  mapDigitalReceiptResponse: jest.fn(() => ({ accessKey: 'ak-1', receiptUrl: 'https://r/ak-1', autofacturaAvailable: false })),
  resolveAutofacturaAvailable: jest.fn().mockResolvedValue(false),
  buildInventoryWarning: jest.fn(() => undefined),
}))

jest.mock('@/services/shared/cashDrawerPosting', () => ({
  postCashSaleToDrawer: jest.fn().mockResolvedValue('POSTED'),
  cashSaleDrawerLocalId: (paymentId: string) => `pay:${paymentId}`,
}))

// Posting durable: nace en la tx del cobro y se aplica post-commit. No es objeto
// de esta suite — defaults sanos para que el camino "pagada" llegue completo.
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: jest.fn().mockResolvedValue({ id: 'posting-1', status: 'PENDING' }),
  applySalePosting: jest.fn().mockResolvedValue({ postingId: 'posting-1', applied: true, issues: [] }),
}))

jest.mock('@/services/dashboard/autoReorder.service', () => ({
  __esModule: true,
  runAutoReorderForVenue: jest.fn().mockResolvedValue(undefined),
}))

// 🔴 El hook de referidos: se importa DINÁMICAMENTE dentro de payCashOrder, pero el
// registro de módulos de jest también intercepta `await import(...)`.
const mockOnOrderPaid = jest.fn().mockResolvedValue(undefined)
jest.mock('@/services/referrals/referralQualification.service', () => ({
  __esModule: true,
  onOrderPaid: (...args: unknown[]) => mockOnOrderPaid(...args),
}))

import { Decimal } from '@prisma/client/runtime/library'

import { SocketEventType } from '@/communication/sockets/types'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

interface FakeOrderRow {
  id: string
  orderNumber: string
  venueId: string
  paymentStatus: 'PENDING' | 'PARTIAL' | 'PAID'
  status: string
  subtotal: Decimal
  discountAmount: Decimal
  serviceChargeAmount: Decimal
  total: Decimal
  paidAmount: Decimal
  remainingBalance: Decimal
  version: number
  areaTicketCode: string | null
}

interface FakePayment {
  id: string
  amount: number
  tipAmount: number
  idempotencyKey: string | null
  method: string
}

function installFakeStore(
  initial: Partial<FakeOrderRow> = {},
  seededPayments: FakePayment[] = [],
  opts: { orderVanishesAfter?: number } = {},
) {
  const row: FakeOrderRow = {
    id: 'order-1',
    orderNumber: 'ORD-1',
    venueId: 'venue-1',
    paymentStatus: 'PENDING',
    status: 'CONFIRMED',
    subtotal: new Decimal(100),
    discountAmount: new Decimal(0),
    serviceChargeAmount: new Decimal(0),
    total: new Decimal(100),
    paidAmount: new Decimal(0),
    remainingBalance: new Decimal(100),
    version: 1,
    areaTicketCode: null,
    ...initial,
  }

  const payments: FakePayment[] = [...seededPayments]

  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))

  // 🔴 BASE FALSA MULTI-TENANT — el `where` SÍ se respeta.
  //
  // Antes este mock ignoraba el `where` y devolvía la fila siempre, así que
  // borrar el `venueId` de cualquier consulta dejaba la suite entera en verde.
  // Aislamiento de tenant es regla dura del proyecto (`critical-warnings.md`:
  // "EVERY database query MUST filter by venueId. No exceptions"), así que aquí
  // una consulta SIN `venueId` no encuentra nada: si alguien lo quita, truena.
  let orderReads = 0
  prismaMock.order.findUnique.mockImplementation(async ({ where }: any) => {
    orderReads++
    if (where?.venueId === undefined) return null // consulta sin tenant → no existe
    if (where.venueId !== row.venueId) return null
    if (where.id !== undefined && where.id !== row.id) return null
    // Simula que la orden deja de ser legible a partir de la N-ésima lectura
    // (se borró, otro tenant, la conexión se cayó). Sólo para el test de "no
    // inventes un snapshot"; por defecto nunca se activa.
    if (opts.orderVanishesAfter !== undefined && orderReads > opts.orderVanishesAfter) return null
    return { ...row }
  })

  prismaMock.order.updateMany.mockImplementation(async ({ where, data }: any) => {
    const versionMatches = where.version === undefined || where.version === row.version
    const statusMatches = !where.paymentStatus?.in || where.paymentStatus.in.includes(row.paymentStatus)
    if (!versionMatches || !statusMatches) return { count: 0 }

    row.paymentStatus = data.paymentStatus ?? row.paymentStatus
    row.status = data.status ?? row.status
    row.paidAmount = new Decimal(data.paidAmount ?? row.paidAmount)
    row.remainingBalance = new Decimal(data.remainingBalance ?? row.remainingBalance)
    row.total = new Decimal(data.total ?? row.total)
    if (data.version?.increment) row.version += data.version.increment
    return { count: 1 }
  })

  prismaMock.payment.findMany.mockImplementation(async () =>
    payments.map(p => ({ amount: new Decimal(p.amount), tipAmount: new Decimal(p.tipAmount) })),
  )

  prismaMock.payment.create.mockImplementation(async ({ data }: any) => {
    if (data.idempotencyKey && payments.some(p => p.idempotencyKey === data.idempotencyKey)) {
      const err: any = new Error('Unique constraint failed')
      err.code = 'P2002'
      throw err
    }
    const created: FakePayment = {
      id: `payment-${payments.length + 1}`,
      amount: Number(data.amount),
      tipAmount: Number(data.tipAmount),
      idempotencyKey: data.idempotencyKey ?? null,
      method: data.method,
    }
    payments.push(created)
    return { ...created, receipts: [] }
  })

  prismaMock.payment.findUnique.mockImplementation(async ({ where }: any) => {
    const key = where?.venueId_idempotencyKey?.idempotencyKey
    const found = payments.find(p => p.idempotencyKey === key)
    return found ? { ...found, amount: new Decimal(found.amount), tipAmount: new Decimal(found.tipAmount), receipts: [] } : null
  })

  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })

  return { row, payments }
}

/** El payload del último ORDER_UPDATED emitido, o undefined si no hubo. */
function lastOrderUpdatedPayload(): any {
  const calls = mockBroadcastToVenue.mock.calls.filter(c => c[1] === SocketEventType.ORDER_UPDATED)
  return calls.length ? calls[calls.length - 1][2] : undefined
}

describe('payCashOrder — saldo autoritativo en la respuesta', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockOnOrderPaid.mockResolvedValue(undefined)
  })

  // ── 1. LA RESPUESTA DICE CUÁNTO FALTA ────────────────────────────────────────

  it('🔴 un pago PARCIAL devuelve orderPaymentStatus PARTIAL y el restante exacto', async () => {
    // Cuenta de $100, abona $40 → faltan $60 = 6000 centavos.
    const { row } = installFakeStore()

    const res = await payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1' })

    expect(res.orderPaymentStatus).toBe('PARTIAL')
    expect(res.remainingBalanceCents).toBe(6000)
    expect(res.orderTotalCents).toBe(10000)
    expect(res.totalPaidCents).toBe(4000)

    // 🔴 El assert que de verdad importa: la respuesta NO puede desviarse de lo
    // que se persistió (que va en pesos), o el POS pinta un saldo que la base
    // contradice. Aquí se compara convirtiendo la fila, no al revés.
    expect(res.remainingBalanceCents).toBe(Math.round(Number(row.remainingBalance) * 100))
    expect(res.totalPaidCents).toBe(Math.round(Number(row.paidAmount) * 100))
    expect(res.orderTotalCents).toBe(Math.round(Number(row.total) * 100))
  })

  it('🔴 con DECIMALES el restante sigue cuadrando al centavo con lo persistido', async () => {
    // $123.45 con $10.00 de cargo por servicio = $133.45. Abona $50.00 → faltan $83.45.
    // Es justo el caso donde la aritmética local del carrito se desviaba, Y donde un
    // `* 100` sin redondear devolvería 8344.999999999998 en vez de 8345.
    const { row } = installFakeStore({
      subtotal: new Decimal(123.45),
      serviceChargeAmount: new Decimal(10),
      total: new Decimal(133.45),
      remainingBalance: new Decimal(133.45),
    })

    const res = await payCashOrder('venue-1', 'order-1', { amount: 5000, tip: 0, staffId: 'staff-1' })

    expect(res.orderPaymentStatus).toBe('PARTIAL')
    expect(res.remainingBalanceCents).toBe(8345)
    expect(res.orderTotalCents).toBe(13345)
    expect(res.totalPaidCents).toBe(5000)
    // 🔴 ENTEROS: nada de flotantes con cola decimal en un campo de dinero.
    expect(Number.isInteger(res.remainingBalanceCents)).toBe(true)
    expect(Number.isInteger(res.orderTotalCents)).toBe(true)
    expect(Number.isInteger(res.totalPaidCents)).toBe(true)
    // Respuesta == base.
    expect(res.remainingBalanceCents).toBe(Math.round(Number(row.remainingBalance) * 100))
    expect(res.orderTotalCents).toBe(Math.round(Number(row.total) * 100))
  })

  it('🔴 el segundo abono cierra la cuenta: PAID con restante 0', async () => {
    // Ya había $40 cobrados; entra el resto ($60) → la cuenta queda saldada.
    const { row } = installFakeStore(
      { paymentStatus: 'PARTIAL', paidAmount: new Decimal(40), remainingBalance: new Decimal(60), version: 2 },
      [{ id: 'payment-prev', amount: 40, tipAmount: 0, idempotencyKey: 'parte-1', method: 'CASH' }],
    )

    const res = await payCashOrder('venue-1', 'order-1', { amount: 6000, tip: 0, staffId: 'staff-1', idempotencyKey: 'parte-2' })

    expect(res.orderPaymentStatus).toBe('PAID')
    expect(res.remainingBalanceCents).toBe(0)
    expect(res.orderTotalCents).toBe(10000)
    expect(res.totalPaidCents).toBe(10000)
    expect(row.paymentStatus).toBe('PAID')
  })

  it('🔴 PAID con UN CENTAVO de residuo: el estado manda, el saldo no se falsea', async () => {
    // El caso feo. Cuenta de $2.01, el cliente da $2.00: el restante real cae en
    // 0.009999999999999787, que SÍ pasa la tolerancia `<= 0.01` → la orden queda
    // PAID con un centavo colgando. Es el estado que del otro lado obligó a poner
    // un guard, y aquí queda clavado:
    //   · `orderPaymentStatus` es 'PAID' → es lo que el cliente debe usar para
    //     decidir si la cuenta se cerró. NUNCA `remainingBalanceCents === 0`.
    //   · `remainingBalanceCents` es 1, no 0: espeja lo persistido en vez de
    //     mentir. Y es ENTERO — sin redondear saldría 0.9999999999999787.
    const { row } = installFakeStore({
      subtotal: new Decimal(2.01),
      total: new Decimal(2.01),
      remainingBalance: new Decimal(2.01),
    })

    const res = await payCashOrder('venue-1', 'order-1', { amount: 200, tip: 0, staffId: 'staff-1' })

    expect(res.orderPaymentStatus).toBe('PAID')
    expect(res.remainingBalanceCents).toBe(1)
    expect(Number.isInteger(res.remainingBalanceCents)).toBe(true)
    expect(res.orderTotalCents).toBe(201)
    expect(res.totalPaidCents).toBe(200)
    // El centavo cuadra: total − pagado === restante, todo en enteros.
    expect(res.orderTotalCents! - res.totalPaidCents!).toBe(res.remainingBalanceCents)
    expect(row.paymentStatus).toBe('PAID')
  })

  it('la propina entra en el total y en lo pagado (convención de este endpoint)', async () => {
    // total = subtotal - descuento + cargo + PROPINA. Cuenta $100 + $15 de propina
    // → total $115, pagado $115 (100 + 15), restante 0.
    const { row } = installFakeStore()

    const res = await payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 1500, staffId: 'staff-1' })

    expect(res.orderTotalCents).toBe(11500)
    expect(res.totalPaidCents).toBe(11500)
    expect(res.remainingBalanceCents).toBe(0)
    expect(res.orderPaymentStatus).toBe('PAID')
    expect(Number(row.total)).toBe(115)
  })

  // ── 2. REGRESIÓN: onOrderPaid SÓLO cuando la orden quedó pagada ──────────────

  it('🔴 un pago PARCIAL NO califica el referido (onOrderPaid no se llama)', async () => {
    installFakeStore()

    await payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1' })

    expect(mockOnOrderPaid).not.toHaveBeenCalled()
  })

  it('el pago que COMPLETA sí califica el referido', async () => {
    installFakeStore()

    await payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1' })

    expect(mockOnOrderPaid).toHaveBeenCalledTimes(1)
    expect(mockOnOrderPaid).toHaveBeenCalledWith({ orderId: 'order-1', venueId: 'venue-1' })
  })

  it('un fallo del hook de referidos NUNCA tumba el cobro', async () => {
    installFakeStore()
    mockOnOrderPaid.mockRejectedValue(new Error('referidos caído'))

    const res = await payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1' })

    expect(res.status).toBe('COMPLETED')
    expect(res.orderPaymentStatus).toBe('PAID')
  })

  // ── 3. REGRESIÓN: ORDER_UPDATED deja de mentir ───────────────────────────────

  it('🔴 ORDER_UPDATED lleva PARTIAL cuando la orden quedó parcial', async () => {
    installFakeStore()

    await payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1' })

    expect(lastOrderUpdatedPayload()).toMatchObject({
      orderId: 'order-1',
      orderNumber: 'ORD-1',
      paymentStatus: 'PARTIAL',
    })
  })

  it('ORDER_UPDATED sigue llevando PAID cuando la orden sí quedó pagada', async () => {
    installFakeStore()

    await payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1' })

    expect(lastOrderUpdatedPayload()).toMatchObject({ paymentStatus: 'PAID' })
  })

  // ── 4. CAMINO IDEMPOTENTE ────────────────────────────────────────────────────

  it('🔴 el reintento idempotente devuelve el saldo REAL, no 0 ni el del carrito', async () => {
    // El cliente reintenta la parte 1 de un cobro dividido: el pago ya existe y la
    // orden sigue debiendo $60. Devolver 0 aquí le diría "ya está saldada".
    installFakeStore({ paymentStatus: 'PARTIAL', paidAmount: new Decimal(40), remainingBalance: new Decimal(60), version: 2 }, [
      { id: 'payment-prev', amount: 40, tipAmount: 0, idempotencyKey: 'parte-1', method: 'CASH' },
    ])

    const res = await payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1', idempotencyKey: 'parte-1' })

    expect(res.paymentId).toBe('payment-prev')
    expect(res.orderPaymentStatus).toBe('PARTIAL')
    expect(res.remainingBalanceCents).toBe(6000)
    expect(res.orderTotalCents).toBe(10000)
    expect(res.totalPaidCents).toBe(4000)
  })

  it('🔴 el reintento de un cobro que YA cerró la cuenta devuelve PAID y 0', async () => {
    installFakeStore({ paymentStatus: 'PAID', paidAmount: new Decimal(100), remainingBalance: new Decimal(0), version: 3 }, [
      { id: 'payment-final', amount: 100, tipAmount: 0, idempotencyKey: 'ultima', method: 'CASH' },
    ])

    const res = await payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1', idempotencyKey: 'ultima' })

    expect(res.paymentId).toBe('payment-final')
    expect(res.orderPaymentStatus).toBe('PAID')
    expect(res.remainingBalanceCents).toBe(0)
    expect(res.totalPaidCents).toBe(10000)
  })

  it('el reintento idempotente NO vuelve a calificar el referido', async () => {
    installFakeStore({ paymentStatus: 'PAID', paidAmount: new Decimal(100), remainingBalance: new Decimal(0), version: 3 }, [
      { id: 'payment-final', amount: 100, tipAmount: 0, idempotencyKey: 'ultima', method: 'CASH' },
    ])

    await payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1', idempotencyKey: 'ultima' })

    expect(mockOnOrderPaid).not.toHaveBeenCalled()
  })

  // ── 5. REGRESIÓN: el contrato viejo intacto (hay APKs en la calle) ───────────

  it('🔴 ADITIVO: ningún campo que ya devolvía la respuesta cambió', async () => {
    installFakeStore()

    const res = await payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 1500, staffId: 'staff-1' })

    expect(res.paymentId).toBe('payment-1')
    expect(res.orderId).toBe('order-1')
    expect(res.orderNumber).toBe('ORD-1')
    // 🔴 CENTAVOS, tal como entraron — sin el sufijo en el nombre porque son
    // legado y renombrarlos rompería los APKs que ya están en la calle. Toda la
    // respuesta habla centavos: estos dos y los `…Cents` nuevos van en la MISMA
    // unidad. Convertirlos a pesos dividiría entre 100 el cobro que pinta el POS.
    expect(res.amount).toBe(10000)
    expect(res.tipAmount).toBe(1500)
    expect(res.method).toBe('CASH')
    expect(res.status).toBe('COMPLETED')
    expect(res.digitalReceipt).toEqual({ accessKey: 'ak-1', receiptUrl: 'https://r/ak-1', autofacturaAvailable: false })
  })

  it('🔴 ADITIVO: el camino idempotente conserva su forma vieja (centavos incluidos)', async () => {
    installFakeStore({ paymentStatus: 'PARTIAL', paidAmount: new Decimal(40), remainingBalance: new Decimal(60), version: 2 }, [
      { id: 'payment-prev', amount: 40, tipAmount: 5, idempotencyKey: 'parte-1', method: 'CASH' },
    ])

    const res = await payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 500, staffId: 'staff-1', idempotencyKey: 'parte-1' })

    expect(res.paymentId).toBe('payment-prev')
    expect(res.orderId).toBe('order-1')
    expect(res.orderNumber).toBe('ORD-1')
    expect(res.amount).toBe(4000)
    expect(res.tipAmount).toBe(500)
    expect(res.method).toBe('CASH')
    expect(res.status).toBe('COMPLETED')
  })

  // ── 6. `amount`/`tipAmount` del camino idempotente: ENTEROS ──────────────────

  it('🔴 el reintento idempotente devuelve amount/tipAmount ENTEROS, sin ruido de float', async () => {
    // Los campos legado se reconstruían con un `Number(decimal) * 100` pelón, que
    // NO redondea. Medido: 6.6% de los importes limpios de 2 decimales caen POR
    // DEBAJO del entero.
    //
    //   $19.99 → 1998.9999999999998   un cliente que TRUNCA lee $19.98 (un centavo
    //                                 de menos sobre un cobro que sí ocurrió)
    //   $0.29  → 28.999999999999996   y un decoder estricto (Moshi `nextInt`) LANZA
    //                                 excepción → el reintento falla entero
    //
    // Redondear no cambia nombre, ni tipo, ni unidad: sólo devuelve el entero que
    // siempre se quiso devolver. Ningún APK puede depender del ruido de float.
    installFakeStore({ paymentStatus: 'PARTIAL', paidAmount: new Decimal(20.28), remainingBalance: new Decimal(79.72), version: 2 }, [
      { id: 'payment-prev', amount: 19.99, tipAmount: 0.29, idempotencyKey: 'centavos', method: 'CASH' },
    ])

    const res = await payCashOrder('venue-1', 'order-1', { amount: 1999, tip: 29, staffId: 'staff-1', idempotencyKey: 'centavos' })

    expect(res.paymentId).toBe('payment-prev')
    expect(res.amount).toBe(1999)
    expect(res.tipAmount).toBe(29)
    expect(Number.isInteger(res.amount)).toBe(true)
    expect(Number.isInteger(res.tipAmount)).toBe(true)
  })

  // ── 7. Ausente es honesto; cero es mentira ───────────────────────────────────

  it('🔴 si la orden ya no se puede leer, OMITE los campos nuevos en vez de inventar 0', async () => {
    // Cero-y-PARTIAL es la peor combinación posible: le pinta al cajero
    // "falta por cobrar $0.00" sobre una cuenta que no existe. Omitirlos es lo
    // MISMO que responde un server viejo, así que el cliente cae a su fallback.
    // `orderVanishesAfter: 1` → la lectura inicial funciona (404/orderNumber) y
    // la del snapshot ya no encuentra la fila.
    installFakeStore(
      { paymentStatus: 'PARTIAL', paidAmount: new Decimal(40), remainingBalance: new Decimal(60), version: 2 },
      [{ id: 'payment-prev', amount: 40, tipAmount: 0, idempotencyKey: 'parte-1', method: 'CASH' }],
      { orderVanishesAfter: 1 },
    )

    const res = await payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1', idempotencyKey: 'parte-1' })

    // El pago SÍ se devuelve — lo viejo nunca se degrada.
    expect(res.paymentId).toBe('payment-prev')
    expect(res.status).toBe('COMPLETED')
    // Y lo nuevo se calla en vez de mentir.
    expect(res.remainingBalanceCents).toBeUndefined()
    expect(res.orderPaymentStatus).toBeUndefined()
    expect(res.orderTotalCents).toBeUndefined()
    expect(res.totalPaidCents).toBeUndefined()
    expect('remainingBalanceCents' in res).toBe(false)
  })

  // ── 8. Aislamiento de tenant ─────────────────────────────────────────────────

  it('🔴 TENANT: TODA lectura de la orden va filtrada por venueId', async () => {
    // Regla dura del proyecto. El filtro estaba en el código pero no lo defendía
    // nadie: con el mock viejo (que ignoraba el `where`) borrar el `venueId` de
    // `readOrderBalanceSnapshot` dejaba los 15 tests en verde.
    installFakeStore({ paymentStatus: 'PARTIAL', paidAmount: new Decimal(40), remainingBalance: new Decimal(60), version: 2 }, [
      { id: 'payment-prev', amount: 40, tipAmount: 0, idempotencyKey: 'parte-1', method: 'CASH' },
    ])

    await payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1', idempotencyKey: 'parte-1' })

    const calls = prismaMock.order.findUnique.mock.calls
    expect(calls.length).toBeGreaterThan(1) // la inicial + la del snapshot
    for (const [args] of calls) {
      expect(args.where).toMatchObject({ venueId: 'venue-1' })
    }
  })

  it('🔴 TENANT: una orden de OTRO venue no se lee ni se cobra', async () => {
    installFakeStore()

    await expect(payCashOrder('venue-AJENO', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1' })).rejects.toThrow(/not found/i)
  })
})
