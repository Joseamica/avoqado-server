/**
 * Qué le hace el envoltorio de jobs al contrato de errores — medido en un proceso Node REAL.
 *
 * 🔴 Esta suite existe porque yo afirmé que el contrato quedaba «idéntico» y era FALSO, y lo
 * demostró la auditoría de Codex del 22-sep. Para saber cuándo termina un tick hay que encadenar
 * un `.finally()` a su promesa, y eso crea una SEGUNDA promesa. Node cuenta los rechazos sin
 * manejar **por promesa**: manejar una rama no maneja la otra. Así que la equivalencia se
 * sostiene sólo mientras el tick devuelva una promesa NUEVA y no compartida.
 *
 * El caso que diverge no es teórico: si un tick maneja su propia promesa y además la devuelve,
 * el envoltorio produce un `unhandledRejection` que antes no existía — y en este servidor ese
 * evento arranca el apagado (`server.ts`). Medido, no argumentado. Hoy **ningún callback del
 * repo tiene esa forma** (los que devuelven promesa la crean con funciones `async`), pero es un
 * camino que el helper permite, así que queda FIJADO aquí en vez de vivir en un comentario.
 *
 * Tiene que ser un proceso aparte: `unhandledRejection` es del runtime y Jest instala sus
 * propios manejadores.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const guion = join(__dirname, '../../fixtures/jobs/contratoDeErrores.ts')

const eventosDe = (escenario: string): number => {
  const salida = execFileSync('npx', ['tsx', guion, escenario], {
    cwd: join(__dirname, '../../..'),
    encoding: 'utf8',
    timeout: 60_000,
  })
  const linea = salida.trim().split('\n').at(-1) as string
  return JSON.parse(linea).eventos as number
}

describe('contrato de `unhandledRejection` del envoltorio de jobs', () => {
  jest.setTimeout(120_000)

  it('promesa NUEVA descartada: un evento, igual que sin envoltorio', () => {
    expect(eventosDe('nueva-descartada')).toBe(1)
  })

  it('promesa NUEVA manejada por el llamador: ningún evento', () => {
    expect(eventosDe('nueva-manejada')).toBe(0)
  })

  it('🔴 promesa COMPARTIDA y ya manejada: el envoltorio AÑADE un evento (límite conocido)', () => {
    // La línea base —la misma forma sin envoltorio— no emite ninguno.
    expect(eventosDe('base-compartida-ya-manejada')).toBe(0)
    // Con envoltorio sí. Queda fijado: si algún día se resuelve, esta prueba lo dirá.
    expect(eventosDe('compartida-ya-manejada')).toBe(1)
  })

  it('🔴 la MISMA promesa en dos ticks: dos eventos, no uno', () => {
    expect(eventosDe('compartida-dos-ticks')).toBe(2)
  })
})
