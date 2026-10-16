/**
 * 🧪 EXPERIMENTO OTel vs correlationId (rama exp/otel-trazas — NO va a develop).
 * Plan: docs/investigaciones/otel-trazas/plan-medicion.md del workspace.
 *
 * Los saltos que HOY pierden la llave del cobro (plan, corrección 5): server → terminal por socket, terminal → server
 * por socket, fila del efecto encolado → job. Los brazos A+ y B hacen el MISMO cambio en los MISMOS puntos; la única
 * diferencia es la llave: `correlationId` (A+) o `traceparent` W3C (B, con el SDK de OTel precargado).
 *
 * 🔴 Con `EXP_PROPAGACION` vacía (brazo A y producción) TODO aquí es un no-op: ningún campo nuevo, ningún contexto
 * nuevo, ningún log nuevo. Este archivo no importa nada de OpenTelemetry: en el brazo B el SDK vive en la precarga
 * (`scripts/exp-otel/otel/preload.cjs`), que publica un puente mínimo en `globalThis.__expOtel`.
 */
import { getContext, runWithContext } from './executionContext'

type Modo = 'correlationId' | 'traceparent' | undefined

interface PuenteOtel {
  inyectar(): string | undefined
  conPadre<T>(traceparent: string, nombre: string, fn: () => T): T
  conEnlace<T>(traceparent: string | undefined, nombre: string, atributos: Record<string, string>, fn: () => T): T
  marcarError(error: unknown): void
}

function modo(): Modo {
  const m = process.env.EXP_PROPAGACION
  return m === 'correlationId' || m === 'traceparent' ? m : undefined
}

const puente = (): PuenteOtel | undefined => (globalThis as { __expOtel?: PuenteOtel }).__expOtel

/** La llave del cobro en curso, para viajar en un mensaje (socket a la terminal o fila del efecto). */
export function llaveDelCobro(): Record<string, string> {
  const m = modo()
  if (m === 'correlationId') {
    const id = getContext()?.correlationId
    return id ? { correlationId: id } : {}
  }
  if (m === 'traceparent') {
    const tp = puente()?.inyectar()
    return tp ? { traceparent: tp } : {}
  }
  return {}
}

/** Lo que se guarda en la fila del efecto: `undefined` en el brazo A (la fila queda idéntica a hoy). */
export function trazaParaLaFila(): Record<string, string> | undefined {
  if (!modo()) return undefined
  const llave = llaveDelCobro()
  return Object.keys(llave).length ? llave : undefined
}

/** Evento de socket de la terminal: en B continúa la traza que trae el mensaje. En A+ ya lo hace `onWithContext`. */
export function conTrazaDeSocket<T>(payload: unknown, evento: string, fn: () => T): T {
  if (modo() !== 'traceparent') return fn()
  const tp = payload && typeof payload === 'object' ? (payload as { traceparent?: unknown }).traceparent : undefined
  const p = puente()
  if (!p || typeof tp !== 'string') return fn()
  return p.conPadre(tp, `socket ${evento}`, fn)
}

/**
 * Un efecto reclamado por el job: corre con la llave del cobro que lo encoló. A+: el contexto propio con el
 * `correlationId` guardado (uno por efecto, nunca el de la vuelta del cron). B: un span NUEVO enlazado (LINK, como pide
 * la convención de mensajería de OTel) a la traza del cobro, nunca hijo de la vuelta.
 */
export function conTrazaDelEfecto<T>(efecto: { id: string; kind: string; paymentId: string; payload: unknown }, fn: () => T): T {
  const m = modo()
  if (!m) return fn()
  const traza = (efecto.payload && typeof efecto.payload === 'object' ? (efecto.payload as { _traza?: Record<string, string> })._traza : undefined) ?? {}
  if (m === 'correlationId') {
    const base = getContext()
    return runWithContext(
      { correlationId: traza.correlationId ?? base?.correlationId ?? efecto.id, source: 'job', entrypoint: 'payment-effects' },
      fn,
    )
  }
  const p = puente()
  if (!p) return fn()
  return p.conEnlace(traza.traceparent, `payment-effect ${efecto.kind}`, { 'avq.effect.id': efecto.id, 'avq.payment.id': efecto.paymentId }, fn)
}

export function marcarErrorEnLaTraza(error: unknown): void {
  if (modo() === 'traceparent') puente()?.marcarError(error)
}

export const propagacionActiva = (): boolean => modo() !== undefined
