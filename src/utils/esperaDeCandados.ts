import { Prisma } from '@prisma/client'
import { ConflictError } from '../errors/AppError'
import { isModelLockTimeoutError, withSerializableRetry } from './serializableRetry'

type Tx = Prisma.TransactionClient

/** El timeout de las transacciones CORTAS (el default de `withSerializableRetry`). */
export const TIMEOUT_TX_CORTA_MS = 10_000
/** El tope de espera más alto que puede tener una transacción: el de una de 120 s (el cierre de pago al personal ⇒ 30 s). */
export const TOPE_ESPERA_MAX_MS = 30_000
/** Lo que una espera le deja a su transacción para terminar: nunca se espera hasta el último segundo del timeout. */
export const MARGEN_TX_MS = 1_000

/**
 * Presupuesto ÚNICO de espera de candados de UNA transacción (pago al personal, fase 3 B9; diseño r6.3 + r7.2). Lo comparten
 * todas sus adquisiciones —en pago al personal: el candado de periodos de la organización, la fila del periodo, el candado y
 * la fila de la clase y las filas de `Organization` y `Venue`; también los exclusivos (traslado, borrado, limpieza de
 * demos)—, así que varias esperas seguidas nunca suman más que el tope (antes cada candado tenía su propio reloj de 5 s y
 * 4,5 s + 6 s llegaban al P2028 de una transacción de 10 s).
 *
 * Se mide el tiempo ESPERANDO candados, no el reloj desde la entrada: el cierre toma las sedes después de calcular (hasta
 * ~76 s medidos) y un plazo de 30 s desde la entrada le daría 409 a todo cierre largo aunque nadie le estorbara.
 *
 * Además respeta el reloj de SU transacción (ronda 1, F3): ninguna espera la empuja más allá de su timeout menos un margen
 * (`MARGEN_TX_MS`), así que nunca llega al P2028 aunque el trabajo previo haya sido lento.
 *
 * Se crea en la PRIMERA línea de la transacción (`transaccionConPresupuesto` lo hace), nunca a mitad: un reloj nuevo
 * borraría lo ya esperado y lo ya transcurrido. Un reintento de `withSerializableRetry` es otra transacción, con su
 * presupuesto nuevo.
 */
export class PresupuestoDeEspera {
  private esperadoMs = 0
  private readonly entrada = Date.now()
  /** `timeoutMs`: el de la transacción; sin él (pruebas, barreras) sólo cuenta la espera. */
  constructor(
    readonly topeMs: number,
    private readonly o: { timeoutMs?: number } = {},
  ) {}

  /** El tope que le cabe a una transacción de `timeoutMs`: 6 s de 10 s y 30 s de 120 s (el 60 %, hasta 30 s). */
  static para(timeoutMs: number): PresupuestoDeEspera {
    return new PresupuestoDeEspera(Math.min(Math.floor(timeoutMs * 0.6), TOPE_ESPERA_MAX_MS), { timeoutMs })
  }

  /**
   * Lo que queda, en ms enteros: `min(tope − esperado, timeout − transcurrido − MARGEN_TX_MS)`, nunca menos de 0. Con
   * menos de 1 ms no se intenta (`lock_timeout = 0` sería «sin tope»).
   */
  restanteMs(): number {
    const porEspera = this.topeMs - this.esperadoMs
    const porReloj = this.o.timeoutMs === undefined ? Infinity : this.o.timeoutMs - (Date.now() - this.entrada) - MARGEN_TX_MS
    return Math.max(0, Math.floor(Math.min(porEspera, porReloj)))
  }

  /** Sólo `tomarCandado`: lo que tardó una adquisición. */
  descontar(ms: number): void {
    this.esperadoMs += Math.max(0, ms)
  }
}

/** Una transacción SERIALIZABLE (con los reintentos de siempre) que recibe su presupuesto de espera al entrar. */
export function transaccionConPresupuesto<T>(
  fn: (tx: Tx, presupuesto: PresupuestoDeEspera) => Promise<T>,
  o: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = o.timeoutMs ?? TIMEOUT_TX_CORTA_MS
  return withSerializableRetry(tx => fn(tx, PresupuestoDeEspera.para(timeoutMs)), { timeoutMs })
}

/** El 409 de un candado que retiene OTRA operación (filas de `Organization` y `Venue`, la clase): el código por defecto. */
export const OPERACION_EN_CURSO = {
  codigo: 'OPERACION_EN_CURSO',
  mensaje: 'Otra operación está cambiando esta sede o su organización; intenta de nuevo en un momento',
} as const

const esEsperaVencida = (e: unknown) => {
  const x = e as { code?: string; meta?: { code?: string } } | null
  return x?.code === '55P03' || (x?.code === 'P2010' && x.meta?.code === '55P03') || isModelLockTimeoutError(e)
}

/**
 * La ÚNICA pieza de la espera acotada (B7 r1-r2; B9): fija `lock_timeout` = lo que le queda al presupuesto de la
 * transacción, toma el candado con `tomar`, descuenta lo que tardó y restaura el valor previo, para que el resto de la
 * transacción no herede el tope. Sin presupuesto, o con `55P03`, contesta 409 con `codigo`/`mensaje` (por defecto
 * `OPERACION_EN_CURSO`) y nunca llega al P2028 de su transacción.
 */
export async function tomarCandado<T>(
  tx: Tx,
  tomar: () => Promise<T>,
  o: { presupuesto: PresupuestoDeEspera; codigo?: string; mensaje?: string },
): Promise<T> {
  const vencido = () => new ConflictError(o.mensaje ?? OPERACION_EN_CURSO.mensaje, o.codigo ?? OPERACION_EN_CURSO.codigo)
  const restante = o.presupuesto.restanteMs()
  if (restante < 1) throw vencido()
  const [{ previo }] = await tx.$queryRaw<Array<{ previo: string }>>`SELECT current_setting('lock_timeout') AS previo`
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${restante}ms'`)
  const t0 = Date.now()
  let r: T
  try {
    r = await tomar()
  } catch (e) {
    o.presupuesto.descontar(Date.now() - t0)
    // 55P03 aborta la transacción: no hay nada que restaurar. Un ConflictError no lo reintenta `withSerializableRetry`.
    if (esEsperaVencida(e)) throw vencido()
    throw e
  }
  o.presupuesto.descontar(Date.now() - t0)
  await tx.$queryRaw`SELECT set_config('lock_timeout', ${previo}, true)`
  return r
}
