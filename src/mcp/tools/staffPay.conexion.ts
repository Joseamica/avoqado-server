// src/mcp/tools/staffPay.conexion.ts — fase 3, B14-fix2 (decisión del founder, 7-oct): las escrituras del MCP de pago al personal
// que por naturaleza abarcan a TODA la organización (cerrar el periodo, marcar pagados recibos enteros, activar sin elegir sedes y
// cambiar las propinas) pedidas desde una conexión que no tiene todas sus sedes. Al DUEÑO no se le niegan: su vista previa lo
// AVISA al inicio, trae `sedesFueraDeLaConexion` y la confirmación queda atada a esa lista; a los demás, FUERA_DE_LA_CONEXION sin
// un dato ni un monto de esas sedes. Al confirmar se revalida todo (rol y sedes fuera de AHORA). Sin sedes fuera, nada cambia.
import { createHash } from 'crypto'
import type { McpScope } from '../scope'
import { text } from '../respond'
import { esDueno, nombresDeSedes } from './staffPay.alcanceDeLaAccion'
import { lista } from './staffPay.formato'

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
  const ids = [...new Set(venueIds)].filter(v => !scope.allowedVenueIds.includes(v)).sort()
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
  if (!(await esDueno(scope))) {
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

const firma = (prefijo: string, fuera: SedeFuera[]) =>
  createHash('sha256')
    .update(`${prefijo}|${fuera.map(s => s.venueId).join(',')}`)
    .digest('hex')
/** La huella que se confirma: la del service y, con sedes fuera, `~` y la firma de su lista ordenada (≤ 105 de 128). */
export const huellaConFuera = (huella: string, fuera: SedeFuera[]) =>
  fuera.length ? `${huella}~${firma('fuera', fuera).slice(0, 40)}` : huella
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
  const i = confirmada.indexOf('~')
  const huella = i < 0 ? confirmada : confirmada.slice(0, i)
  return huellaConFuera(huella, rev.fuera) === confirmada ? { respuesta: null, huella, rev } : { respuesta: sedesFueraCambiaron(rev.fuera) }
}
