/**
 * S0-a del checkpoint 1 (webhook como primer confirmador, Codex 13-sep-2026): identidad SUFICIENTE para deduplicar
 * un registro por `referenceNumber` cuando no trae llave.
 *
 * Las referencias de Blumon y de AngelPay son `yyMMddHHmmss`: dos terminales del mismo negocio que cobran en el
 * mismo segundo producen la MISMA referencia. Hasta hoy el registrador devolvía «el existente» por venue + referencia
 * a secas, aunque fuera de otra orden, otra afiliación u otro importe — y la segunda venta desaparecía en silencio.
 *
 * Un reintento legítimo (la TPV vuelve a mandar el mismo cobro) coincide en importe, propina, orden y afiliación;
 * una colisión difiere en alguna. Por eso se exigen todas las que se puedan comparar: lo que no se conoce de un
 * lado (orden nula en venta rápida, afiliación nula en un cobro legacy) no descalifica.
 */
import { terminalIdentityKey } from '../../utils/terminalSerial'

export interface HuellaDelCobro {
  orderId: string | null
  amountPesos: number | string | { toString(): string }
  tipPesos: number | string | { toString(): string } | null
  merchantAccountId: string | null
  /**
   * Codex R7-2: la OTRA identidad de afiliación del cargo — en el entrante, lo que MANDÓ el APK (cuando la definitiva se
   * resolvió por serial); en un registro, la evidencia `processorData.merchantAccountIdFromApk` que dejó su registro. La
   * configuración de enrutamiento de HOY no demuestra que un cargo HISTÓRICO sea distinto: un replay coincide si alguna de
   * sus identidades de afiliación coincide con alguna del registro.
   */
  merchantAccountIdDelApk?: string | null
  /** Autorización del banco: pertenece al CARGO. Dos autorizaciones distintas son dos cargos aunque todo lo demás coincida. */
  authorizationNumber?: string | null
  /** Llave de idempotencia (= `attemptId` de la terminal). Dos llaves DISTINTAS son dos intentos, nunca el mismo cobro. */
  idempotencyKey?: string | null
  /** Serial FÍSICO de la terminal que cobró (acreditado por el JWT o por el vínculo). Dos terminales = dos cobros. */
  terminalSerial?: string | null
  /** Solicitud POS → terminal a la que pertenece el cobro. Dos solicitudes = dos cobros. */
  terminalPaymentRequestId?: string | null
  /**
   * Sólo en el ENTRANTE: su identidad está acreditada por el vínculo del intento (webhook, S2). Un Payment SIN llave no
   * puede ser este intento —el APK que abre vínculos siempre registra con llave—: es otro cobro del mismo segundo.
   */
  exigeLlave?: boolean
}

export type VeredictoDeIdentidad =
  | { mismo: true }
  | { mismo: false; motivo: 'LLAVE' | 'SOLICITUD' | 'TERMINAL' | 'IMPORTE' | 'PROPINA' | 'ORDEN' | 'AFILIACION' | 'AFILIACION_INCIERTA' }

/** Las identidades de afiliación conocidas de un lado (definitiva + la que mandó/dejó el APK), sin nulos. */
export const afiliacionesDe = (h: Pick<HuellaDelCobro, 'merchantAccountId' | 'merchantAccountIdDelApk'>): string[] => [
  ...new Set([h.merchantAccountId, h.merchantAccountIdDelApk].filter((x): x is string => typeof x === 'string' && x.length > 0)),
]

const centavos = (pesos: HuellaDelCobro['amountPesos'] | null | undefined): number => Math.round(Number(pesos ?? 0) * 100)

export function esElMismoCobroPorReferencia(existente: HuellaDelCobro, entrante: HuellaDelCobro): VeredictoDeIdentidad {
  // Codex R1 (P1-1): la llave fuerte manda sobre la referencia débil. Con las dos llaves presentes y distintas, la
  // coincidencia de referencia (mismo segundo) NO identifica el cobro aunque importe, propina, orden y afiliación coincidan.
  if (existente.idempotencyKey && entrante.idempotencyKey && existente.idempotencyKey !== entrante.idempotencyKey) {
    return { mismo: false, motivo: 'LLAVE' }
  }
  if (entrante.exigeLlave && entrante.idempotencyKey && !existente.idempotencyKey) return { mismo: false, motivo: 'LLAVE' }
  // La referencia sin llave (legacy) exige además la misma solicitud y la misma terminal cuando las dos se conocen.
  if (
    entrante.terminalPaymentRequestId &&
    existente.terminalPaymentRequestId &&
    entrante.terminalPaymentRequestId !== existente.terminalPaymentRequestId
  ) {
    return { mismo: false, motivo: 'SOLICITUD' }
  }
  const serialEntrante = entrante.terminalSerial?.trim() ? terminalIdentityKey(entrante.terminalSerial) : null
  const serialExistente = existente.terminalSerial?.trim() ? terminalIdentityKey(existente.terminalSerial) : null
  if (serialEntrante && serialExistente && serialEntrante !== serialExistente) return { mismo: false, motivo: 'TERMINAL' }
  if (centavos(existente.amountPesos) !== centavos(entrante.amountPesos)) return { mismo: false, motivo: 'IMPORTE' }
  if (centavos(existente.tipPesos) !== centavos(entrante.tipPesos)) return { mismo: false, motivo: 'PROPINA' }
  if (entrante.orderId && existente.orderId && entrante.orderId !== existente.orderId) return { mismo: false, motivo: 'ORDEN' }
  // Codex R7-2: la afiliación se compara como CONJUNTO de identidades (definitiva + la del APK) en los dos lados. Si los
  // conjuntos no se cruzan, sólo una autorización DISTINTA demuestra que es otro cargo (AFILIACION); sin esa prueba la
  // identidad es INCIERTA — el enrutamiento pudo cambiar entre el registro y el replay — y el llamador no crea: deja evidencia.
  const afEntrante = afiliacionesDe(entrante)
  const afExistente = afiliacionesDe(existente)
  if (afEntrante.length > 0 && afExistente.length > 0 && !afEntrante.some(a => afExistente.includes(a))) {
    const authEntrante = entrante.authorizationNumber?.trim() || null
    const authExistente = existente.authorizationNumber?.trim() || null
    if (authEntrante && authExistente && authEntrante !== authExistente) return { mismo: false, motivo: 'AFILIACION' }
    return { mismo: false, motivo: 'AFILIACION_INCIERTA' }
  }
  return { mismo: true }
}

