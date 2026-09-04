/**
 * El reembolso del TPV honra la llave de idempotencia.
 *
 * 🔴 POR QUÉ EXISTE ESTA PRUEBA (medido el 3-sep-2026, no supuesto):
 *
 * La TPV está a punto de estrenar una cola durable de reembolsos — hoy, cuando el SDK ya
 * devolvió el dinero y el POST falla, el registro se pierde en silencio (`PaymentViewModel
 * .handleRefundSuccess` sólo escribe un `Timber.w`, con el comentario «we don't queue refunds
 * for offline retry»). Antes de encolar nada hay que poder REINTENTAR sin duplicar, y el
 * servidor no podía:
 *
 *   1. `RefundRequestData` NO declaraba `idempotencyKey`, así que ni el body ni el header
 *      `Idempotency-Key` (los dos los manda `PaymentApiService.recordRefund`) se leían;
 *   2. el `Payment` del reembolso se creaba SIN `idempotencyKey`, de modo que el
 *      `@@unique([venueId, idempotencyKey])` que YA existe en el modelo no protegía nada;
 *   3. el único candado era `refundAmountInPesos > remainingRefundable → BadRequestError`,
 *      que atrapa un reembolso TOTAL duplicado pero **deja pasar uno PARCIAL**: dos POST de
 *      $50 sobre un cobro de $100 creaban dos filas y devolvían $100.
 *
 * O sea que una cola de reintentos habría convertido una pérdida ÚNICA en una duplicación
 * REPETIDA, restando del turno y publicando otro `PAY_OUT` en cada vuelta. Peor que el
 * defecto que venía a arreglar.
 *
 * ⚠️ Hoy la TPV manda `idempotencyKey = null` SIEMPRE — `PaymentContext.RefundPayment` la
 * declara con default `null` y ningún constructor la puebla; encima Gson omite los nulos, así
 * que la llave ni siquiera viaja. Por eso este cambio del servidor es ADITIVO y seguro de
 * desplegar solo: sin llave se comporta exactamente como antes (lo fija el caso «APK viejo»).
 * Quien manda la llave es la Fase 1 del plan, en el cliente.
 *
 * El andamiaje de mocks se copia de `refund.turnoDelNegocio.test.ts` (mismo servicio bajo
 * prueba), que a su vez lo copió de `refund.cashDrawer.test.ts`.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  postCashRefundToDrawer: jest.fn().mockResolvedValue('POSTED'),
}))
jest.mock('@/services/dashboard/inventoryRestock.service', () => ({ restockOrderItems: jest.fn().mockResolvedValue({}) }))
jest.mock('@/services/payments/transactionCost.service', () => ({ createRefundTransactionCost: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/dashboard/commission/commission-calculation.service', () => ({
  createRefundCommission: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  generateDigitalReceipt: jest.fn().mockRejectedValue(new Error('sin recibo')),
}))
jest.mock('@/services/wallet/stampLedger.service', () => ({ reverseStampForOrder: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/referrals/referralRefund.service', () => ({ onOrderRefunded: jest.fn().mockResolvedValue(null) }))

import { Prisma } from '@prisma/client'
import { logAction } from '@/services/dashboard/activity-log.service'
import { postCashRefundToDrawer } from '@/services/shared/cashDrawerPosting'
import * as refundService from '@/services/tpv/refund.tpv.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const LLAVE = 'llave-abc-123'

/** El reembolso que YA existe en la base cuando llega el reintento. */
const reembolsoExistente = {
  id: 'pay-refund-ya-existia',
  venueId: VENUE,
  idempotencyKey: LLAVE,
  amount: -50,
  tipAmount: 0,
  status: 'COMPLETED',
  type: 'REFUND',
  authorizationNumber: '123456',
  referenceNumber: 'ref-1',
  receipts: [],
  /** El vínculo que el guardia de Q2 comprueba: este reembolso es DE `pay-orig`. */
  processorData: { originalPaymentId: 'pay-orig' },
}

/**
 * Arma el escenario de REINTENTO de verdad: corre un primer reembolso para APRENDER la llave
 * que el servicio persiste, y vuelve a armar con una fila que lleva ESA llave.
 *
 * 🔴 No se calcula la llave en la prueba a propósito: replicar aquí el `sha256` haría que la
 * prueba pasara siempre, porque estaría comprobando su propia copia de la fórmula. Aprendiéndola
 * de lo PERSISTIDO se fija la propiedad que de verdad importa —la llave con la que se BUSCA es
 * la misma con la que se GUARDA—, que es justo lo que el mock viejo no podía ver.
 */
