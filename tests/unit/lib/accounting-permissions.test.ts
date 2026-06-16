/**
 * Locks the Contabilidad permission matrix (source of truth = src/lib/permissions.ts).
 * This is the permanent "role-bajo denegado" guard: if someone widens these defaults by
 * accident, CI fails. Verified live via /full-testing (superadmin) + here for every role.
 *
 *   accounting:read     → ver Resumen / Bancos / Catálogo
 *   accounting:reconcile→ confirmar conciliación bancaria
 *   accounting:manage   → sembrar / editar el catálogo de cuentas
 */
import { StaffRole } from '@prisma/client'

import { hasPermission } from '../../../src/lib/permissions'

const r = (role: string) => role as StaffRole

describe('Contabilidad — matriz de permisos por rol', () => {
  it.each(['VIEWER', 'HOST', 'WAITER', 'KITCHEN', 'CASHIER'])('%s NO tiene NINGÚN permiso de contabilidad', role => {
    expect(hasPermission(r(role), [], 'accounting:read')).toBe(false)
    expect(hasPermission(r(role), [], 'accounting:reconcile')).toBe(false)
    expect(hasPermission(r(role), [], 'accounting:manage')).toBe(false)
  })

  it('MANAGER: solo lectura (ve los tableros, pero NO concilia ni edita el catálogo)', () => {
    expect(hasPermission(r('MANAGER'), [], 'accounting:read')).toBe(true)
    expect(hasPermission(r('MANAGER'), [], 'accounting:reconcile')).toBe(false)
    expect(hasPermission(r('MANAGER'), [], 'accounting:manage')).toBe(false)
  })

  it.each(['ADMIN', 'OWNER'])('%s: acceso completo (read + reconcile + manage)', role => {
    expect(hasPermission(r(role), [], 'accounting:read')).toBe(true)
    expect(hasPermission(r(role), [], 'accounting:reconcile')).toBe(true)
    expect(hasPermission(r(role), [], 'accounting:manage')).toBe(true)
  })

  it('SUPERADMIN: acceso completo (vía wildcard)', () => {
    expect(hasPermission(r('SUPERADMIN'), [], 'accounting:manage')).toBe(true)
  })
})
