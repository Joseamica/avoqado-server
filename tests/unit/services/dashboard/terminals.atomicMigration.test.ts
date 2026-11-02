import prisma from '@/utils/prismaClient'
import { updateTerminal } from '@/services/dashboard/terminals.superadmin.service'
import { tpvCommandQueueService } from '@/services/tpv/command-queue.service'
import { broadcastTpvCommand } from '@/communication/sockets'
import { borrarDisenoAlCambiarDeNegocio, invalidateCustomerDisplayCache } from '@/services/customer-display/customerDisplayVenueChange'

jest.mock('@/communication/sockets', () => ({ broadcastTpvCommand: jest.fn(), broadcastSuperadminTerminalUpdate: jest.fn() }))
jest.mock('@/services/customer-display/customerDisplayVenueChange', () => ({
  borrarDisenoAlCambiarDeNegocio: jest.fn().mockResolvedValue({ cambio: true, disenoBorrado: false, fromVenueId: 'v1' }),
  invalidateCustomerDisplayCache: jest.fn(),
}))

jest.mock('@/utils/prismaClient', () => {
  const db = {
    terminal: { findUnique: jest.fn(), update: jest.fn() },
    venue: { findUnique: jest.fn() },
    merchantAccount: { findMany: jest.fn() },
    tpvCommandQueue: { findFirst: jest.fn() },
    venuePaymentConfig: { create: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  }
  db.$transaction.mockImplementation(async fn => fn(db))
  return { __esModule: true, default: db }
})
jest.mock('@/services/tpv/command-queue.service', () => ({ tpvCommandQueueService: { queueCommand: jest.fn() } }))
jest.mock('@/services/superadmin/merchantAccount.service', () => ({ notifyAffectedTerminals: jest.fn() }))
jest.mock('@/lib/providerDeviceCompatibility', () => ({
  assertMerchantsTerminalCompatible: jest.fn().mockResolvedValue(undefined),
  isProviderCompatibleWithBrand: jest.fn(() => true),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

const db = prisma as any
const queue = tpvCommandQueueService.queueCommand as jest.Mock
beforeEach(() => {
  jest.clearAllMocks()
  db.terminal.findUnique.mockResolvedValue({
    id: 't1',
    name: 'PAX',
    type: 'TPV_ANDROID',
    status: 'ACTIVE',
    venueId: 'old',
    assignedMerchantIds: ['m-old'],
  })
  db.venue.findUnique.mockResolvedValue({ id: 'new' })
  db.merchantAccount.findMany.mockResolvedValue([{ id: 'm-new', active: true }])
  db.tpvCommandQueue.findFirst.mockResolvedValue(null)
  db.terminal.update.mockImplementation(async ({ data }: any) => ({ id: 't1', venueId: 'new', ...data }))
  queue.mockResolvedValue({ commandId: 'wipe-new' })
})

it('mueve y asigna el merchant en la misma transacción que crea el borrado', async () => {
  const result = await updateTerminal('t1', { venueId: 'new', assignedMerchantIds: ['m-new'] }, { staffId: 'admin' })
  expect(db.$transaction).toHaveBeenCalled()
  expect(db.terminal.update).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ id: 't1', venueId: 'old' }),
      data: expect.objectContaining({ venueId: 'new', assignedMerchantIds: ['m-new'] }),
    }),
  )
  expect(queue).toHaveBeenCalledWith(
    expect.objectContaining({
      venueId: 'new',
      payload: { migration: { fromVenueId: 'old', previousMerchantIds: ['m-old'], toVenueId: 'new' } },
    }),
    db,
  )
  expect(result).toMatchObject({ migrationCommandId: 'wipe-new' })
})

it('un error al encolar rechaza la transacción: nunca devuelve éxito', async () => {
  queue.mockRejectedValue(new Error('queue unavailable'))
  await expect(updateTerminal('t1', { venueId: 'new' })).rejects.toThrow('queue unavailable')
  expect(broadcastTpvCommand).not.toHaveBeenCalled()
})

it('conserva los cambios de estado y activación del contrato al trasladar', async () => {
  await updateTerminal('t1', { venueId: 'new', status: 'ACTIVE', name: 'Caja 2' }, { staffId: 'admin' })
  expect(db.terminal.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ status: 'ACTIVE', name: 'Caja 2', activatedAt: expect.any(Date), activatedBy: 'admin' }),
    }),
  )
})

