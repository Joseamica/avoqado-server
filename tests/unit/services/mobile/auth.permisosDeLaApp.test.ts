/**
 * Los permisos que las APPS reciben al iniciar sesión.
 *
 * El bug: el negocio arma un "Conjunto de permisos" a la medida de una persona
 * —o le QUITA permisos a un rol— y la TERMINAL le hace caso mientras el iPad y
 * el Android siguen igual. No es que la app desobedezca: es que el login móvil
 * calculaba la lista con `getEffectiveRolePermissions(role, custom)` a secas,
 * sin mirar el `permissionSet` de la persona y sin pasar las exclusiones. La
 * lista llegaba mal calculada desde el servidor.
 *
 * `GET /tpv/auth/permissions` (la terminal) SÍ mira el permission set, y de ahí
 * la asimetría que el negocio ve como "en la terminal sí puedo y en la app no".
 *
 * 🔴 Los dos tests de FORMA DE LA CONSULTA no son ceremonia: con un mock, los
 * campos llegan gratis. En producción, si el `include` no pide `permissionSet`
 * y el `select` no pide `deniedPermissions`, llegan `undefined` y el cálculo
 * vuelve a ser el de antes — en verde y sin que nadie se entere.
 */
import prisma from '../../../../src/utils/prismaClient'
import * as jwtService from '../../../../src/jwt.service'
import bcrypt from 'bcryptjs'
import { loginWithEmail } from '../../../../src/services/mobile/auth.mobile.service'

const prismaMock = prisma as any

const VENUE_ID = 'venue_amaena'

/** El conjunto a la medida: cobra, pero no ve los números del negocio. */
const CONJUNTO_A_LA_MEDIDA = {
  id: 'ps_1',
  venueId: VENUE_ID,
  name: 'Vendedora sin métricas',
  description: null,
  permissions: ['menu:read', 'orders:create', 'payments:create'],
  color: null,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const VENUE = {
  id: VENUE_ID,
  name: 'Amaena',
  slug: 'amaena',
  logo: null,
  type: 'SALON',
  status: 'ACTIVE',
  kycStatus: 'APPROVED',
  organizationId: 'org_1',
  timezone: 'America/Mexico_City',
}

function staffConVenue(extraDelStaffVenue: Record<string, unknown>) {
  return {
    id: 'staff_heidi',
    email: 'heidi@amaena.com',
    emailVerified: true,
    firstName: 'Heidi',
    lastName: 'Salmeron',
    password: 'hash',
    active: true,
    photoUrl: null,
    phone: null,
    lockedUntil: null,
    failedLoginAttempts: 0,
    createdAt: new Date(),
    lastLoginAt: null,
    venues: [
      {
        venueId: VENUE_ID,
        role: 'WAITER',
        permissionSetId: null,
        permissionSet: null,
        venue: VENUE,
        ...extraDelStaffVenue,
      },
    ],
  }
}

/** Los permisos que la app va a guardar para ESTE venue. */
async function permisosQueRecibeLaApp(): Promise<string[]> {
  const resultado = await loginWithEmail('heidi@amaena.com', 'la-contraseña')
  return resultado.staff.venues[0].permissions
}

beforeEach(() => {
  jest.spyOn(bcrypt, 'compare').mockImplementation(() => Promise.resolve(true) as any)
  jest.spyOn(jwtService, 'generateAccessToken').mockReturnValue('access')
  jest.spyOn(jwtService, 'generateRefreshToken').mockReturnValue('refresh')
  prismaMock.staff.update.mockResolvedValue({})
  prismaMock.venueRolePermission.findMany.mockResolvedValue([])
  prismaMock.venueRoleConfig.findMany.mockResolvedValue([])
})

describe('loginWithEmail — la lista de permisos que reciben iPad y Android', () => {
  it('manda los permisos del conjunto a la medida cuando la persona tiene uno', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(
      staffConVenue({ permissionSetId: CONJUNTO_A_LA_MEDIDA.id, permissionSet: CONJUNTO_A_LA_MEDIDA }),
    )

    const permisos = await permisosQueRecibeLaApp()

    // 🔴 La aserción tiene que morder donde el ROL y el CONJUNTO difieren, o el
    // test pasa con el bug intacto. `home:read` y `analytics:read` los trae el
    // WAITER de fábrica y el conjunto NO: si la app los recibe, el servidor
    // ignoró el conjunto y mandó los del rol.
    expect(permisos).not.toContain('analytics:read')
    expect(permisos).not.toContain('home:read')
    expect(permisos).toEqual(expect.arrayContaining(['orders:create', 'payments:create']))
  })

  it('respeta los permisos que el negocio le QUITÓ al rol', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(staffConVenue({}))
    prismaMock.venueRolePermission.findMany.mockResolvedValue([
      {
        venueId: VENUE_ID,
        role: 'WAITER',
        permissions: [],
        // 🔴 Van los DOS a propósito. `home:read` IMPLICA `analytics:read`
        // (PERMISSION_DEPENDENCIES), y la resta se vuelve a resolver después
        // — decisión del founder del 2026-08-18: lo que un permiso conservado
        // implica, regresa. Excluir sólo `analytics:read` no lo quita mientras
        // el rol conserve `home:read`, y este test lo deja fijado.
        deniedPermissions: ['home:read', 'analytics:read'],
      },
    ])

    const permisos = await permisosQueRecibeLaApp()

    expect(permisos).not.toContain('analytics:read')
  })

  it('pide el conjunto de permisos en la consulta, no sólo su id', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(staffConVenue({}))

    await permisosQueRecibeLaApp()

    const consulta = prismaMock.staff.findUnique.mock.calls.at(-1)![0]
    expect(consulta.select.venues.include).toMatchObject({ permissionSet: true })
  })

  it('pide las exclusiones del rol en la consulta', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(staffConVenue({}))

    await permisosQueRecibeLaApp()

    const consulta = prismaMock.venueRolePermission.findMany.mock.calls.at(-1)![0]
    expect(consulta.select).toMatchObject({ deniedPermissions: true })
  })

  it('sin conjunto ni exclusiones sigue mandando los permisos del rol', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(staffConVenue({}))

    const permisos = await permisosQueRecibeLaApp()

    // WAITER de fábrica: cobra y toma órdenes.
    expect(permisos).toEqual(expect.arrayContaining(['orders:create', 'payments:create', 'menu:read']))
  })
})
