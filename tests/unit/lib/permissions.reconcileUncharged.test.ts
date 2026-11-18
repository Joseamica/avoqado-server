/**
 * El permiso para declarar «ya revisé la terminal: no se cobró» (plan 18-sep, Task 1; F1, 17-nov).
 *
 * 🔴 Es un permiso PROPIO, y eso es el encargo, no un detalle: `payments:resolve-no-instrument` afirma otra cosa —que nadie
 * presentó tarjeta—. Éste afirma que alguien MIRÓ la pantalla del aparato y no hubo cobro. El 18-sep lo traía el cajero; desde
 * F1 (founder, 17-nov) lo firma siempre un gerente con su PIN, y el cajero ya no lo trae de fábrica.
 *
 * 1. NEW FEATURE TESTS — quién lo tiene y quién no
 * 2. REGRESSION TESTS — no toca el permiso de gerencia ni concede `tpv:update`
 */
import { StaffRole } from '@prisma/client'
import { hasPermission, INDIVIDUAL_PERMISSIONS_BY_RESOURCE } from '@/lib/permissions'

const RECONCILE_UNCHARGED = 'payments:reconcile-uncharged'

describe('payments:reconcile-uncharged', () => {
  // 🔴 F1 (founder, 17-nov: «el sistema solo! lo que menos tenga que decidir»): «no se cobró» lo firma SIEMPRE un gerente con
  // su PIN. El cajero ya no lo trae de fábrica; el DASHBOARD copia esta tabla al crear un perfil (`defaultPermissions.generated`).
  it('🔴 F1: el CAJERO ya NO lo tiene de fábrica', () => {
    expect(hasPermission(StaffRole.CASHIER, null, RECONCILE_UNCHARGED)).toBe(false)
  })

  it('lo tienen también MANAGER, ADMIN y OWNER', () => {
    for (const rol of [StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]) {
      expect(hasPermission(rol, null, RECONCILE_UNCHARGED)).toBe(true)
    }
  })

  it('NO se lo concede a CASHIER, WAITER ni VIEWER', () => {
    for (const rol of [StaffRole.CASHIER, StaffRole.WAITER, StaffRole.VIEWER]) {
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
    expect(hasPermission(StaffRole.MANAGER, null, RECONCILE_UNCHARGED, [RECONCILE_UNCHARGED])).toBe(false)
  })
})
