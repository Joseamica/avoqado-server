import { turnoAbiertoDelNegocio } from '@/services/shared/turnoDeCaja'

describe('turnoAbiertoDelNegocio', () => {
  it('busca el turno OPEN del NEGOCIO, sin filtrar por persona, el más reciente', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'shift-1' })
    const r = await turnoAbiertoDelNegocio({ shift: { findFirst } } as never, 'v1')
    expect(r).toEqual({ id: 'shift-1' })
    const arg = findFirst.mock.calls[0][0]
    expect(arg.where).toEqual({ venueId: 'v1', status: 'OPEN', endTime: null })
    expect(arg.where).not.toHaveProperty('staffId')
    expect(arg.orderBy).toEqual({ startTime: 'desc' })
  })

  it('devuelve null cuando no hay turno abierto', async () => {
    const findFirst = jest.fn().mockResolvedValue(null)
    expect(await turnoAbiertoDelNegocio({ shift: { findFirst } } as never, 'v1')).toBeNull()
  })
})
