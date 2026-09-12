import { resetReceiptLayout } from '@/services/dashboard/receiptLayout/receiptLayout.service'
import { CANONICAL_LAYOUT } from '@/services/shared/receiptLayout'
import { ConflictError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

const mock = prisma as unknown as {
  receiptLayout: { deleteMany: jest.Mock; findUnique: jest.Mock }
  staff: { findUnique: jest.Mock }
}

describe('resetReceiptLayout', () => {
  beforeEach(() => jest.clearAllMocks())

  it('borra sólo si la revisión coincide, devuelve la canónica y DICE qué revisión descartó', async () => {
    mock.receiptLayout.deleteMany.mockResolvedValue({ count: 1 })
    mock.receiptLayout.findUnique.mockResolvedValue(null)
    const r = await resetReceiptLayout({ venueId: 'v1', expectedRevision: 3 })
    expect(mock.receiptLayout.deleteMany).toHaveBeenCalledWith({ where: { venueId: 'v1', revision: 3 } })
    expect(r.layout).toMatchObject({ blocks: CANONICAL_LAYOUT, source: 'default', revision: 0, updatedAt: null })
    // La bitácora necesita saber QUÉ se tiró: sin eso, «restableció» no permite recuperar nada.
    expect(r.discardedRevision).toBe(3)
  })

  it('🔴 con una revisión vieja NO borra: 409 con la vigente Y el nombre de quien guardó', async () => {
    mock.receiptLayout.deleteMany.mockResolvedValue({ count: 0 })
    mock.receiptLayout.findUnique.mockResolvedValue({ revision: 8, updatedById: 'st1' })
    mock.staff.findUnique.mockResolvedValue({ firstName: 'Ana', lastName: 'Ríos' })
    const err = await resetReceiptLayout({ venueId: 'v1', expectedRevision: 3 }).catch(e => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect(err.code).toBe('RECEIPT_LAYOUT_STALE')
    // Mismo aviso que al guardar: «alguien más guardó» sin nombre no dice a quién preguntarle.
    expect(err.details).toEqual({ currentRevision: 8, updatedByName: 'Ana Ríos' })
  })

  it('🔴 restablecer cuando YA está en la canónica es un no-op tranquilo: ni 409 ni revisión descartada', async () => {
    mock.receiptLayout.deleteMany.mockResolvedValue({ count: 0 })
    mock.receiptLayout.findUnique.mockResolvedValue(null)
    const r = await resetReceiptLayout({ venueId: 'v1', expectedRevision: 0 })
    expect(r.layout).toMatchObject({ source: 'default', revision: 0 })
    // null = no se borró nada ⇒ el controlador NO escribe bitácora (no pasó nada que auditar).
    expect(r.discardedRevision).toBeNull()
  })
})
