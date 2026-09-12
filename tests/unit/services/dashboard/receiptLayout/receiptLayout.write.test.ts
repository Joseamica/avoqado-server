import { putReceiptLayout } from '@/services/dashboard/receiptLayout/receiptLayout.service'
import { CANONICAL_LAYOUT } from '@/services/shared/receiptLayout'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

const mock = prisma as unknown as {
  receiptLayout: { create: jest.Mock; updateMany: jest.Mock; findUnique: jest.Mock }
  staff: { findUnique: jest.Mock }
}
const raw = () => JSON.parse(JSON.stringify(CANONICAL_LAYOUT)) as unknown[]
const filaGuardada = (revision: number, updatedById: string | null = null) => ({
  blocks: CANONICAL_LAYOUT,
  schemaVersion: 1,
  revision,
  updatedById,
  updatedAt: new Date('2026-09-11T12:00:00.000Z'),
})

describe('putReceiptLayout — CAS', () => {
  beforeEach(() => jest.clearAllMocks())

  it('expectedRevision 0 CREA la fila y devuelve lo releído', async () => {
    mock.receiptLayout.create.mockResolvedValue({})
    mock.receiptLayout.findUnique.mockResolvedValue(filaGuardada(1))
    const r = await putReceiptLayout({ venueId: 'v1', blocks: raw(), expectedRevision: 0, updatedById: 's1' })
    expect(mock.receiptLayout.create).toHaveBeenCalled()
    expect(mock.receiptLayout.updateMany).not.toHaveBeenCalled()
    expect(r).toMatchObject({ revision: 1, source: 'custom' })
  })

  it('🔴 dos creaciones a la vez: el perdedor recibe 409, no una segunda receta', async () => {
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    mock.receiptLayout.create.mockRejectedValue(p2002)
    mock.receiptLayout.findUnique.mockResolvedValue(filaGuardada(1))
    await expect(putReceiptLayout({ venueId: 'v1', blocks: raw(), expectedRevision: 0 })).rejects.toMatchObject({
      code: 'RECEIPT_LAYOUT_STALE',
    })
  })

  it('expectedRevision > 0 compara e incrementa EN LA MISMA sentencia', async () => {
    mock.receiptLayout.updateMany.mockResolvedValue({ count: 1 })
    mock.receiptLayout.findUnique.mockResolvedValue(filaGuardada(5))
    await putReceiptLayout({ venueId: 'v1', blocks: raw(), expectedRevision: 4 })
    expect(mock.receiptLayout.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: 'v1', revision: 4 },
        data: expect.objectContaining({ revision: { increment: 1 } }),
      }),
    )
  })

  it('🔴 una revisión vieja NO pisa: 0 filas afectadas → 409 con la revisión vigente', async () => {
    mock.receiptLayout.updateMany.mockResolvedValue({ count: 0 })
    mock.receiptLayout.findUnique.mockResolvedValue(filaGuardada(7))
    const err = await putReceiptLayout({ venueId: 'v1', blocks: raw(), expectedRevision: 3 }).catch(e => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect(err.code).toBe('RECEIPT_LAYOUT_STALE')
    // El dashboard necesita SABER contra qué reintentar; un 409 mudo obliga a recargar a ciegas.
    expect(err.details).toMatchObject({ currentRevision: 7 })
  })

  it('🔴 el 409 dice QUIÉN guardó: sin el nombre, el aviso no le sirve a nadie', async () => {
    mock.receiptLayout.updateMany.mockResolvedValue({ count: 0 })
    mock.receiptLayout.findUnique.mockResolvedValue(filaGuardada(7, 's9'))
    mock.staff.findUnique.mockResolvedValue({ firstName: 'Ana', lastName: 'Ríos' })
    const err = await putReceiptLayout({ venueId: 'v1', blocks: raw(), expectedRevision: 3 }).catch(e => e)
    expect(err.details).toMatchObject({ currentRevision: 7, updatedByName: 'Ana Ríos' })
  })

  it('nadie a quien nombrar (fila sin autor) → el 409 sigue saliendo, sin inventar un nombre', async () => {
    mock.receiptLayout.updateMany.mockResolvedValue({ count: 0 })
    mock.receiptLayout.findUnique.mockResolvedValue(filaGuardada(7, null))
    const err = await putReceiptLayout({ venueId: 'v1', blocks: raw(), expectedRevision: 3 }).catch(e => e)
    expect(mock.staff.findUnique).not.toHaveBeenCalled()
    expect(err.details).toMatchObject({ currentRevision: 7 })
    expect(err.details.updatedByName).toBeUndefined()
  })

  it('🔴 si la consulta del nombre falla, el 409 NO se convierte en 500', async () => {
    mock.receiptLayout.updateMany.mockResolvedValue({ count: 0 })
    mock.receiptLayout.findUnique.mockResolvedValue(filaGuardada(7, 's9'))
    mock.staff.findUnique.mockRejectedValue(new Error('la base se cayó'))
    const err = await putReceiptLayout({ venueId: 'v1', blocks: raw(), expectedRevision: 3 }).catch(e => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect(err.details).toMatchObject({ currentRevision: 7 })
  })

  it('🔴 devuelve lo RELEÍDO, no lo que le mandaron', async () => {
    const distinto = CANONICAL_LAYOUT.filter(b => b.type !== 'staff')
    mock.receiptLayout.updateMany.mockResolvedValue({ count: 1 })
    mock.receiptLayout.findUnique.mockResolvedValue({ ...filaGuardada(2), blocks: distinto })
    const r = await putReceiptLayout({ venueId: 'v1', blocks: raw(), expectedRevision: 1 })
    expect(r.blocks).toEqual(distinto)
  })

  it('🔴 el candado de integridad corre ANTES de tocar la base', async () => {
    const sinTotales = raw().filter(b => (b as { type: string }).type !== 'totals')
    const err = await putReceiptLayout({ venueId: 'v1', blocks: sinTotales, expectedRevision: 1 }).catch(e => e)
    expect(err).toBeInstanceOf(BadRequestError)
    expect(err.code).toBe('RECEIPT_LAYOUT_MISSING_BLOCK')
    expect(mock.receiptLayout.updateMany).not.toHaveBeenCalled()
    expect(mock.receiptLayout.create).not.toHaveBeenCalled()
  })

  it('🔴 un texto con ESC se rechaza con su propio código, sin escribir', async () => {
    const conEsc = raw()
    const i = conEsc.findIndex(b => (b as { type: string }).type === 'text')
    ;(conEsc[i] as { lines: string[] }).lines = ['hola\u001Bm']
    const err = await putReceiptLayout({ venueId: 'v1', blocks: conEsc, expectedRevision: 1 }).catch(e => e)
    expect(err.code).toBe('RECEIPT_LAYOUT_TEXT_FORBIDDEN_CHARS')
    expect(mock.receiptLayout.updateMany).not.toHaveBeenCalled()
  })

  it('un tipo desconocido es 400 UNKNOWN_BLOCK, con mensaje en español y su posición', async () => {
    const err = await putReceiptLayout({ venueId: 'v1', blocks: [{ type: 'hologram' }], expectedRevision: 1 }).catch(e => e)
    expect(err).toBeInstanceOf(BadRequestError)
    expect(err.code).toBe('RECEIPT_LAYOUT_UNKNOWN_BLOCK')
    expect(err.message).toBe('Bloque 1: Tipo de bloque desconocido')
    expect(err.details).toEqual({ index: 0 })
    expect(mock.receiptLayout.updateMany).not.toHaveBeenCalled()
  })

  // 🔴 Antes TODO error de forma salía como «bloque desconocido»: un texto de 60 caracteres
  // decía «este servidor no reconoce el bloque», que manda a buscar el problema donde no está.
  it('🔴 un tipo CONOCIDO con forma inválida es INVALID_BLOCK, con el tipo y la posición', async () => {
    const blocks = raw()
    const i = blocks.findIndex(b => (b as { type: string }).type === 'text')
    ;(blocks[i] as { lines: string[] }).lines = ['x'.repeat(60)]
    const err = await putReceiptLayout({ venueId: 'v1', blocks, expectedRevision: 1 }).catch(e => e)
    expect(err.code).toBe('RECEIPT_LAYOUT_INVALID_BLOCK')
    expect(err.details).toEqual({ index: i, blockType: 'text' })
    expect(mock.receiptLayout.updateMany).not.toHaveBeenCalled()
  })
})
