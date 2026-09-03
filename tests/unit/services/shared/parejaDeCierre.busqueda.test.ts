import { Prisma } from '@prisma/client'
import { asegurarLaLiga, buscarParejasAMedias } from '@/services/shared/parejaDeCierre'

const VENUE = 'venue-1'
const DESDE = new Date('2026-09-01T00:00:00.000Z')
const CERRADO_A_LAS = new Date('2026-09-03T20:05:00.000Z')

function db(over: { gavetas?: unknown[]; turnosVivos?: unknown[] } = {}) {
  return {
    cashDrawerSession: {
      findMany: jest.fn().mockResolvedValue(over.gavetas ?? []),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    shift: { findMany: jest.fn().mockResolvedValue(over.turnosVivos ?? []) },
  } as any
}

const gavetaCerrada = {
  id: 'caja-1',
  venueId: VENUE,
  shiftId: 'shift-1',
  status: 'CLOSED',
  openedAt: new Date('2026-09-03T14:00:00.000Z'),
  closedAt: CERRADO_A_LAS,
  actualAmount: new Prisma.Decimal('2950.00'),
  overShort: new Prisma.Decimal('-50.00'),
  closedByStaffId: 'staff-1',
  shift: {
    id: 'shift-1',
    venueId: VENUE,
    status: 'OPEN',
    startTime: new Date('2026-09-03T14:00:00.000Z'),
    endTime: null,
    cashDeclared: null,
    cashDifference: null,
    closedById: null,
  },
}

describe('buscarParejasAMedias — a quién se le pregunta y qué se descarta', () => {
  it('🔴 sólo mira parejas LIGADAS: sin `shiftId` no se adivina de quién era la gaveta', async () => {
    const p = db()
    await buscarParejasAMedias(p, { limit: 25, since: DESDE })

    const where = p.cashDrawerSession.findMany.mock.calls[0][0].where
    expect(where.shiftId).toEqual({ not: null })
  })

  it('pide las dos formas del gesto a medias, y sólo esas', async () => {
    const p = db()
    await buscarParejasAMedias(p, { limit: 25, since: DESDE })

    const where = p.cashDrawerSession.findMany.mock.calls[0][0].where
    // Gaveta cerrada con su turno todavía abierto, y turno cerrado con su gaveta todavía abierta.
    expect(where.OR).toEqual([
      { status: 'CLOSED', closedAt: { gte: DESDE }, shift: { is: { status: 'OPEN' } } },
      { status: 'OPEN', shift: { is: { status: 'CLOSED', endTime: { gte: DESDE } } } },
    ])
  })

  it('🔴 la consulta va ACOTADA: sin tope, cada pasada recorrería la historia entera', async () => {
    const p = db()
    await buscarParejasAMedias(p, { limit: 25, since: DESDE })

    expect(p.cashDrawerSession.findMany.mock.calls[0][0].take).toBe(25)
  })

  it('devuelve la reparación ya decidida, con los números de la mitad que firmó', async () => {
    const p = db({ gavetas: [gavetaCerrada] })

    const [pareja] = await buscarParejasAMedias(p, { limit: 25, since: DESDE })

    expect(pareja.falta).toBe('TURNO')
    expect(Number(pareja.conteo)).toBe(2950)
    expect(Number(pareja.esperado)).toBe(3000)
  })

  it('🔴 pregunta si el negocio SIGUIÓ, y no se lo inventa: un turno vivo protege su gaveta', async () => {
    const gavetaHuerfana = {
      ...gavetaCerrada,
      status: 'OPEN',
      closedAt: null,
      actualAmount: null,
      overShort: null,
      closedByStaffId: null,
      shift: { ...gavetaCerrada.shift, status: 'CLOSED', endTime: CERRADO_A_LAS, closedById: 'staff-2' },
    }
    const p = db({ gavetas: [gavetaHuerfana], turnosVivos: [{ venueId: VENUE }] })

    const parejas = await buscarParejasAMedias(p, { limit: 25, since: DESDE })

    // `endTime: null` es la definición de la casa de «turno vivo»: cubre OPEN y CLOSING, que es lo
    // que usa `abrirTurnoDeCaja` para decidir si puede abrir otro.
    expect(p.shift.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: { in: [VENUE] }, endTime: null } }))
    expect(parejas).toEqual([])
  })

  it('sin turno vivo, esa misma gaveta huérfana SÍ se repara', async () => {
    const gavetaHuerfana = {
      ...gavetaCerrada,
      status: 'OPEN',
      closedAt: null,
      actualAmount: null,
      overShort: null,
      closedByStaffId: null,
      shift: { ...gavetaCerrada.shift, status: 'CLOSED', endTime: CERRADO_A_LAS, closedById: 'staff-2' },
    }
    const p = db({ gavetas: [gavetaHuerfana], turnosVivos: [] })

    const [pareja] = await buscarParejasAMedias(p, { limit: 25, since: DESDE })

    expect(pareja.falta).toBe('GAVETA')
    expect(pareja.cashDrawerSessionId).toBe('caja-1')
  })

  it('no pregunta por turnos vivos si no hay candidatas: una consulta de más por tic, cada tic', async () => {
    const p = db()
    await buscarParejasAMedias(p, { limit: 25, since: DESDE })

    expect(p.shift.findMany).not.toHaveBeenCalled()
  })
})

describe('asegurarLaLiga — el registro durable se pone ANTES del primer commit', () => {
  it('liga la gaveta al turno cuando la liga falta', async () => {
    const p = db()

    const ligada = await asegurarLaLiga(p, VENUE, 'shift-1', 'caja-1')

    expect(ligada).toBe(true)
    // 🔴 Condicional por `shiftId: null`: nunca se roba una liga ajena, y dos gestos simultáneos no
    // chocan contra el `@unique` — el segundo actualiza 0 filas y sigue.
    expect(p.cashDrawerSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'caja-1', venueId: VENUE, shiftId: null },
      data: { shiftId: 'shift-1' },
    })
  })

  it('🔴 si el turno YA tiene otra gaveta, no se intenta: un P2002 tumbaría el cierre entero', async () => {
    const p = db()
    p.cashDrawerSession.findUnique.mockResolvedValue({ id: 'otra-caja' })

    const ligada = await asegurarLaLiga(p, VENUE, 'shift-1', 'caja-1')

    expect(ligada).toBe(false)
    expect(p.cashDrawerSession.updateMany).not.toHaveBeenCalled()
  })

  it('la gaveta que ya es la del turno no se vuelve a escribir', async () => {
    const p = db()
    p.cashDrawerSession.findUnique.mockResolvedValue({ id: 'caja-1' })

    const ligada = await asegurarLaLiga(p, VENUE, 'shift-1', 'caja-1')

    expect(ligada).toBe(true)
    expect(p.cashDrawerSession.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 NUNCA lanza: es una mejora de la reparación, no una condición para cerrar la caja', async () => {
    const p = db()
    p.cashDrawerSession.findUnique.mockRejectedValue(new Error('la base se cayó'))

    await expect(asegurarLaLiga(p, VENUE, 'shift-1', 'caja-1')).resolves.toBe(false)
  })
})
