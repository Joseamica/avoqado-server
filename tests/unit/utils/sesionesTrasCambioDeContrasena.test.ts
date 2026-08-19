/**
 * Cambiar la contrasena tiene que echar a las sesiones que ya estaban abiertas.
 *
 * El caso que importa no es el prospecto nuevo — es el dueno que corre a un
 * gerente: le cambia la contrasena creyendo que lo dejo fuera, y hasta ahora el
 * gerente seguia dentro desde su celular hasta 90 dias, viendo ventas y cortes.
 *
 * No hay tabla de sesiones ni Redis: los tokens son JWT autonomos. La forma de
 * matarlos sin inventar infraestructura es comparar CUANDO se emitio el token
 * (`iat`) contra CUANDO se cambio la contrasena (`lastPasswordReset`).
 */
import { tokenEmitidoAntesDelCambio } from '../../../src/utils/passwordChangeGuard'

const SEG = 1000

describe('tokenEmitidoAntesDelCambio', () => {
  const cambio = new Date('2026-08-18T12:00:00Z')
  const iatDe = (d: Date) => Math.floor(d.getTime() / 1000)

  it('echa al token emitido ANTES del cambio de contrasena', () => {
    const viejo = iatDe(new Date(cambio.getTime() - 60 * 60 * SEG)) // una hora antes
    expect(tokenEmitidoAntesDelCambio(viejo, cambio)).toBe(true)
  })

  it('deja pasar al token emitido DESPUES del cambio', () => {
    const nuevo = iatDe(new Date(cambio.getTime() + 10 * SEG))
    expect(tokenEmitidoAntesDelCambio(nuevo, cambio)).toBe(false)
  })

  it('no se echa a si mismo: el token que nace junto con el cambio sobrevive', () => {
    // Quien acaba de cambiar su contrasena e inicia sesion en el mismo segundo
    // no debe quedar fuera por un redondeo.
    expect(tokenEmitidoAntesDelCambio(iatDe(cambio), cambio)).toBe(false)
  })

  it('tolera un reloj desfasado unos segundos entre procesos', () => {
    // 3 segundos ANTES del cambio: dentro del margen, sobrevive.
    const casiIgual = iatDe(new Date(cambio.getTime() - 3 * SEG))
    expect(tokenEmitidoAntesDelCambio(casiIgual, cambio)).toBe(false)
    // 30 segundos antes: eso ya no es desfase de reloj, es una sesion vieja.
    const claramenteAntes = iatDe(new Date(cambio.getTime() - 30 * SEG))
    expect(tokenEmitidoAntesDelCambio(claramenteAntes, cambio)).toBe(true)
  })

  it('sin fecha de cambio, nadie se queda fuera', () => {
    // Cuentas que jamas han cambiado su contrasena: la inmensa mayoria hoy.
    // Este es el caso que NO se puede romper — echaria a todos los clientes.
    expect(tokenEmitidoAntesDelCambio(iatDe(cambio), null)).toBe(false)
    expect(tokenEmitidoAntesDelCambio(iatDe(cambio), undefined)).toBe(false)
  })

  it('sin iat en el token, no se echa a nadie', () => {
    // Un token sin `iat` no se puede juzgar. Preferimos dejarlo pasar y que lo
    // resuelvan las otras validaciones, antes que sacar a alguien por una duda.
    expect(tokenEmitidoAntesDelCambio(undefined, cambio)).toBe(false)
    expect(tokenEmitidoAntesDelCambio(NaN, cambio)).toBe(false)
  })
})
