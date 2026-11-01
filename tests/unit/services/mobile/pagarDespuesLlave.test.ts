import { Prisma } from '@prisma/client'
import { BadRequestError, ConflictError } from '@/errors/AppError'

const tx = {
  $queryRaw: jest.fn(),
  order: { findUnique: jest.fn() },
  orderKeyRelease: { findUnique: jest.fn(), upsert: jest.fn() },
}
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) },
}))

import {
  liberarLlaveDePagarDespues,
  rechazarLlaveDePagarDespues,
  rechazarSiLaLlaveSeCerroEnTx,
} from '@/services/mobile/pagarDespuesLlave'

const LLAVE = 'pay-later:0f8f1c2e-1111-4a5b-9c1d-123456789abc'

beforeEach(() => jest.clearAllMocks())

describe('D9 · cerrar la llave de «Pagar después»', () => {
  it('sin cuenta con esa llave, la cierra (idempotente) y lo dice; el candado va PRIMERO, el mismo de crear la cuenta', async () => {
    tx.order.findUnique.mockResolvedValue(null)
    tx.orderKeyRelease.upsert.mockResolvedValue({})

    await expect(liberarLlaveDePagarDespues('venue-1', LLAVE, 'staff-1')).resolves.toEqual({ released: true })

    const candado = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql
    expect(candado.values).toEqual([`avoqado:order-mobile-external:v1:venue-1:${LLAVE}`])
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.order.findUnique.mock.invocationCallOrder[0])
    expect(tx.orderKeyRelease.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId_externalId: { venueId: 'venue-1', externalId: LLAVE } },
        update: {},
        create: expect.objectContaining({ venueId: 'venue-1', externalId: LLAVE, staffId: 'staff-1' }),
      }),
    )
  })

  it('si la cuenta existe (la respuesta se perdió), NO cierra nada y devuelve la cuenta', async () => {
    tx.order.findUnique.mockResolvedValue({ id: 'ord-1', total: new Prisma.Decimal('150.50'), status: 'CONFIRMED', paymentStatus: 'PENDING' })

    await expect(liberarLlaveDePagarDespues('venue-1', LLAVE, 'staff-1')).resolves.toEqual({
      released: false,
      order: { id: 'ord-1', total: 150.5, status: 'CONFIRMED', paymentStatus: 'PENDING' },
    })
    expect(tx.orderKeyRelease.upsert).not.toHaveBeenCalled()
  })

  it('sólo acepta llaves de «Pagar después»', async () => {
    await expect(liberarLlaveDePagarDespues('venue-1', 'exchange:abc', 'staff-1')).rejects.toBeInstanceOf(BadRequestError)
    await expect(liberarLlaveDePagarDespues('venue-1', `pay-later:${'x'.repeat(130)}`, 'staff-1')).rejects.toBeInstanceOf(
      BadRequestError,
    )
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })

  it('crear la cuenta con una llave cerrada da 409 ORDER_KEY_RELEASED', async () => {
    tx.orderKeyRelease.findUnique.mockResolvedValue({ id: 'r1' })
    const error = await rechazarSiLaLlaveSeCerroEnTx(tx as never, 'venue-1', LLAVE).catch(e => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('ORDER_KEY_RELEASED')

    tx.orderKeyRelease.findUnique.mockResolvedValue(null)
    await expect(rechazarSiLaLlaveSeCerroEnTx(tx as never, 'venue-1', LLAVE)).resolves.toBeUndefined()
  })

  it('las otras entradas (TPV, sincronización) no aceptan una llave de «Pagar después»', () => {
    expect(() => rechazarLlaveDePagarDespues(LLAVE)).toThrow(BadRequestError)
    expect(() => rechazarLlaveDePagarDespues(`  ${LLAVE}`)).toThrow(BadRequestError)
    expect(() => rechazarLlaveDePagarDespues('web:abc')).not.toThrow()
    expect(() => rechazarLlaveDePagarDespues(null)).not.toThrow()
  })
})
