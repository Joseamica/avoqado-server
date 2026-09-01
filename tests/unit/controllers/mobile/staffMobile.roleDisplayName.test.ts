/**
 * GET /mobile/venues/:venueId/staff — roleDisplayName (aditivo).
 *
 * Lo que estas pruebas protegen (founder, 2026-09-01): el selector de
 * "Vendedor" del POS pintaba el ENUM crudo ("WAITER", "VIEWER"). El endpoint
 * ahora manda el nombre como se ve — default en español, o el nombre custom
 * del venue (VenueRoleConfig, p.ej. VIEWER renombrado a "Investor") — con el
 * MISMO resolver que ya usa el login. El enum crudo sigue viajando en `role`
 * (contrato /mobile: nunca quitar campos).
 */

import type { NextFunction, Request, Response } from 'express'

import { prismaMock } from '@tests/__helpers__/setup'
import { getActiveStaff } from '@/controllers/mobile/staff.mobile.controller'

const venueId = 'venue-123'

function makeRes(): Response & { __json: any } {
  const res: any = {}
  res.__json = undefined
  res.status = jest.fn(() => res)
  res.json = jest.fn((body: any) => {
    res.__json = body
    return res
  })
  return res
}

function makeReq(): Request {
  return { params: { venueId }, query: {} } as unknown as Request
}

function staffVenueRow(staffId: string, role: string) {
  return {
    staffId,
    role,
    active: true,
    staff: { id: staffId, firstName: 'Ana', lastName: 'García', email: 'a@x.mx', photoUrl: null, active: true },
  }
}

describe('getActiveStaff — roleDisplayName', () => {
  it('manda el nombre default en español junto al enum crudo', async () => {
    prismaMock.staffVenue.findMany.mockResolvedValue([staffVenueRow('s1', 'WAITER'), staffVenueRow('s2', 'VIEWER')] as any)
    prismaMock.venueRoleConfig.findMany.mockResolvedValue([])

    const res = makeRes()
    await getActiveStaff(makeReq(), res, jest.fn() as NextFunction)

    expect(res.__json.success).toBe(true)
    expect(res.__json.data[0]).toMatchObject({ role: 'WAITER', roleDisplayName: 'Mesero' })
    expect(res.__json.data[1]).toMatchObject({ role: 'VIEWER', roleDisplayName: 'Observador' })
  })

  it('respeta el nombre CUSTOM del venue (VIEWER renombrado a "Investor")', async () => {
    prismaMock.staffVenue.findMany.mockResolvedValue([staffVenueRow('s2', 'VIEWER')] as any)
    prismaMock.venueRoleConfig.findMany.mockResolvedValue([{ venueId, role: 'VIEWER', displayName: 'Investor' }] as any)

    const res = makeRes()
    await getActiveStaff(makeReq(), res, jest.fn() as NextFunction)

    expect(res.__json.data[0]).toMatchObject({ role: 'VIEWER', roleDisplayName: 'Investor' })
  })

  it('si el resolver de nombres truena, la lista sale igual sin el campo (fail-open)', async () => {
    prismaMock.staffVenue.findMany.mockResolvedValue([staffVenueRow('s1', 'WAITER')] as any)
    prismaMock.venueRoleConfig.findMany.mockRejectedValue(new Error('db exploded'))

    const res = makeRes()
    const next = jest.fn() as NextFunction
    await getActiveStaff(makeReq(), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.__json.success).toBe(true)
    expect(res.__json.data[0].role).toBe('WAITER')
    expect(res.__json.data[0].roleDisplayName).toBeUndefined()
  })
})

describe('getActiveStaff — showAsSeller (quién aparece como Vendedor)', () => {
  /**
   * Decisión del founder (2026-09-01): por DEFAULT todos salen como vendedor
   * —como siempre— y el venue APAGA los roles que no venden (p.ej. un VIEWER
   * renombrado a "Investor") con la perilla del editor de roles
   * (VenueRoleConfig.showAsSeller). El POS filtra por este campo.
   */
  beforeEach(() => {
    prismaMock.venueRoleConfig.findMany.mockResolvedValue([])
  })

  it('sin configuración TODOS salen (default prendido), incluido VIEWER', async () => {
    prismaMock.staffVenue.findMany.mockResolvedValue([
      staffVenueRow('s1', 'WAITER'),
      staffVenueRow('s2', 'VIEWER'),
      staffVenueRow('s3', 'KITCHEN'),
    ] as any)

    const res = makeRes()
    await getActiveStaff(makeReq(), res, jest.fn() as NextFunction)

    expect(res.__json.data.map((s: any) => s.showAsSeller)).toEqual([true, true, true])
  })

  it('apagar la perilla de un rol lo marca showAsSeller:false (el "Investor" del cliente)', async () => {
    prismaMock.staffVenue.findMany.mockResolvedValue([staffVenueRow('s1', 'WAITER'), staffVenueRow('s2', 'VIEWER')] as any)
    // getRoleDisplayNamesForVenues y la perilla comparten tabla pero piden
    // selects distintos; aquí basta con que AMBAS consultas devuelvan la fila.
    prismaMock.venueRoleConfig.findMany.mockResolvedValue([
      { venueId, role: 'VIEWER', displayName: 'Investor', showAsSeller: false },
    ] as any)

    const res = makeRes()
    await getActiveStaff(makeReq(), res, jest.fn() as NextFunction)

    expect(res.__json.data[0]).toMatchObject({ role: 'WAITER', showAsSeller: true })
    expect(res.__json.data[1]).toMatchObject({ role: 'VIEWER', roleDisplayName: 'Investor', showAsSeller: false })
  })

  it('si la consulta de la perilla truena, todos salen (fail-open, como siempre)', async () => {
    prismaMock.staffVenue.findMany.mockResolvedValue([staffVenueRow('s2', 'VIEWER')] as any)
    prismaMock.venueRoleConfig.findMany.mockRejectedValue(new Error('db exploded'))

    const res = makeRes()
    const next = jest.fn() as NextFunction
    await getActiveStaff(makeReq(), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.__json.data[0]).toMatchObject({ role: 'VIEWER', showAsSeller: true })
  })
})
