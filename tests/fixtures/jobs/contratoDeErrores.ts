/**
 * Mide, en un proceso Node REAL, cuántos `unhandledRejection` emite el envoltorio de jobs.
 *
 * Tiene que ser un proceso aparte: `unhandledRejection` es un evento del runtime y depende de
 * cuándo Node decide que una promesa quedó sin manejador. Un mock no puede acreditarlo, y Jest
 * instala sus propios manejadores.
 *
 * Se invoca con el nombre del escenario y escribe una línea JSON.
 */
import { __conRegistroDeJobParaPruebas as conRegistro } from '../../../src/observability/jobContext'

const eventos: string[] = []
process.on('unhandledRejection', r => eventos.push(String((r as Error)?.message ?? r)))

const fallo = () => new Error('el tick falló')
const escenario = process.argv[2]

// Cada rama replica cómo un cron REAL descarta o maneja lo que el tick devuelve.
if (escenario === 'nueva-descartada') {
  void conRegistro('x', () => Promise.reject(fallo()))
} else if (escenario === 'nueva-manejada') {
  conRegistro('x', () => Promise.reject(fallo())).catch(() => {})
} else if (escenario === 'compartida-ya-manejada') {
  // El tick maneja SU promesa y además la devuelve. Aquí el envoltorio NO es transparente:
  // encadenar crea una segunda promesa, y manejar una rama no maneja la otra.
  const p = Promise.reject(fallo())
  p.catch(() => {})
  void conRegistro('x', () => p)
} else if (escenario === 'compartida-dos-ticks') {
  const p = Promise.reject(fallo())
  void conRegistro('x', () => p)
  void conRegistro('x', () => p)
} else if (escenario === 'base-compartida-ya-manejada') {
  // La MISMA forma, sin envoltorio: la línea base contra la que se compara.
  const p = Promise.reject(fallo())
  p.catch(() => {})
  void p
}

setTimeout(() => {
  process.stdout.write(JSON.stringify({ escenario, eventos: eventos.length }) + '\n')
  process.exit(0)
}, 80)
