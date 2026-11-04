// Antes de cada página de un exporte: si hay cobros en vuelo o el hilo va lento, el exporte cede.
import { performance } from 'node:perf_hooks'
import { getInFlightRequests } from '@/middlewares/eventLoopGuard.middleware'

const ESPERA_MS = 250
const RETRASO_MAX_MS = 50
const TOPE_MS = 30_000

// ponytail: lista conservadora por URL (también cuenta listados del dashboard de cobros/órdenes);
// sobra-ceder es barato, faltar-ceder es lo caro.
const RUTAS_DE_COBRO = [/\/terminal-payment/, /\/api\/v1\/tpv\//, /\/payments/, /\/orders/, /\/refund/]

export function esRutaDeCobro(url: string): boolean {
  return RUTAS_DE_COBRO.some(r => r.test(url))
}

export type Presion = { cobrosEnVuelo: number; retrasoMs: number }

export async function medirPresion(): Promise<Presion> {
  const t0 = performance.now()
  await new Promise<void>(r => setImmediate(r))
  return {
    cobrosEnVuelo: getInFlightRequests().filter(r => esRutaDeCobro(r.url)).length,
    retrasoMs: performance.now() - t0,
  }
}

const dormirReal = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function esperarTurno(
  deps: {
    medir?: () => Promise<Presion>
    dormir?: (ms: number) => Promise<void>
    ahora?: () => number
    alEsperar?: () => Promise<void> | void
  } = {},
): Promise<{ esperoMs: number; forzado: boolean }> {
  const medir = deps.medir ?? medirPresion
  const dormir = deps.dormir ?? dormirReal
  const ahora = deps.ahora ?? Date.now
  const inicio = ahora()
  let avisado = false
  for (;;) {
    const p = await medir()
    if (p.cobrosEnVuelo === 0 && p.retrasoMs <= RETRASO_MAX_MS) return { esperoMs: ahora() - inicio, forzado: false }
    if (ahora() - inicio >= TOPE_MS) return { esperoMs: ahora() - inicio, forzado: true }
    if (!avisado) {
      avisado = true
      try {
        await deps.alEsperar?.()
      } catch {
        // avisar es cosmético: nunca detiene el exporte
      }
    }
    await dormir(ESPERA_MS)
  }
}