it('un merchant inexistente no mueve ni encola nada', async () => {
  db.merchantAccount.findMany.mockResolvedValue([])
  await expect(updateTerminal('t1', { venueId: 'new', assignedMerchantIds: ['missing'] })).rejects.toThrow()
  expect(db.terminal.update).not.toHaveBeenCalled()
  expect(queue).not.toHaveBeenCalled()
})

it('revalida merchants activos dentro de la transacción antes de encolar', async () => {
  db.merchantAccount.findMany.mockResolvedValueOnce([{ id: 'm-new' }]).mockResolvedValueOnce([])
  await expect(updateTerminal('t1', { venueId: 'new', assignedMerchantIds: ['m-new'] })).rejects.toThrow(/activo/)
  expect(queue).not.toHaveBeenCalled()
})

it('protocolo 2 conserva el venue y merchants hasta que la app reservó su ventana segura', async () => {
  db.terminal.findUnique.mockResolvedValue({
    id: 't1',
    name: 'PAX',
    type: 'TPV_ANDROID',
    status: 'ACTIVE',
    venueId: 'old',
    assignedMerchantIds: ['m-old'],
    commandProtocolVersion: 2,
  })
  await updateTerminal('t1', { venueId: 'new', assignedMerchantIds: ['m-new'] }, { staffId: 'admin' })
  expect(broadcastTpvCommand).toHaveBeenCalledWith(
    't1',
    'old',
    expect.objectContaining({
      commandId: 'wipe-new',
      payload: { _deliveryProtocol: 2 },
      type: 'FACTORY_RESET',
    }),
  )
  const data = db.terminal.update.mock.calls[0][0].data
  expect(db.$queryRaw).toHaveBeenCalled()
  expect(data).not.toHaveProperty('venueId')
  expect(data).not.toHaveProperty('assignedMerchantIds')
  expect(queue).toHaveBeenCalledWith(
    expect.objectContaining({
      venueId: 'old',
      migrationIntent: { toVenueId: 'new', assignedMerchantIds: ['m-new'] },
    }),
    db,
  )
})

it('revalida una intención concurrente después de bloquear la terminal del protocolo 2', async () => {
  db.terminal.findUnique.mockResolvedValue({
    id: 't1',
    type: 'TPV_ANDROID',
    status: 'ACTIVE',
    venueId: 'old',
    assignedMerchantIds: [],
    commandProtocolVersion: 2,
  })
  db.tpvCommandQueue.findFirst.mockResolvedValue({
    id: 'concurrent',
    status: 'PENDING',
    payload: { migration: { fromVenueId: 'old', toVenueId: 'other' } },
  })
  await expect(updateTerminal('t1', { venueId: 'new' })).rejects.toMatchObject({ statusCode: 409 })
  expect(queue).not.toHaveBeenCalled()
})

