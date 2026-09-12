import { getReceiptLayout } from '@/services/dashboard/receiptLayout/receiptLayout.service'
import { CANONICAL_LAYOUT } from '@/services/shared/receiptLayout'
import prisma from '@/utils/prismaClient'

const mock = prisma as unknown as { receiptLayout: { findUnique: jest.Mock } }

describe('getReceiptLayout', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 sin fila devuelve la canónica, revision 0 y updatedAt null', async () => {
    mock.receiptLayout.findUnique.mockResolvedValue(null)
    await expect(getReceiptLayout('v1')).resolves.toEqual({
      blocks: CANONICAL_LAYOUT,
      schemaVersion: 1,
      revision: 0,
      source: 'default',
      updatedAt: null,
    })
  })

  it('con fila íntegra devuelve lo guardado y source custom', async () => {
    const guardados = CANONICAL_LAYOUT.filter(b => b.type !== 'staff')
    const updatedAt = new Date('2026-09-11T10:00:00.000Z')
    mock.receiptLayout.findUnique.mockResolvedValue({ blocks: guardados, schemaVersion: 1, revision: 4, updatedAt })
    await expect(getReceiptLayout('v1')).resolves.toEqual({
      blocks: guardados,
      schemaVersion: 1,
      revision: 4,
      source: 'custom',
      updatedAt,
    })
  })

  it('🔴 una fila CORRUPTA no tumba el ticket: cae a la canónica y CONSERVA su revision', async () => {
    mock.receiptLayout.findUnique.mockResolvedValue({
      blocks: [{ type: 'hologram' }, { type: 'signature' }],
      schemaVersion: 1,
      revision: 9,
      updatedAt: new Date('2026-09-11T10:00:00.000Z'),
    })
    const r = await getReceiptLayout('v1')
    expect(r.blocks).toEqual(CANONICAL_LAYOUT)
    expect(r.source).toBe('default')
    // La revisión es del REGISTRO, no del contenido: perderla daría un 409 eterno al guardar.
    expect(r.revision).toBe(9)
  })

  it('consulta por venueId, no por id (sería otro tenant)', async () => {
    mock.receiptLayout.findUnique.mockResolvedValue(null)
    await getReceiptLayout('v1')
    expect(mock.receiptLayout.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: 'v1' } }))
  })
})