const armarReintentoDe = async (
  extra: Record<string, unknown> = {},
  fila: Record<string, unknown> = {},
  opciones: Record<string, unknown> = {},
) => {
  armar()
  await refundService.recordRefund(VENUE, cuerpo({ idempotencyKey: LLAVE, ...extra }) as never)
  const llavePersistida = datosDelPagoCreado().idempotencyKey
  jest.clearAllMocks()
  armar({ ...opciones, yaExiste: { ...reembolsoExistente, idempotencyKey: llavePersistida, ...fila } })
  return llavePersistida
}

/**
 * Arma el camino completo. `yaExiste` = qué devuelve la búsqueda POR LLAVE:
 * `null` es el primer POST, el objeto es el reintento.
 */
function armar(opts: { yaExiste?: typeof reembolsoExistente | null; yaReembolsado?: number } = {}) {
  const { yaExiste = null, yaReembolsado = 0 } = opts

  const original = {
    id: 'pay-orig',
    venueId: VENUE,
    orderId: null,
    order: null,
    method: 'CASH',
    fundsFlow: 'CASH_DRAWER',
    amount: 100,
    tipAmount: 0,
    status: 'COMPLETED',
    type: 'REGULAR',
    processorData: { refundedAmount: yaReembolsado },
    source: 'TPV',
    terminalId: null,
    merchantAccountId: null,
    tenderTypeId: null,
    processedById: 'staff-1',
    receipts: [],
  }

  ;(prismaMock as any).payment = {
    // 🔑 El servicio hace DOS búsquedas distintas: el pago ORIGINAL con `findFirst`
    // tenant-scoped y el reembolso previo con `findUnique` por llave compuesta.
    findUnique: jest.fn().mockImplementation(async (args: any) => {
      const compuesta = args?.where?.venueId_idempotencyKey ?? args?.where?.Payment_venueId_idempotencyKey_key
      if (compuesta) {
        // 🔴 Se COMPARA la llave pedida, no se devuelve la fila a ciegas. Antes el mock
        // contestaba a cualquier búsqueda compuesta, así que los casos de reintento pasaban
        // aunque la llave derivada NO coincidiera con la persistida — o sea, pasaban aunque la
        // derivación estuviera rota. Lo cazó la 5ª auditoría.
        return yaExiste && compuesta.idempotencyKey === yaExiste.idempotencyKey ? yaExiste : null
      }
      return original
    }),
    findFirst: jest.fn().mockResolvedValue(original),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation(async (a: any) => ({ id: 'pay-refund-nuevo', ...a.data })),
    update: jest.fn().mockResolvedValue(original),
  }
  ;(prismaMock as any).shift = {
    findFirst: jest.fn().mockResolvedValue({ id: 'shift-negocio', status: 'OPEN' }),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  }
  ;(prismaMock as any).venueTransaction = { create: jest.fn().mockResolvedValue({}) }
  ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prismaMock))
  ;(prismaMock as any).$queryRaw = jest.fn().mockResolvedValue([original])
  return original
}

const cuerpo = (extra: Record<string, unknown> = {}) => ({
  venueId: VENUE,
  originalPaymentId: 'pay-orig',
  amount: 5000, // centavos → $50 sobre un cobro de $100 ⇒ PARCIAL, el caso que se colaba
  reason: 'cliente',
  staffId: 'staff-1',
  authorizationNumber: '123456',
  referenceNumber: 'ref-1',
  isPartialRefund: true,
  currency: 'MXN',
  ...extra,
})

const datosDelPagoCreado = () => (prismaMock as any).payment.create.mock.calls[0][0].data

beforeEach(() => jest.clearAllMocks())

