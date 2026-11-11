import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  createPermissionOverride,
  consumePermissionOverride,
  OverrideDisabledError,
  OVERRIDE_TTL_MS,
  OVERRIDE_TTL_ATADO_MS,
} from '@/services/mobile/permission-override.mobile.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: { findFirst: jest.fn() },
    venueRolePermission: { findUnique: jest.fn() },
    venueSettings: { findUnique: jest.fn() },
    permissionOverride: { create: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn() },
  },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const VENUE = 'venue_1'
const NOW = new Date('2026-11-10T18:00:00.000Z')
const LLAVE = 'pay-out:loc-1:500000'
const gerente = {
  id: 'sv_manager',
  role: StaffRole.MANAGER,
  permissionSetId: null,
  permissionSet: null,
  staff: { firstName: 'Laura', lastName: 'Méndez' },
}
const settings = prisma.venueSettings.findUnique as jest.Mock
const updateMany = prisma.permissionOverride.updateMany as jest.Mock
const findUnique = prisma.permissionOverride.findUnique as jest.Mock
const create = prisma.permissionOverride.create as jest.Mock
const findFirst = prisma.permissionOverride.findFirst as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue(null)
  ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(gerente)
  create.mockImplementation(async ({ data }: any) => data)
  settings.mockResolvedValue({ managerPinOverrideEnabled: true })
})

const emitir = (operationKey?: string | null) =>
  createPermissionOverride({ venueId: VENUE, pin: '1234', permission: 'cash-drawer:pay-out', now: NOW, operationKey })

describe('autorización atada a una operación (retiro de caja)', () => {
  it('con llave vive 7 días y guarda la llave', async () => {
    const r = await emitir(LLAVE)
    expect(OVERRIDE_TTL_ATADO_MS).toBe(7 * 24 * 60 * 60 * 1000)
    expect(r.expiresAt.getTime()).toBe(NOW.getTime() + OVERRIDE_TTL_ATADO_MS)
    expect(create.mock.calls[0][0].data).toMatchObject({ operationKey: LLAVE })
  })

  it('sin llave sigue siendo de 60 s y sin llave guardada', async () => {
    const r = await emitir()
    expect(r.expiresAt.getTime()).toBe(NOW.getTime() + OVERRIDE_TTL_MS)
    expect(create.mock.calls[0][0].data.operationKey).toBeNull()
  })

  it('la emisión con el interruptor apagado se rechaza', async () => {
    settings.mockResolvedValue({ managerPinOverrideEnabled: false })
    await expect(emitir(LLAVE)).rejects.toBeInstanceOf(OverrideDisabledError)
    expect(create).not.toHaveBeenCalled()
  })

  it('con llave sólo autoriza esa llave (el where lleva la llave y no pide consumedAt null)', async () => {
    findFirst.mockResolvedValue({ authorizedById: 'sv_manager' })
    await consumePermissionOverride({
      token: 't',
      venueId: VENUE,
      permission: 'cash-drawer:pay-out',
      route: 'POST /x',
      now: NOW,
      operationKey: LLAVE,
    })
    const where = findFirst.mock.calls[0][0].where
    expect(where).toMatchObject({ token: 't', venueId: VENUE, permission: 'cash-drawer:pay-out', operationKey: LLAVE })
    expect(where.expiresAt).toEqual({ gt: NOW })
    expect(where).not.toHaveProperty('consumedAt')
  })

  it('con llave autoriza otra vez la misma llave y devuelve el mismo autorizador', async () => {
    findFirst.mockResolvedValue({ authorizedById: 'sv_manager' })
    const p = { token: 't', venueId: VENUE, permission: 'cash-drawer:pay-out', route: 'POST /x', now: NOW, operationKey: LLAVE }
    expect(await consumePermissionOverride(p)).toEqual({ authorizedById: 'sv_manager' })
    expect(await consumePermissionOverride(p)).toEqual({ authorizedById: 'sv_manager' })
  })

  it('con llave la marca de consumo se pone sólo la primera vez', async () => {
    findFirst.mockResolvedValue({ authorizedById: 'sv_manager' })
    await consumePermissionOverride({
      token: 't',
      venueId: VENUE,
      permission: 'cash-drawer:pay-out',
      route: 'POST /x?a=1',
      now: NOW,
      operationKey: LLAVE,
    })
    // la marca va con consumedAt: null en el where: sólo la primera vez escribe
    const marca = updateMany.mock.calls[0][0]
    expect(marca.where).toMatchObject({ token: 't', consumedAt: null })
    expect(marca.data).toMatchObject({ consumedAt: NOW, consumedRoute: 'POST /x' })
  })

  it('con llave otra llave no pasa (sin fila ⇒ null)', async () => {
    findFirst.mockResolvedValue(null)
    const r = await consumePermissionOverride({
      token: 't',
      venueId: VENUE,
      permission: 'cash-drawer:pay-out',
      route: 'POST /x',
      now: NOW,
      operationKey: 'pay-out:loc-2:500000',
    })
    expect(r).toBeNull()
  })

  it('sin llave no sirve donde se pide llave: el where sin llave exige operationKey null', async () => {
    updateMany.mockResolvedValue({ count: 0 })
    await consumePermissionOverride({ token: 't', venueId: VENUE, permission: 'p:q', route: 'POST /x', now: NOW })
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ consumedAt: null, operationKey: null })
  })

  it('con llave no sirve donde no se pide llave (una atada no pasa en otra ruta)', async () => {
    // el where de «sin llave» incluye operationKey: null, así que la fila atada no cuenta
    updateMany.mockResolvedValue({ count: 0 })
    expect(
      await consumePermissionOverride({ token: 'atada', venueId: VENUE, permission: 'cash-drawer:pay-out', route: 'POST /y', now: NOW }),
    ).toBeNull()
    expect(updateMany.mock.calls[0][0].where.operationKey).toBeNull()
  })

  it('sin llave sigue siendo de un uso, 60 s y honra el interruptor', async () => {
    settings.mockResolvedValue({ managerPinOverrideEnabled: false })
    expect(await consumePermissionOverride({ token: 't', venueId: VENUE, permission: 'p:q', route: 'POST /x', now: NOW })).toBeNull()
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('con llave ignora el interruptor apagado al consumir', async () => {
    settings.mockResolvedValue({ managerPinOverrideEnabled: false })
    findFirst.mockResolvedValue({ authorizedById: 'sv_manager' })
    const r = await consumePermissionOverride({
      token: 't',
      venueId: VENUE,
      permission: 'cash-drawer:pay-out',
      route: 'POST /x',
      now: NOW,
      operationKey: LLAVE,
    })
    expect(r).toEqual({ authorizedById: 'sv_manager' })
    expect(settings).not.toHaveBeenCalled()
  })

  it('vencida (7 días + 1 s) ⇒ null: el where pide expiresAt > ahora', async () => {
    findFirst.mockResolvedValue(null)
    const tarde = new Date(NOW.getTime() + OVERRIDE_TTL_ATADO_MS + 1000)
    const r = await consumePermissionOverride({
      token: 't',
      venueId: VENUE,
      permission: 'cash-drawer:pay-out',
      route: 'POST /x',
      now: tarde,
      operationKey: LLAVE,
    })
    expect(r).toBeNull()
    expect(findFirst.mock.calls[0][0].where.expiresAt).toEqual({ gt: tarde })
  })
})
