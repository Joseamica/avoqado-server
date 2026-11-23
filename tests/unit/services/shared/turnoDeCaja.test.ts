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
    // Sin `select`, los 8 caminos de dinero traerían la fila `Shift` entera —con sus
    // `Decimal` y sus dos `Json`— en CADA cobro. El `select` no es cosmético.
    expect(arg.select).toEqual({ id: true })
  })

  it('ESTRECHA la fila a `{ id }`: es la propiedad «drop-in» de la que dependen los 8 sitios', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'x', staffId: 'y', startingCash: 100 })
    expect(await turnoAbiertoDelNegocio({ shift: { findFirst } } as never, 'v1')).toEqual({ id: 'x' })
  })

  it('devuelve null cuando no hay turno abierto', async () => {
    const findFirst = jest.fn().mockResolvedValue(null)
    expect(await turnoAbiertoDelNegocio({ shift: { findFirst } } as never, 'v1')).toBeNull()
  })
})

describe('turnoDelNegocioAhora (máquina de efectivo, Codex r1 #13)', () => {
  it('el MISMO turno vivo OPEN del negocio (por `turnoAbiertoDelNegocio`), con su inicio, en lecturas acotadas', async () => {
    const prisma = (await import('@/utils/prismaClient')).default
    const { turnoDelNegocioAhora } = await import('@/services/shared/turnoDeCaja')
    const inicio = new Date('2026-11-20T14:00:00.000Z')
    jest
      .mocked(prisma.shift.findFirst)
      .mockResolvedValueOnce({ id: 'shift-1' } as never)
      .mockResolvedValueOnce({ startTime: inicio } as never)
    await expect(turnoDelNegocioAhora('v1')).resolves.toEqual({ shiftId: 'shift-1', startTime: inicio })
    const [vivo, inicioDelTurno] = jest.mocked(prisma.shift.findFirst).mock.calls.map(c => c[0]!)
    expect(vivo.where).toEqual({ venueId: 'v1', status: 'OPEN', endTime: null })
    expect(vivo.orderBy).toEqual({ startTime: 'desc' })
    expect(inicioDelTurno).toEqual({ where: { id: 'shift-1', venueId: 'v1' }, select: { startTime: true } })
    jest.mocked(prisma.shift.findFirst).mockReset().mockResolvedValue(null)
    await expect(turnoDelNegocioAhora('v1')).resolves.toBeNull()
  })
})
