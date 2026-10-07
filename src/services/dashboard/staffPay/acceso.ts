import prisma from '../../../utils/prismaClient'
import { BadRequestError, ForbiddenError } from '../../../errors/AppError'
import { getUserAccess, hasPermission } from '../../access/access.service'
import { venueHasFeatureAccess, venuesWithFeatureAccess } from '../../access/basePlan.service'

/** Cómo se consigue el plan: las mismas palabras que las rutas, el MCP y los servicios (spec fase 3 §10, decisión D3). */
const COMO_SE_CONSIGUE = 'viene en el plan Pro o se contrata suelto por sucursal'

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

export const MENSAJE_SIN_ACTIVAR = 'Pago al personal todavía no está activado: actívalo en Pago por servicio → Periodos.'

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
  try {
    return hasPermission(await getUserAccess(userId, venueId), permiso)
  } catch {
    return false
  }
}

export async function assertPermisoEnTodasLasSedes(userId: string, organizationId: string, permiso: string): Promise<void> {
  const sedes = await sedesConServicePay(organizationId)
  if (sedes.length === 0)
    throw new ForbiddenError(`Pago por servicio no está activo en ninguna sede de esta organización: ${COMO_SE_CONSIGUE}.`)
  for (const venueId of sedes) {
    if (!(await tienePermiso(userId, venueId, permiso))) {
      throw new ForbiddenError(`Esta acción afecta a toda la organización: necesitas ${permiso} en todas las sedes`)
    }
  }
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
