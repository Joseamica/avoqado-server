/**
 * Task 5k — 🔴 se podían reembolsar $150 sobre un cobro de $100.
 *
 * DEFECTO PREEXISTENTE (la lectura vieja es de `702e8966c`, dic-2025; la escritura de
 * `ea35b7b20`, ene-2026), destapado por la auditoría de Codex `gpt-5.6-sol` del 3-sep-2026.
 * No lo introdujo el plan del «turno de caja del negocio»; sale ahora porque se encontró.
 *
 * `recordRefund` **valida con la foto BLOQUEADA y escribía con la VIEJA**:
 *
 *   · `:363-364` lee `originalPayment.processorData` con un `findUnique` **FUERA** de la
 *     transacción — antes de que exista candado alguno;
 *   · `:454-467` vuelve a leer la MISMA fila con `SELECT … FOR UPDATE` dentro de la
 *     transacción y valida correctamente contra `lockedAlreadyRefunded`;
 *   · `:594-625` construía `newRefundedAmount`, `refundHistory`, `refunds[]` y hasta la base
 *     del spread (`...processorData`) desde la foto VIEJA, y `:635` la persistía.
 *
 * La carrera, con un cobro de $100 y dos reembolsos concurrentes de $60 y $40:
 *
 *   1. los dos leen `refundedAmount = 0` fuera del candado;
 *   2. A toma el candado, valida contra 0, escribe `refundedAmount = 60`;
 *   3. B toma el candado, ve correctamente `lockedRemaining = 40` y PASA — pero escribe
 *      `0 + 40 = 40`, **borrando los 60 de A** y su historial;
 *   4. un tercero de $50 lee «40 devueltos», ve $60 disponibles, pasa ⇒ **$150 sobre $100**.
 *
 * 🔴 LO QUE HACE QUE ESTA PRUEBA PRUEBE ALGO: las dos fotos **difieren**. `findUnique`
 * devuelve `refundedAmount: 0` (lo que B leyó antes del candado) y el `$queryRaw` del
 * `FOR UPDATE` devuelve `refundedAmount: 60` (lo que A ya dejó escrito). Con el MISMO valor
 * en las dos —como hacen las pruebas hermanas, que reusan un solo objeto— la prueba pasa con
 * el defecto vivo y no guarda nada.
 *
 * El andamiaje de mocks se copia de `refund.turnoDelNegocio.test.ts` (mismo servicio).
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

import * as refundService from '@/services/tpv/refund.tpv.service'
import logger from '@/config/logger'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'

/** El reembolso de $60 que YA ganó la carrera y dejó su huella bajo el candado. */
const ENTRADA_HISTORIAL_DE_A = {
  refundId: 'pay-refund-A',
  amount: 60,
  reason: 'primero',
  staffId: 'staff-1',
  timestamp: '2026-09-03T10:00:00.000Z',
}
const ENTRADA_REFUNDS_DE_A = {
  refundPaymentId: 'pay-refund-A',
  amount: 60,
  amountCents: 6000,
  reason: 'primero',
  at: '2026-09-03T10:00:00.000Z',
}

/**
 * 🔴 Una llave que NO la escribe el reembolso y que un proceso concurrente SÍ pone sobre el
 * MISMO `processorData`: el webhook de AngelPay estampa `angelpayWebhook` con un
 * `{...existingProcessorData}` propio (`angelpay-webhook.service.ts:653,694`). Sirve para fijar
 * que la BASE del spread es la foto bloqueada: con la vieja, todo lo que llegara entre las dos
 * lecturas se resucita al valor anterior — o desaparece.
 */
const SELLO_DEL_WEBHOOK = { receivedAt: '2026-09-03T10:00:30.000Z', reconciledVia: 'payment-create-backfill' }

/**
 * Arma las DOS fotos del mismo pago de $100:
 *   · `findUnique` → la vieja, sin reembolsos (lo que B leyó antes del candado);
 *   · `$queryRaw`  → la bloqueada, con los $60 de A ya aplicados.
 */
