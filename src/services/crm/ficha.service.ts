/**
 * C2 · Ficha editable (plan 2026-11-06): los datos del negocio y sus personas, cambiados desde la ficha (o por el MCP del
 * superadmin) sin pisar nunca lo que otra persona cambió mientras se veía.
 *
 * El orden es el mismo en cada escritor (pasada de la familia tras Codex r2, §c): (1) el candado de la fila
 * (`lockEditableTx`: 404 si no la ve, 403 si la ve y no la edita); (2) «¿ya está hecho esto mismo?» → éxito sin escribir,
 * sin evento, sin ActivityLog y sin toque; (3) comparar `vio` (lo que la pantalla enseñaba) con lo guardado → 409
 * `CRM_CAMBIO_AL_EDITAR` con `ahora`; (4) escribir. Ningún evento ni ActivityLog lleva datos de personas.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import type { CrmAccess } from './access.service'
import { lockEditableTx, touchNoEarlierTx } from './accounts.service'
import { cambioAlEditar, mismoTexto } from './loQueSeVio'
import { addEvent } from './timeline.service'

// ── Datos del negocio ─────────────────────────────────────────────────────────────────────────────────────────────────

export const CAMPOS_DEL_NEGOCIO = ['name', 'giro', 'ventasRango', 'sucursales', 'modulos', 'referidoPor'] as const
export type CampoDelNegocio = (typeof CAMPOS_DEL_NEGOCIO)[number]
export type DatosDelNegocio = {
  name: string
  giro: string | null
  ventasRango: string | null
  sucursales: number | null
  modulos: string[]
  referidoPor: string | null
}

/** Los que califican: cambiarlos fija `qualifiedAt` (una entrada vieja de la landing ya no los pisa) y son los únicos con valores en la Historia. */
const CALIFICAN: ReadonlySet<CampoDelNegocio> = new Set(['giro', 'ventasRango', 'sucursales', 'modulos'])

/** Una lista como se guarda: recortada, sin vacíos ni repetidos, en el mismo orden. */
export const listaLimpia = (lista?: readonly string[] | null): string[] => [
  ...new Set((lista ?? []).map(item => item.trim()).filter(Boolean)),
]

const textoOnull = (valor?: string | null) => (valor ?? '').trim() || null

/** El valor como se guarda. */
function limpio(campo: CampoDelNegocio, valor: unknown): unknown {
  if (campo === 'modulos') return listaLimpia(valor as string[] | null)
  if (campo === 'sucursales') return valor ?? null
  if (campo === 'name') return (valor as string).trim()
  return textoOnull(valor as string | null)
}

function igual(campo: CampoDelNegocio, a: unknown, b: unknown): boolean {
  if (campo === 'modulos') {
    const [x, y] = [listaLimpia(a as string[] | null), listaLimpia(b as string[] | null)]
    return x.length === y.length && x.every((item, i) => item === y[i])
  }
  if (campo === 'sucursales') return (a ?? null) === (b ?? null)
  return mismoTexto(a as string | null, b as string | null)
}

/**
 * Cambia los datos del negocio (nombre, giro, ventas, sucursales, módulos, «Lo recomendó»). Sólo se comparan con `vio` los
 * campos que de verdad cambian; pedir lo que ya está guardado es un no-op (`cambiados: []`) aunque `vio` sea viejo.
 */
export async function updateAccount(
  access: CrmAccess,
  accountId: string,
  input: { cambios: Partial<DatosDelNegocio>; vio: Partial<DatosDelNegocio> },
): Promise<{ accountId: string; cambiados: CampoDelNegocio[] }> {
  const now = new Date()
  const { cambiados, organizationId } = await prisma.$transaction(async tx => {
    await lockEditableTx(tx, access, accountId)
    const guardado = await tx.crmAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { name: true, giro: true, ventasRango: true, sucursales: true, modulos: true, referidoPor: true, organizationId: true },
    })
    const cambiados = CAMPOS_DEL_NEGOCIO.filter(campo => campo in input.cambios && !igual(campo, input.cambios[campo], guardado[campo]))
    if (!cambiados.length) return { cambiados, organizationId: guardado.organizationId }

    const viejos = cambiados.filter(campo => !igual(campo, input.vio[campo], guardado[campo]))
    if (viejos.length) throw cambioAlEditar(Object.fromEntries(viejos.map(campo => [campo, guardado[campo]])))

    const data: Prisma.CrmAccountUpdateInput = Object.fromEntries(cambiados.map(campo => [campo, limpio(campo, input.cambios[campo])]))
    // Como el alta a mano y la landing: una calificación nueva gana a una entrada vieja reparada tarde (ruling 65 e).
    if (cambiados.some(campo => CALIFICAN.has(campo))) Object.assign(data, { qualifiedAt: now, qualificationAvailable: true })
    await touchNoEarlierTx(tx, accountId, now)
    await tx.crmAccount.update({ where: { id: accountId }, data, select: { id: true } })
    for (const campo of cambiados) {
      // El nombre del negocio y «Lo recomendó» pueden ser nombres de personas: la Historia sólo dice que cambiaron (Duda 1).
      const valores = CALIFICAN.has(campo)
        ? { de: guardado[campo] as Prisma.InputJsonValue | null, a: limpio(campo, input.cambios[campo]) as Prisma.InputJsonValue | null }
        : {}
      await addEvent(tx, { accountId, kind: 'ACCOUNT_EDIT', actorStaffId: access.staffId, data: { campo, ...valores } })
    }
    return { cambiados, organizationId: guardado.organizationId }
  })
  if (cambiados.length) {
    void logAction({
      staffId: access.staffId,
      venueId: null,
      organizationId,
      action: 'CRM_ACCOUNT_UPDATED',
      entity: 'CrmAccount',
      entityId: accountId,
      data: { campos: cambiados },
    })
  }
  return { accountId, cambiados }
}
