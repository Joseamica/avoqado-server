/**
 * 🔴 IDOR cross-tenant en `PUT /tpv/terminals/:serialNumber/settings` (hermano del de
 * `/dashboard/tpv/:tpvId/settings`, encontrado al cerrarlo el 2026-09-16).
 *
 * La ruta sólo exige estar autenticado y el controlador buscaba la terminal por su número de serie
 * en TODA la base: una sesión del negocio A cambiaba los ajustes de cobro de una terminal del
 * negocio B —y el `enableShifts` de ese negocio— con sólo saber su serie, que en una PAX es un
 * número consecutivo. La terminal ahora se busca DENTRO del venue de la sesión.
 */
import type { NextFunction, Request, Response } from 'express'

import { prismaMock } from '@tests/__helpers__/setup'
import { updateTpvSettings } from '@/controllers/tpv/terminal.tpv.controller'

jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  moduleService: { isModuleEnabled: jest.fn().mockResolvedValue(false) },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))

const VENUE_A = 'venue-a'
const VENUE_B = 'venue-b'
const SERIAL_B = 'AVQD-2841548417'

const TERMINALS = [
  {
    id: 'terminal-b',
    serialNumber: SERIAL_B,
    venueId: VENUE_B,
    config: { settings: { showTipScreen: true } },
    configOverrides: null,
    venue: { organizationId: null },
  },
]

/** Honra el `where`: si el controlador no acota por venue, encuentra la terminal ajena. */
function fakeFindFirst({ where }: { where: { serialNumber?: string; venueId?: string } }) {
  const found = TERMINALS.find(t => t.serialNumber === where.serialNumber && (where.venueId === undefined || t.venueId === where.venueId))
  return Promise.resolve(found ?? null)
}

function makeRes(): Response & { __status: number; __body: any } {
  const res: any = { __status: 0, __body: null }
  res.status = jest.fn((code: number) => {
    res.__status = code
    return res
  })
  res.json = jest.fn((body: any) => {
    res.__body = body
    return res
  })
  return res
}

function putReq(authVenueId: string | undefined, body: Record<string, unknown>) {
  return {
    params: { serialNumber: SERIAL_B },
    body,
    authContext: authVenueId ? { userId: 'staff-a', venueId: authVenueId, role: 'MANAGER' } : undefined,
  } as unknown as Request
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.terminal.findFirst.mockImplementation(fakeFindFirst as any)
  prismaMock.terminal.update.mockResolvedValue({} as any)
  prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue(null)
  prismaMock.venueSettings.upsert.mockResolvedValue({} as any)
})

describe('PUT /tpv/terminals/:serialNumber/settings — sólo dentro del negocio de la sesión', () => {
  it('una sesión del venue A NO cambia los ajustes de una terminal del venue B, ni sus turnos', async () => {
    const res = makeRes()
    const next = jest.fn() as NextFunction

    await updateTpvSettings(putReq(VENUE_A, { showTipScreen: false, enableShifts: false }), res, next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }))
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
    expect(prismaMock.venueSettings.upsert).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })

  it('sin sesión no busca nada (falla cerrado)', async () => {
    const res = makeRes()
    const next = jest.fn() as NextFunction

    await updateTpvSettings(putReq(undefined, { showTipScreen: false }), res, next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }))
    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
  })

  it('uso legítimo: la propia terminal del negocio se actualiza, buscada dentro de su venue', async () => {
    const res = makeRes()
    const next = jest.fn() as NextFunction

    await updateTpvSettings(putReq(VENUE_B, { showTipScreen: false }), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.__status).toBe(200)
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { serialNumber: SERIAL_B, venueId: VENUE_B } }),
    )
    expect(prismaMock.terminal.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'terminal-b' } }))
  })
})
