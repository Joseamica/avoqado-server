/**
 * recordFastPayment — el cobro que trae orden se desvía a SU venta, no a una FAST vacía.
 *
 * 🔴 Nota de diseño — por qué esta suite NO mockea `recordOrderPayment`:
 * `recordOrderPayment` y `recordFastPayment` viven en el MISMO archivo
 * (`payment.tpv.service.ts`). En CommonJS, una función que llama a otra función
 * exportada del MISMO módulo lo hace contra el binding LOCAL (la declaración de
 * función), no contra el objeto `exports` — así que un `jest.mock('.../payment.tpv.service', …)`
 * que sustituye `recordOrderPayment` en el objeto exportado NUNCA intercepta esa
 * llamada interna (verificado empíricamente: con la delegación ya implementada, el
 * mock seguía en 0 llamadas y corría la función real).
 *
 * Por eso esta suite deja correr la `recordOrderPayment` REAL y verifica la
 * delegación por sus efectos observables en Prisma.
 *
 * 🔴 Ronda 3 — lo que esta suite dejó de mockear, y por qué importa:
 *
 * 1. `terminalPaymentService.closeRowFromPaymentTx` YA NO SE MOCKEA. La ronda anterior
 *    lo sustituía por un `jest.fn()` y, encima, fijaba A MANO el resultado de la
 *    relectura de la fila. O sea: la suite le dictaba a la prueba la respuesta de la
 *    única función de la que dependía la corrección. Con eso, los dos agujeros reales
 *    (paymentId AJENO y fila COMPLETED con paymentId NULO) no rompían un solo test.
 *    Ahora corre la implementación REAL contra una fila de arbitraje en memoria que
 *    ella misma muta — así el estado que ve el código bajo prueba lo produce el código
 *    de producción, no el autor del test.
 *
 * 2. Los pagos ya no se fijan con `mockResolvedValueOnce`: hay una tabla `Payment` en
 *    memoria. `payment.create` inserta; `findUnique`/`findFirst`/`findMany` consultan.
 *    Así la verificación de "¿mi pago aterrizó?" se DERIVA de si realmente se creó un
 *    pago — que es justo lo que la ronda anterior fijaba a mano — y los checks de
 *    idempotencia de la ruta FAST se comportan como en producción.
 *
 * Las dependencias CRUZADAS que sí se siguen mockeando (otro archivo, interceptables)
 * son sólo las que hacen falta para que ambos caminos terminen limpio: guard de
 * ventas, validación de staff, sockets, costo de transacción, comisión, auto-reorder,
 * recibo digital e inventario. Todas están además envueltas en try/catch en el propio
 * código de producción ("no tumbar el pago por un efecto secundario").
 *
 * 🔴 Ronda 4 (2026-08-12) — POR QUÉ el throw POST-commit ya NO se simula con inventario:
 *
 * Estos tests nacieron usando el `BadRequestError` del pre-flight de inventario como
 * vehículo para "truena DESPUÉS de comitear". Ese throw se ELIMINÓ a propósito en otra
 * rama: era un doble cobro VIVO (el POS pintaba error de inventario sobre un cobro que
 * sí pasó, el cajero volvía a pasar la tarjeta con llaves NUEVAS y la deduplicación no
 * lo atrapaba). Hoy el faltante vuelve como `inventoryWarning` en la respuesta 201 y no
 * lanza — ver `payment.inventory-post-commit.test.ts`.
 *
 * La protección de ESTA suite —no caer a FAST cuando el Payment ya aterrizó— NO es
 * código muerto: sigue habiendo un throw post-commit real, y es el que ahora la ancla
 * (`commitEnDuda`, abajo). El mapa completo de lo que puede tronar con el dinero ya
 * adentro, a hoy:
 *
 *   1. `prisma.$transaction` rechazando con el COMMIT ya aplicado — commit en duda: se
 *      pierde el ack, se cae la conexión, el pool corta al comitear. Prisma reporta
 *      fallo sobre datos que YA quedaron escritos y `recordOrderPayment` relanza ese
 *      error tal cual. ES EL QUE SE USA AQUÍ. (Misma familia que el doble cobro por
 *      error de transporte que ya nos costó un P1: nunca concluir "no se cobró" desde
 *      algo que no lo afirma.)
 *   2. El `throw updateError` de la rama autónoma, que sólo relanza `BadRequestError` /
 *      `NotFoundError`. Sigue en el código, pero HOY ninguna ruta post-commit produce
 *      esos tipos: el inventario ya no lanza, y todo lo demás de
 *      `updateOrderTotalsForStandalonePayment` o va en try/catch o lanza `Error`
 *      pelón / errores de Prisma, que ese clause deja pasar de largo a propósito. Es
 *      un guard latente, no una vía viva — por eso no se usa para anclar nada.
 */
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn().mockResolvedValue(undefined),
}))

