/**
 * Negarle `sale-verifications:approve` a MANAGER (los supervisores) en las tiendas de PlayTelecom (spec 2026-10-30 §5.8, plan A10).
 * El plan es puro; el resolver de permisos es el real, para que «negado» quiera decir que de verdad ya no aprueba.
 */
import { StaffRole } from '@prisma/client'

import { evaluatePermissionList, hasPermission } from '@/lib/permissions'
import { APPROVE, managersWithApproveSet, planDenyApprove } from '../../../scripts/negar-aprobar-a-supervisores'

const REVIEW = 'sale-verifications:review'

describe('planDenyApprove', () => {
  const plan = planDenyApprove(
    ['t-sin-fila', 't-con-negados', 't-ya-negado', 't-solo-admin'],
    [
      { venueId: 't-con-negados', role: 'MANAGER', deniedPermissions: ['orders:create'] },
      { venueId: 't-ya-negado', role: 'MANAGER', deniedPermissions: [APPROVE, 'menu:update'] },
      { venueId: 't-solo-admin', role: 'ADMIN', deniedPermissions: [] },
    ],
  )

  it('agrega approve a MANAGER en cada tienda sin borrar lo que ya tenía negado', () => {
    expect(plan.toUpdate).toEqual([{ venueId: 't-con-negados', deniedPermissions: ['orders:create', APPROVE] }])
  })

  it('la tienda sin fila de MANAGER (aunque tenga la de otro rol) se crea con approve negado', () => {
    expect(plan.toCreate).toEqual(['t-sin-fila', 't-solo-admin'])
  })

  it('la tienda donde ya está negado no se toca (se puede repetir)', () => {
    expect(plan.alreadyDenied).toEqual(['t-ya-negado'])
    const otraVez = planDenyApprove(['t-ya-negado'], [{ venueId: 't-ya-negado', role: 'MANAGER', deniedPermissions: [APPROVE] }])
    expect(otraVez).toEqual({ toCreate: [], toUpdate: [], alreadyDenied: ['t-ya-negado'] })
  })

  it('con el resolver real, el MANAGER ya no aprueba pero sigue viendo las ventas', () => {
    for (const denied of [[APPROVE], plan.toUpdate[0].deniedPermissions]) {
      expect(hasPermission(StaffRole.MANAGER, [], APPROVE, denied)).toBe(false)
      expect(hasPermission(StaffRole.MANAGER, [], REVIEW, denied)).toBe(true)
    }
  })

  // Regresión: sin la negación, MANAGER aprueba como hoy (A4 le dio approve por default).
  it('sin negación MANAGER conserva approve', () => {
    expect(hasPermission(StaffRole.MANAGER, [], APPROVE, [])).toBe(true)
  })
})

describe('managersWithApproveSet', () => {
  const fila = (role: string, permissions: string[] | null) => ({ role, permissionSet: permissions ? { permissions } : null })

  it('reporta al MANAGER cuyo conjunto propio concede approve o review, también por comodín', () => {
    const filas = [
      fila('MANAGER', [REVIEW]),
      fila('MANAGER', [APPROVE]),
      fila('MANAGER', ['sale-verifications:*']),
      fila('MANAGER', ['*:*']),
      fila('MANAGER', ['orders:read']),
      fila('MANAGER', null),
      fila('WAITER', [REVIEW]),
    ]
    expect(managersWithApproveSet(filas, evaluatePermissionList)).toEqual(filas.slice(0, 4))
  })
})
