/**
 * D4 (30-oct): `/auth/status` no mandaba `Venue.timezone`, y el DASHBOARD arma sus sucursales sólo de esta respuesta: todo el panel
 * usaba la hora de CDMX en cualquier sucursal (`activeVenue?.timezone || 'America/Mexico_City'`), también en Tijuana o Cancún.
 * Cada sucursal sale ahora con su zona; una inválida (un legado como «GMT-6») sale como CDMX, porque formatear con una zona
 * inválida truena (`RangeError`) y el panel no puede caerse por eso.
 */
import type { Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import prisma from '@/utils/prismaClient'
import { getAuthStatus } from '@/controllers/dashboard/auth.dashboard.controller'
import { MASTER_ADMIN_PRINCIPAL_ID } from '@/lib/authPrincipals'

jest.mock('jsonwebtoken')
jest.mock('@/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }))
jest.mock('@/services/dashboard/venueRoleConfig.dashboard.service', () => ({
  getRoleDisplayNames: jest.fn(async () => new Map()),
  DEFAULT_ROLE_DISPLAY_NAMES: {},
}))
jest.mock('@/services/master-catalog/masterCatalogAccess.service', () => ({
  resolveMasterCatalogAccess: jest.fn(async () => ({ canRead: false })),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: jest.fn() },
    venueRolePermission: { findMany: jest.fn() },
    venue: { findMany: jest.fn() },
    organizationModule: { findMany: jest.fn() },
    onboardingProgress: { findUnique: jest.fn() },
  },
}))

const db = prisma as unknown as {
  staff: { findUnique: jest.Mock }
  venueRolePermission: { findMany: jest.Mock }
  venue: { findMany: jest.Mock }
  organizationModule: { findMany: jest.Mock }
}

function sucursal(id: string, timezone: string) {
  return {
    id,
    name: `Sucursal ${id}`,
    slug: id,
    logo: null,
    currency: 'MXN',
    type: 'RESTAURANT',
    status: 'ACTIVE',
    kycStatus: null,
    timezone,
    address: null,
    city: null,
    state: null,
    zipCode: null,
    country: null,
    email: null,
    phone: null,
    organizationId: 'org-1',
    organization: { id: 'org-1', name: 'Org', slug: 'org' },
    features: [],
    venueModules: [],
    settings: null,
  }
}

function staffCon(rol: 'OWNER' | 'SUPERADMIN' | 'MANAGER', venues: ReturnType<typeof sucursal>[]) {
  return {
    id: 'staff-1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    emailVerified: true,
    photoUrl: null,
    phone: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastLoginAt: new Date('2026-10-01T00:00:00.000Z'),
    organizations: [
      {
        organizationId: 'org-1',
        role: rol === 'OWNER' ? 'OWNER' : 'MEMBER',
        isActive: true,
        leftAt: null,
        isPrimary: true,
        organization: { id: 'org-1', name: 'Org', email: 'otro@example.com', onboardingCompletedAt: new Date('2026-01-01') },
      },
    ],
    venues: venues.map(venue => ({ role: rol, pin: null, venue })),
  }
}

function respuesta() {
  const res: Partial<Response> & { payload?: any } = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn((payload: unknown) => {
    res.payload = payload
    return res
  }) as Response['json']
  res.clearCookie = jest.fn().mockReturnValue(res)
  res.cookie = jest.fn().mockReturnValue(res)
  res.setHeader = jest.fn().mockReturnValue(res)
  return res
}

const zonas = (venues: Array<{ id: string; timezone?: string }>) => Object.fromEntries(venues.map(v => [v.id, v.timezone]))

async function estado() {
  const res = respuesta()
  await getAuthStatus({ cookies: { accessToken: 'valido' } } as unknown as Request, res as Response)
  return res.payload
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(jwt.verify as jest.Mock).mockReturnValue({ sub: 'staff-1' })
  db.venueRolePermission.findMany.mockResolvedValue([])
  db.organizationModule.findMany.mockResolvedValue([])
})

describe('/auth/status manda la zona horaria de cada sucursal (D4)', () => {
  it('sucursales del usuario: cada una con su zona; una inválida sale como CDMX', async () => {
    db.staff.findUnique.mockResolvedValue(
      staffCon('MANAGER', [sucursal('cancun', 'America/Cancun'), sucursal('legado', 'GMT-6'), sucursal('cdmx', 'America/Mexico_City')]),
    )
    const payload = await estado()
    expect(zonas(payload.user.venues)).toEqual({ cancun: 'America/Cancun', legado: 'America/Mexico_City', cdmx: 'America/Mexico_City' })
    expect(db.staff.findUnique.mock.calls[0][0].select.venues.select.venue.select.timezone).toBe(true)
  })

  it('dueño: las sucursales de su organización también traen su zona (en venues y en allVenues)', async () => {
    db.staff.findUnique.mockResolvedValue(staffCon('OWNER', [sucursal('cdmx', 'America/Mexico_City')]))
    db.venue.findMany.mockResolvedValue([sucursal('cdmx', 'America/Mexico_City'), sucursal('tijuana', 'America/Tijuana')])
    const payload = await estado()
    expect(zonas(payload.user.venues)).toEqual({ cdmx: 'America/Mexico_City', tijuana: 'America/Tijuana' })
    expect(zonas(payload.allVenues)).toEqual({ cdmx: 'America/Mexico_City', tijuana: 'America/Tijuana' })
    expect(db.venue.findMany.mock.calls[0][0].select.timezone).toBe(true)
  })

  it('superadministrador: todas las sucursales del sistema traen su zona', async () => {
    db.staff.findUnique.mockResolvedValue(staffCon('SUPERADMIN', [sucursal('cdmx', 'America/Mexico_City')]))
    db.venue.findMany.mockResolvedValue([sucursal('cdmx', 'America/Mexico_City'), sucursal('cancun', 'America/Cancun')])
    const payload = await estado()
    expect(zonas(payload.allVenues)).toEqual({ cdmx: 'America/Mexico_City', cancun: 'America/Cancun' })
    expect(db.venue.findMany.mock.calls[0][0].select.timezone).toBe(true)
  })

  it('administrador maestro: todas las sucursales traen su zona', async () => {
    ;(jwt.verify as jest.Mock).mockReturnValue({ sub: MASTER_ADMIN_PRINCIPAL_ID })
    db.staff.findUnique.mockResolvedValue(null)
    db.venue.findMany.mockResolvedValue([sucursal('cancun', 'America/Cancun'), sucursal('vacia', '')])
    const payload = await estado()
    expect(zonas(payload.allVenues)).toEqual({ cancun: 'America/Cancun', vacia: 'America/Mexico_City' })
    expect(zonas(payload.user.venues)).toEqual({ cancun: 'America/Cancun', vacia: 'America/Mexico_City' })
  })
})
