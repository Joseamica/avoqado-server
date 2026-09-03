/**
 * Qué denegaciones de permiso llegan a la bitácora que LEE EL DUEÑO.
 *
 * 🔴 El problema que resuelve, medido en producción (venue Testarudo Cafe,
 * 2026-09-01): de los 122 registros que la pantalla de bitácora mostraba,
 * los 122 eran `PERMISSION_DENIED`. Ninguno era un intento de intrusión —
 * eran GETs del PROPIO dashboard: cada vez que un empleado con rol de piso
 * abría el panel, la app pedía `/features`, `/settlement-calendar`,
 * `/ecommerce-merchants` y `/role-config`, su rol rebotaba las cuatro, y el
 * servidor apuntaba cuatro líneas. Un descuento, un borrado o un cambio de
 * precio quedaban enterrados bajo ese ruido.
 *
 * La regla: una LECTURA rebotada no cambió nada y no hay daño que auditar;
 * una ESCRITURA rebotada sí es alguien intentando hacer algo que no puede.
 *
 * Lo que NO se filtra, y es la mitad del diseño: el cruce de TENANT
 * (`venue-access`) se audita siempre, aunque sea un GET — alguien tocando el
 * negocio de otro es exactamente lo que un auditor busca.
 */
import { debeAuditarDenegacion } from '@/middlewares/checkPermission.middleware'

describe('debeAuditarDenegacion', () => {
  describe('falta de permiso dentro del propio venue', () => {
    it.each(['GET', 'HEAD', 'OPTIONS', 'get', 'head'])('NO audita la lectura rebotada (%s)', method => {
      expect(debeAuditarDenegacion({ method, entity: 'permission' })).toBe(false)
    })

    it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete'])('SÍ audita la escritura rebotada (%s)', method => {
      expect(debeAuditarDenegacion({ method, entity: 'permission' })).toBe(true)
    })
  })

  describe('acceso a un venue que no es tuyo', () => {
    // Un cruce de tenant es señal de seguridad aunque no escriba nada.
    it.each(['GET', 'HEAD', 'POST', 'DELETE'])('SÍ audita siempre (%s)', method => {
      expect(debeAuditarDenegacion({ method, entity: 'venue-access' })).toBe(true)
    })
  })

  describe('lo que no se reconoce', () => {
    // Ante la duda se AUDITA: perder un rastro es peor que una fila de más.
    it('audita una entidad desconocida', () => {
      expect(debeAuditarDenegacion({ method: 'GET', entity: 'algo-nuevo' })).toBe(true)
    })

    it('audita cuando no se sabe el método', () => {
      expect(debeAuditarDenegacion({ method: undefined, entity: 'permission' })).toBe(true)
      expect(debeAuditarDenegacion({ method: '', entity: 'permission' })).toBe(true)
    })
  })
})