function armarCarrera() {
  const base = {
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
    source: 'TPV',
    terminalId: null,
    merchantAccountId: null,
    tenderTypeId: null,
    processedById: 'staff-1',
  }

  const fotoVieja = { ...base, processorData: {} }

  const fotoBloqueada = {
    ...base,
    processorData: {
      refundedAmount: 60,
      refundedAmountCents: 6000,
      isFullyRefunded: false,
      lastRefundId: 'pay-refund-A',
      lastRefundAt: '2026-09-03T10:00:00.000Z',
      refundHistory: [ENTRADA_HISTORIAL_DE_A],
      refunds: [ENTRADA_REFUNDS_DE_A],
      angelpayWebhook: SELLO_DEL_WEBHOOK,
    },
  }

  ;(prismaMock as any).payment = {
    findUnique: jest.fn().mockResolvedValue(fotoVieja),
    findFirst: jest.fn().mockResolvedValue(fotoVieja),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation(async (a: any) => ({ id: 'pay-refund-B', ...a.data })),
    update: jest.fn().mockResolvedValue(fotoBloqueada),
  }
  ;(prismaMock as any).shift = {
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  }
  ;(prismaMock as any).venueTransaction = { create: jest.fn().mockResolvedValue({}) }
  ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prismaMock))
  // El ÚNICO `$queryRaw` de este camino es el `SELECT … FOR UPDATE` del pago original.
  ;(prismaMock as any).$queryRaw = jest.fn().mockResolvedValue([fotoBloqueada])

  return { fotoVieja, fotoBloqueada }
}

const cuerpo = (extra: Record<string, unknown> = {}) => ({
  venueId: VENUE,
  originalPaymentId: 'pay-orig',
  amount: 4000, // centavos → $40
  reason: 'segundo',
  staffId: 'staff-1',
  authorizationNumber: '123456',
  referenceNumber: 'ref-B',
  isPartialRefund: true,
  currency: 'MXN',
  ...extra,
})

/** Lo que se persistió sobre el pago ORIGINAL. */
const escrito = () => (prismaMock as any).payment.update.mock.calls[0][0].data.processorData as Record<string, any>

beforeEach(() => jest.clearAllMocks())

