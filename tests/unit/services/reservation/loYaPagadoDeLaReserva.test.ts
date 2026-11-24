/**
 * hz:fefa11b6:D20 0a — los lugares que ya pagó un crédito de paquete van en $0 y nunca se vuelven a cobrar.
 * Regla pura (los tramos) + la lectura del neto de créditos de la reserva.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { creditosDeLaReserva, NOTA_PAGADA_CON_PAQUETE, partirPorCreditos } from '@/services/reservation/loYaPagadoDeLaReserva'

const D = (n: number) => new Prisma.Decimal(n)
const yoga = { productId: 'yoga', unitPrice: D(200) }
const masaje = { productId: 'masaje', unitPrice: D(800) }
const ver = (r: ReturnType<typeof partirPorCreditos>) =>
  r.tramos.map(t => [t.renglon, t.quantity, Number(t.unitPrice), t.notes, t.conModificadores])

describe('partirPorCreditos', () => {
  it('sin créditos: un tramo por servicio, todos los lugares a precio de lista (igual que antes)', () => {
    const r = partirPorCreditos([yoga], 3, new Map())
    expect(ver(r)).toEqual([[0, 3, 200, null, true]])
    expect(r.creditosAplicados).toBe(0)
  })

  it('1 lugar y 1 crédito: $0 con la nota y con los extras (no hay lugar que se cobre)', () => {
    expect(ver(partirPorCreditos([yoga], 1, new Map([['yoga', 1]])))).toEqual([[0, 1, 0, NOTA_PAGADA_CON_PAQUETE, true]])
  })

  it('3 lugares y 2 créditos: 2 en $0, 1 a precio; los extras van en el que se cobra', () => {
    const r = partirPorCreditos([yoga], 3, new Map([['yoga', 2]]))
    expect(ver(r)).toEqual([
      [0, 2, 0, NOTA_PAGADA_CON_PAQUETE, false],
      [0, 1, 200, null, true],
    ])
    expect(r.creditosAplicados).toBe(2)
  })

  it('más créditos que lugares: sólo cubre los lugares', () => {
    expect(ver(partirPorCreditos([yoga], 1, new Map([['yoga', 5]])))).toEqual([[0, 1, 0, NOTA_PAGADA_CON_PAQUETE, true]])
  })

  it('cita de dos servicios con crédito sólo del primero: el segundo se cobra entero', () => {
    expect(ver(partirPorCreditos([yoga, masaje], 1, new Map([['yoga', 1]])))).toEqual([
      [0, 1, 0, NOTA_PAGADA_CON_PAQUETE, true],
      [1, 1, 800, null, true],
    ])
  })

  it('el mismo producto dos veces: el crédito se gasta una sola vez', () => {
    expect(ver(partirPorCreditos([yoga, yoga], 1, new Map([['yoga', 1]])))).toEqual([
      [0, 1, 0, NOTA_PAGADA_CON_PAQUETE, true],
      [1, 1, 200, null, true],
    ])
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
