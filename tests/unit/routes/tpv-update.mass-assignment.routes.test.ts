import { Prisma } from '@prisma/client'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * 🔴 Asignación masiva en `PUT /dashboard/venues/:venueId/tpv/:tpvId` (auditoría de Codex del spec
 * «pantalla del cliente», 3ª ronda, 2026-09-16, hallazgo D1).
 *
 * La ruta pasaba el cuerpo ENTERO a `prisma.terminal.update` con `where: { id }`. Con `tpv:update` en
 * su negocio, un gerente podía mandar `venueId` (mover su terminal a otro negocio), `assignedMerchantIds`
 * (conectarla a cuentas de cobro ajenas) o `deviceUid` (apropiársela para otro aparato).
 *
 * La autorización es la REAL: `checkPermission` no está simulado. Sólo se simulan la autenticación
 * y la capa de datos. Lo que se comprueba es lo que de verdad llega a Prisma.
 */

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['x-test-auth-context']
    const value = Array.isArray(raw) ? raw[0] : raw
    if (!value) {
      res.status(401).json({ message: 'No autorizado' })
      return
    }
    ;(req as any).authContext = JSON.parse(value)
    next()
  },
}))

import dashboardRoutes from '@/routes/dashboard.routes'

const VENUE_A = 'venue-a'
const VENUE_B = 'venue-b'

type FakeTerminal = { id: string; venueId: string; type: string; name: string; [key: string]: unknown }

let terminals: FakeTerminal[] = []

function freshTerminals(): FakeTerminal[] {
  return [
    {
      id: 'terminal-a',
      venueId: VENUE_A,
      type: 'TPV_ANDROID',
      name: 'Caja 1',
      serialNumber: 'AVQD-2841548417',
      brand: 'PAX',
      model: 'A910S',
      status: 'ACTIVE',
      assignedMerchantIds: ['merchant-a'],
      deviceUid: null,
    },
    {
      id: 'terminal-b',
      venueId: VENUE_B,
      type: 'TPV_ANDROID',
      name: 'Caja ajena',
      serialNumber: 'AVQD-2841548418',
      brand: 'PAX',
      model: 'A910S',
      status: 'ACTIVE',
      assignedMerchantIds: ['merchant-b'],
      deviceUid: null,
    },
  ]
}

/** Membresías con los roles REALES: MANAGER tiene `tpv:update` y CASHIER no. */
const MEMBERSHIPS: Record<string, { role: string; active: boolean }> = {
  'manager-a:venue-a': { role: 'MANAGER', active: true },
  'cashier-a:venue-a': { role: 'CASHIER', active: true },
}

function matches(terminal: FakeTerminal, where: { id?: string; venueId?: string }) {
  return terminal.id === where.id && (where.venueId === undefined || terminal.venueId === where.venueId)
}

function p2025() {
  return new Prisma.PrismaClientKnownRequestError('No record was found for an update.', { code: 'P2025', clientVersion: 'test' })
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/dashboard', dashboardRoutes)
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code })
  })
  return app
}

function as(userId: string, tokenRole: string) {
  return {
    'x-test-auth-context': JSON.stringify({ userId, venueId: VENUE_A, orgId: 'org-a', role: tokenRole }),
    'x-venue-id': VENUE_A,
  }
}

function putTerminal(path: string, headers: Record<string, string>, body: unknown) {
  return request(makeApp())
    .put(`/api/v1/dashboard${path}`)
    .set(headers)
    .send(body as any)
}

/** Lo que el servicio le pidió escribir a Prisma. */
function lastUpdate(): { where: Record<string, unknown>; data: Record<string, unknown> } {
  const calls = prismaMock.terminal.update.mock.calls
  return calls[calls.length - 1][0] as any
}

function tpvUpdatedAudit() {
  return (logAction as jest.Mock).mock.calls.map(([params]) => params).filter(params => params?.action === 'TPV_UPDATED')
}

