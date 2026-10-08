import prisma from '../../../utils/prismaClient'
import { BadRequestError, ForbiddenError } from '../../../errors/AppError'
import { getUserAccess, hasPermission } from '../../access/access.service'
import { venueHasFeatureAccess, venuesWithFeatureAccess } from '../../access/basePlan.service'
import { auditarAccesoNegado } from '../accesoNegado'
import { COMO_SE_CONSIGUE_EL_PLAN } from './textos'

/**
 * El PLAN: la función SERVICE_PAY (plan Pro, suelta por sucursal, sede exenta o demo), con el resolver de funciones del
 * plan (spec fase 3 §10, decisión D3). 🔴 Nunca el de módulos: el módulo SERVICE_PAY ya no existe (Bloque C) y cruzar
 * resolvers falla en silencio (`.claude/rules/feature-gating.md`).
 */
export async function venueHasServicePayAccess(venueId: string): Promise<boolean> {
  return venueHasFeatureAccess(venueId, 'SERVICE_PAY')
}

/**
 * La activación explícita (spec fase 3 §7.1): el dueño apretó «Activar pago al personal» (`staffPayStartDate`). Se lee aquí y
 * no con `estadoActivacion` porque `activacion.service` importa este archivo.
 */
export async function organizacionActivada(organizationId: string): Promise<boolean> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { staffPayStartDate: true } })
  return org?.staffPayStartDate != null
}

/**
 * La misma pregunta desde una sede: el gate de las rutas y el MCP sólo conocen la sede del URL. La puerta de dinero es de la
 * ORGANIZACIÓN (pre-flight C2, fila 13): NO pregunta si esta sede tiene su ventana de participación (`activarSede`, B11).
 */
export async function organizacionDeLaSedeActivada(venueId: string): Promise<boolean> {
  const v = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
  return !!v && (await organizacionActivada(v.organizationId))
}

/**
 * Con el plan pero sin activar. Activar pide `staffpay:close` en TODAS las sedes con el plan (`activacion.service`), así que el
 * texto dice a quién pedírselo (feature-gating.md: «apagado se ve y se explica»). Un solo nombre: «Pago al personal».
 */
export const MENSAJE_SIN_ACTIVAR =
  'Pago al personal todavía no está activado: actívalo en Pago al personal → Periodos. Activarlo pide el permiso de cerrar periodos en todas las sucursales; si no lo tienes, pídeselo al dueño del negocio.'

/** Tope de sedes con el plan por organización: el alcance de un periodo (y sus permisos) se resuelve completo en memoria. */
export const TOPE_SEDES_CON_MODULO = 500
const LOTE_SEDES = 500

/**
 * Sedes de la organización con pago al personal en su plan: el alcance de toda operación de organización (spec §5.7, §9.2).
 * Recorre TODAS las sedes por páginas (cursor por id) y resuelve el plan en lote (`venuesWithFeatureAccess`, la misma regla
 * que `venueHasFeatureAccess`: exentas y demos también lo tienen). Con más del tope se NIEGA (Codex bloque A #2): un recorte
 * dejaba fuera del cierre, del alcance guardado y del recibo el dinero de la sede 501 sin avisar. Usa el cliente GLOBAL: quien
 * lo necesite dentro de una foto o una transacción lo resuelve ANTES y lo pasa como dato (nunca un `tx` al resolver).
 */
export async function sedesConServicePay(organizationId: string): Promise<string[]> {
  const activas: string[] = []
  let despuesDe: string | undefined
  for (;;) {
    const page = await prisma.venue.findMany({
      where: { organizationId, ...(despuesDe ? { id: { gt: despuesDe } } : {}) },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: LOTE_SEDES,
    })
    if (!page.length) break
    const ids = page.map(v => v.id)
    const conPlan = await venuesWithFeatureAccess(ids, 'SERVICE_PAY')
    for (const id of ids) if (conPlan.has(id)) activas.push(id)
    if (activas.length > TOPE_SEDES_CON_MODULO) {
      throw new BadRequestError(
        `Esta organización tiene más de ${TOPE_SEDES_CON_MODULO} sedes con Pago por servicio en su plan: el cierre no puede continuar; contacta a Avoqado.`,
        'DEMASIADAS_SEDES',
      )
    }
    if (page.length < LOTE_SEDES) break
    despuesDe = page[page.length - 1].id
  }
  return activas
}

async function tienePermiso(userId: string, venueId: string, permiso: string): Promise<boolean> {
  return (await permisoYAcceso(userId, venueId, permiso)).tiene
}

/** El permiso y si la persona entra a la sede (para nombrarla). Cualquier error cuenta como «sin permiso», como siempre. */
async function permisoYAcceso(userId: string, venueId: string, permiso: string): Promise<{ tiene: boolean; entra: boolean }> {
  try {
    return { tiene: hasPermission(await getUserAccess(userId, venueId), permiso), entra: true }
  } catch {
    return { tiene: false, entra: false }
  }
}

