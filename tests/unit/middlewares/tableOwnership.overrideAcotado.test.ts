/**
 * `staffCanManageAllTables` con override PARAMETRIZADO — el comportamiento, no el cableado.
 *
 * El archivo hermano (`tableOwnership.cobroDeMesaAjena.test.ts`) prueba QUÉ lista monta
 * cada ruta. Éste prueba que la función efectivamente la HONRA: sin él, el middleware
 * podía ignorar el parámetro y seguir preguntando siempre por `tables:manage-all` — una
 * ablación que no tumbaba ningún test (por eso existe este archivo).
 *
 * Corre contra el catálogo REAL de permisos (`@/lib/permissions` sin mockear): sólo se
 * mockea Prisma.
 */

import { StaffRole } from '@prisma/client'
import {
  DEFAULT_OWNERSHIP_OVERRIDES,
  PAYMENT_OWNERSHIP_OVERRIDES,
  staffCanManageAllTables,
} from '@/middlewares/checkTableOwnership.middleware'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueSettings: { findUnique: jest.fn() },
    order: { findFirst: jest.fn(), findMany: jest.fn() },
    staffVenue: { findFirst: jest.fn(), findUnique: jest.fn() },
    venue: { findUnique: jest.fn() },
    staffOrganization: { findUnique: jest.fn() },
    venueRolePermission: { findUnique: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const VENUE = 'venue-1'
const USER = 'staff-cajero'

/**
 * El rol se lee de `StaffVenue`, NO del token.
 *
 * Este comentario decía antes: "el rol llega por el token (mismo venue), así que no hace
 * falta más DB que el probe de SUPERADMIN" — y eso describía exactamente el hueco de
 * seguridad que se cerró el 2026-08-18: `resolveUserRoleForVenue` devolvía el rol del JWT
 * sin mirar la base, así que ni aplicaba el `PermissionSet` del empleado ni se enteraba de
 * que lo habían dado de baja. Ahora consulta, y el mock refleja al mismo empleado.
 */
const puedeSaltarse = (role: StaffRole, overrides: readonly string[]) => {
  ;(prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue({
    role,
    active: true,
    permissionSetId: null,
    permissionSet: null,
  })
  return staffCanManageAllTables(USER, VENUE, VENUE, role, overrides)
}

describe('El override que se le pasa es el que se evalúa', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // No es SUPERADMIN y el venue no tiene permisos personalizados.
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(null)
    ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue(null)
  })

  it('🔴 CASHIER con el override DEFAULT no se salta la propiedad de mesa', async () => {
    await expect(puedeSaltarse(StaffRole.CASHIER, DEFAULT_OWNERSHIP_OVERRIDES)).resolves.toBe(false)
  })

  it('CASHIER con el override de COBRO sí — es el arreglo del caso #4', async () => {
    await expect(puedeSaltarse(StaffRole.CASHIER, PAYMENT_OWNERSHIP_OVERRIDES)).resolves.toBe(true)
  })

  it('WAITER no se salta la propiedad ni siquiera con el override de cobro', async () => {
    await expect(puedeSaltarse(StaffRole.WAITER, PAYMENT_OWNERSHIP_OVERRIDES)).resolves.toBe(false)
  })

  it.each([StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER])('%s se salta con cualquiera de los dos', async role => {
    await expect(puedeSaltarse(role, DEFAULT_OWNERSHIP_OVERRIDES)).resolves.toBe(true)
    await expect(puedeSaltarse(role, PAYMENT_OWNERSHIP_OVERRIDES)).resolves.toBe(true)
  })

  it('sin pasar override, el default sigue siendo tables:manage-all (compatibilidad)', async () => {
    // Se declara el rol en la base para CADA caso: `jest.clearAllMocks()` limpia las
    // llamadas pero NO las implementaciones, así que sin esto el segundo caso heredaría
    // el `mockResolvedValue` del primero y el test mediría el rol equivocado.
    const conRol = (role: StaffRole) =>
      (prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue({ role, active: true, permissionSetId: null, permissionSet: null })

    conRol(StaffRole.CASHIER)
    await expect(staffCanManageAllTables(USER, VENUE, VENUE, StaffRole.CASHIER)).resolves.toBe(false)
    conRol(StaffRole.MANAGER)
    await expect(staffCanManageAllTables(USER, VENUE, VENUE, StaffRole.MANAGER)).resolves.toBe(true)
  })

  it('un rol personalizado al que se le dio tables:pay-any liquida cheques ajenos', async () => {
    // El editor de roles guarda la lista EXPANDIDA sin wildcard.
    ;(prisma.venueRolePermission.findUnique as jest.Mock).mockResolvedValue({
      permissions: ['payments:create', 'payments:read', 'orders:read', 'tables:read', 'tables:pay-any'],
    })
    await expect(puedeSaltarse(StaffRole.WAITER, PAYMENT_OWNERSHIP_OVERRIDES)).resolves.toBe(true)
    await expect(puedeSaltarse(StaffRole.WAITER, DEFAULT_OWNERSHIP_OVERRIDES)).resolves.toBe(false)
  })

  it('SUPERADMIN pasa siempre, sin mirar la lista', async () => {
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue({ id: 'sv-1' })
    await expect(puedeSaltarse(StaffRole.VIEWER, DEFAULT_OWNERSHIP_OVERRIDES)).resolves.toBe(true)
  })
})

describe('La otra rama: PermissionSet (lista efectiva que REEMPLAZA al rol)', () => {
  // Sin token de este venue, el rol y su PermissionSet salen de StaffVenue. Esta rama
  // no pasa por `hasPermission` sino por `evaluatePermissionList`, y también tiene que
  // honrar el override recibido.
  const conPermissionSet = (permissions: string[]) =>
    (prisma.staffVenue.findUnique as jest.Mock).mockResolvedValue({
      role: StaffRole.CASHIER,
      active: true,
      permissionSetId: 'ps-1',
      permissionSet: { permissions },
    })

  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.staffVenue.findFirst as jest.Mock).mockResolvedValue(null)
  })

  it('con tables:pay-any en su lista efectiva, liquida el cheque ajeno', async () => {
    conPermissionSet(['payments:create', 'tables:read', 'tables:pay-any'])
    await expect(staffCanManageAllTables(USER, VENUE, undefined, undefined, PAYMENT_OWNERSHIP_OVERRIDES)).resolves.toBe(true)
  })

  it('🔴 esa misma lista NO se salta el candado en las rutas que EDITAN la mesa', async () => {
    conPermissionSet(['payments:create', 'tables:read', 'tables:pay-any'])
    await expect(staffCanManageAllTables(USER, VENUE, undefined, undefined, DEFAULT_OWNERSHIP_OVERRIDES)).resolves.toBe(false)
  })

  it('sin ninguno de los dos permisos, no se salta nada', async () => {
    conPermissionSet(['payments:create', 'tables:read'])
    await expect(staffCanManageAllTables(USER, VENUE, undefined, undefined, PAYMENT_OWNERSHIP_OVERRIDES)).resolves.toBe(false)
  })
})
