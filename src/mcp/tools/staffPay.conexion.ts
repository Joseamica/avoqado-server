// src/mcp/tools/staffPay.conexion.ts — fase 3, B14-fix2 (decisión del founder, 7-oct): las escrituras del MCP de pago al personal
// que por naturaleza abarcan a TODA la organización (cerrar el periodo, marcar pagados recibos enteros, activar sin elegir sedes y
// cambiar las propinas) pedidas desde una conexión que no tiene todas sus sedes. Al DUEÑO no se le niegan: su vista previa lo
// AVISA al inicio, trae `sedesFueraDeLaConexion` y la confirmación queda atada a esa lista; a los demás, FUERA_DE_LA_CONEXION sin
// un dato ni un monto de esas sedes. Al confirmar se revalida todo (rol y sedes fuera de AHORA). Sin sedes fuera, nada cambia.
// Ronda 1 (R5): DUEÑO es también quien tiene rol OWNER en TODAS las sedes que la acción abarca (`esDueno`).
// Ronda 1 de B14-fix2 (I1): lo que el cierre devuelve DESPUÉS de esa validación —un rechazo con su vista previa nueva o un «ya
// cerrado» de otra persona— se revisa otra vez contra SUS sedes (`falloDelCierre`, `yaCerradoRevisado`).
import { createHash } from 'crypto'
import type { McpScope } from '../scope'
import { text } from '../respond'
import { esDueno, nombresDeSedes } from './staffPay.alcanceDeLaAccion'
import { lista } from './staffPay.formato'
import { cuerpoDelFallo } from './staffPay.sedes'

type Respuesta = ReturnType<typeof text>
export interface SedeFuera {
  venueId: string
  nombre: string
}
export type AccionDeOrganizacion = 'cierre' | 'pagado' | 'activar' | 'propinas'
export interface RevisionDeConexion {
  /** Las sedes que abarca la acción y NO están en la conexión, ordenadas por id. Vacía ⇒ todo igual que antes. */
  fuera: SedeFuera[]
  /** Quien NO es dueño: la negativa FUERA_DE_LA_CONEXION (sin datos ni montos de esas sedes). null si puede seguir. */
  negada: Respuesta | null
  /** Para el dueño: el «Ojo: …» del inicio del mensaje. '' sin sedes fuera. */
  aviso: string
}

/** Cuántos nombres dice un texto antes de «y N más» (la lista completa va en `sedesFueraDeLaConexion`). */
const TOPE_NOMBRES = 10
const enPalabras = (nombres: string[]) =>
  nombres.length > TOPE_NOMBRES ? `${nombres.slice(0, TOPE_NOMBRES).join(', ')} y ${nombres.length - TOPE_NOMBRES} más` : lista(nombres)
const nombresDe = (fuera: SedeFuera[]) => enPalabras(fuera.map(s => s.nombre))

/** Qué incluye cada acción y qué pasa si se confirma, en español del dueño (`n`: cuántas sedes fuera, para el verbo). */
const ACCIONES: Record<AccionDeOrganizacion, { que: string; siConfirmas: (fuera: string, n: number) => string }> = {
  cierre: { que: 'el cierre de este periodo', siConfirmas: () => 'se cierran todas' },
  pagado: {
    que: 'marcar pagados estos recibos',
    siConfirmas: f => `se marcan pagados esos recibos completos, incluidos sus montos de ${f}`,
  },
  activar: {
    que: 'activar el pago al personal sin elegir sedes',
    siConfirmas: (f, n) => `se ${n > 1 ? 'activan' : 'activa'} también ${f}`,
  },
  propinas: { que: 'cambiar las propinas del recibo', siConfirmas: f => `cambian también las propinas de ${f}` },
}

