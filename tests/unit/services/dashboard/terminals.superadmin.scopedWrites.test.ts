/**
 * Las funciones del superadmin que también usa el dashboard de la ORGANIZACIÓN escriben dentro de su ámbito.
 *
 * 🔴 Auditoría de Codex del spec «pantalla del cliente», 4ª ronda (2026-09-17), C1 y la consulta que le siguió:
 * `updateTerminalForOrg`, `deleteTerminalForOrg`, `assignMerchantsForOrg` y `generateActivationCodeForOrg` validan que
 * la terminal sea de la organización y luego llaman a estas funciones, que escribían sólo por id. Si entre la
 * validación y la escritura la terminal pasaba a otra organización, el dueño anterior la seguía modificando: por
 * ejemplo, le dejaba sus comercios de cobro. Sin ámbito (el superadmin) el comportamiento no cambia.
 */

import { Prisma } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import { NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { generateActivationCode as generateActivationCodeUtil } from '@/services/dashboard/terminal-activation.service'
import { deleteTerminal, generateActivationCodeForTerminal, updateTerminal } from '@/services/dashboard/terminals.superadmin.service'

jest.mock('@/utils/prismaClient', () => {
  // b771c2: borrar va en una transacción que bloquea antes las órdenes de la terminal; `delete` es el mismo mock dentro y fuera.
  const borrar = jest.fn()
  const tx = {
    terminal: { update: jest.fn(), delete: borrar },
    $queryRaw: jest.fn().mockResolvedValue([]),
  }
  return {
    __esModule: true,
    default: {
      terminal: {
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: borrar,
      },
      merchantAccount: {
        findMany: jest.fn(),
      },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      __tx: tx,
    },
  }
})

jest.mock('@/lib/providerDeviceCompatibility', () => {
  const actual = jest.requireActual('@/lib/providerDeviceCompatibility')
  return {
    ...actual,
    assertMerchantsTerminalCompatible: jest.fn().mockResolvedValue(undefined),
  }
})

jest.mock('@/services/dashboard/terminal-activation.service', () => {
  const actual = jest.requireActual('@/services/dashboard/terminal-activation.service')
  return {
    ...actual,
    generateActivationCode: jest.fn().mockResolvedValue({ activationCode: 'A3F9K2' }),
  }
})

const mockedPrisma = prisma as unknown as {
  terminal: { findUnique: jest.Mock; update: jest.Mock; delete: jest.Mock }
  merchantAccount: { findMany: jest.Mock }
  $transaction: jest.Mock
  __tx: { terminal: { update: jest.Mock; delete: jest.Mock }; $queryRaw: jest.Mock }
}

const orgScope = { organizationId: 'org-1' }
const orgWhere = { id: 'term-1', venue: { organizationId: 'org-1' } }
const p2025 = () => new Prisma.PrismaClientKnownRequestError('No record was found for an update.', { code: 'P2025', clientVersion: 'test' })
const auditActions = () => (logAction as jest.Mock).mock.calls.map(([params]) => params?.action)

const terminalRow = {
  id: 'term-1',
  venueId: 'venue-1',
  name: 'Caja 1',
  type: 'TPV_ANDROID',
  brand: 'NEXGO',
  selfRegistered: false,
  status: 'INACTIVE',
  activatedAt: null,
  serialNumber: 'AVQD-1',
  assignedMerchantIds: [] as string[],
}

beforeEach(() => {
  jest.clearAllMocks()
  mockedPrisma.terminal.findUnique.mockResolvedValue(terminalRow)
  mockedPrisma.terminal.update.mockImplementation(async ({ where, data }) => ({ ...terminalRow, id: where.id, ...data }))
  mockedPrisma.__tx.terminal.update.mockImplementation(async ({ where, data }) => ({ ...terminalRow, id: where.id, ...data }))
  mockedPrisma.terminal.delete.mockResolvedValue(terminalRow)
})

describe('updateTerminal con el ámbito de la organización', () => {
  it('escribe acotado a la organización del venue actual de la terminal', async () => {
    await updateTerminal('term-1', { name: 'Caja 2' }, undefined, orgScope)

    expect(mockedPrisma.terminal.update).toHaveBeenCalledWith(expect.objectContaining({ where: orgWhere }))
  })

  it('reasignar comercios también se escribe acotado (el dinero no cambia de dueño)', async () => {
    mockedPrisma.merchantAccount.findMany.mockResolvedValue([{ id: 'ma-1', displayName: 'Comercio 1' }])

    await updateTerminal('term-1', { assignedMerchantIds: ['ma-1'] }, undefined, orgScope)

    expect(mockedPrisma.terminal.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: orgWhere, data: expect.objectContaining({ assignedMerchantIds: ['ma-1'] }) }),
    )
  })

  it('el cambio de marca con depuración de comercios también va acotado', async () => {
    mockedPrisma.terminal.findUnique.mockResolvedValue({ ...terminalRow, assignedMerchantIds: ['ma-angelpay-1'] })
    mockedPrisma.merchantAccount.findMany.mockResolvedValue([
      { id: 'ma-angelpay-1', displayName: 'AngelPay 1', externalMerchantId: 'ext-1', provider: { code: 'ANGELPAY' } },
    ])

    await updateTerminal('term-1', { brand: 'PAX', forceUnassign: true }, undefined, orgScope)

    expect(mockedPrisma.__tx.terminal.update).toHaveBeenCalledWith(expect.objectContaining({ where: orgWhere }))
  })

  it('si la terminal ya pasó a otra organización, responde 404 y no deja bitácora de éxito', async () => {
    mockedPrisma.terminal.update.mockRejectedValue(p2025())

    await expect(updateTerminal('term-1', { name: 'Caja 2' }, undefined, orgScope)).rejects.toBeInstanceOf(NotFoundError)
    expect(auditActions()).not.toContain('TERMINAL_UPDATED')
  })

  it('sin ámbito (superadmin) sigue escribiendo sólo por id', async () => {
    await updateTerminal('term-1', { name: 'Caja 2' })

    expect(mockedPrisma.terminal.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'term-1' } }))
  })
})

