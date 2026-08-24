import { PUBLIC_BOOKING_PUBLIC_KEYS, toPublicBookingPayload } from '@/services/public/publicBookingPayload'

/**
 * `GET /api/v1/public/venues/:slug/info` es **anónimo**: lo consume el widget incrustado en el
 * sitio de cualquier negocio, sin token. El controlador copiaba `settings.publicBooking` entero,
 * así que TODO campo nuevo de esa config quedaba publicado en internet por el simple hecho de
 * existir.
 *
 * Así se filtró `customerApprovalNotificationRoles` —qué roles del staff reciben el aviso de
 * aprobación— al agregarlo en Fase 1. Verificado con una petición anónima real el 2026-08-24:
 *
 *   curl .../public/venues/avoqado-full/info
 *   → "customerApprovalNotificationRoles": ["OWNER","ADMIN"]
 *
 * Estos tests fijan una lista BLANCA. El que de verdad importa es el tercero: un campo inventado
 * no puede salir, así que quien amplíe la config tiene que decidir a propósito si es público, en
 * vez de publicarlo sin enterarse.
 */
describe('toPublicBookingPayload — lista blanca del payload anónimo', () => {
  const CONFIG_COMPLETA = {
    enabled: true,
    requirePhone: true,
    requireEmail: false,
    requireAccount: true,
    requireCustomerApproval: true,
    customerApprovalNotificationRoles: ['OWNER', 'ADMIN'],
    showStaffPicker: false,
  }

  it('🔴 NO expone customerApprovalNotificationRoles (config interna del staff)', () => {
    expect(toPublicBookingPayload(CONFIG_COMPLETA)).not.toHaveProperty('customerApprovalNotificationRoles')
  })

  it('sigue entregando lo que los clientes SÍ necesitan', () => {
    expect(toPublicBookingPayload(CONFIG_COMPLETA)).toEqual({
      enabled: true,
      requirePhone: true,
      requireEmail: false,
      requireAccount: true,
      requireCustomerApproval: true,
      showStaffPicker: false,
    })
  })

  it('🔴 un campo NUEVO no se publica solo: la lista blanca lo deja fuera', () => {
    const conCampoFuturo = { ...CONFIG_COMPLETA, algoInternoQueAlguienAgregara: 'secreto' }
    const payload = toPublicBookingPayload(conCampoFuturo)
    expect(Object.keys(payload).sort()).toEqual([...PUBLIC_BOOKING_PUBLIC_KEYS].sort())
    expect(JSON.stringify(payload)).not.toContain('secreto')
  })

  it('una config incompleta no inventa valores ni truena', () => {
    // Venues viejos pueden no traer todas las llaves; el widget ya tiene sus propios defaults.
    const payload = toPublicBookingPayload({ enabled: true })
    expect(payload.enabled).toBe(true)
    expect(payload).not.toHaveProperty('customerApprovalNotificationRoles')
  })
})