/** El nombre que ve el dueño en el editor de roles (dashboard, `settings.permissionLabels`): nunca el código interno. */
const NOMBRE_DEL_PERMISO: Record<string, string> = {
  'staffpay:read': 'Ver pago al personal',
  'staffpay:manage': 'Configurar pago al personal',
  'staffpay:close': 'Cerrar periodos y registrar pagos',
}

/**
 * «A, B y 2 sedes donde no tienes acceso». Sólo se nombran las sedes a las que la persona entra (las demás, igual que en la
 * pantalla de sedes, no se le muestran); hasta `max` nombres y el resto en número.
 */
export function listaDeSedes(nombres: string[], sinAcceso: number, max = 5): string {
  const vistos = [...nombres].sort((a, b) => a.localeCompare(b, 'es'))
  const partes = vistos.slice(0, max)
  if (vistos.length > max) partes.push(`${vistos.length - max} más`)
  if (sinAcceso > 0) partes.push(`${sinAcceso} ${sinAcceso === 1 ? 'sede donde no tienes acceso' : 'sedes donde no tienes acceso'}`)
  return partes.length <= 1 ? (partes[0] ?? '') : `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}`
}

/**
 * E6a-fix2 C2: LA regla de las acciones de organización (activar, propinas, periodicidad, niveles): el permiso en TODAS las
 * sedes con el plan. Devuelve la negativa que daría la acción, o `null` si puede. La usan el 403 (`assertPermisoEnTodasLasSedes`)
 * y el booleano de `GET /access` (`puedeAdministrarLaOrganizacion`): una sola regla, no dos. El texto dice qué falta, dónde y a
 * quién pedírselo, con el nombre del permiso y no su código.
 */
export async function negativaDeOrganizacion(
  userId: string,
  organizationId: string,
  permiso: string,
): Promise<{ error: ForbiddenError | BadRequestError; faltanEn: string[] } | null> {
  let sedes: string[]
  try {
    sedes = await sedesConServicePay(organizationId)
  } catch (e) {
    if (e instanceof BadRequestError && e.code === 'DEMASIADAS_SEDES') return { error: e, faltanEn: [] }
    throw e
  }
  if (sedes.length === 0) {
    const sinPlan = `Pago por servicio no está activo en ninguna sede de esta organización: ${COMO_SE_CONSIGUE_EL_PLAN}.`
    return { error: new ForbiddenError(sinPlan), faltanEn: [] }
  }
  const faltan: Array<{ venueId: string; entra: boolean }> = []
  for (const venueId of sedes) {
    const r = await permisoYAcceso(userId, venueId, permiso)
    if (!r.tiene) faltan.push({ venueId, entra: r.entra })
  }
  if (faltan.length === 0) return null
  const visibles = faltan.filter(f => f.entra).map(f => f.venueId)
  const filas = visibles.length
    ? await prisma.venue.findMany({ where: { id: { in: visibles } }, select: { id: true, name: true }, take: visibles.length })
    : []
  const nombres = filas.filter(v => visibles.includes(v.id) && typeof v.name === 'string').map(v => v.name)
  // Lo que no se nombra (sin acceso, o una sede que ya no se encontró) va en número: nunca se pierde de la cuenta.
  const lista = listaDeSedes(nombres, faltan.length - nombres.length)
  const nombre = NOMBRE_DEL_PERMISO[permiso] ?? permiso
  const texto = `Para esto necesitas el permiso «${nombre}» en todas las sedes de la organización (te falta en: ${lista}). Pídeselo al dueño del negocio.`
  return { error: new ForbiddenError(texto, 'FALTA_PERMISO_EN_SEDES'), faltanEn: faltan.map(f => f.venueId) }
}

/**
 * `auditoria`: la sede desde la que se intenta una ESCRITURA. Con ella, la negativa por permiso deja `PERMISSION_DENIED` en la
 * bitácora, como los 403 de escritura del middleware (`checkPermission`). Las vistas previas (el MCP) no la pasan: una lectura
 * rebotada no se audita.
 */
export async function assertPermisoEnTodasLasSedes(
  userId: string,
  organizationId: string,
  permiso: string,
  auditoria?: { venueId: string },
): Promise<void> {
  const negativa = await negativaDeOrganizacion(userId, organizationId, permiso)
  if (!negativa) return
  if (auditoria && negativa.error.code === 'FALTA_PERMISO_EN_SEDES') {
    auditarAccesoNegado({
      staffId: userId,
      venueId: auditoria.venueId,
      organizationId,
      entity: 'permission',
      entityId: permiso,
      reason: 'FALTA_PERMISO_EN_SEDES',
      datos: { permission: permiso, faltanEn: negativa.faltanEn },
    })
  }
  throw negativa.error
}

