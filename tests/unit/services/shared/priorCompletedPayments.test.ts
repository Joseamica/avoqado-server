/**
 * `countPriorCompletedPayments` contesta UNA pregunta de dinero: ¿el cobro que se está
 * registrando es el PRIMERO de su orden? Ese `0` es lo único que decide
 * `incrementTotalOrders` en el claim del turno — si la orden ya cuenta o no en `totalOrders`.
 *
 * Antes la misma consulta vivía copiada en cuatro rieles (TPV, pago manual, settle del
 * dashboard y confirmación de B4Bit) envuelta en
 * `typeof tx.payment.count === 'function' ? … : 0`. El Prisma TransactionClient real SIEMPRE
 * trae `payment.count`, así que la rama del `0` nunca corría en producción: su único efecto era
 * que un doble de prueba sin `count` contara cada cobro como «el primero» en silencio y la
 * suite siguiera en verde. Lo que fija esta prueba: la regla vive una sola vez y nunca contesta
 * a ciegas.
 */
import { countPriorCompletedPayments } from '@/services/shared/priorCompletedPayments'

const input = { venueId: 'venue-1', orderId: 'order-1' }

describe('countPriorCompletedPayments — ¿es el primer cobro de la orden?, y nunca en silencio', () => {
  it('cuenta sólo los pagos COMPLETED que no son reembolsos, acotados al venue Y a la orden', async () => {
    const tx = { payment: { count: jest.fn().mockResolvedValue(2) } }

    await expect(countPriorCompletedPayments(tx as never, input)).resolves.toBe(2)

    expect(tx.payment.count).toHaveBeenCalledTimes(1)
    expect(tx.payment.count).toHaveBeenCalledWith({
      where: { venueId: 'venue-1', orderId: 'order-1', status: 'COMPLETED', type: { not: 'REFUND' } },
    })
  })

  it('0 previos significa «este cobro es el primero de la orden»', async () => {
    const tx = { payment: { count: jest.fn().mockResolvedValue(0) } }

    await expect(countPriorCompletedPayments(tx as never, input)).resolves.toBe(0)
  })

  it('🔴 un tx sin payment.count revienta nombrando la dependencia: nunca cae a 0 (que contaría el cobro como el primero)', async () => {
    const txSinCount = { payment: { create: jest.fn(), findFirst: jest.fn() } }

    await expect(countPriorCompletedPayments(txSinCount as never, input)).rejects.toThrow(
      'countPriorCompletedPayments requiere una transacción con payment.count',
    )
    expect(txSinCount.payment.create).not.toHaveBeenCalled()
  })

  it('un tx sin modelo payment revienta con el MISMO mensaje, no con un TypeError sobre undefined', async () => {
    const txSinPayment = { shift: { findFirst: jest.fn() } }

    await expect(countPriorCompletedPayments(txSinPayment as never, input)).rejects.toThrow(
      'countPriorCompletedPayments requiere una transacción con payment.count',
    )
  })

  it('🔴 un count que resuelve undefined (un jest.fn() pelón) también revienta: un `?? 0` lo volvería «primer cobro» en silencio', async () => {
    const tx = { payment: { count: jest.fn() } }

    await expect(countPriorCompletedPayments(tx as never, input)).rejects.toThrow(
      'countPriorCompletedPayments: payment.count devolvió undefined en vez de un entero',
    )
  })

  it('un count que resuelve algo que no es un entero (null, texto, negativo) revienta igual', async () => {
    for (const raro of [null, '2', -1, 1.5]) {
      const tx = { payment: { count: jest.fn().mockResolvedValue(raro) } }
      await expect(countPriorCompletedPayments(tx as never, input)).rejects.toThrow('countPriorCompletedPayments: payment.count devolvió')
    }
  })
})
