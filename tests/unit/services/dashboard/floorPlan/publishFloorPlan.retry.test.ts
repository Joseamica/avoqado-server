/**
 * Plano de mesas — choques de concurrencia al publicar (spec 2026-10-08 §5.2).
 * Un bloqueo mutuo (40P01) o un conflicto de escritura (P2034) dentro de la transacción se reintenta UNA vez: es seguro
 * porque el folio (`saveId`) hace idempotente la publicación. Si vuelve a chocar, sale el 409 FLOOR_PLAN_CHANGED en
 * español, nunca un 500 crudo. Un P2002 (choque de número/nombre con alguien que escribió a la vez) también es 409.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { publishFloorPlan } from '@/services/dashboard/floorPlan/floorPlan.service'
import { ConflictError } from '@/errors/AppError'

const mockGetFloorPlan = jest.fn()
jest.mock('@/services/dashboard/floorPlan/floorPlan.read', () => ({
  ...jest.requireActual('@/services/dashboard/floorPlan/floorPlan.read'),
  getFloorPlan: (...a: unknown[]) => mockGetFloorPlan(...a),
}))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

const input = {
  saveId: '7f1c4b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f',
  baseFingerprint: '0123456789abcdef',
  areas: [],
  tables: [],
  elements: [],
}
const PLAN_CHANGED = 'Alguien más cambió el plano mientras lo editabas. Recarga para ver sus cambios.'
const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(`fallo ${code}`, { code, clientVersion: 'test', meta })
/** Un 40P01 crudo de Postgres (lo que llega de una consulta `$queryRaw` sin envolver). */
const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' })
const replay = { replayed: true, publicationId: 'pub-1' }

let transaction: jest.Mock
beforeEach(() => {
  transaction = prismaMock.$transaction as jest.Mock
  transaction.mockReset()
  mockGetFloorPlan.mockReset().mockResolvedValue({ fingerprint: 'abc', areas: [], tables: [], elements: [] })
})

describe('publishFloorPlan — choques de concurrencia', () => {
  it.each([
    ['un conflicto de escritura de Prisma (P2034)', () => known('P2034')],
    ['un bloqueo mutuo crudo (40P01)', deadlock],
    ['un bloqueo mutuo envuelto en P2010', () => known('P2010', { code: '40P01' })],
    ['una falla de serialización (40001)', () => known('P2010', { code: '40001' })],
  ])('reintenta UNA vez ante %s y publica', async (_nombre, error) => {
    transaction.mockRejectedValueOnce(error()).mockResolvedValueOnce(replay)
    const out = await publishFloorPlan('v1', input, 'staff-1')
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(out).toMatchObject({ publicationId: 'pub-1', replayed: true })
  })

  it('si vuelve a chocar, sale el 409 FLOOR_PLAN_CHANGED en español (nunca un 500)', async () => {
    transaction.mockRejectedValueOnce(known('P2034')).mockRejectedValueOnce(deadlock())
    const error = await publishFloorPlan('v1', input, 'staff-1').catch(e => e)
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject({ statusCode: 409, code: 'FLOOR_PLAN_CHANGED', message: PLAN_CHANGED })
  })

  it('un número o nombre que otro escribió a la vez (P2002) es un 409, no un 500 (y se reintenta una vez)', async () => {
    const choque = known('P2002', { target: ['venueId', 'number'] })
    transaction.mockRejectedValueOnce(choque).mockRejectedValueOnce(choque)
    const error = await publishFloorPlan('v1', input, 'staff-1').catch(e => e)
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(error).toMatchObject({ statusCode: 409, code: 'FLOOR_PLAN_CHANGED', message: PLAN_CHANGED })
  })

  it('no reintenta los errores del negocio (409 de huella, 422 de cuenta abierta, cualquier otro)', async () => {
    const huella = new ConflictError(PLAN_CHANGED, 'FLOOR_PLAN_CHANGED')
    transaction.mockRejectedValueOnce(huella)
    await expect(publishFloorPlan('v1', input, 'staff-1')).rejects.toBe(huella)
    expect(transaction).toHaveBeenCalledTimes(1)

    transaction.mockReset()
    const otro = new Error('se cayó la conexión')
    transaction.mockRejectedValueOnce(otro)
    await expect(publishFloorPlan('v1', input, 'staff-1')).rejects.toBe(otro)
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it('un error distinto en el reintento sale tal cual', async () => {
    const otro = new Error('se cayó la conexión')
    transaction.mockRejectedValueOnce(known('P2034')).mockRejectedValueOnce(otro)
    await expect(publishFloorPlan('v1', input, 'staff-1')).rejects.toBe(otro)
  })
})
