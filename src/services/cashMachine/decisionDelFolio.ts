/**
 * Máquina de efectivo QuickPay Mini · fase 1a · «¿qué hace este mensaje con el folio?». Rediseño tras la ronda 3 de Codex sobre el
 * código (plan `2026-11-20-maquina-de-efectivo-fase-1a.md`, D1–D4 y los ajustes de `codex-r6.md`).
 *
 * Antes cada mensaje (cierre, duda, reenvío, gerente) volvía a traer carrito, turno y evidencia, y el SERVIDOR los comparaba; cada
 * comparación olvidada abría un hueco (r3 #2, #3, #9, #10). Ahora:
 *  · El PRIMER mensaje del folio congela carrito, turno, reparto y dueño (`CashMachineFolio`). La venta se arma SIEMPRE de esa copia.
 *  · El PRIMER cierre comprobado (de la PC o declarado por un gerente) es el desenlace (`decision`) y nunca se reemplaza.
 *  · Lo demás sólo AGREGA observaciones (`CashMachineObservation`, una fila por huella): otro carrito, turno u hora es una discrepancia
 *    que se anota para revisión, nunca una sustitución; otro desenlace o importes es un conflicto (409) con la evidencia guardada.
 *  · Una duda nunca se vuelve desenlace (r6-2): sólo un cierre lo es.
 *
 * Aquí vive la regla, PURA (sin base). Quien escribe lee el folio BAJO SU CANDADO y hace lo que ésta dice. La matriz está en
 * `tests/unit/services/cashMachine/decisionDelFolio.test.ts`.
 */
import { operationHash } from '../../utils/operationHash'
import type { CierreDeLaMaquina, QuienResolvio } from './ventaDeLaMaquina'

/** El desenlace aceptado del folio (r6-1): se guarda en la primera transacción y se TERMINA (venta o cierre) después. */
export interface DecisionGuardada {
  /** El cierre comprobado, con los importes CONGELADOS del folio. */
  cierre: CierreDeLaMaquina
  resolvedBy: QuienResolvio
  /** Quien procesa el cobro: la sesión de la PC (MAQUINA) o el gerente (GERENTE). */
  userId: string
  /** El vendedor por omisión del carrito congelado (la sesión de la PC que subió el folio). */
  vendedorPorOmision: string
  /** GERENTE: lo que leyó en la máquina. */
  evidence: string | null
  /** La PC estaba revocada al decidirse: lo anterior a su revocación entra con esta marca (TRAS_REVOCAR). */
  trasRevocar: boolean
  /** Un PAGADO de una PC revocada cobrado después de su revocación o sin hora: el dinero queda, no es venta. */
  motivoSinVenta: 'PC_REVOCADA' | null
}

/** Lo que el folio congeló con su primer mensaje. */
export interface FolioCongelado {
  deviceId: string | null
  cartHash: string | null
  saleShiftId: string | null
  dueCents: number
  saleCents: number
  tipCents: number
  version: number
  decision: DecisionGuardada | null
}

export interface EstadoDelFolio {
  folio: FolioCongelado | null
  /** Ya tiene su `CashMachineClose` (con venta, o sin ella y su motivo): el acuse es TERMINADO. */
  terminado: boolean
  /** Hay una duda (ESPERANDO) de este folio. */
  duda: boolean
}

export interface Importes {
  dueCents: number
  saleCents: number
  tipCents: number
}

export type PeticionSobreElFolio =
  | {
      que: 'CIERRE'
      origen: 'PC'
      deviceId: string | null
      cierre: CierreDeLaMaquina
      /** El carrito y el turno que mandó la PC: sólo para anotar la discrepancia, nunca sustituyen lo congelado. */
      carritoRecibido: string | null
      turnoRecibido: string | null
      /** Cuándo revocaron el emparejamiento FIJO del intento (r6-6); `null` = vigente. */
      revocadaEn: Date | null
    }
  | {
      que: 'CIERRE'
      origen: 'GERENTE'
      cierre: CierreDeLaMaquina
      /** r6-4: la versión de la evidencia que vio el gerente, y si su declaración ya está en el historial (repetición exacta). */
      versionVista: number
      repeticion: boolean
    }
  | {
      que: 'DUDA'
      deviceId: string | null
      importes: Importes
      carritoRecibido: string | null
      turnoRecibido: string | null
      revocadaEn: Date | null
    }
  | { que: 'CONSULTA' }

