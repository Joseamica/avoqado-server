/**
 * El limitador de "cambiar de usuario" cuenta por APARATO, no por IP.
 *
 * Por qué importa: todas las tablets de un local salen por la MISMA IP (NAT). Contando por IP,
 * una persona tecleando mal su PIN dejaría a las otras tablets del local sin poder cambiar de
 * usuario durante quince minutos — el mismo defecto que ya documentó el override cuando compartía
 * cubeta con el checador.
 */
import { __llaveDeRelevoParaPruebas as llaveDeAparato } from '../../../src/middlewares/pin-login-rate-limit.middleware'

const req = (headers: Record<string, string>, ip = '10.0.0.1', sid?: string) =>
  ({ get: (h: string) => headers[h.toLowerCase()], ip, socket: { remoteAddress: ip }, ...(sid ? { authContext: { sid } } : {}) }) as never

describe('limitador de cambio de usuario', () => {
  it('🔑 dos tablets de la MISMA red tienen cubetas distintas', () => {
    const a = llaveDeAparato(req({ 'x-device-id': 'tablet-caja' }))
    const b = llaveDeAparato(req({ 'x-device-id': 'tablet-barra' }))

    expect(a).not.toBe(b)
  })

  it('la misma tablet siempre cae en la misma cubeta', () => {
    expect(llaveDeAparato(req({ 'x-device-id': 'tablet-caja' }))).toBe(llaveDeAparato(req({ 'x-device-id': 'tablet-caja' }, '10.0.0.9')))
  })

  it('🔴 una app vieja sin el header cae a la IP — mejor contar de más que no contar', () => {
    const k = llaveDeAparato(req({}))

    expect(k).toContain('10.0.0.1')
  })

  it('un header absurdamente largo no se usa como llave', () => {
    const k = llaveDeAparato(req({ 'x-device-id': 'x'.repeat(500) }))

    expect(k).toContain('10.0.0.1')
  })

  /**
   * 🔴 [Auditoría de Codex, 2026-08-30, P1] La llave era `X-Device-Id`, o sea un dato que pone
   * el propio cliente. Rotándolo en cada intento se estrenaba cubeta y el tope de 10 no existía;
   * quedaba sólo el de venue (1,920 intentos al día), suficiente para recorrer un PIN de cuatro
   * dígitos y salir con permisos de OWNER. La llave es ahora el `sid`, que viaja firmado.
   */
  it('🔴 [P1] rotar el X-Device-Id NO estrena cubeta: manda la sesión, que va firmada', () => {
    const intento1 = llaveDeAparato(req({ 'x-device-id': 'inventado-1' }, '10.0.0.1', 'sess_abc'))
    const intento2 = llaveDeAparato(req({ 'x-device-id': 'inventado-2' }, '10.0.0.1', 'sess_abc'))
    const intento3 = llaveDeAparato(req({}, '10.0.0.1', 'sess_abc'))

    expect(intento1).toBe(intento2)
    expect(intento2).toBe(intento3)
  })

  it('dos sesiones distintas siguen teniendo cubetas distintas — estrenar una cuesta un login con contraseña', () => {
    expect(llaveDeAparato(req({}, '10.0.0.1', 'sess_ana'))).not.toBe(llaveDeAparato(req({}, '10.0.0.1', 'sess_luis')))
  })

  it('sin sesión se cae al aparato y luego a la IP — esas peticiones el servicio las rechaza igual', () => {
    expect(llaveDeAparato(req({ 'x-device-id': 'tablet-caja' }))).toContain('device:')
    expect(llaveDeAparato(req({}))).toContain('10.0.0.1')
  })
})
