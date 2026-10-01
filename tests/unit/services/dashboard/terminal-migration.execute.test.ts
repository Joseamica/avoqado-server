import prisma from '@/utils/prismaClient'
import { migrateExecute } from '@/services/dashboard/terminal-migration.service'
import { updateTerminal } from '@/services/dashboard/terminals.superadmin.service'
import { assertMerchantsTerminalCompatible } from '@/lib/providerDeviceCompatibility'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findUnique: jest.fn() },
    venue: { findUnique: jest.fn() },
    venuePaymentConfig: { findFirst: jest.fn(), findUnique: jest.fn() },
    organizationPaymentConfig: { findUnique: jest.fn() },
    merchantAccount: { findMany: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    tpvCommandQueue: { findMany: jest.fn(), findFirst: jest.fn() },
  },
}))
jest.mock('@/services/dashboard/terminals.superadmin.service', () => ({
  updateTerminal: jest.fn(),
  deviceReboundAfter: jest.fn(() => false),
  migrationCommandWhere: jest.fn(() => ({ commandType: 'FACTORY_RESET' })),
}))
jest.mock('@/lib/providerDeviceCompatibility', () => ({ assertMerchantsTerminalCompatible: jest.fn() }))
const db = prisma as any
const move = updateTerminal as jest.Mock
const compatible = assertMerchantsTerminalCompatible as jest.Mock
const actor = { staffId: 'admin' }
const config = {
  primaryAccountId: 'm-default',
  secondaryAccountId: null,
  tertiaryAccountId: null,
  preferredProcessor: 'AUTO',
  routingRules: null,
}

beforeEach(() => {
  jest.clearAllMocks()
  compatible.mockResolvedValue(undefined)
  db.terminal.findUnique.mockResolvedValue({
    id: 't1',
    venueId: 'old',
    type: 'TPV_ANDROID',
    status: 'ACTIVE',
    brand: 'PAX',
    assignedMerchantIds: ['m-origin'],
  })
  db.venue.findUnique.mockImplementation(async ({ where }: any) => ({ id: where.id, organizationId: 'org' }))
  db.venuePaymentConfig.findFirst.mockResolvedValue(config)
  db.venuePaymentConfig.findUnique.mockResolvedValue(config)
  db.organizationPaymentConfig.findUnique.mockResolvedValue(null)
  db.merchantAccount.findMany.mockImplementation(async ({ where }: any) => where.id.in.map((id: string) => ({ id, active: true })))
  db.staffVenue.findFirst.mockResolvedValue({ id: 'staff-with-pin' })
  db.tpvCommandQueue.findMany.mockResolvedValue([])
  move.mockResolvedValue({ id: 't1', venueId: 'new', migrationCommandId: 'new-wipe' })
})

it('sin selección usa el comercio del destino y una sola operación atómica', async () => {
  const result = await migrateExecute('t1', 'new', actor)
  expect(move).toHaveBeenCalledTimes(1)
  expect(move).toHaveBeenCalledWith('t1', { venueId: 'new', assignedMerchantIds: ['m-default'] }, actor, undefined, {
    expectedVenueId: 'old',
    paymentConfig: undefined,
  })
  expect(result.commandId).toBe('new-wipe')
  expect(db.tpvCommandQueue.findFirst).not.toHaveBeenCalled()
})
it('una selección explícita gana y conserva el ámbito de la organización', async () => {
  const scope = { organizationId: 'org' }
  await migrateExecute('t1', 'new', actor, ['m-selected'], false, scope)
  expect(move).toHaveBeenCalledWith('t1', { venueId: 'new', assignedMerchantIds: ['m-selected'] }, actor, scope, expect.anything())
})
it('sin config de destino no mueve aunque el cliente omita merchant', async () => {
  db.venuePaymentConfig.findFirst.mockResolvedValue(null)
  await expect(migrateExecute('t1', 'new', actor)).rejects.toThrow('configuración de pagos')
  expect(move).not.toHaveBeenCalled()
})
it('un comercio incompatible falla ANTES del traslado', async () => {
  compatible.mockRejectedValue(new Error('incompatible'))
  await expect(migrateExecute('t1', 'new', actor, ['wrong'])).rejects.toThrow('compatible')
  expect(move).not.toHaveBeenCalled()
})
it('un comercio desactivado falla ANTES del traslado', async () => {
  db.merchantAccount.findMany.mockResolvedValue([])
  await expect(migrateExecute('t1', 'new', actor)).rejects.toThrow('desactivado')
  expect(move).not.toHaveBeenCalled()
})
it('rechaza destino sin PIN y dispositivos que no son TPV Android', async () => {
  db.staffVenue.findFirst.mockResolvedValue(null)
  await expect(migrateExecute('t1', 'new', actor)).rejects.toThrow('PIN')
  db.staffVenue.findFirst.mockResolvedValue({ id: 'pin' })
  db.terminal.findUnique.mockResolvedValue({ id: 't1', venueId: 'old', type: 'POS_ANDROID', assignedMerchantIds: [] })
  await expect(migrateExecute('t1', 'new', actor)).rejects.toThrow('dispositivo')
  expect(move).not.toHaveBeenCalled()
})
it('no confunde un comando anterior con el borrado nuevo', async () => {
  move.mockResolvedValue({ id: 't1', venueId: 'new' })
  db.tpvCommandQueue.findFirst.mockResolvedValue({ id: 'old-wipe' })
  await expect(migrateExecute('t1', 'new', actor)).rejects.toThrow('No se confirmó')
  expect(db.tpvCommandQueue.findFirst).not.toHaveBeenCalled()
})
it('el error de la transacción se propaga sin éxito parcial', async () => {
  move.mockRejectedValue(new Error('queue unavailable'))
  await expect(migrateExecute('t1', 'new', actor)).rejects.toThrow('queue unavailable')
})
it('acarrea merchant y config en la misma operación, con selección explícita', async () => {
  db.venuePaymentConfig.findFirst.mockResolvedValue(null)
  db.venuePaymentConfig.findUnique.mockImplementation(async ({ where }: any) => (where.venueId === 'old' ? config : null))
  await migrateExecute('t1', 'new', actor, ['m-picked'], true)
  expect(move).toHaveBeenCalledWith(
    't1',
    { venueId: 'new', assignedMerchantIds: ['m-picked'] },
    actor,
    undefined,
    expect.objectContaining({
      expectedVenueId: 'old',
      paymentConfig: expect.objectContaining({ primaryAccountId: 'm-picked', secondaryAccountId: null }),
    }),
  )
})
it('no acarrea comercios entre organizaciones', async () => {
  db.venue.findUnique.mockImplementation(async ({ where }: any) => ({ id: where.id, organizationId: where.id }))
  db.venuePaymentConfig.findFirst.mockResolvedValue(null)
  await expect(migrateExecute('t1', 'new', actor, undefined, true)).rejects.toThrow('otra organización')
  expect(move).not.toHaveBeenCalled()
})
it('hereda el comercio de organización cuando el destino no tiene config propia', async () => {
  db.venuePaymentConfig.findFirst.mockResolvedValue(null)
  db.venuePaymentConfig.findUnique.mockResolvedValue(null)
  db.organizationPaymentConfig.findUnique.mockResolvedValue(config)
  await migrateExecute('t1', 'new', actor)
  expect(move).toHaveBeenCalledWith('t1', { venueId: 'new', assignedMerchantIds: ['m-default'] }, actor, undefined, expect.anything())
})
