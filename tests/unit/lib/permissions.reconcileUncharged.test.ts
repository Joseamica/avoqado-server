/**
 * El permiso del CAJERO para declarar «ya revisé la terminal: no se cobró» (plan 18-sep, Task 1).
 *
 * 🔴 Es un permiso PROPIO, y eso es el encargo, no un detalle: `payments:resolve-no-instrument` vive en
 * gerencia (MANAGER+) y afirma otra cosa —que nadie presentó tarjeta—. Éste afirma que el cajero MIRÓ la
 * pantalla del aparato y no hubo cobro, y lo tiene el cajero porque en un mostrador a las 10 de la mañana
 * puede no haber gerente (decisión del founder, 18-sep, tras 26 minutos parados en Testarudo).
 *
 * 1. NEW FEATURE TESTS — quién lo tiene y quién no
 * 2. REGRESSION TESTS — no toca el permiso de gerencia ni concede `tpv:update`
 */
import { StaffRole } from '@prisma/client'
import { hasPermission, INDIVIDUAL_PERMISSIONS_BY_RESOURCE } from '@/lib/permissions'

const RECONCILE_UNCHARGED = 'payments:reconcile-uncharged'

describe('payments:reconcile-uncharged', () => {
  it('lo tiene el CAJERO: es quien está frente a la terminal cuando pasa', () => {
    expect(hasPermission(StaffRole.CASHIER, null, RECONCILE_UNCHARGED)).toBe(true)
  })

  it('lo tienen también MANAGER, ADMIN y OWNER', () => {
    for (const rol of [StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]) {
      expect(hasPermission(rol, null, RECONCILE_UNCHARGED)).toBe(true)
    }
  })

  it('NO se lo concede a WAITER ni a VIEWER', () => {
    for (const rol of [StaffRole.WAITER, StaffRole.VIEWER]) {
      expect(hasPermission(rol, null, RECONCILE_UNCHARGED)).toBe(false)
    }
  })

  it('aparece en el catálogo individual, para poder asignarse en un rol personalizado', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE.payments).toContain(RECONCILE_UNCHARGED)
  })

  // ---- REGRESIÓN ----

  it('🔴 NO toca el permiso de gerencia: el cajero sigue SIN poder declarar «no se presentó tarjeta»', () => {
    expect(hasPermission(StaffRole.CASHIER, null, 'payments:resolve-no-instrument')).toBe(false)
  })

  it('🔴 NO le concede `tpv:update` al cajero: liberar terminales a secas sigue siendo de gerencia', () => {
    expect(hasPermission(StaffRole.CASHIER, null, 'tpv:update')).toBe(false)
  })

  it('🔴 un venue que lo NIEGA explícitamente gana sobre el default del rol', () => {
    expect(hasPermission(StaffRole.CASHIER, null, RECONCILE_UNCHARGED, [RECONCILE_UNCHARGED])).toBe(false)
  })
})
