/**
 * Máquina de efectivo QuickPay Mini · fase 1a · Codex servidor r2, familia A: «¿quién puede escribir el desenlace de un folio?».
 *
 * Dos rondas parcharon esta pregunta entrada por entrada y cada parche rompió otra (r2 #1, #4, #8, #9). Aquí vive la ÚNICA respuesta,
 * PURA (sin base): cada entrada lee lo que el folio ya tiene BAJO SU CANDADO (`leerEstadoDelFolio`), le pregunta a
 * `decidirEscrituraDelFolio` y hace lo que ésta dice. Las entradas: la venta y la duda de la PC, los dos GET, la resolución del gerente
 * (POS y panel), la revisión de una incidencia, la repetición y la carrera P2002. La matriz completa está en
 * `tests/unit/services/cashMachine/decisionDelFolio.test.ts`.
 *
 * Las reglas (founder y Codex r2):
 *  · Lo definitivo (el cierre o el «no se pudo registrar») de OTRA PC no se toca ni se le contesta: 409 con la evidencia guardada.
 *  · La repetición EXACTA de lo definitivo (misma huella y mismo carrito) se permite, también a la PC revocada.
 *  · La duda es de la PC que la subió: un cierre de otra PC —venta o 202— nunca la cierra.
 *  · Con duda, el cierre debe traer SUS importes (venta/propina) y SU carrito congelado; si no, 409.
 *  · La PC revocada conserva su `revokedAt` aunque sólo exista su duda: el primer cierre mira la hora del comprobante y queda
 *    TRAS_REVOCAR; un PAGADO posterior o sin hora no es venta (202 PC_REVOCADA). El gerente no está revocado: él declara.
 *  · La revisión confirma la versión de la evidencia que vio el gerente.
 */
import { operationHash } from '../../utils/operationHash'
import type { DesenlaceDeLaMaquina, MotivoSinRegistro } from './ventaDeLaMaquina'

/** Lo que el folio ya tiene guardado de una operación: de quién es y con qué evidencia. */
export interface LoGuardadoDelFolio {
  deviceId: string | null
  /** La huella del cierre (`huellaDelCierre`); una duda no tiene desenlace: `null`. */
  huella: string | null
  /** La huella de los artículos (`huellaDelCarrito`); un cierre sin pedido no tiene: `null`. */
  huellaDelCarrito: string | null
  dueCents: number
  saleCents: number
  tipCents: number
}

export interface EstadoDelFolio {
  cierre: LoGuardadoDelFolio | null
  sinRegistro: LoGuardadoDelFolio | null
  duda: (LoGuardadoDelFolio & { abierta: boolean }) | null
}

/** Quién escribe: la PC (con la fecha de su revocación, si la revocaron) o el gerente, que actúa sobre la duda de esa PC. */
export type QuienEscribe = { tipo: 'PC'; deviceId: string | null; revocadaEn: Date | null } | { tipo: 'GERENTE'; deviceId: string | null }

export interface Importes {
  dueCents: number
  saleCents: number
  tipCents: number
}

export type PeticionSobreElFolio =
  | {
      que: 'CIERRE'
      quien: QuienEscribe
      outcome: DesenlaceDeLaMaquina
      /** La hora del comprobante de la máquina; `null` = desconocida. */
      horaDelComprobante: Date | null
      evidencia: { huella: string; huellaDelCarrito: string | null }
      importes: Importes
      /** Un PAGADO que no puede ser venta aunque sus importes sean posibles (descuento, premio, venta rechazada…). */
      motivoSinVenta?: MotivoSinRegistro
    }
  | { que: 'DUDA'; quien: QuienEscribe; importes: Importes; huellaDelCarrito: string | null }
  | { que: 'CONSULTA' }
  | { que: 'REVISION'; kind: string; status: string; versionVista: number; versionActual: number }

export type DecisionDelFolio =
  | { accion: 'REGISTRAR'; trasRevocar: boolean }
  | { accion: 'SIN_REGISTRO'; motivo: MotivoSinRegistro; trasRevocar: boolean }
  | { accion: 'REPETIR'; de: 'CIERRE' | 'SIN_REGISTRO' | 'REVISION' }
  | { accion: 'CONFLICTO'; motivo: 'OTRA_PC' | 'OTRA_EVIDENCIA' | 'DUDA_CERRADA' | 'VERSION' }
  | { accion: 'ABRIR_DUDA'; trasRevocar: boolean }
  | { accion: 'DUDA_ABIERTA' }
  | { accion: 'NO_EXISTE' }
  | { accion: 'REVISAR' }
  | { accion: 'NO_REVISABLE' }

/** Sin carrito de un lado (un cancelado, o una fila sin huella) no hay nada que comparar. */
const carritosCompatibles = (a: string | null, b: string | null) => a == null || b == null || a === b
const mismosImportes = (a: Importes, b: Importes) => a.dueCents === b.dueCents && a.saleCents === b.saleCents && a.tipCents === b.tipCents
const mismaOperacion = (guardado: LoGuardadoDelFolio, importes: Importes, carrito: string | null) =>
  mismosImportes(guardado, importes) && carritosCompatibles(guardado.huellaDelCarrito, carrito)

