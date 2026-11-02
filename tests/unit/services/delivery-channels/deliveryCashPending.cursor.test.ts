/**
 * Codex código r4 (23-oct): el cursor de «Rappi · por cobrar» se valida ESTRICTO. Uno alterado nunca llega a Postgres (el byte nulo
 * era un 500) ni reinicia en silencio la primera página: es un 400 «Cursor inválido».
 */
import { BadRequestError } from '@/errors/AppError'
import { listDeliveryCashPending } from '@/services/delivery-channels/core/deliveryCashPending.service'

const mockFindMany = jest.fn()
const mockCount = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { order: { findMany: (...a: unknown[]) => mockFindMany(...a), count: (...a: unknown[]) => mockCount(...a) } },
}))

const b64 = (s: string) => Buffer.from(s).toString('base64url')

beforeEach(() => {
  mockFindMany.mockReset().mockResolvedValue([])
  mockCount.mockReset().mockResolvedValue(0)
})

describe('listDeliveryCashPending: el cursor', () => {
  it.each([
    ['fecha válida + id con byte nulo (el caso de Codex)', 'MjAyNi0xMC0yM1QxNzowMDowMC4wMDBafGMA'],
    ['vacío (Codex r5: no reinicia la lista en silencio)', ''],
    ['ilegible', 'no-es-un-cursor'],
    ['sin id', b64('2026-10-23T17:00:00.000Z|')],
    ['id que no es cuid', b64('2026-10-23T17:00:00.000Z|abc')],
    ['fecha que no existe', b64('2026-02-30T17:00:00.000Z|cmabcdefghijklmnopqrstuvw')],
    ['con algo de más', b64('2026-10-23T17:00:00.000Z|cmabcdefghijklmnopqrstuvw|x')],
  ])('%s → 400 «Cursor inválido», sin consultar la base', async (_caso, cursor) => {
    const r = listDeliveryCashPending({ venueId: 'v1', cursor })
    await expect(r).rejects.toBeInstanceOf(BadRequestError)
    await expect(r).rejects.toThrow('Cursor inválido')
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('el que el propio servidor entregó sigue desde ahí', async () => {
    await listDeliveryCashPending({ venueId: 'v1', cursor: b64('2026-10-23T17:00:00.000Z|cmabcdefghijklmnopqrstuvw') })
    const where = mockFindMany.mock.calls[0][0].where
    expect(where.OR[1]).toEqual({ createdAt: new Date('2026-10-23T17:00:00.000Z'), id: { lt: 'cmabcdefghijklmnopqrstuvw' } })
  })
})