// El posting durable nace dentro de la tx del cobro (fase 3.5); esta suite
// prueba la delegación, no el posting.
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: jest.fn().mockResolvedValue({ id: 'posting-test', status: 'PENDING' }),
  applySalePosting: jest.fn(),
}))
jest.mock('@/utils/staff-venue.util', () => ({
  __esModule: true,
  // recordOrderPayment/recordFastPayment llaman a un wrapper LOCAL (mismo módulo,
  // no interceptable) que sólo reenvía aquí — mockear el cruzado basta.
  validateStaffVenue: jest.fn().mockResolvedValue('staff-1'),
}))
// 🔴 `@/services/terminal-payment.service` NO se mockea a propósito (ver nota de arriba).
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { broadcastToVenue: jest.fn() },
  socketManager: { broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  __esModule: true,
  generateDigitalReceipt: jest.fn(),
}))
jest.mock('@/services/payments/transactionCost.service', () => ({
  __esModule: true,
  createTransactionCost: jest.fn(),
}))
jest.mock('@/services/dashboard/commission/commission-calculation.service', () => ({
  __esModule: true,
  createCommissionForPayment: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/dashboard/autoReorder.service', () => ({
  __esModule: true,
  runAutoReorderForVenue: jest.fn().mockResolvedValue({ ran: false }),
}))
// Lo usan los tests de throw POST-commit (updateOrderTotalsForStandalonePayment llama
// a esto por cada línea sin pagar del pre-flight). Default con stock de sobra para no
// afectar a los demás — se sobreescribe donde se necesita forzar el rechazo.
jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({
  __esModule: true,
  getProductInventoryStatus: jest.fn().mockResolvedValue({ inventoryMethod: 'QUANTITY', currentStock: 999 }),
  deductInventoryForProduct: jest.fn().mockResolvedValue(undefined),
}))
// Import dinámico dentro de recordFastPayment (gancho de referidos). Sin mockear,
// corre de verdad y truena por dependencias sin configurar — inofensivo (atrapado
// por su propio try/catch en la fuente) pero ensucia la salida con console.error.
jest.mock('@/services/referrals/referralQualification.service', () => ({
  __esModule: true,
  onOrderPaid: jest.fn().mockResolvedValue(undefined),
}))

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { recordFastPayment } from '@/services/tpv/payment.tpv.service'
import { getProductInventoryStatus } from '@/services/dashboard/productInventoryIntegration.service'

const prismaMock = prisma as any
const getProductInventoryStatusMock = getProductInventoryStatus as jest.Mock

// ---------------------------------------------------------------------------
// Fila de arbitraje EN MEMORIA. La lee `recordFastPayment` y la MUTA el
// `closeRowFromPaymentTx` real — nadie le dicta su contenido a la prueba.
// ---------------------------------------------------------------------------
type FakeRow = { requestId: string; venueId: string; orderId: string | null; status: string; paymentId: string | null }
let arbitrationRow: FakeRow | null = null

// Tabla `Payment` en memoria. `payment.create` inserta aquí, y las consultas —
// tanto la verificación de identidad como los checks de idempotencia de FAST —
// leen de aquí. Así "¿aterrizó mi pago?" se DERIVA de la realidad del fixture.
let payments: any[] = []

/** Igualdad simple + el único operador que usan estos where: `{ not: x }`. */
function whereMatches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, value]) => {
    if (value && typeof value === 'object' && 'not' in (value as any)) return row[key] !== (value as any).not
    return row[key] === value
  })
}

