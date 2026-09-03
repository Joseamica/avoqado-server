/**
 * Task 5r — 🔴 se podían devolver $130 sobre un cobro de $120.
 *
 * DEFECTO PREEXISTENTE, hermano del «$150 sobre $100» de la Task 5k pero por otra puerta:
 * aquél era una CARRERA (dos escritores simultáneos), éste es de SEMÁNTICA y basta con hacer
 * las cosas despacio y una por una.
 *
 * `refund.dashboard.service` medía lo ya devuelto como `Σ Math.abs(refund.amount)` —la VENTA
 * de cada reembolso previo, sin su propina, porque el `SELECT` ni siquiera pedía `tipAmount`—
 * y lo comparaba contra `amount + tipAmount`, que SÍ la incluye. Dos bases distintas para el
 * mismo cobro.
 *
 * Cobro de $100 + $20 de propina = **$120**:
 *
 *   1. reembolso A de $60 por el dashboard → se reparte 50 de venta + 10 de propina;
 *   2. reembolso B de $60 → el acumulado sólo «ve» los $50 de venta de A, así que cree que
 *      quedan $70 y PASA. Ya salieron $120 y persiste `50 + 60 = 110`;
 *   3. un tercero de $10 lee 110 sobre 120, cree que quedan 10, y PASA ⇒ **$130 sobre $120**.
 *
 * 🔴 LO QUE HACE QUE ESTA PRUEBA PRUEBE ALGO: el cobro lleva **propina**. Con `tipAmount = 0`
 * las dos semánticas coinciden y el archivo entero pasaría con el defecto vivo — que es
 * exactamente por qué las pruebas que ya existían no lo veían.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { PaymentType, TransactionStatus } from '@prisma/client'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'

/** Cobro de $100 de venta + $20 de propina = $120 entregados por el cliente. */
const cobroConPropina = (over: Record<string, unknown> = {}) => ({
  id: 'payment-original',
  venueId: VENUE,
  status: TransactionStatus.COMPLETED,
  type: PaymentType.REGULAR,
  method: 'CASH',
  source: 'APP',
  amount: 100,
  tipAmount: 20,
  orderId: 'order-1',
  shiftId: null,
  merchantAccountId: null,
  processorData: {},
  fundsFlow: null,
  tenderTypeId: null,
  tenderCountsAsCash: null,
  ...over,
})

/**
 * El reembolso A, tal y como el propio servicio lo dejó escrito: el split proporcional de
 * $60 sobre un cobro 100/20 es **$50 de venta + $10 de propina**, los dos en negativo.
 */
const REEMBOLSO_A = {
  id: 'refund-A',
  amount: -50,
  tipAmount: -10,
  createdAt: new Date('2026-09-03T10:00:00.000Z'),
  status: TransactionStatus.COMPLETED,
  processorData: { originalPaymentId: 'payment-original', amount: 60, amountCents: 6000 },
}

const REEMBOLSO_B = {
  id: 'refund-B',
  amount: -50,
  tipAmount: -10,
  createdAt: new Date('2026-09-03T10:05:00.000Z'),
  status: TransactionStatus.COMPLETED,
  processorData: { originalPaymentId: 'payment-original', amount: 60, amountCents: 6000 },
}

const reembolsar = (centavos: number) =>
  issueRefund({ venueId: VENUE, paymentId: 'payment-original', amount: centavos, reason: 'RETURNED_GOODS', staffId: 'staff-9' })

/** Lo que se persistió sobre el cobro ORIGINAL. */
const acumuladoEscrito = () => prismaMock.payment.update.mock.calls[0][0].data.processorData as Record<string, any>