export type DecisionDelFolio =
  /** CONSULTA: el folio ya tiene su cierre. */
  | { accion: 'TERMINADO' }
  /** CONSULTA: tiene desenlace, pero la venta todavía no se termina (el reenvío la reanuda). */
  | { accion: 'RECIBIDO' }
  | { accion: 'DUDA_ABIERTA' }
  | { accion: 'NO_EXISTE' }
  /** El gerente vio otra versión de la evidencia: no se escribe nada (r6-4). */
  | { accion: 'VERSION' }
  /** Se guarda la evidencia y se contesta 409. */
  | { accion: 'CONFLICTO'; motivo: 'OTRA_PC' | 'OTRA_EVIDENCIA' }
  /** La primera duda del folio: congela y abre la duda. */
  | { accion: 'ABRIR_DUDA'; trasRevocar: boolean }
  /** Este cierre es el desenlace del folio (congela si es el primer mensaje). */
  | { accion: 'ACEPTAR'; trasRevocar: boolean; motivoSinVenta: 'PC_REVOCADA' | null; discrepancia: boolean }
  /** El folio contesta lo que ya tiene (y se reanuda si está RECIBIDO); `discrepancia` = se anota para revisión. */
  | { accion: 'SEGUIR'; discrepancia: boolean }

const mismosImportes = (a: Importes, b: Importes) => a.dueCents === b.dueCents && a.saleCents === b.saleCents && a.tipCents === b.tipCents
const horaDe = (c: CierreDeLaMaquina): string | null => {
  if (!c.occurredAtKnown || !c.occurredAt) return null
  const t = new Date(c.occurredAt).getTime()
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}
/** Lo físico de un cierre (r6-3): GUARDADO y CANCELADO con las mismas cifras NO son lo mismo, ni dos modos de cancelación. */
const mismoDesenlaceFisico = (a: CierreDeLaMaquina, b: CierreDeLaMaquina) =>
  a.outcome === b.outcome &&
  a.creditCents === b.creditCents &&
  a.changeDispensedCents === b.changeDispensedCents &&
  (a.cancelMode ?? null) === (b.cancelMode ?? null)