// 🔴 §4.3 del plan de la pantalla del cliente: el escritor llama al gancho DENTRO de su transacción y ANTES de escribir
// `venueId` (si fuera después, el gancho leería el negocio nuevo y no borraría nada), y sólo invalida la caché DESPUÉS del
// commit (antes, un cálculo concurrente podría leer el diseño todavía sin borrar y volver a guardarlo).
describe('el gancho de la pantalla del cliente en el traslado', () => {
  const mockGancho = borrarDisenoAlCambiarDeNegocio as jest.Mock
  const mockInvalidar = invalidateCustomerDisplayCache as jest.Mock
  let tx: any
  let confirmar!: () => void
  let fallarCommit!: (e: unknown) => void
  const flush = () => new Promise(r => setImmediate(r))

  beforeEach(() => {
    // Un `tx` DISTINTO del cliente global, con delegados PROPIOS (no los mismos objetos de `db`): sólo así una escritura
    // por `tx.terminal.update` se distingue de una por `prisma.terminal.update` (Codex 14-oct, P3: con `{ ...db }`,
    // `tx.terminal === db.terminal` y las dos llamadas eran la misma para el doble). Cubre lo que el traslado usa DENTRO de
    // la transacción: la terminal, los merchants, la cola de comandos, la config de pago y el candado explícito.
    tx = {
      $queryRaw: jest.fn(),
      terminal: { update: jest.fn(async ({ data }: any) => ({ id: 't1', venueId: 'new', ...data })) },
      merchantAccount: { findMany: jest.fn().mockResolvedValue([{ id: 'm-new', active: true }]) },
      tpvCommandQueue: { findFirst: jest.fn().mockResolvedValue(null) },
      venuePaymentConfig: { create: jest.fn() },
    }
    // La promesa del commit queda retenida: la prueba decide cuándo confirma (o falla) la transacción.
    db.$transaction.mockImplementation(
      (fn: any) =>
        new Promise((resolve, reject) => {
          Promise.resolve(fn(tx)).then(v => {
            confirmar = () => resolve(v)
            fallarCommit = reject
          }, reject)
        }),
    )
  })
  afterEach(() => {
    db.$transaction.mockImplementation(async (fn: any) => fn(db))
  })

  it('(a) protocolo < 2: el gancho va en la transacción, antes de escribir venueId; la caché se invalida tras el commit', async () => {
    const traslado = updateTerminal('t1', { venueId: 'new', assignedMerchantIds: ['m-new'] }, { staffId: 'admin' })
    await flush()

    expect(mockGancho).toHaveBeenCalledTimes(1)
    expect(mockGancho).toHaveBeenCalledWith(tx, { terminalId: 't1', toVenueId: 'new', reason: 'terminal_moved', staffId: 'admin' })
    expect(mockGancho.mock.calls[0][0]).toBe(tx)
    expect(mockGancho.mock.calls[0][0]).not.toBe(prisma)
    // La escritura del negocio nuevo va por `tx.terminal.update` (dentro de la transacción) y NUNCA por el cliente global.
    const escrituraDelNegocio = tx.terminal.update.mock.calls.findIndex((c: any[]) => c[0].data.venueId === 'new')
    expect(escrituraDelNegocio).toBeGreaterThanOrEqual(0)
    expect(db.terminal.update).not.toHaveBeenCalled()
    expect(mockGancho.mock.invocationCallOrder[0]).toBeLessThan(tx.terminal.update.mock.invocationCallOrder[escrituraDelNegocio])
    // El resto de lo que el traslado lee/escribe dentro de la transacción también va por `tx`.
    expect(tx.merchantAccount.findMany).toHaveBeenCalled()
    expect(tx.tpvCommandQueue.findFirst).toHaveBeenCalled()
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'new' }), tx)
    expect(mockInvalidar).toHaveBeenCalledTimes(0) // todavía sin commit

    confirmar()
    await traslado
    expect(mockInvalidar).toHaveBeenCalledTimes(1)
    expect(mockInvalidar).toHaveBeenCalledWith('t1')
  })

  it('(b) si el commit falla, el escritor rechaza y la caché no se toca', async () => {
    const traslado = updateTerminal('t1', { venueId: 'new', assignedMerchantIds: ['m-new'] }, { staffId: 'admin' })
    await flush()
    expect(mockGancho).toHaveBeenCalledTimes(1)

    fallarCommit(new Error('commit'))
    await expect(traslado).rejects.toThrow('commit')
    expect(mockInvalidar).toHaveBeenCalledTimes(0)
  })

  it('(c) protocolo 2 (deferMove): la terminal no se muda aquí, así que ni gancho ni invalidación', async () => {
    db.terminal.findUnique.mockResolvedValue({
      id: 't1',
      name: 'PAX',
      type: 'TPV_ANDROID',
      status: 'ACTIVE',
      venueId: 'old',
      assignedMerchantIds: ['m-old'],
      commandProtocolVersion: 2,
    })
    const traslado = updateTerminal('t1', { venueId: 'new', assignedMerchantIds: ['m-new'] }, { staffId: 'admin' })
    await flush()
    confirmar()
    await traslado

    expect(tx.$queryRaw).toHaveBeenCalled() // tomó el candado explícito del protocolo 2
    // Aun sin mudarla, la escritura (nombre, estado…) va por `tx.terminal.update`, sin `venueId`, y no por el cliente global.
    expect(tx.terminal.update).toHaveBeenCalledTimes(1)
    expect(tx.terminal.update.mock.calls[0][0].data).not.toHaveProperty('venueId')
    expect(db.terminal.update).not.toHaveBeenCalled()
    expect(mockGancho).not.toHaveBeenCalled()
    expect(mockInvalidar).not.toHaveBeenCalled()
  })
})