export function decidirEscrituraDelFolio(estado: EstadoDelFolio, pet: PeticionSobreElFolio): DecisionDelFolio {
  if (pet.que === 'REVISION') {
    if (pet.kind === 'ESPERANDO') return { accion: 'NO_REVISABLE' }
    if (pet.versionVista !== pet.versionActual) return { accion: 'CONFLICTO', motivo: 'VERSION' }
    return pet.status === 'RESUELTO' ? { accion: 'REPETIR', de: 'REVISION' } : { accion: 'REVISAR' }
  }

  const definitivo = estado.cierre
    ? { de: 'CIERRE' as const, fila: estado.cierre }
    : estado.sinRegistro
      ? { de: 'SIN_REGISTRO' as const, fila: estado.sinRegistro }
      : null
  const { duda } = estado

  if (pet.que === 'CONSULTA') {
    if (definitivo) return { accion: 'REPETIR', de: definitivo.de }
    // Una duda sin desenlace guardado sigue esperando (nunca se fabrica uno, r1 #6).
    return duda ? { accion: 'DUDA_ABIERTA' } : { accion: 'NO_EXISTE' }
  }

  const { deviceId } = pet.quien
  const revocadaEn = pet.quien.tipo === 'PC' ? pet.quien.revocadaEn : null

  if (pet.que === 'DUDA') {
    if (duda && duda.deviceId !== deviceId) return { accion: 'CONFLICTO', motivo: 'OTRA_PC' }
    if (definitivo && definitivo.fila.deviceId !== deviceId) return { accion: 'CONFLICTO', motivo: 'OTRA_PC' }
    // La evidencia de la PC es SU duda; sin ella, lo definitivo que ella misma guardó.
    const suyo = duda ?? definitivo?.fila
    if (suyo && !mismaOperacion(suyo, pet.importes, pet.huellaDelCarrito)) return { accion: 'CONFLICTO', motivo: 'OTRA_EVIDENCIA' }
    if (definitivo) return { accion: 'REPETIR', de: definitivo.de }
    if (duda) return duda.abierta ? { accion: 'DUDA_ABIERTA' } : { accion: 'CONFLICTO', motivo: 'DUDA_CERRADA' }
    return { accion: 'ABRIR_DUDA', trasRevocar: revocadaEn !== null }
  }

  // CIERRE: la PC sube su cierre, o el gerente resuelve la duda de esa PC.
  if (definitivo) {
    if (definitivo.fila.deviceId !== deviceId) return { accion: 'CONFLICTO', motivo: 'OTRA_PC' }
    const igual =
      definitivo.fila.huella === pet.evidencia.huella &&
      carritosCompatibles(definitivo.fila.huellaDelCarrito, pet.evidencia.huellaDelCarrito)
    return igual ? { accion: 'REPETIR', de: definitivo.de } : { accion: 'CONFLICTO', motivo: 'OTRA_EVIDENCIA' }
  }
  if (duda) {
    if (duda.deviceId !== deviceId) return { accion: 'CONFLICTO', motivo: 'OTRA_PC' }
    if (!duda.abierta) return { accion: 'CONFLICTO', motivo: 'DUDA_CERRADA' }
    if (!mismaOperacion(duda, pet.importes, pet.evidencia.huellaDelCarrito)) return { accion: 'CONFLICTO', motivo: 'OTRA_EVIDENCIA' }
  }
  const trasRevocar = revocadaEn !== null
  if (revocadaEn && pet.outcome === 'PAGADO') {
    const antes = pet.horaDelComprobante !== null && pet.horaDelComprobante <= revocadaEn
    if (!antes) return { accion: 'SIN_REGISTRO', motivo: 'PC_REVOCADA', trasRevocar }
  }
  if (pet.outcome === 'PAGADO' && pet.motivoSinVenta) return { accion: 'SIN_REGISTRO', motivo: pet.motivoSinVenta, trasRevocar }
  return { accion: 'REGISTRAR', trasRevocar }
}

/**
 * La evidencia de una incidencia que NO es duda (r2 #8): `eventos` guarda el PRIMERO y, con el tope lleno, reemplaza el último por el
 * más nuevo (el «último» siempre es el último real). Una entrega IDÉNTICA a la última (la PC reintenta el mismo 409; sólo cambia la hora
 * de llegada) no es evidencia nueva: cuenta en `veces` y `repetidas`, pero no sube `version` ni reabre la fila. Todo lo demás del
 * payload —la revisión y su historia— se conserva. Quien llama tiene el candado del folio (lee y escribe sin perder entregas).
 */
export const TOPE_DE_EVENTOS = 50

export function acumularEvento(previo: unknown, evento: Record<string, unknown>): { payload: Record<string, unknown>; nueva: boolean } {
  const { recibidoEn: _hora, ...contenido } = evento
  const ultimaHuella = operationHash(contenido)
  if (!previo || typeof previo !== 'object') {
    return { payload: { eventos: [evento], veces: 1, version: 1, repetidas: 0, ultimaHuella }, nueva: true }
  }
  const p = previo as Record<string, unknown> & { eventos?: unknown; veces?: number; version?: number; repetidas?: number }
  const eventos = Array.isArray(p.eventos) ? (p.eventos as unknown[]) : []
  const veces = (typeof p.veces === 'number' ? p.veces : eventos.length) + 1
  if (p.ultimaHuella === ultimaHuella) {
    return { payload: { ...p, veces, repetidas: (p.repetidas ?? 0) + 1 }, nueva: false }
  }
  const siguientes = eventos.length < TOPE_DE_EVENTOS ? [...eventos, evento] : [...eventos.slice(0, TOPE_DE_EVENTOS - 1), evento]
  return {
    payload: { ...p, eventos: siguientes, veces, version: (p.version ?? 1) + 1, repetidas: p.repetidas ?? 0, ultimaHuella },
    nueva: true,
  }
}

/** La versión de la evidencia de una incidencia (la que el gerente confirma al revisarla). Las filas sin ella van en 1. */
export const versionDeLaIncidencia = (payload: unknown): number => {
  const v = (payload as { version?: unknown } | null)?.version
  return typeof v === 'number' ? v : 1
}
