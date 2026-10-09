/**
 * Plano de mesas — choques de concurrencia al publicar (spec 2026-10-08 §5.2).
 * Un bloqueo mutuo (40P01) o un conflicto de escritura (P2034) dentro de la transacción se reintenta UNA vez: es seguro
 * porque el folio (`saveId`) hace idempotente la publicación. Si vuelve a chocar, sale el 409 FLOOR_PLAN_CHANGED en
 * español, nunca un 500 crudo. Un P2002 (choque de número/nombre con alguien que escribió a la vez) también es 409.
 * Un P2028 (la transacción se pasó de tiempo) es 503 FLOOR_PLAN_BUSY: el editor vuelve a intentar con el mismo folio.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { publishFloorPlan } from '@/services/dashboard/floorPlan/floorPlan.service'
import { ConflictError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import logger from '@/config/logger'

const mockGetFloorPlan = jest.fn()
jest.mock('@/services/dashboard/floorPlan/floorPlan.read', () => ({
  ...jest.requireActual('@/services/dashboard/floorPlan/floorPlan.read'),
  getFloorPlan: (...a: unknown[]) => mockGetFloorPlan(...a),
}))
const mockBroadcast = jest.fn()
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: () => ({ broadcastToVenue: (...a: unknown[]) => mockBroadcast(...a) }) },
}))

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
/** Un 40P01 en una consulta de MODELO: Prisma 6.19 no le da código, el SQLSTATE sólo viaja en el mensaje. */
const deadlockDeModelo = () =>
  new Prisma.PrismaClientUnknownRequestError(
    'Invalid `prisma.table.update()` invocation: Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "40P01", message: "deadlock detected", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
    { clientVersion: 'test' },
  )
const replay = { replayed: true, publicationId: 'pub-1' }

let transaction: jest.Mock
beforeEach(() => {
  transaction = prismaMock.$transaction as jest.Mock
  transaction.mockReset()
  mockGetFloorPlan.mockReset().mockResolvedValue({ fingerprint: 'abc', areas: [], tables: [], elements: [] })
  mockBroadcast.mockReset()
})

describe('publishFloorPlan — choques de concurrencia', () => {
  it.each([
    ['un conflicto de escritura de Prisma (P2034)', () => known('P2034')],
    ['un bloqueo mutuo crudo (40P01)', deadlock],
    ['un bloqueo mutuo en una consulta de modelo (PrismaClientUnknownRequestError)', deadlockDeModelo],
    ['un bloqueo mutuo envuelto en P2010', () => known('P2010', { code: '40P01' })],
    ['una falla de serialización (40001)', () => known('P2010', { code: '40001' })],
  ])('reintenta UNA vez ante %s y publica', async (_nombre, error) => {
    transaction.mockRejectedValueOnce(error()).mockResolvedValueOnce(replay)
    const out = await publishFloorPlan('v1', input, 'staff-1')
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(out).toMatchObject({ publicationId: 'pub-1', replayed: true })
  })

  it('un reintento que publica de verdad deja UNA bitácora y UN aviso a los POS', async () => {
    const publicada = {
      replayed: false,
      publicationId: 'pub-2',
      summary: { tables: { created: 1 } },
      resultFingerprint: 'fedcba9876543210',
    }
    transaction.mockRejectedValueOnce(deadlockDeModelo()).mockResolvedValueOnce(publicada)
    const out = await publishFloorPlan('v1', input, 'staff-1')
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(out).toMatchObject({ publicationId: 'pub-2', replayed: false })
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'FLOOR_PLAN_PUBLISHED', venueId: 'v1', staffId: 'staff-1' }))
    expect(mockBroadcast).toHaveBeenCalledTimes(1)
    expect(mockBroadcast).toHaveBeenCalledWith('v1', 'floor_plan_updated', { fingerprint: 'fedcba9876543210' })
  })

  it('un reintento que encuentra la publicación ya guardada (folio repetido) no repite bitácora ni aviso', async () => {
    transaction.mockRejectedValueOnce(known('P2034')).mockResolvedValueOnce(replay)
    await publishFloorPlan('v1', input, 'staff-1')
    expect(logAction).not.toHaveBeenCalled()
    expect(mockBroadcast).not.toHaveBeenCalled()
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
    // El segundo P2002 ya no huele a escritor concurrente: sale a nivel error, con el índice que chocó.
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('choque de único'),
      expect.objectContaining({ code: 'P2002', target: ['venueId', 'number'], saveId: input.saveId }),
    )
  })

  it('un choque que no es P2002 en el reintento sólo avisa (warn), no es error', async () => {
    transaction.mockRejectedValueOnce(known('P2034')).mockRejectedValueOnce(known('P2034'))
    await publishFloorPlan('v1', input, 'staff-1').catch(() => undefined)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it.each([
    ['en el primer intento', [known('P2028')], 1],
    ['en el reintento tras un choque', [known('P2034'), known('P2028')], 2],
  ])('la transacción que se pasa de tiempo (P2028) %s es 503 FLOOR_PLAN_BUSY en español', async (_cuando, errores, intentos) => {
    for (const e of errores) transaction.mockRejectedValueOnce(e)
    const error = await publishFloorPlan('v1', input, 'staff-1').catch(e => e)
    expect(transaction).toHaveBeenCalledTimes(intentos)
    expect(error).toMatchObject({
      statusCode: 503,
      code: 'FLOOR_PLAN_BUSY',
      message: 'El servidor está ocupado y no pudo guardar. Intenta de nuevo; tus cambios siguen en pantalla.',
    })
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