describe('deleteTerminal con el ámbito de la organización', () => {
  it('borra acotado a la organización', async () => {
    await deleteTerminal('term-1', undefined, orgScope)

    expect(mockedPrisma.terminal.delete).toHaveBeenCalledWith({ where: orgWhere })
  })

  it('si la terminal ya pasó a otra organización, responde 404 y no la reporta borrada', async () => {
    mockedPrisma.terminal.delete.mockRejectedValue(p2025())

    await expect(deleteTerminal('term-1', undefined, orgScope)).rejects.toBeInstanceOf(NotFoundError)
    expect(auditActions()).not.toContain('TERMINAL_DELETED')
  })

  it('sin ámbito (superadmin) sigue borrando sólo por id', async () => {
    await deleteTerminal('term-1')

    expect(mockedPrisma.terminal.delete).toHaveBeenCalledWith({ where: { id: 'term-1' } })
  })

  it('b771c2: bloquea las órdenes de la terminal ANTES de borrarla (orden → terminal), en la misma transacción', async () => {
    await deleteTerminal('term-1')

    // órdenes (FOR UPDATE) → terminal (FOR UPDATE) → relectura de órdenes → borrado.
    const candado = mockedPrisma.__tx.$queryRaw
    expect(candado).toHaveBeenCalledTimes(3)
    const sqls = candado.mock.calls.map(([sql]) => (sql as Prisma.Sql).sql)
    expect(sqls[0]).toContain('"TpvCommandQueue"')
    expect(sqls[0]).toContain('FOR UPDATE OF q')
    expect(sqls[1]).toContain('FOR UPDATE OF t')
    expect(sqls[2]).toContain('"TpvCommandQueue"')
    expect(sqls[2]).not.toContain('FOR UPDATE')
    expect((candado.mock.calls[0][0] as Prisma.Sql).values).toEqual(['term-1'])
    expect(candado.mock.invocationCallOrder[2]).toBeLessThan(mockedPrisma.terminal.delete.mock.invocationCallOrder[0])
  })

  it('b771c2 (Codex r3): una orden nueva entre el candado de las órdenes y el de la terminal ⇒ 409 y no se borra', async () => {
    mockedPrisma.__tx.$queryRaw
      .mockResolvedValueOnce([{ id: 'cmd-viejo' }])
      .mockResolvedValueOnce([{ id: 'term-1' }])
      .mockResolvedValueOnce([{ id: 'cmd-viejo' }, { id: 'cmd-nuevo' }])

    await expect(deleteTerminal('term-1')).rejects.toMatchObject({ statusCode: 409, code: 'ORDENES_DE_LA_TERMINAL_CAMBIARON' })
    expect(mockedPrisma.terminal.delete).not.toHaveBeenCalled()
    expect(auditActions()).not.toContain('TERMINAL_DELETED')
  })
})

describe('generateActivationCodeForTerminal con el ámbito de la organización', () => {
  it('pasa el ámbito a quien lee y escribe el código', async () => {
    await generateActivationCodeForTerminal('term-1', 'staff-1', orgScope)

    expect(generateActivationCodeUtil).toHaveBeenCalledWith('term-1', 'staff-1', orgScope)
  })

  it('sin ámbito (superadmin) no inventa uno', async () => {
    await generateActivationCodeForTerminal('term-1', 'staff-1')

    expect(generateActivationCodeUtil).toHaveBeenCalledWith('term-1', 'staff-1', undefined)
  })
})