export interface EleccionPorReferencia<T> {
  elegido: T | null
  descartes: { id: string; motivo: Exclude<VeredictoDeIdentidad, { mismo: true }>['motivo'] }[]
}

/**
 * Codex R2 (P1-1): entre VARIOS Payments con la misma referencia, el reintento elige el que tiene identidad suficiente.
 * Descartar al primer candidato nunca es permiso para crear: sólo se crea cuando NINGUNO coincide. Un entrante SIN llave
 * (APK viejo) prefiere al candidato sin llave (legacy ↔ legacy) sobre uno con llave de la misma terminal.
 */
export function elegirRegistroPorReferencia<T extends HuellaDelCobro & { id: string }>(
  candidatos: T[],
  entrante: HuellaDelCobro,
): EleccionPorReferencia<T> {
  const ordenados = entrante.idempotencyKey
    ? candidatos
    : [...candidatos].sort((a, b) => Number(!!a.idempotencyKey) - Number(!!b.idempotencyKey))
  const descartes: EleccionPorReferencia<T>['descartes'] = []
  for (const candidato of ordenados) {
    const veredicto = esElMismoCobroPorReferencia(candidato, entrante)
    if (veredicto.mismo) return { elegido: candidato, descartes }
    descartes.push({ id: candidato.id, motivo: veredicto.motivo })
  }
  return { elegido: null, descartes }
}

/** Serial y solicitud que un Payment ya registrado conserva en `processorData` (filas anteriores a la columna incluidas). */
export function serialDelRegistro(processorData: unknown): string | null {
  const datos = processorData && typeof processorData === 'object' ? (processorData as Record<string, unknown>) : null
  return typeof datos?.deviceSerialNumber === 'string' && datos.deviceSerialNumber.trim() ? datos.deviceSerialNumber : null
}
export function solicitudDelRegistro(processorData: unknown): string | null {
  const datos = processorData && typeof processorData === 'object' ? (processorData as Record<string, unknown>) : null
  return typeof datos?.terminalPaymentRequestId === 'string' && datos.terminalPaymentRequestId ? datos.terminalPaymentRequestId : null
}

export interface RegistroConIdentidad {
  id: string
  orderId: string | null
  amount: unknown
  tipAmount: unknown
  merchantAccountId: string | null
  idempotencyKey: string | null
  terminalPaymentRequestId: string | null
  processorData: unknown
  authorizationNumber?: string | null
}

/** Codex R7-2: la afiliación que MANDÓ el APK cuando el registro se atribuyó a otra (evidencia que dejó `resolverAfiliacionDelCobro`). */
export function afiliacionDelApkDelRegistro(processorData: unknown): string | null {
  const datos = processorData && typeof processorData === 'object' ? (processorData as Record<string, unknown>) : null
  return typeof datos?.merchantAccountIdFromApk === 'string' && datos.merchantAccountIdFromApk ? datos.merchantAccountIdFromApk : null
}

/** Huella de identidad de un Payment ya registrado (columnas + lo que conserva `processorData`). */
export function huellaDelRegistro<T extends RegistroConIdentidad>(registro: T): HuellaDelCobro & { id: string; registro: T } {
  return {
    id: registro.id,
    registro,
    orderId: registro.orderId,
    amountPesos: registro.amount as HuellaDelCobro['amountPesos'],
    tipPesos: registro.tipAmount as HuellaDelCobro['tipPesos'],
    merchantAccountId: registro.merchantAccountId,
    merchantAccountIdDelApk: afiliacionDelApkDelRegistro(registro.processorData),
    authorizationNumber: registro.authorizationNumber ?? null,
    idempotencyKey: registro.idempotencyKey ?? null,
    terminalSerial: serialDelRegistro(registro.processorData),
    terminalPaymentRequestId: registro.terminalPaymentRequestId ?? solicitudDelRegistro(registro.processorData),
  }
}