export function decidirSobreElFolio(estado: EstadoDelFolio, pet: PeticionSobreElFolio): DecisionDelFolio {
  const { folio } = estado
  if (pet.que === 'CONSULTA') {
    if (estado.terminado) return { accion: 'TERMINADO' }
    if (folio?.decision) return { accion: 'RECIBIDO' }
    return estado.duda ? { accion: 'DUDA_ABIERTA' } : { accion: 'NO_EXISTE' }
  }

  // r6-4: el gerente resuelve con la evidencia que VIO; su repetición exacta (ya en el historial) no necesita volver a verla.
  if (pet.que === 'CIERRE' && pet.origen === 'GERENTE' && !pet.repeticion && pet.versionVista !== (folio?.version ?? 1)) {
    return { accion: 'VERSION' }
  }
  // D3: el folio es de la PC que lo subió primero; el gerente actúa sobre el de esa PC.
  const deviceId = pet.que === 'DUDA' || pet.origen === 'PC' ? pet.deviceId : null
  if (folio && (pet.que === 'DUDA' || pet.origen === 'PC') && folio.deviceId !== deviceId) {
    return { accion: 'CONFLICTO', motivo: 'OTRA_PC' }
  }
  const importes = pet.que === 'DUDA' ? pet.importes : pet.cierre
  if (folio && !mismosImportes(folio, importes)) return { accion: 'CONFLICTO', motivo: 'OTRA_EVIDENCIA' }
  // D2: otro carrito o turno se anota; nunca sustituye lo congelado. El gerente no manda carrito ni turno.
  const recibido = pet.que === 'DUDA' || pet.origen === 'PC' ? pet : null
  const discrepanciaDeLoCongelado =
    !!folio && !!recibido && (recibido.carritoRecibido !== folio.cartHash || recibido.turnoRecibido !== folio.saleShiftId)

  if (pet.que === 'DUDA') {
    // r6-2: una duda nunca se vuelve desenlace; si el folio ya tiene uno, contesta ése.
    if (!folio) return { accion: 'ABRIR_DUDA', trasRevocar: pet.revocadaEn !== null }
    return { accion: 'SEGUIR', discrepancia: discrepanciaDeLoCongelado }
  }

  if (folio?.decision) {
    if (!mismoDesenlaceFisico(folio.decision.cierre, pet.cierre)) return { accion: 'CONFLICTO', motivo: 'OTRA_EVIDENCIA' }
    // r3 #10: la hora física que faltaba (o una distinta) se agrega a revisión, sin tocar lo ya asentado.
    const otraHora = horaDe(folio.decision.cierre) !== horaDe(pet.cierre)
    return { accion: 'SEGUIR', discrepancia: discrepanciaDeLoCongelado || otraHora }
  }

  // Este cierre es el desenlace. La PC revocada (r6-6, con su emparejamiento FIJO): lo cobrado antes de la revocación entra con su
  // marca; un PAGADO posterior o sin hora deja el dinero sin venta. El gerente no está revocado: él declara.
  const revocadaEn = pet.origen === 'PC' ? pet.revocadaEn : null
  let motivoSinVenta: 'PC_REVOCADA' | null = null
  if (revocadaEn && pet.cierre.outcome === 'PAGADO') {
    const hora = horaDe(pet.cierre)
    if (hora === null || new Date(hora) > revocadaEn) motivoSinVenta = 'PC_REVOCADA'
  }
  return { accion: 'ACEPTAR', trasRevocar: revocadaEn !== null, motivoSinVenta, discrepancia: discrepanciaDeLoCongelado }
}

/**
 * r6-3: la huella de una observación física. Entra todo lo que la distingue — qué fue (cierre, duda o importes imposibles), el origen
 * (PC o gerente, con el aparato y el emparejamiento de la PC), el desenlace y su modo de cancelación, los importes, la hora física,
 * `lastSeen`, el turno y el carrito recibidos y el carrito congelado —. Fuera: la hora de llegada y quién de la sesión lo mandó (dos
 * gerentes que declaran lo mismo son UNA observación).
 */
export function huellaDeLaObservacion(observacion: Record<string, unknown>): string {
  const { recibidoEn: _llegada, userId: _sesion, ...lo } = observacion
  return operationHash(lo)
}

/**
 * La evidencia de una incidencia que NO es duda. La historia completa vive en `CashMachineObservation`; aquí sólo la primera y la
 * última entrega (lo que enseña la bandeja), cuántas veces llegó, cuántas fueron retransmisiones y la `version` que confirma la
 * revisión. `nueva` lo dice la huella contra TODO el historial (no la última entrega): una retransmisión no sube la versión ni reabre.
 */
export function acumularEnLaIncidencia(previo: unknown, evento: Record<string, unknown>, nueva: boolean): Record<string, unknown> {
  if (!previo || typeof previo !== 'object') return { eventos: [evento], veces: 1, repetidas: nueva ? 0 : 1, version: 1 }
  const p = previo as Record<string, unknown> & { eventos?: unknown; veces?: number; version?: number; repetidas?: number }
  const eventos = Array.isArray(p.eventos) ? (p.eventos as unknown[]) : []
  return {
    ...p,
    eventos: nueva ? [eventos[0] ?? evento, evento] : eventos,
    veces: (typeof p.veces === 'number' ? p.veces : eventos.length) + 1,
    repetidas: (p.repetidas ?? 0) + (nueva ? 0 : 1),
    version: (p.version ?? 1) + (nueva ? 1 : 0),
  }
}

/** La versión de la evidencia de una incidencia (la que el gerente confirma al revisarla). Las filas sin ella van en 1. */
export const versionDeLaIncidencia = (payload: unknown): number => {
  const v = (payload as { version?: unknown } | null)?.version
  return typeof v === 'number' ? v : 1
}
