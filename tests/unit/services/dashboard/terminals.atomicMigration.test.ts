import prisma from '@/utils/prismaClient'
import { updateTerminal } from '@/services/dashboard/terminals.superadmin.service'
import { tpvCommandQueueService } from '@/services/tpv/command-queue.service'
import { broadcastTpvCommand } from '@/communication/sockets'

jest.mock('@/communication/sockets', () => ({ broadcastTpvCommand: jest.fn(), broadcastSuperadminTerminalUpdate: jest.fn() }))

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
