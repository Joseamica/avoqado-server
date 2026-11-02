/**
 * 0.e — las rutas del kiosco (lista y check-in) exigen `self-service:check-in` con el `checkPermission` de siempre
 * (atajo SUPERADMIN, PIN de gerente, Conjuntos de Permisos y roles a la medida, igual que toda ruta). La identidad
 * «Autoservicio» (Fase 1) sólo tendrá ese permiso; `reservations:update` lo IMPLICA (PERMISSION_DEPENDENCIES), así
 * que nadie que hoy hace check-in en el kiosco con `reservations:update` pierde acceso.
 *
 * Introspección ESTÁTICA del router real de Express (mismo patrón que
 * `mobile.creditPacks.routes.permissions.test.ts`): sin supertest y sin DB.
 */

import { StaffRole } from '@prisma/client'
import mobileRouter from '@/routes/mobile.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { evaluatePermissionList, hasPermission } from '@/lib/permissions'

function inspectRoute(router: any, method: string, path: string) {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const routeLayers: any[] = layer.route.stack ?? []
    if (!routeLayers.some(rl => rl.method === method)) continue

    const handlers = routeLayers.map(rl => rl.handle)
    const permissionLayer = routeLayers.find(rl => typeof (rl.handle as any)?.requiredPermission === 'string')
    return {
      hasAuthenticateToken: handlers.includes(authenticateTokenMiddleware),
      requiredPermission: (permissionLayer?.handle as any)?.requiredPermission as string | undefined,
    }
  }
  return undefined
}

const KIOSK = 'self-service:check-in'

describe('mobile.routes — kiosco: checkPermission(self-service:check-in)', () => {
  it.each([
    ['get', '/venues/:venueId/kiosk/roster'],
    ['post', '/venues/:venueId/kiosk/reservations/:reservationId/check-in'],
    ['post', '/venues/:venueId/kiosk/check-in'],
  ])('%s %s → autenticada y exige self-service:check-in (string EXACTO)', (method, path) => {
    const r = inspectRoute(mobileRouter, method, path)
    expect(r).toBeDefined()
    expect(r!.hasAuthenticateToken).toBe(true)
    expect(r!.requiredPermission).toBe(KIOSK)
  })
})

describe('self-service:check-in — quién lo tiene', () => {
  it('viene de fábrica en MANAGER, ADMIN y OWNER', () => {
    for (const role of [StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]) {
      expect(hasPermission(role, null, KIOSK)).toBe(true)
    }
  })

  it('HOST lo tiene POR IMPLICACIÓN: sus defaults traen reservations:update (hoy ya hace check-in)', () => {
    expect(hasPermission(StaffRole.HOST, null, 'reservations:update')).toBe(true)
    expect(hasPermission(StaffRole.HOST, null, KIOSK)).toBe(true)
  })

  it('WAITER y CASHIER de fábrica NO lo tienen: tampoco traen reservations:update', () => {
    for (const role of [StaffRole.WAITER, StaffRole.CASHIER]) {
      expect(hasPermission(role, null, 'reservations:update')).toBe(false)
      expect(hasPermission(role, null, KIOSK)).toBe(false)
    }
  })

  it('un rol a la medida (VenueRolePermission de WAITER) con sólo reservations:update lo pasa', () => {
    expect(hasPermission(StaffRole.WAITER, ['reservations:update'], KIOSK)).toBe(true)
  })

  it('un Conjunto de Permisos con sólo reservations:update lo pasa', () => {
    expect(evaluatePermissionList(['reservations:update'], KIOSK)).toBe(true)
  })

  it('un Conjunto guardado desde el preset ADMIN (con `reservations:*` crudo) lo pasa', () => {
    expect(evaluatePermissionList(['reservations:*'], KIOSK)).toBe(true)
  })

  it('un rol a la medida con `reservations:*` crudo lo pasa', () => {
    expect(hasPermission(StaffRole.WAITER, ['reservations:*'], KIOSK)).toBe(true)
  })

  // Codex, código r1 #5: `*:update` es un comodín válido y antes abría la ruta (pedía `reservations:update`).
  it('un Conjunto o un rol a la medida con `*:update` lo pasa (como antes)', () => {
    expect(evaluatePermissionList(['*:update'], KIOSK)).toBe(true)
    expect(hasPermission(StaffRole.WAITER, ['*:update'], KIOSK)).toBe(true)
  })

  // Codex, código r2 #4: lo implicado se va con lo que lo implicaba.
  it('quitar `reservations:update` (o el comodín que lo daba) quita también el check-in implícito', () => {
    expect(hasPermission(StaffRole.VIEWER, ['*:update'], KIOSK, ['*:update'])).toBe(false)
    expect(hasPermission(StaffRole.HOST, null, KIOSK, ['reservations:update'])).toBe(false)
  })

  it('pero si el negocio lo escribió o el rol lo trae escrito, se queda', () => {
    expect(hasPermission(StaffRole.HOST, ['self-service:check-in'], KIOSK, ['reservations:update'])).toBe(true)
    expect(hasPermission(StaffRole.MANAGER, null, KIOSK, ['reservations:update'])).toBe(true)
  })

  it('un comodín que no concede editar reservas no lo regala', () => {
    expect(evaluatePermissionList(['*:read'], KIOSK)).toBe(false)
    expect(evaluatePermissionList(['orders:*'], KIOSK)).toBe(false)
  })

  it('es estrecho: un Conjunto con sólo self-service:check-in no abre la agenda ni deja editar reservas', () => {
    expect(evaluatePermissionList([KIOSK], KIOSK)).toBe(true)
    expect(evaluatePermissionList([KIOSK], 'reservations:read')).toBe(false)
    expect(evaluatePermissionList([KIOSK], 'reservations:update')).toBe(false)
  })
})
