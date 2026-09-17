import { Prisma } from '@prisma/client'

import { prismaMock } from '@tests/__helpers__/setup'
import { NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { generateActivationCode } from '@/services/dashboard/terminal-activation.service'
import { activateTerminal, deleteTpv } from '@/services/dashboard/tpv.dashboard.service'

// 🔴 Auditoría de Codex del spec «pantalla del cliente», 4ª ronda (2026-09-17), hallazgo C1 y el inventario que le
// siguió: estas operaciones del dashboard leían la terminal dentro del negocio de la ruta y después la escribían sólo
// por id. Si entre la lectura y la escritura la terminal se mudaba (una migración del dueño de la organización o del
// superadmin), un operador autorizado sólo en el negocio A modificaba o borraba una terminal que ya era del negocio B.

const venueId = 'venue-a'
const terminalId = 'terminal-1'

const p2025 = () => new Prisma.PrismaClientKnownRequestError('No record was found for an update.', { code: 'P2025', clientVersion: 'test' })

const auditActions = () => (logAction as jest.Mock).mock.calls.map(([params]) => params?.action)

describe('activateTerminal — registrar la serie escribe dentro del negocio', () => {
  beforeEach(() => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      id: terminalId,
      venueId,
      type: 'TPV_ANDROID',
      status: 'PENDING_ACTIVATION',
      serialNumber: null,
    } as any)
    prismaMock.terminal.findUnique.mockResolvedValue(null)
  })

  it('escribe la serie y el estado acotados al negocio de la ruta', async () => {
    prismaMock.terminal.update.mockResolvedValue({ id: terminalId, name: 'Caja 1' } as any)

    await activateTerminal(venueId, terminalId, '2841548417')

    expect(prismaMock.terminal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: terminalId, venueId },
        data: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    )
    expect(auditActions()).toContain('TPV_ACTIVATED')
  })

  it('si la terminal se mudó entre la lectura y la escritura, responde 404 y no deja bitácora de éxito', async () => {
    prismaMock.terminal.update.mockRejectedValue(p2025())

    await expect(activateTerminal(venueId, terminalId, '2841548417')).rejects.toBeInstanceOf(NotFoundError)
    expect(auditActions()).not.toContain('TPV_ACTIVATED')
  })
})

describe('deleteTpv — borrar una terminal borra dentro del negocio', () => {
  beforeEach(() => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      id: terminalId,
      venueId,
      name: 'Caja 1',
      activatedAt: null,
      selfRegistered: false,
    } as any)
    prismaMock.order.count.mockResolvedValue(0)
    prismaMock.payment.count.mockResolvedValue(0)
  })

  it('borra acotado al negocio de la ruta', async () => {
    prismaMock.terminal.delete.mockResolvedValue({} as any)

    await deleteTpv(venueId, terminalId)

    expect(prismaMock.terminal.delete).toHaveBeenCalledWith({ where: { id: terminalId, venueId } })
    expect(auditActions()).toContain('TPV_DELETED')
  })

  it('si la terminal se mudó a otro negocio a media operación, responde 404 y no la reporta borrada', async () => {
    prismaMock.terminal.delete.mockRejectedValue(p2025())

    await expect(deleteTpv(venueId, terminalId)).rejects.toBeInstanceOf(NotFoundError)
    expect(auditActions()).not.toContain('TPV_DELETED')
  })
})

describe('generateActivationCode — el código se escribe dentro del ámbito de quien lo pide', () => {
  beforeEach(() => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      id: terminalId,
      venueId,
      activatedAt: null,
      serialNumber: null,
      venue: { id: venueId, name: 'Negocio A' },
    } as any)
    prismaMock.terminal.update.mockResolvedValue({} as any)
  })

  it('con el negocio de la ruta, lee y escribe acotado a ese venue', async () => {
    const result = await generateActivationCode(terminalId, 'staff-1', { venueId })

    expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: terminalId, venueId } }))
    expect(prismaMock.terminal.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: terminalId, venueId } }))
    expect(result.activationCode).toHaveLength(6)
  })

  it('con la organización, acota por la organización del venue actual de la terminal', async () => {
    await generateActivationCode(terminalId, 'staff-1', { organizationId: 'org-1' })

    const scoped = { id: terminalId, venue: { organizationId: 'org-1' } }
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: scoped }))
    expect(prismaMock.terminal.update).toHaveBeenCalledWith(expect.objectContaining({ where: scoped }))
  })

  it('sin ámbito (superadmin y alta interna) sigue filtrando sólo por id', async () => {
    await generateActivationCode(terminalId, 'staff-1')

    expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: terminalId } }))
    expect(prismaMock.terminal.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: terminalId } }))
  })

  it('si la terminal se mudó entre la lectura y la escritura, responde 404 y no entrega un código', async () => {
    prismaMock.terminal.update.mockRejectedValue(p2025())

    await expect(generateActivationCode(terminalId, 'staff-1', { venueId })).rejects.toBeInstanceOf(NotFoundError)
  })
})
