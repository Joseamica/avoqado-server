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
 * delegación por sus efectos observables en Prisma:
 *   - `recordOrderPayment` hace, como PRIMERA consulta sustantiva (sin
 *     idempotencyKey/referenceNumber en el payload, ambos checks previos se
 *     saltan), `prisma.order.findUnique({ where: { id: orderId, venueId } })`.
 *     Que esa consulta lleve el `orderId` de la fila de arbitraje —y no cree una
 *     orden nueva— prueba que la delegación ocurrió de verdad.
 *   - El error resultante ("Order order-real not found…") es exclusivo de
 *     `recordOrderPayment`; la ruta FAST nunca lo produce.
 *
 * 🔴 Ronda 2 (mutation testing) — dos huecos Critical que los mocks de "no se llegó
 * a llamar X" no cerraban:
 *   1. El test de fail-open sólo probaba "no delegó", no "SÍ se cobró por FAST". Un
 *      mutante que convierte el catch en fail-CERRADO (agrega `throw err`) seguía
 *      pasando los 3 tests originales.
 *   2. Ningún fixture dejaba tener ÉXITO a `recordOrderPayment`, así que un mutante
 *      que quita el `return` de la delegación (dejando el cobro seguir de largo a
 *      crear una orden FAST encima) también pasaba: el único test que delega SIEMPRE
 *      truena, y la excepción se propaga igual con o sin `return`.
 *
 * Para cerrar ambos huecos hace falta que la ruta FAST real (creación de orden +
 * pago) y la `recordOrderPayment` real puedan completar sin tronar en las pruebas
 * de éxito. Como ninguna de las dos es interceptable desde este archivo (mismo
 * problema de arriba: varias de sus dependencias — `updateOrderTotalsForStandalonePayment`,
 * la creación de la orden FAST — también viven en el MISMO módulo), se mockean sólo
 * las dependencias CRUZADAS (de otro archivo, sí interceptables) que hacen falta
 * para que ambos caminos terminen limpio: guard de ventas, validación de staff,
 * cierre de la fila de arbitraje, sockets, costo de transacción, comisión,
 * auto-reorder y recibo digital. Todas están además envueltas en try/catch en el
 * propio código de producción ("no tumbar el pago por un efecto secundario"), así
 * que ni siquiera son estrictamente obligatorias para que la función resuelva —
 * pero mockearlas evita ruido y hace el camino feliz determinista.
 *
 * 🔴 Ronda 2, hallazgo Important (resuelto por el founder — ahora SÍ en alcance):
 * si `recordOrderPayment` truena por dentro (pre-flight de inventario, venue con
 * ventas deshabilitadas, split incompatible, orden no encontrada…), la tarjeta YA
 * se cobró — dejar propagar el error perdería el registro del dinero en NINGÚN
 * lado, peor que la venta FAST vacía que este cambio vino a arreglar. Por eso
 * `recordFastPayment` ahora envuelve la delegación en try/catch: si truena, cae a
 * la ruta FAST de siempre (con un `logger.error('🚨 …')` obligatorio para que
 * alguien lo revise). Como consecuencia, el test original de "delega con el
 * orderId correcto" ya NO puede probarlo dejando tronar a recordOrderPayment y
 * comprobando el mensaje de su error — ese error ahora se traga y cae a FAST. Se
 * simplificó a probar sólo A QUIÉN se le preguntó; el fallback en sí tiene su
 * propio test dedicado más abajo.
 */
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/utils/staff-venue.util', () => ({
  __esModule: true,
  // recordOrderPayment/recordFastPayment llaman a un wrapper LOCAL (mismo módulo,
  // no interceptable) que sólo reenvía aquí — mockear el cruzado basta.
  validateStaffVenue: jest.fn().mockResolvedValue('staff-1'),
}))
jest.mock('@/services/terminal-payment.service', () => ({
  __esModule: true,
  terminalPaymentService: { closeRowFromPaymentTx: jest.fn().mockResolvedValue(undefined) },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
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

const prismaMock = prisma as any

describe('recordFastPayment — un cobro con orden NO crea venta sintetica', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.terminalPaymentRequest.findUnique.mockResolvedValue(null)
  })

  it('con solicitud que traia orden, delega en recordOrderPayment preguntando por el orderId correcto', async () => {
    prismaMock.terminalPaymentRequest.findUnique.mockResolvedValueOnce({
      orderId: 'order-real',
      venueId: 'venue-1',
      status: 'CANCELLED',
    })
    // No se mockea `order.findUnique` con una orden completa a propósito: el punto
    // de este test es sólo probar A QUIÉN se le pregunta. recordOrderPayment truena
    // (orden inexistente en el mock — NotFoundError), pero desde el fallback del
    // founder ese error ya NO se propaga: se traga y cae a FAST (probado en su
    // propio test más abajo). Por eso aquí sólo importa la consulta, no el resultado
    // final de la llamada — se tolera cualquier desenlace con `.catch()`.
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
    //
    // Ronda 2: antes esta prueba sólo comprobaba `order.findUnique` no llamado (=
    // "no delegó"). Un mutante que convierte el catch de la consulta en fail-CERRADO
    // (agrega `throw err` tras el logger.error) también deja "no delegó" en verdad
    // —porque ahora nada se registra en absoluto— y el test seguía en verde. La
    // señal que sí lo detecta es POSITIVA: el dinero quedó registrado por FAST.
    prismaMock.terminalPaymentRequest.findUnique.mockRejectedValueOnce(new Error('connection refused'))

    prismaMock.order.create.mockResolvedValueOnce({
      id: 'fast-order-1',
      venueId: 'venue-1',
      orderNumber: 'FAST-1',
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    })
    prismaMock.payment.create.mockResolvedValueOnce({
      id: 'fast-payment-1',
      feeAmount: 0,
      netAmount: 30,
      status: 'COMPLETED',
      type: 'FAST',
      amount: 30,
      tipAmount: 0,
      method: 'CASH',
      processedBy: null,
    })

    let result: any
    let caughtError: unknown
    try {
      result = await recordFastPayment('venue-1', { amount: 30, tip: 0, terminalPaymentRequestId: 'req-1', method: 'CASH' } as any, 'user-1')
    } catch (err) {
      caughtError = err
    }

    // Si el fail-open estuviera roto (catch fail-cerrado), esto quedaría undefined.
    expect(caughtError).toBeUndefined()
    // La prueba positiva: SÍ se creó la venta FAST y SÍ se registró el pago.
    expect(prismaMock.order.create).toHaveBeenCalled()
    expect(prismaMock.payment.create).toHaveBeenCalled()
    expect(result).toMatchObject({ id: 'fast-payment-1' })

    // Se conserva la señal original: tampoco se acercó a la búsqueda de orden
    // activa que sólo hace recordOrderPayment (o sea, además de cobrar, no delegó).
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
  })

  it('si recordOrderPayment tiene éxito, recordFastPayment NO sigue de largo a crear una orden FAST', async () => {
    // Ronda 2, Critical #2: quitar el `return` de la delegación no lo detectaba
    // ningún test, porque el único caso que delega SIEMPRE tronaba (orden
    // inexistente) — la excepción se propaga igual con o sin `return`, así que
    // "perder el `return`" era indistinguible. Aquí se arma un fixture donde
    // recordOrderPayment SÍ completa, para poder comprobar que la ejecución no
    // sigue de largo a la lógica FAST (que crearía una SEGUNDA orden y un SEGUNDO
    // Payment encima del que recordOrderPayment ya registró).
    prismaMock.terminalPaymentRequest.findUnique.mockResolvedValueOnce({
      orderId: 'order-real',
      venueId: 'venue-1',
      status: 'CANCELLED',
    })
    // Orden real sin líneas (evita el pre-flight de inventario por falta de items)
    // y con un total mucho mayor al pago (pago PARCIAL: willBeFullyPaid = false),
    // que también evita ese mismo pre-flight por el otro lado. Ninguna de las dos
    // cosas es lo que este test quiere ejercitar — sólo que recordOrderPayment
    // complete de verdad.
    prismaMock.order.findUnique.mockResolvedValueOnce({
      id: 'order-real',
      venueId: 'venue-1',
      splitType: null,
      items: [],
      payments: [],
      total: 1000,
      source: 'TPV',
      externalId: null,
    })
    prismaMock.payment.create.mockResolvedValueOnce({
      id: 'real-order-payment-1',
      feeAmount: 0,
      netAmount: 30,
      status: 'COMPLETED',
      type: 'REGULAR',
      amount: 30,
      tipAmount: 0,
      method: 'CASH',
      processedBy: null,
    })

    let result: any
    let caughtError: unknown
    try {
      result = await recordFastPayment('venue-1', { amount: 30, tip: 0, terminalPaymentRequestId: 'req-1', method: 'CASH' } as any, 'user-1')
    } catch (err) {
      caughtError = err
    }

    expect(caughtError).toBeUndefined()
    // La señal inequívoca de que NO se siguió de largo: nunca se creó una orden
    // FAST encima del pago que recordOrderPayment ya había registrado.
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    // Y el resultado devuelto es el de recordOrderPayment, no uno inventado por FAST.
    expect(result).toMatchObject({ id: 'real-order-payment-1' })
  })

  it('si recordOrderPayment truena al delegar, el cobro SÍ se registra por FAST en vez de perderse', async () => {
    // 🔴 Hallazgo Important resuelto por el founder: la tarjeta YA se cobró. Antes
    // de la delegación, ese dinero por lo menos aterrizaba en una venta FAST — sin
    // este fallback, un pre-flight de inventario, un venue con ventas deshabilitadas
    // o (como aquí) una orden que ya no existe dejarían el cobro sin registrar en
    // NINGÚN lado. Eso sería una regresión de ESTE cambio: peor que la venta FAST
    // vacía que se vino a arreglar.
    prismaMock.terminalPaymentRequest.findUnique.mockResolvedValueOnce({
      orderId: 'order-real',
      venueId: 'venue-1',
      status: 'CANCELLED',
    })
    // No se mockea `order.findUnique` con una orden completa → recordOrderPayment
    // truena con NotFoundError. Cualquier otra causa (inventario, venue deshabilitado,
    // split incompatible) tronaría igual de temprano y activaría el mismo fallback —
    // no hace falta ejercitar cada una para probar que el fallback en sí funciona.
    prismaMock.order.create.mockResolvedValueOnce({
      id: 'fast-order-2',
      venueId: 'venue-1',
      orderNumber: 'FAST-2',
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    })
    prismaMock.payment.create.mockResolvedValueOnce({
      id: 'fast-payment-2',
      feeAmount: 0,
      netAmount: 30,
      status: 'COMPLETED',
      type: 'FAST',
      amount: 30,
      tipAmount: 0,
      method: 'CASH',
      processedBy: null,
    })

    let result: any
    let caughtError: unknown
    try {
      result = await recordFastPayment('venue-1', { amount: 30, tip: 0, terminalPaymentRequestId: 'req-1', method: 'CASH' } as any, 'user-1')
    } catch (err) {
      caughtError = err
    }

    // Si el try/catch de la delegación se quitara, esto quedaría con el error real
    // de recordOrderPayment en vez de undefined.
    expect(caughtError).toBeUndefined()
    // El dinero SÍ quedó registrado — por FAST, y una sola vez (no se duplicó).
    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ id: 'fast-payment-2' })

    // El 🚨 NO es opcional: un cobro que no pudo aterrizar en su venta real
    // necesita que alguien lo revise, aunque el dinero sí haya quedado registrado.
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('🚨'),
      expect.objectContaining({ requestId: 'req-1', orderId: 'order-real' }),
    )
  })
})