describe('el reembolso del TPV honra la llave de idempotencia', () => {
  it('🔴 persiste la llave en la fila creada — sin esto el @@unique no protege nada', async () => {
    armar()

    await refundService.recordRefund(VENUE, cuerpo({ idempotencyKey: LLAVE }) as never)

    // Lo persistido NO es la llave del cliente: es la huella de (llave, pago original, monto).
    const guardada = datosDelPagoCreado().idempotencyKey
    expect(guardada.startsWith('refund:')).toBe(true)
    expect(guardada.length).toBe(64)
  })

  it('🔴 un reintento con la MISMA llave devuelve el existente y NO crea otra fila', async () => {
    await armarReintentoDe()

    const r = await refundService.recordRefund(VENUE, cuerpo({ idempotencyKey: LLAVE }) as never)

    expect(r.id).toBe('pay-refund-ya-existia')
    expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
  })

  it('🔴 el reintento NO vuelve a decrementar el turno', async () => {
    await armarReintentoDe()

    await refundService.recordRefund(VENUE, cuerpo({ idempotencyKey: LLAVE }) as never)

    // Decrementar dos veces le firmaría al cajero un faltante que no existe.
    expect((prismaMock as any).shift.updateMany).not.toHaveBeenCalled()
    expect((prismaMock as any).shift.update).not.toHaveBeenCalled()
  })

  it('🔴 el reintento se resuelve ANTES del guardia de sobre-reembolso', async () => {
    // Un reembolso TOTAL ya aplicado deja `remainingRefundable` en 0. Si la comprobación de
    // la llave fuera después, el reintento rebotaría con un 400 que el cliente NO puede
    // distinguir de un rechazo real: la cola lo marcaría `Permanent`, alarmaría al cajero y
    // —con la barrera de la Fase 2— bloquearía el cierre de turno por un reembolso que SÍ
    // quedó registrado.
    // El primer intento (el que aprende la llave) usa EL MISMO cuerpo que el reintento: con el
    // monto dentro de la huella, aprenderla con otro importe daría una llave distinta.
    await armarReintentoDe({ amount: 10000, isPartialRefund: false }, {}, { yaReembolsado: 100 })

    const r = await refundService.recordRefund(VENUE, cuerpo({ idempotencyKey: LLAVE, amount: 10000, isPartialRefund: false }) as never)

    expect(r.id).toBe('pay-refund-ya-existia')
  })

  it('🔴 si dos reintentos corren a la vez, el P2002 devuelve al ganador en vez de reventar', async () => {
    // Los dos leen `null` (nadie existía todavía) y los dos llegan al create. El único que
    // puede resolverlo es el índice de la base; el perdedor tiene que devolver la fila del
    // ganador, no un 500 que la cola reintentaría para siempre.
    armar()
    ;(prismaMock as any).payment.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'x',
        meta: { target: ['venueId', 'idempotencyKey'] },
      }),
    )
    ;(prismaMock as any).payment.findUnique.mockImplementation(async (args: any) => {
      if (args?.where?.venueId_idempotencyKey || args?.where?.Payment_venueId_idempotencyKey_key) {
        // La primera lectura (antes del create) no lo ve; la de recuperación sí.
        return (prismaMock as any).payment.create.mock.calls.length > 0 ? reembolsoExistente : null
      }
      return { ...armarOriginal() }
    })

    const r = await refundService.recordRefund(VENUE, cuerpo({ idempotencyKey: LLAVE }) as never)

    expect(r.id).toBe('pay-refund-ya-existia')
    // El P2002 ocurre en Payment.create: la conciliación usa el id REAL y vive después,
    // por lo que el perdedor nunca deja una fila fantasma ni duplica la del ganador.
    expect((prismaMock as any).activityLog.create).not.toHaveBeenCalled()
  })

  it('rollback stateful P2002: descarta el decremento perdedor, devuelve al ganador y no deja audit fantasma', async () => {
    const original = armar()
    const committed = { totalSales: 300, totalTips: 40, payments: [] as any[], audits: [] as any[] }
    let stagedAlChocar: typeof committed | null = null
    let p2002Raised = false

    ;(prismaMock as any).payment.findUnique.mockImplementation(async (args: any) => {
      if (args?.where?.venueId_idempotencyKey || args?.where?.Payment_venueId_idempotencyKey_key) {
        return p2002Raised ? reembolsoExistente : null
      }
      return original
    })
    ;(prismaMock as any).$transaction.mockImplementationOnce(async (callback: any) => {
      const staged = {
        totalSales: committed.totalSales,
        totalTips: committed.totalTips,
        payments: [...committed.payments],
        audits: [...committed.audits],
      }
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: original.id,
            venueId: original.venueId,
            orderId: original.orderId,
            status: original.status,
            type: original.type,
            amount: original.amount,
            tipAmount: original.tipAmount,
            processorData: original.processorData,
          },
        ]),
        shift: {
          findFirst: jest.fn().mockResolvedValue({ id: 'shift-open', status: 'OPEN' }),
          updateMany: jest.fn().mockImplementation(async ({ data }: any) => {
            staged.totalSales -= Number(data.totalSales.decrement)
            if (data.totalTips) staged.totalTips -= Number(data.totalTips.decrement)
            return { count: 1 }
          }),
        },
        payment: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn().mockImplementation(async () => {
            stagedAlChocar = { ...staged, payments: [...staged.payments], audits: [...staged.audits] }
            p2002Raised = true
            throw new Prisma.PrismaClientKnownRequestError('unique', {
              code: 'P2002',
              clientVersion: 'x',
              meta: { target: ['venueId', 'idempotencyKey'] },
            })
          }),
          update: jest.fn(),
        },
        activityLog: {
          create: jest.fn().mockImplementation(async ({ data }: any) => {
            staged.audits.push(data)
            return { id: 'audit-staged' }
          }),
        },
        venueTransaction: { create: jest.fn() },
      }

      const result = await callback(tx)
      Object.assign(committed, staged)
      return result
    })

    const result = await refundService.recordRefund(VENUE, cuerpo({ idempotencyKey: LLAVE }) as never)

    expect(stagedAlChocar).toEqual({ totalSales: 250, totalTips: 40, payments: [], audits: [] })
    expect(result.id).toBe('pay-refund-ya-existia')
    expect(committed).toEqual({ totalSales: 300, totalTips: 40, payments: [], audits: [] })
    expect((prismaMock as any).activityLog.create).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
    expect(postCashRefundToDrawer).not.toHaveBeenCalled()
  })

  // ─── Hallazgos de la auditoría de Codex (3-sep-2026) ────────────────────────

  it('🔴 Q2: la llave reusada por un COBRO no se devuelve como si fuera el reembolso', async () => {
    // `Payment.idempotencyKey` es UNA sola columna para cobros Y reembolsos, y el
    // `@@unique` es de toda la tabla. Buscar sólo por (venueId, idempotencyKey) puede
    // devolver una VENTA. Sin este guardia, la respuesta diría que el pago se reembolsó
    // y el pago seguiría intacto.
    // 🔴 El 400 que había aquí antes REINTRODUCÍA el defecto original: cuando este código
    // corre el SDK YA devolvió el dinero, así que rechazar deja la devolución hecha y sin
    // asiento — y encima el mensaje decía «no se reembolsó nada», que es falso. Se degrada:
    // se registra el reembolso SIN llave, ruidosamente. Nunca se pierde el dinero.
    await armarReintentoDe({}, { type: 'REGULAR' })

    const r = await refundService.recordRefund(VENUE, cuerpo({ idempotencyKey: LLAVE }) as never)

    expect(r.id).toBe('pay-refund-nuevo')
    expect(datosDelPagoCreado().idempotencyKey).toBeUndefined()
  })

  it('🔴 Q2: la llave reusada sobre OTRO pago original tampoco se devuelve', async () => {
    await armarReintentoDe({}, { processorData: { originalPaymentId: 'pay-de-otra-venta' } })

    const r = await refundService.recordRefund(VENUE, cuerpo({ idempotencyKey: LLAVE }) as never)

    expect(r.id).toBe('pay-refund-nuevo')
    expect(datosDelPagoCreado().idempotencyKey).toBeUndefined()
  })

  it('🔴 R1b: el ganador de la carrera también pasa el guardia — un COBRO no se devuelve', async () => {
    // Arreglé el camino rápido y dejé abierta la recuperación: `ganador` se devolvía sin
    // comprobar `type` ni el pago original. Una venta concurrente con la misma llave se habría
    // respondido como reembolso exitoso. La prueba vieja no lo veía porque SIEMPRE usaba un
    // ganador válido — pasaba aunque el guardia no existiera.
    armar()
    ;(prismaMock as any).payment.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('choque', {
        code: 'P2002',
        clientVersion: 'x',
        meta: { target: ['venueId', 'idempotencyKey'] },
      }),
    )
    ;(prismaMock as any).payment.findUnique.mockImplementation(async (args: any) => {
      if (args?.where?.venueId_idempotencyKey) {
        return (prismaMock as any).payment.create.mock.calls.length > 0 ? { ...reembolsoExistente, type: 'REGULAR' } : null
      }
      return armarOriginal()
    })

    await expect(refundService.recordRefund(VENUE, cuerpo({ idempotencyKey: LLAVE }) as never)).rejects.toThrow()
  })

  it('🔴 Q3: un P2002 de OTRA restricción se relanza, no se traga como carrera ganada', async () => {
    // El catch aceptaba cualquier P2002. La misma transacción puede violar el PK de
    // `Payment` o los únicos de `VenueTransaction`; tragárselos devolvería 201 sobre una
    // transacción que nunca se escribió.
    armar()
    ;(prismaMock as any).payment.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('otra cosa', {
        code: 'P2002',
        clientVersion: 'x',
        meta: { target: ['VenueTransaction_paymentId_key'] },
      }),
    )
    // 🔑 La recuperación SÍ encuentra una fila con esa llave: sin comprobar el `target`,
    // el catch la devolvería como «otro ganó la carrera» y respondería 201 sobre una
    // transacción que jamás se escribió. Sin esta línea la prueba pasaría por el motivo
    // equivocado — relanzaría igual sólo porque no hay nada que devolver.
    ;(prismaMock as any).payment.findUnique.mockImplementation(async (args: any) => {
      if (args?.where?.venueId_idempotencyKey) {
        return (prismaMock as any).payment.create.mock.calls.length > 0 ? reembolsoExistente : null
      }
      return armarOriginal()
    })

    await expect(refundService.recordRefund(VENUE, cuerpo({ idempotencyKey: LLAVE }) as never)).rejects.toThrow()
  })

  it('🔴 Q6: una llave VACÍA se trata como ausente y NO se persiste', async () => {
    // `''` es falsy: no dispara el cortocircuito, pero antes SÍ se persistía. La siguiente
    // operación con llave vacía chocaba contra el índice y tampoco entraba al recovery
    // (su condición también es falsy) ⇒ reembolso real SIN registro contable.
    armar()

    await refundService.recordRefund(VENUE, cuerpo({ idempotencyKey: '   ' }) as never)

    expect(datosDelPagoCreado().idempotencyKey).toBeUndefined()
  })

  const llaveGuardadaPara = async (cuerpoDelPost: Record<string, unknown>) => {
    jest.clearAllMocks()
    armar()
    await refundService.recordRefund(VENUE, cuerpo(cuerpoDelPost) as never)
    return datosDelPagoCreado().idempotencyKey
  }

  it('🔴 el MISMO reembolso reintentado produce la MISMA llave — es lo que deduplica', async () => {
    const a = await llaveGuardadaPara({ idempotencyKey: LLAVE })
    const b = await llaveGuardadaPara({ idempotencyKey: LLAVE })

    expect(a).toBe(b)
  })

  it('🔴 el MISMO cliente con OTRO monto produce OTRA llave — un parcial nuevo no se traga', async () => {
    // Si la llave sólo dependiera de la cadena del cliente, un segundo reembolso parcial que
    // reusara la llave se habría devuelto como «reintento» y su dinero —ya devuelto por el
    // SDK— habría quedado SIN registrar. El monto entra en la huella para que eso no pase.
    const a = await llaveGuardadaPara({ idempotencyKey: LLAVE, amount: 5000 })
    const b = await llaveGuardadaPara({ idempotencyKey: LLAVE, amount: 2500 })

    expect(a).not.toBe(b)
  })

  it('🔴 el MISMO cliente sobre OTRO pago original produce OTRA llave', async () => {
    const a = await llaveGuardadaPara({ idempotencyKey: LLAVE })
    const b = await llaveGuardadaPara({ idempotencyKey: LLAVE, originalPaymentId: 'pay-otro' })

    expect(a).not.toBe(b)
  })

  it('🔴 dos devoluciones REALES distintas con la misma llave dan llaves distintas', async () => {
    // El caso de dinero de la 5ª auditoría: dos devoluciones de $50 sobre el MISMO cobro, con
    // la misma llave del cliente reusada, pero con AUTORIZACIONES distintas del procesador.
    // Antes daban la misma huella y la segunda se devolvía como «reintento» de la primera: su
    // dinero, ya entregado por el SDK, quedaba sin registrar.
    const a = await llaveGuardadaPara({ idempotencyKey: LLAVE, authorizationNumber: '111111' })
    const b = await llaveGuardadaPara({ idempotencyKey: LLAVE, authorizationNumber: '222222' })

    expect(a).not.toBe(b)
  })

  it('🔴 dos devoluciones con distinta REFERENCIA también se distinguen', async () => {
    const a = await llaveGuardadaPara({ idempotencyKey: LLAVE, referenceNumber: 'ref-A' })
    const b = await llaveGuardadaPara({ idempotencyKey: LLAVE, referenceNumber: 'ref-B' })

    expect(a).not.toBe(b)
  })

  it('🔴 un monto con decimales de centavo se rechaza antes de abrir transacción o llave', async () => {
    // El contrato vigente ya no redondea dos cantidades distintas a la misma huella: los
    // centavos son la unidad autoritativa y cualquier fracción se rechaza en el servicio.
    armar()

    await expect(refundService.recordRefund(VENUE, cuerpo({ idempotencyKey: LLAVE, amount: 100.4 }) as never)).rejects.toThrow(
      /amount.*entero seguro.*centavos/i,
    )

    expect((prismaMock as any).$transaction).not.toHaveBeenCalled()
    expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
  })

  it('🔴 una llave larguísima ya no es un caso especial — cabe y es determinista', async () => {
    // La columna es `@db.VarChar(64)`. Como TODA llave se hashea, el largo del cliente deja de
    // importar: ni tumba la transacción ni obliga a renunciar a la idempotencia.
    const larga = 'x'.repeat(5000)
    const a = await llaveGuardadaPara({ idempotencyKey: larga })
    const b = await llaveGuardadaPara({ idempotencyKey: larga })

    expect(a.length).toBe(64)
    expect(a).toBe(b)
  })

  it('🔴 Q1: el reintento NO toca el cajón — de eso se encarga el reconciliador', async () => {
    // 🔴 Yo había puesto aquí una reposición del `PAY_OUT`, y era PEOR que el hueco que venía
    // a tapar: no pasa `targetSessionId`, así que toma la caja abierta AHORA. Un reembolso de
    // ayer cuyo posting falló y se reintenta mañana entraba en la caja de mañana ⇒ faltante
    // inventado para un cajero que no hizo nada — el mismo defecto que se mató en agosto.
    //
    // El job `cash-drawer-reconciler` YA repone los `PAY_OUT` faltantes cada 5 min, y lo hace
    // bien: sólo dentro de la ventana `[openedAt, closedAt]` de la sesión que corresponde, y
    // lo que cae fuera lo reporta como `outsideDrawer` en vez de esconderlo.
    await armarReintentoDe()

    await refundService.recordRefund(VENUE, cuerpo({ idempotencyKey: LLAVE }) as never)

    expect(postCashRefundToDrawer).not.toHaveBeenCalled()
  })

  // ─── Compatibilidad con la calle ────────────────────────────────────────────

  it('sin llave (el APK que hay hoy en la calle) el comportamiento NO cambia', async () => {
    armar()

    const r = await refundService.recordRefund(VENUE, cuerpo() as never)

    expect(r.id).toBe('pay-refund-nuevo')
    expect((prismaMock as any).payment.create).toHaveBeenCalledTimes(1)
    expect(datosDelPagoCreado().idempotencyKey).toBeUndefined()
    // Y sin llave NO se busca por llave: una lectura de más en el camino del dinero por
    // cada reembolso de cada terminal vieja.
    for (const call of (prismaMock as any).payment.findUnique.mock.calls) {
      expect(call[0]?.where?.venueId_idempotencyKey).toBeUndefined()
    }
  })
})

/** El pago original, para el mock de recuperación del caso P2002. */
function armarOriginal() {
  return {
    id: 'pay-orig',
    venueId: VENUE,
    orderId: null,
    order: null,
    method: 'CASH',
    fundsFlow: 'CASH_DRAWER',
    amount: 100,
    tipAmount: 0,
    status: 'COMPLETED',
    type: 'REGULAR',
    processorData: { refundedAmount: 0 },
    source: 'TPV',
    terminalId: null,
    merchantAccountId: null,
    tenderTypeId: null,
    processedById: 'staff-1',
    receipts: [],
  }
}
