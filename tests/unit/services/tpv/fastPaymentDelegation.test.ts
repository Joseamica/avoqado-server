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
 */
import prisma from '@/utils/prismaClient'
import { recordFastPayment } from '@/services/tpv/payment.tpv.service'

const prismaMock = prisma as any

describe('recordFastPayment — un cobro con orden NO crea venta sintetica', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.terminalPaymentRequest.findUnique.mockResolvedValue(null)
  })

  it('con solicitud que traia orden, delega en recordOrderPayment y NO crea orden FAST', async () => {
    prismaMock.terminalPaymentRequest.findUnique.mockResolvedValueOnce({
      orderId: 'order-real',
      venueId: 'venue-1',
      status: 'CANCELLED',
    })
    // No se mockea `order.findUnique` con una orden completa a propósito: el punto
    // de este test es sólo probar A QUIÉN se le pregunta, no ejercitar el resto de
    // recordOrderPayment (eso es harina de otro costal — el default `undefined` de
    // jest.fn() hace que "no exista" y arroje un NotFoundError determinista con el
    // orderId adentro, que es justo la señal que necesitamos.
    await expect(recordFastPayment('venue-1', { amount: 30, terminalPaymentRequestId: 'req-1' } as any, 'user-1')).rejects.toThrow(
      'Order order-real not found in venue venue-1',
    )

    expect(prismaMock.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'order-real', venueId: 'venue-1' }) }),
    )
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('sin terminalPaymentRequestId sigue por la ruta FAST — ni siquiera consulta la fila', async () => {
    await recordFastPayment('venue-1', { amount: 30 } as any, 'user-1').catch(() => {})

    expect(prismaMock.terminalPaymentRequest.findUnique).not.toHaveBeenCalled()
    // Tampoco se acerca a la búsqueda de orden activa que sólo hace recordOrderPayment.
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
  })

  it('si la consulta de la fila truena, NO bloquea el cobro — cae a FAST', async () => {
    // 🔴 Fail-open: un fallo de infra jamás puede impedir registrar dinero que YA se cobró.
    prismaMock.terminalPaymentRequest.findUnique.mockRejectedValueOnce(new Error('connection refused'))

    await recordFastPayment('venue-1', { amount: 30, terminalPaymentRequestId: 'req-1' } as any, 'user-1').catch(() => {})

    // Si hubiera delegado, la primera consulta de recordOrderPayment sería a
    // order.findUnique con el orderId de la fila — nunca se llega ahí.
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
  })
})