describe('Task 5k — el acumulado del reembolso se construye con la foto BLOQUEADA', () => {
  it('🔴 acumula sobre lo que ya había bajo el candado ($60 + $40 = $100), no sobre la lectura vieja', async () => {
    armarCarrera()

    await refundService.recordRefund(VENUE, cuerpo() as never, 'staff-1')

    const pd = escrito()
    // Con el defecto vivo esto valía 40: los $60 de A quedaban borrados y el pago volvía a
    // tener $60 «disponibles» que ya se habían devuelto.
    expect(pd.refundedAmount).toBe(100)
    expect(pd.refundedAmountCents).toBe(10000)
  })

  it('🔴 el HISTORIAL no se borra: conserva la entrada del reembolso que ganó la carrera', async () => {
    armarCarrera()

    await refundService.recordRefund(VENUE, cuerpo() as never, 'staff-1')

    const pd = escrito()
    // Un acumulado correcto con el historial borrado sigue siendo un libro que miente:
    // nadie podría reconstruir a quién se le devolvieron los primeros $60.
    expect(pd.refundHistory).toHaveLength(2)
    expect(pd.refundHistory[0]).toEqual(ENTRADA_HISTORIAL_DE_A)
    expect(pd.refundHistory[1]).toMatchObject({ refundId: 'pay-refund-B', amount: 40 })

    expect(pd.refunds).toHaveLength(2)
    expect(pd.refunds[0]).toEqual(ENTRADA_REFUNDS_DE_A)
    expect(pd.refunds[1]).toMatchObject({ refundPaymentId: 'pay-refund-B', amount: 40, amountCents: 4000 })
  })

  it('🔴 la BASE del spread es la foto bloqueada: no resucita lo que otro escribió en medio', async () => {
    armarCarrera()

    await refundService.recordRefund(VENUE, cuerpo() as never, 'staff-1')

    // `angelpayWebhook` no existía en la foto vieja; con `...processorData` (la vieja) el
    // reembolso lo borraba de la fila, deshaciendo la conciliación del webhook.
    expect(escrito().angelpayWebhook).toEqual(SELLO_DEL_WEBHOOK)
  })

  it('marca el pago como totalmente reembolsado cuando el acumulado real lo alcanza', async () => {
    armarCarrera()

    await refundService.recordRefund(VENUE, cuerpo() as never, 'staff-1')

    // Con la foto vieja daba `false` (40 >= 100), así que un cobro ya devuelto por completo
    // se seguía anunciando como reembolsable.
    expect(escrito().isFullyRefunded).toBe(true)
  })

  it('deja dicho en el log que hubo un reembolso concurrente, con los dos números', async () => {
    armarCarrera()

    await refundService.recordRefund(VENUE, cuerpo() as never, 'staff-1')

    // Con el defecto vivo la carrera era INVISIBLE: el acumulado salía mal y nada la nombraba.
    const avisos = (logger.warn as jest.Mock).mock.calls.filter(([msg]) => String(msg).includes('Reembolso concurrente'))
    expect(avisos).toHaveLength(1)
    expect(avisos[0][1]).toMatchObject({
      originalPaymentId: 'pay-orig',
      devueltoAlLeerFueraDelCandado: 0,
      devueltoBajoElCandado: 60,
      esteReembolso: 40,
      totalDevueltoTrasEste: 100,
    })
  })

  // ─── Regresión: el camino normal (una sola petición) no cambia ────────────────

  it('sin carrera —las dos fotos iguales— el acumulado sale igual que siempre', async () => {
    armarCarrera()
    // Ambas lecturas ven lo mismo: es el caso de todos los días.
    const limpia = {
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
      source: 'TPV',
      terminalId: null,
      merchantAccountId: null,
      tenderTypeId: null,
      processedById: 'staff-1',
      processorData: {},
    }
    ;(prismaMock as any).payment.findUnique.mockResolvedValue(limpia)
    ;(prismaMock as any).$queryRaw.mockResolvedValue([limpia])

    await refundService.recordRefund(VENUE, cuerpo() as never, 'staff-1')

    const pd = escrito()
    expect(pd.refundedAmount).toBe(40)
    expect(pd.refundedAmountCents).toBe(4000)
    expect(pd.isFullyRefunded).toBe(false)
    expect(pd.refundHistory).toHaveLength(1)
    expect(pd.refunds).toHaveLength(1)
    // …y sin carrera no se ensucia el log: el aviso es señal, no ruido de cada reembolso.
    expect((logger.warn as jest.Mock).mock.calls.filter(([m]) => String(m).includes('Reembolso concurrente'))).toHaveLength(0)
  })
})

/**
 * Ronda de arreglo 1 — la guarda del remanente se puede volver INOFENSIVA sin que nadie se entere.
 *
 * El `SELECT … FOR UPDATE` de `:258` declara su tipo A MANO (`{ id; amount: unknown; tipAmount:
 * unknown; processorData: unknown }`), así que TypeScript NO comprueba que el SQL devuelva de
 * verdad esas columnas. Si una edición futura recorta una:
 *
 *   · sin `amount` → `Number(undefined)` = `NaN` ⇒ `lockedTotal` y `lockedRemaining` son `NaN` ⇒
 *     `refundAmountInPesos > NaN` es **`false`** ⇒ TODOS los reembolsos pasan la validación, en
 *     silencio y para siempre;
 *   · 🔴 sin `processorData` → no hay ningún `NaN` que delate nada: `?? {}` deja
 *     `lockedAlreadyRefunded` en **0** en cada reembolso ⇒ el acumulado se reinicia solo y
 *     RESUCITA el defecto de esta misma tarea. Por eso la guarda comprueba la PRESENCIA de la
 *     columna y no sólo que el número sea finito: `Number.isFinite` no ve este caso.
 *
 * Es la trampa «el mock te da el campo gratis, el `select` real no» que esta fase ya pagó una vez.
 */