beforeEach(() => {
  jest.clearAllMocks()
  terminals = freshTerminals()

  prismaMock.terminal.findFirst.mockImplementation((({ where }: any) =>
    Promise.resolve(terminals.find(t => matches(t, where)) ?? null)) as any)
  prismaMock.terminal.update.mockImplementation((({ where, data }: any) => {
    const target = terminals.find(t => matches(t, where))
    if (!target) return Promise.reject(p2025())
    Object.assign(target, data)
    return Promise.resolve({ ...target })
  }) as any)

  // Capa de datos de la autorización real.
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.findUnique.mockImplementation((({ where }: any) => {
    const key = `${where?.staffId_venueId?.staffId}:${where?.staffId_venueId?.venueId}`
    const membership = MEMBERSHIPS[key]
    return Promise.resolve(
      membership ? { role: membership.role, active: membership.active, permissionSetId: null, permissionSet: null } : null,
    )
  }) as any)
  prismaMock.venue.findUnique.mockImplementation((({ where }: any) =>
    Promise.resolve({ id: where?.id, organizationId: `org-${where?.id}` })) as any)
  prismaMock.staffOrganization.findUnique.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
})

describe('Editar una terminal desde el dashboard: sólo los campos del formulario llegan a la base', () => {
  it('ignora venueId, assignedMerchantIds y deviceUid aunque el gerente los mande', async () => {
    const response = await putTerminal('/venues/venue-a/tpv/terminal-a', as('manager-a', 'MANAGER'), {
      name: 'Caja 2',
      venueId: VENUE_B,
      assignedMerchantIds: ['merchant-b'],
      deviceUid: 'aparato-ajeno',
      activatedAt: '2020-01-01T00:00:00.000Z',
      customerDisplayRequest: { status: 'PENDING' },
    })

    expect(response.status).toBe(200)
    expect(prismaMock.terminal.update).toHaveBeenCalledTimes(1)
    const { where, data } = lastUpdate()
    expect(where).toEqual({ id: 'terminal-a', venueId: VENUE_A })
    expect(Object.keys(data).sort()).toEqual(['name', 'updatedAt'])
    expect(data.name).toBe('Caja 2')
    // La terminal sigue en su negocio y con sus comercios.
    expect(terminals[0]).toMatchObject({ venueId: VENUE_A, assignedMerchantIds: ['merchant-a'], deviceUid: null })
    expect(response.body).toMatchObject({ id: 'terminal-a', venueId: VENUE_A, name: 'Caja 2' })
  })

  it('deja constancia en el log de las llaves que ignoró (sólo los nombres, nunca los valores)', async () => {
    await putTerminal('/venues/venue-a/tpv/terminal-a', as('manager-a', 'MANAGER'), {
      name: 'Caja 2',
      venueId: VENUE_B,
      deviceUid: 'aparato-ajeno',
    })

    const warnCalls = (logger.warn as jest.Mock).mock.calls.filter(([message]) => String(message).includes('campos no editables'))
    expect(warnCalls).toHaveLength(1)
    expect(warnCalls[0][1]).toEqual(
      expect.objectContaining({ terminalId: 'terminal-a', venueId: VENUE_A, ignoredFields: ['deviceUid', 'venueId'] }),
    )
    expect(JSON.stringify(warnCalls[0][1])).not.toContain('aparato-ajeno')
  })

  it('conserva los campos del formulario y el campo viejo de la pantalla invertida', async () => {
    const response = await putTerminal('/venues/venue-a/tpv/terminal-a', as('manager-a', 'MANAGER'), {
      name: 'Caja 3',
      serialNumber: 'AVQD-2841548417',
      type: 'TPV_ANDROID',
      brand: 'PAX',
      model: 'A920',
      status: 'MAINTENANCE',
      config: '{"settings":{"showTipScreen":false}}',
      customerDisplayInverted: true,
    })

    expect(response.status).toBe(200)
    const { data } = lastUpdate()
    // La serie que ya tenía no se reescribe (la terminal se autentica con ella).
    expect(Object.keys(data).sort()).toEqual(
      ['brand', 'config', 'customerDisplayInverted', 'model', 'name', 'status', 'type', 'updatedAt'].sort(),
    )
    expect(data).toMatchObject({
      name: 'Caja 3',
      model: 'A920',
      status: 'MAINTENANCE',
      config: { settings: { showTipScreen: false } },
      customerDisplayInverted: true,
    })
    // La bitácora lista los campos escritos, sin los valores de la configuración.
    expect(tpvUpdatedAudit()[0]?.data?.updatedFields).toEqual(
      ['brand', 'config', 'customerDisplayInverted', 'model', 'name', 'status', 'type'].sort(),
    )
    expect(JSON.stringify(tpvUpdatedAudit()[0])).not.toContain('showTipScreen')
  })

  it('un tipo o un estado vacío del formulario no cambia nada (antes tronaba en Prisma)', async () => {
    const response = await putTerminal('/venues/venue-a/tpv/terminal-a', as('manager-a', 'MANAGER'), {
      name: 'Caja 1',
      type: '',
      status: '',
    })

    expect(response.status).toBe(200)
    expect(Object.keys(lastUpdate().data).sort()).toEqual(['name', 'updatedAt'])
  })

  it('rechaza un estado inventado con 400 y no escribe', async () => {
    const response = await putTerminal('/venues/venue-a/tpv/terminal-a', as('manager-a', 'MANAGER'), {
      name: 'Caja 1',
      status: 'HACKEADA',
    })

    expect(response.status).toBe(400)
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
  })

  it('normaliza la marca: una Nexgo guardada como «nexgo» dejaría de cobrar con AngelPay', async () => {
    await putTerminal('/venues/venue-a/tpv/terminal-a', as('manager-a', 'MANAGER'), { name: 'Caja 1', brand: ' nexgo ' })

    expect(lastUpdate().data.brand).toBe('NEXGO')
  })

  it('normaliza una serie NUEVA de una terminal de cobro igual que al crearla', async () => {
    await putTerminal('/venues/venue-a/tpv/terminal-a', as('manager-a', 'MANAGER'), {
      name: 'Caja 1',
      serialNumber: ' avqd-2841548499 ',
    })

    expect(lastUpdate().data.serialNumber).toBe('AVQD-2841548499')
  })

  it('la misma serie escrita con otro formato no se reescribe', async () => {
    await putTerminal('/venues/venue-a/tpv/terminal-a', as('manager-a', 'MANAGER'), {
      name: 'Caja 1',
      serialNumber: ' avqd-2841548417 ',
    })

    expect(lastUpdate().data).not.toHaveProperty('serialNumber')
  })

  it('no toca la terminal de otro negocio aunque la URL diga el propio', async () => {
    const response = await putTerminal('/venues/venue-a/tpv/terminal-b', as('manager-a', 'MANAGER'), { name: 'Robada' })

    expect(response.status).toBe(404)
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
    expect(terminals[1].name).toBe('Caja ajena')
  })

  it('si la terminal se muda de negocio a media operación, responde 404 y no escribe en el otro', async () => {
    // Se lee en A y, antes de escribir, un superadmin la mueve a B.
    prismaMock.terminal.findFirst.mockImplementationOnce((({ where }: any) => {
      const found = terminals.find(t => matches(t, where)) ?? null
      const snapshot = found ? { ...found } : null
      if (found) found.venueId = VENUE_B
      return Promise.resolve(snapshot)
    }) as any)

    const response = await putTerminal('/venues/venue-a/tpv/terminal-a', as('manager-a', 'MANAGER'), { name: 'Caja 2' })

    expect(response.status).toBe(404)
    expect(lastUpdate().where).toEqual({ id: 'terminal-a', venueId: VENUE_A })
    expect(terminals[0].name).toBe('Caja 1')
    expect(tpvUpdatedAudit()).toHaveLength(0)
  })

  it('la bitácora dice quién editó y qué campos cambió', async () => {
    await putTerminal('/venues/venue-a/tpv/terminal-a', as('manager-a', 'MANAGER'), { name: 'Caja 2', venueId: VENUE_B })

    expect(tpvUpdatedAudit()).toEqual([
      expect.objectContaining({
        action: 'TPV_UPDATED',
        entity: 'Terminal',
        entityId: 'terminal-a',
        venueId: VENUE_A,
        staffId: 'manager-a',
        data: expect.objectContaining({ name: 'Caja 2', updatedFields: ['name'] }),
      }),
    ])
  })

  it('un cajero no puede editar la terminal', async () => {
    const response = await putTerminal('/venues/venue-a/tpv/terminal-a', as('cashier-a', 'CASHIER'), { name: 'Caja 2' })

    expect(response.status).toBe(403)
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
  })
})