/** Las sedes de `venueIds` que NO están en la conexión, con su nombre leído acotado a la organización; sin consulta si no hay. */
export async function sedesFueraDeLaConexion(scope: McpScope, venueIds: readonly string[]): Promise<SedeFuera[]> {
  const enConexion = new Set(scope.allowedVenueIds) // ronda 1 (R2): con SUPERADMIN, todas las sedes de la plataforma
  const ids = [...new Set(venueIds)].filter(v => !enConexion.has(v)).sort()
  if (!ids.length) return []
  const nombres = await nombresDeSedes(scope.activeOrg, ids)
  return ids.map(venueId => ({ venueId, nombre: nombres.get(venueId) ?? venueId }))
}

/**
 * La regla de B14-fix2 para una acción que abarca `venueIds`, en la vista previa Y al confirmar (el rol se lee cada vez). Sin
 * sedes fuera: nada (ni consulta el rol). Con sedes fuera y quien pide NO es dueño: la negativa. Si es dueño: el aviso.
 */
export async function revisarConexion(
  scope: McpScope,
  accion: AccionDeOrganizacion,
  venueIds: readonly string[],
): Promise<RevisionDeConexion> {
  const fuera = await sedesFueraDeLaConexion(scope, venueIds)
  if (!fuera.length) return { fuera, negada: null, aviso: '' }
  // R5: dueño de la organización, o OWNER en TODAS las sedes que abarca la acción (las de la conexión y las de fuera).
  if (!(await esDueno(scope, venueIds))) {
    const error = `Esta acción incluye ${nombresDe(fuera)}, que no ${fuera.length > 1 ? 'están' : 'está'} en esta conexión. Hazla desde el dashboard o con una conexión que incluya todas las sedes.`
    return { fuera, aviso: '', negada: text({ ok: false, code: 'FUERA_DE_LA_CONEXION', error }) }
  }
  const dentro = await nombresDeSedes(scope.activeOrg, scope.allowedVenueIds)
  const conexion = enPalabras([...dentro.values()].sort((a, b) => a.localeCompare(b, 'es')))
  const a = ACCIONES[accion]
  return {
    fuera,
    negada: null,
    aviso: `Ojo: esta conexión es sólo de ${conexion}, pero ${a.que} incluye también ${nombresDe(fuera)}. Si confirmas, ${a.siConfirmas(nombresDe(fuera), fuera.length)}.`,
  }
}

/** El mensaje de la vista previa con el aviso al inicio (si lo hay). */
export const conAviso = (r: RevisionDeConexion, mensaje: string) => (r.aviso ? `${r.aviso} ${mensaje}` : mensaje)
/** `sedesFueraDeLaConexion` para la vista previa del dueño y el ActivityLog; nada sin sedes fuera (igual que antes). */
export const camposFuera = (r: RevisionDeConexion) => (r.fuera.length ? { sedesFueraDeLaConexion: r.fuera } : {})

const firma = (prefijo: string, fuera: ReadonlyArray<{ venueId: string }>) =>
  createHash('sha256')
    .update(`${prefijo}|${fuera.map(s => s.venueId).join(',')}`)
    .digest('hex')
/** La huella que se confirma: la del service y, con sedes fuera, `~` y la firma de su lista ordenada (≤ 105 de 128). */
export const huellaConFuera = (huella: string, fuera: ReadonlyArray<{ venueId: string }>) =>
  fuera.length ? `${huella}~${firma('fuera', fuera).slice(0, 40)}` : huella
/** La parte de la huella confirmada que no es la firma de las sedes fuera (la del service, o la de activar). */
export const baseDeLaHuella = (confirmada: string) => {
  const i = confirmada.indexOf('~')
  return i < 0 ? confirmada : confirmada.slice(0, i)
}
/** La de cambiar las propinas: sin sedes fuera no hay (como antes); con ellas, la firma de la acción y de su lista. */
export const huellaDePropinas = (encender: boolean, fuera: SedeFuera[]) => (fuera.length ? firma(`propinas|${encender}`, fuera) : null)

