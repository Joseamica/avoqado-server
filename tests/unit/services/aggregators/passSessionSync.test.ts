import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { countLiveFutureSessions, enqueueLiveSessionsSync } from '@/services/aggregators/passSessionSync'

const NOW = new Date('2030-01-10T12:00:00Z')

describe('passSessionSync — ocurrencias vivas a futuro', () => {
  // nuevo — ronda 1, H4: el tope de 500 es por conexión; el producto se filtra EN la consulta, no después
  it('dar de baja busca sólo las ocurrencias vivas de esos productos y las encola', async () => {
    prismaMock.aggregatorSessionLink.findMany.mockResolvedValueOnce([{ classSessionId: 's1' }, { classSessionId: 's2' }])
    prismaMock.aggregatorConnection.findMany.mockResolvedValue([{ id: 'c1' }])
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValue(null)
    await expect(enqueueLiveSessionsSync(prismaMock, 'v1', 'c1', ['p1', 'p2'], NOW)).resolves.toBe(2)
    const args = prismaMock.aggregatorSessionLink.findMany.mock.calls[0][0]
    expect(args.where).toEqual({
      connectionId: 'c1',
      live: true,
      publishedStartsAt: { gt: NOW },
      classSession: { venueId: 'v1', productId: { in: ['p1', 'p2'] } },
    })
    expect(args.take).toBe(500)
    expect(prismaMock.aggregatorOutbox.create.mock.calls.map((c: any) => c[0].data.classSessionId)).toEqual(['s1', 's2'])
  })

  // C5 (P1-5) — con más de 500 ocurrencias vivas la 501 quedaba publicada sin trabajo pendiente: tandas con cursor por id
  it('501 ocurrencias vivas ⇒ las 501 encoladas (tandas de 500 con cursor por id)', async () => {
    const page = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `l${String(from + i).padStart(3, '0')}`, classSessionId: `s${from + i}` }))
    prismaMock.aggregatorSessionLink.findMany.mockResolvedValueOnce(page(1, 500)).mockResolvedValueOnce(page(501, 1))
    prismaMock.aggregatorConnection.findMany.mockResolvedValue([{ id: 'c1' }])
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValue(null)
    await expect(enqueueLiveSessionsSync(prismaMock, 'v1', 'c1', ['p1'], NOW)).resolves.toBe(501)
    expect(prismaMock.aggregatorOutbox.create).toHaveBeenCalledTimes(501)
    const [first, second] = prismaMock.aggregatorSessionLink.findMany.mock.calls.map((c: any) => c[0])
    expect(first).toMatchObject({ orderBy: { id: 'asc' }, take: 500 })
    expect(second.where).toMatchObject({ id: { gt: 'l500' } })
    expect(prismaMock.aggregatorSessionLink.findMany).toHaveBeenCalledTimes(2)
  })
  // C5 — sin lista de productos (desconectar): todas las ocurrencias vivas a futuro de la conexión
  it('productIds null ⇒ todas las ocurrencias vivas a futuro de la conexión, de cualquier clase', async () => {
    prismaMock.aggregatorSessionLink.findMany.mockResolvedValueOnce([{ id: 'l1', classSessionId: 's1' }])
    prismaMock.aggregatorConnection.findMany.mockResolvedValue([{ id: 'c1' }])
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValue(null)
    await expect(enqueueLiveSessionsSync(prismaMock, 'v1', 'c1', null, NOW)).resolves.toBe(1)
    expect(prismaMock.aggregatorSessionLink.findMany.mock.calls[0][0].where).toEqual({
      connectionId: 'c1',
      live: true,
      publishedStartsAt: { gt: NOW },
      classSession: { venueId: 'v1' },
    })
  })
  // C5 — tope de seguridad con log
  it('al llegar al tope de tandas se detiene y lo registra con [PASES]', async () => {
    let n = 0
    prismaMock.aggregatorSessionLink.findMany.mockImplementation((async () => {
      n += 1
      return Array.from({ length: 500 }, (_, i) => ({ id: `p${n}-${String(i).padStart(3, '0')}`, classSessionId: `s${n}-${i}` }))
    }) as any)
    prismaMock.aggregatorConnection.findMany.mockResolvedValue([])
    await enqueueLiveSessionsSync(prismaMock, 'v1', 'c1', ['p1'], NOW)
    expect(n).toBe(20)
    expect((logger.error as jest.Mock).mock.calls.map(c => String(c[0]))).toEqual([expect.stringMatching(/^\[PASES\].*tope/)])
    prismaMock.aggregatorSessionLink.findMany.mockReset()
    prismaMock.aggregatorSessionLink.findMany.mockResolvedValue([])
  })

  // nuevo — ronda 1, H4
  it('el conteo para el cambio de plan filtra el producto en la misma consulta', async () => {
    prismaMock.aggregatorSessionLink.count.mockResolvedValueOnce(3)
    await expect(countLiveFutureSessions(prismaMock, 'v1', 'c1', 'p1', NOW)).resolves.toBe(3)
    expect(prismaMock.aggregatorSessionLink.count.mock.calls[0][0].where).toEqual({
      connectionId: 'c1',
      live: true,
      publishedStartsAt: { gt: NOW },
      classSession: { venueId: 'v1', productId: 'p1' },
    })
  })

  // regresión
  it('sin productos ⇒ ni consulta', async () => {
    await expect(enqueueLiveSessionsSync(prismaMock, 'v1', 'c1', [], NOW)).resolves.toBe(0)
    expect(prismaMock.aggregatorSessionLink.findMany).not.toHaveBeenCalled()
  })
})