/** `GET /access` (E6a-fix2 C2): ¿esta persona puede activar y prender las propinas? La MISMA regla que su 403. */
export async function puedeAdministrarLaOrganizacion(userId: string, organizationId: string): Promise<boolean> {
  return (await negativaDeOrganizacion(userId, organizationId, 'staffpay:close')) === null
}

export async function sedesLegibles(userId: string, organizationId: string): Promise<{ venueIds: string[]; parcial: boolean }> {
  const sedes = await sedesConServicePay(organizationId)
  const venueIds: string[] = []
  for (const v of sedes) if (await tienePermiso(userId, v, 'staffpay:read')) venueIds.push(v)
  return { venueIds, parcial: venueIds.length < sedes.length }
}

export async function tienePermisoEn(userId: string, venueId: string, permiso: string): Promise<boolean> {
  return tienePermiso(userId, venueId, permiso)
}

/** Lo que contesta `getUserAccess` cuando la persona de verdad no tiene acceso a la sede (o la sede no existe). */
const SIN_ACCESO = /has no access to venue|^Venue \S+ not found$/

/**
 * Los permisos de `userId` en cada sede, con UNA resolución de acceso por sede para varios permisos (B13: la pantalla de sedes
 * pregunta leer y cerrar en cada una). Cliente global: va ANTES de una foto. Ronda 1 (R4): sólo un sin-acceso REAL cuenta como
 * «sin permisos» (conjunto vacío); cualquier otro error (la base caída, un defecto) se propaga, para que una caída no se lea como
 * «esta persona no ve ninguna sede».
 */
export async function permisosPorSede(userId: string, venueIds: string[], permisos: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  for (const v of [...new Set(venueIds)].sort()) {
    try {
      const access = await getUserAccess(userId, v)
      out.set(v, new Set(permisos.filter(p => hasPermission(access, p))))
    } catch (e) {
      if (!(e instanceof Error && SIN_ACCESO.test(e.message))) throw e
      out.set(v, new Set())
    }
  }
  return out
}

/**
 * Lo HISTÓRICO se lee sobre el alcance del periodo, no sobre las sedes que hoy tienen el plan (Codex R1-1): que BSF lo
 * pierda no puede cambiar el recibo cerrado de Ana ni esconder sus diferencias.
 */
export async function sedesLegiblesDe(userId: string, venueIds: string[]): Promise<{ venueIds: string[]; parcial: boolean }> {
  const todas = [...new Set(venueIds)].sort()
  const legibles: string[] = []
  for (const v of todas) if (await tienePermiso(userId, v, 'staffpay:read')) legibles.push(v)
  return { venueIds: legibles, parcial: legibles.length < todas.length }
}

/**
 * Las sedes de `venueIds` donde `userId` tiene `permiso`. Para resolver el permiso ANTES de una transacción de escritura:
 * usa el cliente GLOBAL, y dentro de la transacción eso retendría su conexión mientras pide otra (la familia de Codex
 * R4-Nuevo 1). Dentro se compara contra este conjunto con `exigirPermisoEnSedes`.
 */
export async function sedesConPermiso(userId: string, venueIds: string[], permiso: string): Promise<string[]> {
  const permitidas: string[] = []
  for (const v of [...new Set(venueIds)].sort()) if (await tienePermiso(userId, v, permiso)) permitidas.push(v)
  return permitidas
}

/** La regla de `assertPermisoEnSedes` contra un conjunto ya resuelto (`sedesConPermiso`). Pura: va dentro de la transacción. */
export function exigirPermisoEnSedes(permitidas: ReadonlySet<string>, venueIds: string[], explicacion: string): void {
  if (venueIds.some(v => !permitidas.has(v))) throw new ForbiddenError(explicacion)
}

/** Exige `permiso` en CADA sede (spec §9.2: cerrar, liquidar, marcar pagado). Revisa en orden fijo. */
export async function assertPermisoEnSedes(userId: string, venueIds: string[], permiso: string, explicacion: string): Promise<void> {
  for (const venueId of [...new Set(venueIds)].sort()) {
    if (!(await tienePermiso(userId, venueId, permiso))) throw new ForbiddenError(explicacion)
  }
}

/**
 * ¿ALGUNA sede de la organización de esta sede tiene el plan? (Codex R2-R1-1, spec §5.6) Las diferencias de UNA clase
 * se leen y se liquidan aunque la sede de la clase ya lo haya perdido: su deuda siempre tiene dónde caer.
 */
export async function organizacionTieneServicePay(venueId: string): Promise<boolean> {
  const v = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
  return !!v && (await sedesConServicePay(v.organizationId)).length > 0
}