/** Lo que responde un confirmar cuyas sedes fuera ya no son las de la vista previa: nada se escribe. */
export const sedesFueraCambiaron = (fuera: SedeFuera[]) =>
  text({
    ok: false,
    code: 'SEDES_FUERA_CAMBIARON',
    error: `Las sedes fuera de esta conexión que incluye esta acción cambiaron desde la vista previa (ahora: ${fuera.length ? nombresDe(fuera) : 'ninguna'}). Pide una vista previa nueva (sin confirm) y muéstrasela al usuario antes de confirmar.`,
  })

/**
 * Al confirmar (cierre y marcar pagado): revalida quién pide y las sedes fuera de AHORA, y comprueba que la huella confirmada
 * lleve EXACTAMENTE su firma. Devuelve la huella del service para escribir, o la respuesta que lo impide.
 */
export async function confirmarConexion(
  scope: McpScope,
  accion: AccionDeOrganizacion,
  venueIds: readonly string[],
  confirmada: string,
): Promise<{ respuesta: null; huella: string; rev: RevisionDeConexion } | { respuesta: Respuesta }> {
  const rev = await revisarConexion(scope, accion, venueIds)
  if (rev.negada) return { respuesta: rev.negada }
  const huella = baseDeLaHuella(confirmada)
  return huellaConFuera(huella, rev.fuera) === confirmada ? { respuesta: null, huella, rev } : { respuesta: sedesFueraCambiaron(rev.fuera) }
}

/** Las sedes de la vista previa que trae un rechazo (`details.preview.periodo.venueIds`); null si no la trae legible. */
const sedesDeLaVistaDelRechazo = (e: unknown): string[] | null => {
  const ids = (e as { details?: { preview?: { periodo?: { venueIds?: unknown } } } } | null)?.details?.preview?.periodo?.venueIds
  return Array.isArray(ids) && ids.every(v => typeof v === 'string') ? ids : null
}

/**
 * I1 (ronda 1 de B14-fix2): un 4xx del cierre (sobre todo al CONFIRMAR) trae datos recalculados DESPUÉS de `confirmarConexion`: si una
 * sede fuera de la conexión entró al alcance entretanto, `HUELLA_CAMBIO` manda una vista previa nueva con ella (total, personas,
 * propinas sin dueño… de toda la organización) y los demás rechazos cuentan sus clases. Se revisa contra las sedes de ESE rechazo: las
 * de su vista previa o, si no la trae legible, las del cierre de AHORA (`sedesAhora`). Quien no es dueño ⇒ FUERA_DE_LA_CONEXION, sin
 * la vista previa; el dueño ⇒ el rechazo de siempre (vista previa acotada, B14-fix F1) con el aviso al inicio y la lista; sin sedes
 * fuera, igual que antes. Un 500 se propaga sin leer nada; si la relectura falla, el rechazo de siempre.
 */
export async function falloDelCierre(scope: McpScope, e: unknown, sedesAhora: () => Promise<string[]>): Promise<Respuesta> {
  const cuerpo = cuerpoDelFallo(scope, e) // lanza si no es un 4xx
  let sedes = sedesDeLaVistaDelRechazo(e)
  if (!sedes) {
    try {
      sedes = await sedesAhora()
    } catch {
      return text(cuerpo)
    }
  }
  const rev = await revisarConexion(scope, 'cierre', sedes)
  if (rev.negada) return rev.negada
  return text(rev.fuera.length ? { ...cuerpo, error: conAviso(rev, cuerpo.error), ...camposFuera(rev) } : cuerpo)
}

/**
 * I1: el «ya estaba cerrado» (otra persona lo cerró entre la validación y la transacción) trae el total, las personas y las sedes
 * de ESE cierre: el mismo chequeo sobre sus sedes. Quien no es dueño ⇒ la negativa; el dueño, con la lista (sin aviso: no hay
 * nada que confirmar); sin sedes fuera, igual que antes.
 */
export async function yaCerradoRevisado(scope: McpScope, r: { venueIds: string[] }): Promise<Respuesta> {
  const rev = await revisarConexion(scope, 'cierre', r.venueIds)
  return rev.negada ?? text({ ok: true, ...r, ...camposFuera(rev) })
}