describe('Task 5r — la propina ya devuelta cuenta en el acumulado del dashboard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.shift.findFirst.mockResolvedValue(null)
    prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
    prismaMock.payment.update.mockResolvedValue({ id: 'payment-original' })
    prismaMock.payment.create.mockResolvedValue({ id: 'refund-nuevo' })
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    }
    ;(prismaMock as any).cashDrawerEvent = { createMany: jest.fn().mockResolvedValue({ count: 1 }) }
  })

  it('🔴 tras DOS reembolsos de $60 que agotan los $120, el siguiente intento se RECHAZA', async () => {
    // El cobro ya trae su acumulado escrito con la regla vieja (50 + 60 = 110), que es
    // justo lo que dejaba $10 «disponibles». Las FILAS dicen la verdad: $120.
    prismaMock.$queryRaw
      .mockResolvedValueOnce([cobroConPropina({ processorData: { refundedAmount: 110, refundedAmountCents: 11000 } })])
      .mockResolvedValueOnce([REEMBOLSO_A, REEMBOLSO_B])

    await expect(reembolsar(1000)).rejects.toThrow(/exceeds remaining refundable/i)
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('🔴 el SEGUNDO reembolso de $60 sí pasa, y persiste los $120 completos (antes: $110)', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([cobroConPropina()]).mockResolvedValueOnce([REEMBOLSO_A])

    await reembolsar(6000)

    const pd = acumuladoEscrito()
    // Con el defecto vivo esto valía 110: los $10 de propina de A no se contaban y el cobro
    // seguía anunciando saldo reembolsable después de haber devuelto los $120 completos.
    expect(pd.refundedAmount).toBe(120)
    expect(pd.refundedAmountCents).toBe(12000)
  })

  it('🔴 un TERCER reembolso de $10 sobre esos mismos $120 ya no cabe', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([cobroConPropina()]).mockResolvedValueOnce([REEMBOLSO_A, REEMBOLSO_B])

    await expect(reembolsar(1000)).rejects.toThrow(/exceeds remaining refundable/i)
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('el remanente que se le devuelve a quien llama también descuenta la propina', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([cobroConPropina()]).mockResolvedValueOnce([REEMBOLSO_A])

    // $120 − $60 (A) − $30 (éste) = $30. Con el defecto vivo salían $40.
    const result = await reembolsar(3000)
    expect(result.remainingRefundable).toBe(30)
  })

  it('🔴 un reembolso previo que NO completó no cuenta como dinero devuelto', async () => {
    // Contar una fila que nunca movió dinero rechazaría un reembolso legítimo. El filtro vive
    // en `centavosDevueltosDeFilas` y NO en el SQL, para no tocar el conteo de ARTÍCULOS
    // devueltos, que sí necesita ver todas las filas.
    prismaMock.$queryRaw
      .mockResolvedValueOnce([cobroConPropina()])
      .mockResolvedValueOnce([{ ...REEMBOLSO_A, status: TransactionStatus.PENDING }])

    await expect(reembolsar(12000)).resolves.toMatchObject({ amount: 120 })
    expect(acumuladoEscrito().refundedAmountCents).toBe(12000)
  })

  it('🔴 el `SELECT` de los reembolsos previos SIGUE pidiendo "tipAmount"', () => {
    // El tipo de un `$queryRaw` se declara a mano: quitar la columna del SQL no rompe el
    // compilador, y en las pruebas unitarias el `$queryRaw` está mockeado, así que el texto
    // del SQL nunca se ejecuta. En producción la guarda de `centavosDevueltosDeFilas` lo
    // atrapa —revienta ruidoso en vez de contar la propina como 0—, pero eso es un 500 en
    // vivo. Esta línea lo caza aquí, que es donde cuesta barato.
    const fuente = readFileSync(join(__dirname, '../../../../src/services/dashboard/refund.dashboard.service.ts'), 'utf8')
    expect(fuente).toContain('SELECT id, amount, "tipAmount", "processorData", "createdAt", status')
  })

  // ─── Regresión: el camino de todos los días no cambia ────────────────────────────────

  it('sin propina el resultado es el de siempre', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([cobroConPropina({ amount: 100, tipAmount: 0 })]).mockResolvedValueOnce([])

    await reembolsar(4000)

    const pd = acumuladoEscrito()
    expect(pd.refundedAmount).toBe(40)
    expect(pd.refundedAmountCents).toBe(4000)
  })

  it('🔴 un acumulado MAYOR que las filas manda: un reembolso viejo sin `originalPaymentId` no se pierde', async () => {
    // Las filas ligadas suman $60, pero el cobro declara $120 devueltos. Recalcular a ciegas
    // desde las filas volvería a ofrecer ese dinero.
    prismaMock.$queryRaw
      .mockResolvedValueOnce([cobroConPropina({ processorData: { refundedAmountCents: 12000, refundedAmount: 120 } })])
      .mockResolvedValueOnce([REEMBOLSO_A])

    await expect(reembolsar(1000)).rejects.toThrow(/exceeds remaining refundable/i)
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })
})