function installFakes() {
  prismaMock.terminalPaymentRequest.findUnique.mockImplementation(async ({ where }: any) =>
    arbitrationRow && arbitrationRow.requestId === where.requestId ? { ...arbitrationRow } : null,
  )
  prismaMock.terminalPaymentRequest.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (!arbitrationRow || arbitrationRow.requestId !== where.requestId) return { count: 0 }
    if (where.status?.not && arbitrationRow.status === where.status.not) return { count: 0 }
    if (where.status?.in && !where.status.in.includes(arbitrationRow.status)) return { count: 0 }
    Object.assign(arbitrationRow, data)
    return { count: 1 }
  })

  prismaMock.payment.create.mockImplementation(async ({ data }: any) => {
    const created = {
      id: `pay-${payments.length + 1}`,
      feeAmount: 0,
      netAmount: 0,
      status: 'COMPLETED',
      tipAmount: 0,
      processedBy: null,
      receipts: [],
      ...data,
    }
    payments.push(created)
    return created
  })
  prismaMock.payment.findFirst.mockImplementation(async ({ where }: any) => payments.find(p => whereMatches(p, where)) ?? null)
  prismaMock.payment.findMany.mockImplementation(async ({ where }: any) => payments.filter(p => whereMatches(p, where)))
  prismaMock.payment.findUnique.mockImplementation(async ({ where }: any) => {
    // Check 1 de idempotencia de FAST usa la llave compuesta del índice único.
    const compound = where.venueId_idempotencyKey
    if (compound) return payments.find(p => whereMatches(p, compound)) ?? null
    return payments.find(p => whereMatches(p, where)) ?? null
  })

  // Efectos secundarios post-commit que el código de producción ejecuta sin `await`
  // (`void …create().catch()`) o cuyo resultado recorre: sin estos, un `undefined`
  // revienta con TypeError, el catch de "modo autónomo" se lo traga, y el
  // `inventoryWarning` nunca llega a asignarse. Son fixture, no aserción.
  prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' })
  // `orderCustomer` no existe en el prismaMock compartido (tests/__helpers__/setup.ts);
  // se crea aquí en vez de tocar el helper global, que usan ~200 suites.
  prismaMock.orderCustomer = prismaMock.orderCustomer ?? { findMany: jest.fn() }
  prismaMock.orderCustomer.findMany.mockResolvedValue([])
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' })
  prismaMock.areaTicketInventoryReservation.findMany.mockResolvedValue([])
  prismaMock.order.update.mockResolvedValue(ordenActualizadaTrasCobro)
}

/**
 * Un throw POST-commit que SÍ ocurre hoy: la transacción del Payment comitea en la base
 * y el llamador ve un error igual (commit en duda). Es la vía que ancla la protección
 * contra duplicar — ver la nota de "Ronda 4" arriba para el mapa completo y para por qué
 * el rechazo de inventario ya no sirve como vehículo.
 */
function commitEnDuda(error: Error) {
  prismaMock.$transaction.mockImplementationOnce(async (callback: any) => {
    await callback(prismaMock) // el Payment SÍ queda escrito…
    throw error // …y aun así el llamador ve un error
  })
}

/** Orden real que hace COMPLETAR a recordOrderPayment sin disparar el pre-flight. */
const ordenQueCompleta = {
  id: 'order-real',
  venueId: 'venue-1',
  splitType: null,
  items: [],
  payments: [],
  total: 1000, // pago PARCIAL → willBeFullyPaid = false → sin pre-flight de inventario
  source: 'TPV',
  externalId: null,
}

/** Segunda lectura, ya con la transacción comiteada: dispara el pre-flight con FALTANTE. */
const ordenQueRechazaPorInventario = {
  id: 'order-real',
  venueId: 'venue-1',
  subtotal: 30,
  discountAmount: 0,
  paymentStatus: 'PENDING',
  servedById: 'staff-1',
  createdById: 'staff-1',
  items: [
    {
      id: 'item-1',
      productId: 'prod-1',
      product: { name: 'Producto agotado' },
      quantity: 1,
      areaTicketLineId: null,
      paymentAllocations: [],
      modifiers: [],
    },
  ],
  payments: [],
  customer: null,
}

