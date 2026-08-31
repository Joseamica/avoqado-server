/**
 * `:campo` (la app de promotores en construcción) necesita saber a qué sucursal quedó
 * atada la sesión al entrar — sin esto tendría que adivinarla de `staff.venues[]`, que
 * incluye las suspendidas y cerradas, y contarlas rechazaría logins perfectamente válidos
 * (una tienda activa + una suspendida = "tienes 2 sucursales").
 *
 * El servidor YA elige la sucursal operativa para sellar el token
 * (`pickOperationalVenueForLogin`); esta prueba fija que esa MISMA decisión también viaja
 * en la respuesta, con su propio nombre (`selectedVenueId`), sin tocar el contrato viejo.
 */
import { VenueStatus } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import * as jwtService from '../../../../src/jwt.service'
import bcrypt from 'bcryptjs'
import { loginWithEmail } from '../../../../src/services/mobile/auth.mobile.service'

const prismaMock = prisma as any

const venue = (id: string, status: VenueStatus) => ({
  venueId: id,
  role: 'MANAGER',
  permissionSetId: null,
  permissionSet: null,
  venue: {
    id,
    name: id,
    slug: id,
    logo: null,
    type: 'SALON',
    status,
    kycStatus: 'APPROVED',
    organizationId: 'org_1',
    timezone: 'America/Mexico_City',
  },
})

function staffWith(venues: ReturnType<typeof venue>[]) {
  return {
    id: 'staff_1',
    email: 'promotor@ejemplo.com',
    emailVerified: true,
    firstName: 'Un',
    lastName: 'Promotor',
    password: 'hash',
    active: true,
    photoUrl: null,
    phone: null,
    lockedUntil: null,
    failedLoginAttempts: 0,
    createdAt: new Date(),
    lastLoginAt: null,
    venues,
  }
}

beforeEach(() => {
  jest.spyOn(bcrypt, 'compare').mockImplementation(() => Promise.resolve(true) as any)
  jest.spyOn(jwtService, 'generateAccessToken').mockReturnValue('access')
  jest.spyOn(jwtService, 'generateRefreshToken').mockReturnValue('refresh')
  prismaMock.staff.update.mockResolvedValue({})
  prismaMock.venueRolePermission.findMany.mockResolvedValue([])
  prismaMock.venueRoleConfig.findMany.mockResolvedValue([])
})

describe('loginWithEmail — selectedVenueId', () => {
  it('devuelve la sucursal a la que ató la sesión, y nunca una suspendida', async () => {
    const venueActivo = venue('venue_activo', 'ACTIVE')
    const venueSuspendido = venue('venue_suspendido', 'SUSPENDED')
    prismaMock.staff.findUnique.mockResolvedValue(staffWith([venueSuspendido, venueActivo]))

    const res = await loginWithEmail('promotor@ejemplo.com', 'buena', false, 'device-1')

    expect(res.selectedVenueId).toBe(venueActivo.venueId)
    // El arreglo NO se filtra: se conserva el contrato que ya consumen Android, iOS y TPV.
    expect(res.staff.venues).toHaveLength(2)
  })

  it('con una sola sucursal operativa, selectedVenueId es esa', async () => {
    const venueUnico = venue('venue_unico', 'ACTIVE')
    prismaMock.staff.findUnique.mockResolvedValue(staffWith([venueUnico]))

    const res = await loginWithEmail('promotor@ejemplo.com', 'buena')

    expect(res.selectedVenueId).toBe(venueUnico.venueId)
  })
})
