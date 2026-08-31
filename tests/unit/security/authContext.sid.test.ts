/**
 * El `sid` tiene que llegar al `authContext`.
 *
 * Sin esto, un controlador no sabe en qué sesión está operando. Lo destapó construir el cambio de
 * usuario por PIN: para RELEVAR a alguien hay que cerrar SU sesión, y el `sid` de esa sesión sólo
 * vivía dentro del middleware — se comprobaba que estuviera viva y se tiraba.
 *
 * 🔴 Aditivo y opcional a propósito: un token legacy (sin `sid`) sigue construyendo su contexto
 * igual que siempre. Si esto fuera obligatorio, expulsaría de golpe a todos los aparatos que aún
 * no migraron.
 */
import { buildAuthContextFromPayload, type AvoqadoJwtPayload } from '../../../src/security'
import { StaffRole } from '@prisma/client'

const base = (over: Record<string, unknown> = {}): AvoqadoJwtPayload =>
  ({ sub: 'staff_1', orgId: 'org_1', venueId: 'venue_1', role: StaffRole.WAITER, ...over }) as AvoqadoJwtPayload

describe('buildAuthContextFromPayload — sid', () => {
  it('🔑 propaga el sid del token al contexto: sin él, nadie puede cerrar la sesión saliente', () => {
    const ctx = buildAuthContextFromPayload(base({ sid: 'sess_abc' }))

    expect(ctx.sid).toBe('sess_abc')
  })

  it('🔴 un token LEGACY sin sid sigue construyendo su contexto igual — no se expulsa a nadie', () => {
    const ctx = buildAuthContextFromPayload(base())

    expect(ctx.sid).toBeUndefined()
    expect(ctx.userId).toBe('staff_1')
    expect(ctx.venueId).toBe('venue_1')
    expect(ctx.role).toBe(StaffRole.WAITER)
  })

  it('no se inventa un sid cuando el token trae otras cosas (impersonación)', () => {
    const ctx = buildAuthContextFromPayload(
      base({ act: { sub: 'super_1', role: StaffRole.SUPERADMIN, mode: 'user', expiresAt: new Date().toISOString() } }),
    )

    expect(ctx.sid).toBeUndefined()
    expect(ctx.isImpersonating).toBe(true)
  })
})