/** Lo que devuelve `order.update` al marcar la cuenta pagada: la deducción itera SUS items. */
const ordenActualizadaTrasCobro = {
  ...ordenQueRechazaPorInventario,
  status: 'COMPLETED',
  paymentStatus: 'PAID',
  total: 30, // lo lee la lealtad post-deducción; sin él revienta y el aviso se pierde
  tableId: null,
}

describe('recordFastPayment — un cobro con orden NO crea venta sintetica', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    arbitrationRow = null
    payments = []
    installFakes()
  })

  it('con solicitud que traia orden, delega en recordOrderPayment preguntando por el orderId correcto', async () => {
    arbitrationRow = { requestId: 'req-1', orderId: 'order-real', venueId: 'venue-1', status: 'CANCELLED', paymentId: null }

    // No se mockea `order.findUnique` con una orden completa a propósito: el punto
    // de este test es sólo probar A QUIÉN se le pregunta.
    await recordFastPayment('venue-1', { amount: 30, terminalPaymentRequestId: 'req-1' } as any, 'user-1').catch(() => {})

    expect(prismaMock.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'order-real', venueId: 'venue-1' }) }),
    )
  })

  it('sin terminalPaymentRequestId sigue por la ruta FAST — ni siquiera consulta la fila', async () => {
    await recordFastPayment('venue-1', { amount: 30 } as any, 'user-1').catch(() => {})

    expect(prismaMock.terminalPaymentRequest.findUnique).not.toHaveBeenCalled()
    // Tampoco se acerca a la búsqueda de orden activa que sólo hace recordOrderPayment.
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
  })

  it('si la consulta de la fila truena, el cobro SÍ se registra por la ruta FAST (no sólo "no delegó")', async () => {
    // 🔴 Fail-open: un fallo de infra jamás puede impedir registrar dinero que YA se cobró.
    // La señal que detecta un catch fail-CERRADO es POSITIVA: el dinero quedó registrado.
    prismaMock.terminalPaymentRequest.findUnique.mockRejectedValueOnce(new Error('connection refused'))
    prismaMock.order.create.mockResolvedValueOnce({
      id: 'fast-order-1',
      venueId: 'venue-1',
      orderNumber: 'FAST-1',
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    })

    let result: any
    let caughtError: unknown
    try {
      result = await recordFastPayment(
        'venue-1',
        { amount: 30, tip: 0, terminalPaymentRequestId: 'req-1', method: 'CASH' } as any,
        'user-1',
      )
    } catch (err) {
      caughtError = err
    }

    expect(caughtError).toBeUndefined()
    expect(prismaMock.order.create).toHaveBeenCalled()
    expect(payments).toHaveLength(1)
    expect(result).toMatchObject({ id: payments[0].id })
    // Además de cobrar, no delegó.
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
  })

  it('si recordOrderPayment tiene éxito, recordFastPayment NO sigue de largo a crear una orden FAST', async () => {
    // Quitar el `return` de la delegación dejaría el cobro seguir de largo a la
    // lógica FAST, creando una SEGUNDA orden y un SEGUNDO Payment encima.
    arbitrationRow = { requestId: 'req-1', orderId: 'order-real', venueId: 'venue-1', status: 'CANCELLED', paymentId: null }
    prismaMock.order.findUnique.mockResolvedValueOnce(ordenQueCompleta)

    let result: any
    let caughtError: unknown
    try {
      result = await recordFastPayment(
        'venue-1',
        { amount: 30, tip: 0, terminalPaymentRequestId: 'req-1', method: 'CASH' } as any,
        'user-1',
      )
    } catch (err) {
      caughtError = err
    }

    expect(caughtError).toBeUndefined()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(payments).toHaveLength(1)
    expect(result).toMatchObject({ id: payments[0].id })
  })

  it('si recordOrderPayment truena al delegar, el cobro SÍ se registra por FAST en vez de perderse', async () => {
    // 🔴 La tarjeta YA se cobró. Sin este fallback, una orden que ya no existe (o un
    // venue con ventas deshabilitadas) dejaría el cobro sin registrar en NINGÚN lado
    // — peor que la venta FAST vacía que este cambio vino a arreglar.
    arbitrationRow = { requestId: 'req-1', orderId: 'order-real', venueId: 'venue-1', status: 'CANCELLED', paymentId: null }
    // Sin mockear `order.findUnique` → recordOrderPayment truena TEMPRANO (NotFoundError),
    // antes de escribir nada.
    prismaMock.order.create.mockResolvedValueOnce({
      id: 'fast-order-2',
      venueId: 'venue-1',
      orderNumber: 'FAST-2',
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    })

    let result: any
    let caughtError: unknown
    try {
      result = await recordFastPayment(
        'venue-1',
        { amount: 30, tip: 0, terminalPaymentRequestId: 'req-1', method: 'CASH', idempotencyKey: 'idem-1' } as any,
        'user-1',
      )
    } catch (err) {
      caughtError = err
    }

    expect(caughtError).toBeUndefined()
    // El dinero SÍ quedó registrado — por FAST, y UNA sola vez.
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(payments).toHaveLength(1)
    expect(result).toMatchObject({ id: payments[0].id })

    // El 🚨 NO es opcional: alguien tiene que revisar un cobro que no aterrizó en su venta.
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('🚨'),
      expect.objectContaining({ requestId: 'req-1', orderId: 'order-real' }),
    )
  })

  it('si recordOrderPayment truena DESPUÉS de comitear el pago, NO cae a FAST — no se duplica el cobro', async () => {
    // Throw TARDÍO: la transacción YA escribió el Payment en la base y el llamador ve
    // un error igual (commit en duda — se pierde el ack, se cae la conexión). Caer a
    // FAST aquí duplicaría el cobro.
    arbitrationRow = { requestId: 'req-1', orderId: 'order-real', venueId: 'venue-1', status: 'PENDING', paymentId: null }
    prismaMock.order.findUnique.mockResolvedValueOnce(ordenQueCompleta)
    const enDuda = new Error('Server has closed the connection.')
    commitEnDuda(enDuda)

    let result: any
    let caughtError: unknown
    try {
      result = await recordFastPayment(
        'venue-1',
        { amount: 3000, tip: 0, terminalPaymentRequestId: 'req-1', method: 'CASH', idempotencyKey: 'idem-post' } as any,
        'user-1',
      )
    } catch (err) {
      caughtError = err
    }

    // El error ORIGINAL sube tal cual — no uno inventado por FAST.
    expect(result).toBeUndefined()
    expect(caughtError).toBe(enDuda)

    // La señal inequívoca: un solo Payment y ninguna orden FAST encima.
    expect(payments).toHaveLength(1)
    expect(prismaMock.order.create).not.toHaveBeenCalled()

    // El 🚨 con el que Better Stack se entera de que alguien tiene que mirar esto.
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('DESPUÉS de comitear'),
      expect.objectContaining({ requestId: 'req-1', orderId: 'order-real' }),
    )
  })

  it('🔴 el aviso de inventario del cobro delegado viaja INTACTO al POS — y el fallback ni se asoma', async () => {
    // El cruce que ninguna de las dos ramas probó sola: el cobro llega por la ruta NUEVA
    // (delegación desde recordFastPayment) y el faltante de inventario se detecta con el
    // Payment YA comiteado. Como ese camino ya NO lanza, no hay nada a qué caer: el mismo
    // objeto que devuelve recordOrderPayment —`inventoryWarning` incluido— sube tal cual.
    //
    // Antes de las dos ramas, este mismo escenario era el doble cobro: el POS veía un
    // error, el cajero repasaba la tarjeta. Ahora ve el cobro confirmado + el faltante.
    arbitrationRow = { requestId: 'req-1', orderId: 'order-real', venueId: 'venue-1', status: 'PENDING', paymentId: null }
    prismaMock.order.findUnique.mockResolvedValueOnce(ordenQueCompleta).mockResolvedValueOnce(ordenQueRechazaPorInventario)
    // amount en CENTAVOS (totalAmount = amount/100): 3000 = $30, que calza con el
    // subtotal 30 de la 2ª orden y dispara isFullyPaid = true.
    getProductInventoryStatusMock.mockResolvedValueOnce({ inventoryMethod: 'QUANTITY', currentStock: 0 })

    const result: any = await recordFastPayment(
      'venue-1',
      { amount: 3000, tip: 0, terminalPaymentRequestId: 'req-1', method: 'CASH', idempotencyKey: 'idem-warn' } as any,
      'user-1',
    )

    // El aviso llega al POS con el detalle, no sólo un código.
    expect(result.inventoryWarning).toBeDefined()
    expect(result.inventoryWarning.code).toBe('INSUFFICIENT_INVENTORY')
    expect(result.inventoryWarning.issues).toEqual([
      expect.objectContaining({ productId: 'prod-1', productName: 'Producto agotado', requested: 1, available: 0 }),
    ])
    // La PRIMERA frase confirma el cobro — si alguna vez lo niega, el cajero vuelve a
    // pasar la tarjeta y estamos otra vez en el doble cobro.
    expect(result.inventoryWarning.message).toMatch(/^El cobro se registró correctamente/)

    // Y el fallback ni se asomó: un solo Payment, ninguna venta FAST, sin 🚨 de delegación.
    expect(payments).toHaveLength(1)
    expect(result).toMatchObject({ id: payments[0].id })
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('[FastPayment]'), expect.anything())
  })

  // =========================================================================
  // REGRESIONES DE LA REVISIÓN FINAL — los dos casos que la ronda anterior no
  // podía ver porque preguntaba por EXISTENCIA en la fila en vez de por
  // IDENTIDAD en la tabla Payment.
  // =========================================================================

  it('🔴 C1 — con un paymentId AJENO en la fila y un throw TEMPRANO, el cobro NO se pierde: se registra por FAST', async () => {
    // `TerminalPaymentRequest.paymentId` es un binding HEURÍSTICO: el watchdog ata
    // CUALQUIER Payment COMPLETED + tarjeta + posterior a la fila sobre esa orden, y
    // `closeRow` escribe el que reporte la terminal (campo opcional). O sea: que la
    // fila traiga un paymentId NO prueba que MI pago comiteó.
    //
    // Aquí la fila trae uno ajeno y recordOrderPayment truena TEMPRANO (orden
    // inexistente → nada escrito). Leer existencia concluiría "ya aterrizó" y
    // relanzaría: el cobro no quedaría registrado en NINGÚN lado — exactamente la
    // regresión que el fallback vino a evitar, y peor que antes de esta rama.
    arbitrationRow = {
      requestId: 'req-1',
      orderId: 'order-real',
      venueId: 'venue-1',
      status: 'COMPLETED',
      paymentId: 'pago-de-otra-cosa', // atado por el watchdog, NO por esta llamada
    }
    prismaMock.order.create.mockResolvedValueOnce({
      id: 'fast-order-c1',
      venueId: 'venue-1',
      orderNumber: 'FAST-C1',
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    })

    let result: any
    let caughtError: unknown
    try {
      result = await recordFastPayment(
        'venue-1',
        { amount: 30, tip: 0, terminalPaymentRequestId: 'req-1', method: 'CASH', idempotencyKey: 'idem-c1' } as any,
        'user-1',
      )
    } catch (err) {
      caughtError = err
    }

    // Lo único que importa: el dinero quedó registrado.
    expect(caughtError).toBeUndefined()
    expect(payments).toHaveLength(1)
    expect(result).toMatchObject({ id: payments[0].id })
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
  })

  it('🔴 I2 (keyless) — con la fila ya COMPLETED y paymentId NULO, un throw POST-commit NO duplica el Payment', async () => {
    // La premisa que la ronda anterior daba por buena —"closeRowFromPaymentTx escribe
    // el paymentId en la misma transacción, ambos comitean juntos o ninguno"— es FALSA
    // por una vía MAINLINE: `closeRowFromPaymentTx` retorna SIN escribir cuando la fila
    // ya está COMPLETED, y un resultado por socket con `status:'success'` y sin
    // paymentId la deja justo así ANTES del registro REST.
    //
    // Este test NO fija ese estado a mano: corre el `closeRowFromPaymentTx` REAL sobre
    // la fila en memoria y luego COMPRUEBA que quedó COMPLETED con paymentId nulo.
    // Con un payload sin llave de identidad (el peor caso: la ruta FAST tampoco tendría
    // con qué deduplicar), leer la fila concluiría "no aterrizó" → FAST → DOS Payments.
    arbitrationRow = { requestId: 'req-1', orderId: 'order-real', venueId: 'venue-1', status: 'COMPLETED', paymentId: null }
    prismaMock.order.findUnique.mockResolvedValueOnce(ordenQueCompleta)
    const enDuda = new Error('Server has closed the connection.')
    commitEnDuda(enDuda)
    prismaMock.order.create.mockResolvedValueOnce({
      id: 'fast-order-i2',
      venueId: 'venue-1',
      orderNumber: 'FAST-I2',
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    })

    let caughtError: unknown
    try {
      // Sin idempotencyKey ni referenceNumber: el payload del repro del revisor.
      await recordFastPayment('venue-1', { amount: 3000, tip: 0, terminalPaymentRequestId: 'req-1', method: 'CASH' } as any, 'user-1')
    } catch (err) {
      caughtError = err
    }

    // La premisa falsa, comprobada por el código REAL y no afirmada por el test:
    // la fila quedó COMPLETED y su paymentId sigue NULO pese a haber comiteado un pago.
    expect(arbitrationRow!.status).toBe('COMPLETED')
    expect(arbitrationRow!.paymentId).toBeNull()

    // Y aun así: UN solo Payment, ninguna orden FAST, y el error original arriba.
    // Sin llave de identidad, la certeza viene del censo antes/después de la orden.
    expect(payments).toHaveLength(1)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(caughtError).toBe(enDuda)
  })

  it('🔴 la verificación pregunta por MI llave a la tabla Payment, no por el paymentId de la fila', async () => {
    // El ancla del arreglo: la pregunta correcta es "¿existe el pago con MI
    // idempotencyKey en ESTA orden?". Si alguien la volviera a cambiar por una lectura
    // de `terminalPaymentRequest.paymentId`, este test cae.
    arbitrationRow = { requestId: 'req-1', orderId: 'order-real', venueId: 'venue-1', status: 'PENDING', paymentId: null }
    prismaMock.order.findUnique.mockResolvedValueOnce(ordenQueCompleta)
    commitEnDuda(new Error('Server has closed the connection.'))

    await recordFastPayment(
      'venue-1',
      { amount: 3000, tip: 0, terminalPaymentRequestId: 'req-1', method: 'CASH', idempotencyKey: 'idem-ancla' } as any,
      'user-1',
    ).catch(() => {})

    expect(prismaMock.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ venueId: 'venue-1', orderId: 'order-real', idempotencyKey: 'idem-ancla' }),
      }),
    )
  })

  it('🔴 una fila de OTRO venue no presta su orden: el cobro se registra como venta rápida y alerta', async () => {
    // `requestId` es @unique GLOBAL y lo genera el cliente: una colisión entre
    // inquilinos devolvería el orderId de otro negocio. Pagar esa orden le cobraría a
    // un venue la cuenta de otro, en silencio.
    arbitrationRow = { requestId: 'req-1', orderId: 'order-del-vecino', venueId: 'venue-2', status: 'CANCELLED', paymentId: null }
    prismaMock.order.create.mockResolvedValueOnce({
      id: 'fast-order-x',
      venueId: 'venue-1',
      orderNumber: 'FAST-X',
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    })

    const result = await recordFastPayment(
      'venue-1',
      { amount: 30, tip: 0, terminalPaymentRequestId: 'req-1', method: 'CASH', idempotencyKey: 'idem-x' } as any,
      'user-1',
    )

    // Nunca se acercó a la orden ajena.
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
    // El dinero SÍ se registró — en el venue del token, como venta rápida.
    expect(payments).toHaveLength(1)
    expect(result).toMatchObject({ id: payments[0].id })
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('🚨'),
      expect.objectContaining({ expectedVenueId: 'venue-1', rowVenueId: 'venue-2' }),
    )
  })
})