describe('Ronda 1 — un SELECT recortado no puede volver inofensiva la guarda del remanente', () => {
  /** El pago bloqueado sin una de sus columnas: exactamente lo que deja un `SELECT` recortado. */
  function sinColumna(columna: 'amount' | 'tipAmount' | 'processorData') {
    const { fotoBloqueada } = armarCarrera()
    const recortada: Record<string, unknown> = { ...fotoBloqueada }
    delete recortada[columna]
    ;(prismaMock as any).$queryRaw.mockResolvedValue([recortada])
  }

  const noSeEscribioNada = () => {
    expect((prismaMock as any).payment.create).not.toHaveBeenCalled()
    expect((prismaMock as any).payment.update).not.toHaveBeenCalled()
    expect((prismaMock as any).shift.updateMany).not.toHaveBeenCalled()
  }

  it.each(['amount', 'tipAmount', 'processorData'] as const)(
    '🔴 si el SELECT deja de traer «%s», el reembolso se RECHAZA en vez de colarse',
    async columna => {
      sinColumna(columna)

      await expect(refundService.recordRefund(VENUE, cuerpo() as never, 'staff-1')).rejects.toThrow(/columna|SELECT/i)

      // Y no se registró nada: rechazar ruidosamente es lo único mejor que devolver de más.
      noSeEscribioNada()
    },
  )

  it('🔴 sin «processorData» NO hay NaN que delate nada — y aun así se rechaza', async () => {
    sinColumna('processorData')

    // Sin la guarda esto NO fallaba: `?? {}` dejaba el acumulado en 0 y el reembolso pasaba
    // tan campante, reiniciando el total devuelto en cada llamada.
    await expect(refundService.recordRefund(VENUE, cuerpo() as never, 'staff-1')).rejects.toThrow()
    noSeEscribioNada()
  })

  it('un valor NULO legítimo NO es una columna ausente: el reembolso pasa', async () => {
    const { fotoBloqueada } = armarCarrera()
    // `tipAmount` y `processorData` son nulables en el modelo. La llave ESTÁ, el valor es null:
    // eso es una fila normal, no un SELECT roto. Si la guarda no distinguiera los dos casos,
    // rechazaría reembolsos buenos — que es peor que el defecto que viene a cerrar.
    ;(prismaMock as any).$queryRaw.mockResolvedValue([{ ...fotoBloqueada, tipAmount: null }])

    await expect(refundService.recordRefund(VENUE, cuerpo() as never, 'staff-1')).resolves.toMatchObject({ id: 'pay-refund-B' })
  })

  it('🔴 un importe que no es número tampoco pasa (el cinturón, además de los tirantes)', async () => {
    const { fotoBloqueada } = armarCarrera()
    // La llave está, así que la comprobación de presencia no lo ve. Lo caza `Number.isFinite`.
    ;(prismaMock as any).$queryRaw.mockResolvedValue([{ ...fotoBloqueada, amount: 'no-es-un-numero' }])

    await expect(refundService.recordRefund(VENUE, cuerpo() as never, 'staff-1')).rejects.toThrow()
    noSeEscribioNada()
  })

  it('el SQL del candado nombra las tres columnas (aviso temprano, en CI y no en la caja)', async () => {
    armarCarrera()

    await refundService.recordRefund(VENUE, cuerpo() as never, 'staff-1')

    const sql = (prismaMock as any).$queryRaw.mock.calls[0][0]
    const texto: string = typeof sql === 'string' ? sql : (sql.sql ?? sql.strings?.join(' ') ?? String(sql))
    // La guarda de runtime protege el dinero pase lo que pase; esta prueba existe para que quien
    // recorte el SELECT se entere en CI, y no un cajero a media devolución.
    expect(texto).toMatch(/\bamount\b/)
    expect(texto).toMatch(/"tipAmount"/)
    expect(texto).toMatch(/"processorData"/)
    expect(texto).toMatch(/FOR UPDATE/)
  })
})
