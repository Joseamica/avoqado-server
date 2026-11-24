/**
 * hz:fefa11b6:D20 0a — los lugares que ya pagó un crédito de paquete van en $0 y nunca se vuelven a cobrar.
 * Regla pura (los tramos) + la lectura del neto de créditos de la reserva.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { creditosDeLaReserva, tramosPorCreditos } from '@/services/reservation/loYaPagadoDeLaReserva'

const ver = (t: ReturnType<typeof tramosPorCreditos>) => t.map(tramos => tramos.map(x => [x.quantity, x.pagado]))

describe('tramosPorCreditos', () => {
  it('sin créditos: un solo tramo con todos los lugares (la cuenta nace igual que antes)', () => {
    expect(ver(tramosPorCreditos(['yoga'], 3, new Map()))).toEqual([[[3, false]]])
  })

  it('1 lugar y 1 crédito: pagado', () => {
    expect(ver(tramosPorCreditos(['yoga'], 1, new Map([['yoga', 1]])))).toEqual([[[1, true]]])
  })

  it('3 lugares y 2 créditos: 2 pagados y 1 por cobrar', () => {
    expect(ver(tramosPorCreditos(['yoga'], 3, new Map([['yoga', 2]])))).toEqual([
      [
        [2, true],
        [1, false],
      ],
    ])
  })

  it('más créditos que lugares: sólo cubre los lugares', () => {
    expect(ver(tramosPorCreditos(['yoga'], 1, new Map([['yoga', 5]])))).toEqual([[[1, true]]])
  })

  it('cita de dos servicios con crédito sólo del primero: el segundo se cobra entero', () => {
    expect(ver(tramosPorCreditos(['yoga', 'masaje'], 1, new Map([['yoga', 1]])))).toEqual([[[1, true]], [[1, false]]])
  })

  it('el mismo producto dos veces con un solo crédito: lo paga una sola vez', () => {
    expect(ver(tramosPorCreditos(['yoga', 'yoga'], 1, new Map([['yoga', 1]])))).toEqual([[[1, true]], [[1, false]]])
  })
})

describe('creditosDeLaReserva', () => {
  const mov = (type: 'REDEEM' | 'REFUND', quantity: number, productId = 'yoga') => ({ type, quantity, creditItemBalance: { productId } })

  it('neto por producto: REDEEM gasta, REFUND positivo regresa, REFUND 0 (marca) no cuenta', async () => {
    prismaMock.creditTransaction.findMany.mockResolvedValue([
      mov('REDEEM', -3),
      mov('REFUND', 1),
      mov('REFUND', 0),
      mov('REDEEM', -1, 'masaje'),
      mov('REFUND', 1, 'masaje'),
    ] as never)
    const r = await creditosDeLaReserva(prismaMock as never, { venueId: 'v', reservationId: 'r' })
    expect([...r.entries()]).toEqual([['yoga', 2]])
  })

  it('lee SÓLO los movimientos de la reserva y del negocio, con tope; nunca los saldos', async () => {
    prismaMock.creditTransaction.findMany.mockResolvedValue([] as never)
    await creditosDeLaReserva(prismaMock as never, { venueId: 'v', reservationId: 'r' })
    const args = prismaMock.creditTransaction.findMany.mock.calls[0][0] as any
    expect(args.where).toEqual({ venueId: 'v', reservationId: 'r', type: { in: ['REDEEM', 'REFUND'] } })
    expect(args.take).toBeGreaterThan(0)
    expect(JSON.stringify(args.select)).not.toMatch(/remainingQuantity|originalQuantity/)
  })
})
