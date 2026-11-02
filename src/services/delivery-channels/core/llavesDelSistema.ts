/**
 * Las llaves de `DeliveryChannelLink.config` que escribe el SISTEMA, nunca el panel.
 *
 * `config` es UNA columna JSON con dos clases de dueño: lo que el negocio edita (horario de delivery, precios del canal) y lo
 * que llevan el sincronizador, los avisos del proveedor y el aprovisionamiento (qué menú está en revisión, cuál se rechazó,
 * qué horario se publicó). Las segundas viven en esta lista para que:
 *   · el PATCH del panel no las borre ni las siembre (`mezclarConfig` las protege), y
 *   · quien las escribe lo haga sobre la fila VIGENTE, bloqueada, y no sobre la copia que trajo de antes.
 *
 * 🔴 POR QUÉ la escritura decide con lo leído bajo candado (Codex plan r3 #2): el job del menú lee los vínculos ANTES de
 * recorrerlos, y dos pasadas pueden encimarse. Con la copia vieja, la segunda pasada no veía el rechazo (ni la aprobación) que
 * la primera ya había guardado y volvía a mandar el mismo menú. `escribirLlavesDelSistema` le pasa a `cambio` lo que la base
 * tiene AHORA, con la fila bloqueada hasta escribir: «sólo si sigue siendo la suya» se decide sin ventana.
 */
import { Prisma } from '@prisma/client'

import prisma from '@/utils/prismaClient'

import type { ProblemaDeMenu } from './types'

export const LLAVES_DEL_SISTEMA = [
  'rappiProvisioning',
  'menuEnRevision',
  'menuRechazado',
  'menuProblemas',
  'horarioPublicado',
  'cerradaEnElProveedor',
] as const
export type LlaveDelSistema = (typeof LLAVES_DEL_SISTEMA)[number]

/** El menú que se mandó y espera veredicto. Fechas en ISO (UTC). */
export interface MenuEnRevision {
  huella: string
  publicadaEn: string
  /** El veredicto anticipado se conserva sin sellar hasta resolver el POST. */
  envioEnCurso?: true
  veredictoAnticipado?: { aprobado: boolean; firmadoEnMs: number }
  /** Cuándo se avisó que el veredicto no llegó en el plazo (se avisa UNA vez por publicación). */
  sinVeredictoAvisadoEn?: string
}
/** Una huella que el proveedor rechazó: no se vuelve a mandar hasta que el menú cambie. */
export interface MenuRechazado {
  huella: string
  en: string
}
/** Lo que el dueño tiene que ver de la última publicación (productos que no salieron, precios ajustados, motivos del rechazo). */
export interface MenuProblemas {
  en: string
  problemas: ProblemaDeMenu[]
}

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** `config` como objeto (lo que no lo es se lee vacío). */
export function configComoObjeto(config: unknown): Record<string, unknown> {
  return esObjeto(config) ? config : {}
}

/** La pendiente de `config`, o `null` si no hay (o si no tiene la forma: una basura no bloquea la publicación). */
export function leerMenuEnRevision(config: unknown): MenuEnRevision | null {
  const p = configComoObjeto(config).menuEnRevision
  if (!esObjeto(p) || typeof p.huella !== 'string' || typeof p.publicadaEn !== 'string') return null
  return {
    huella: p.huella,
    publicadaEn: p.publicadaEn,
    ...(p.envioEnCurso === true ? { envioEnCurso: true as const } : {}),
    ...(esObjeto(p.veredictoAnticipado) &&
    typeof p.veredictoAnticipado.aprobado === 'boolean' &&
    typeof p.veredictoAnticipado.firmadoEnMs === 'number' &&
    Number.isFinite(p.veredictoAnticipado.firmadoEnMs)
      ? { veredictoAnticipado: { aprobado: p.veredictoAnticipado.aprobado, firmadoEnMs: p.veredictoAnticipado.firmadoEnMs } }
      : {}),
    ...(typeof p.sinVeredictoAvisadoEn === 'string' ? { sinVeredictoAvisadoEn: p.sinVeredictoAvisadoEn } : {}),
  }
}

/**
 * D4 (26-oct): el proveedor avisó que la tienda se cerró de SU lado (en Rappi, `STORE_CONNECTIVITY enabled:false`; medido en DEV:
 * nuestra propia pausa NO lo produce). Mientras esté, la pausa del POS que vence no la reabre. La borra sólo quien la reabre
 * desde el panel: un aviso de «abierta» puede llegar viejo y reabriría un cierre nuevo (Codex D4 r3 #4).
 */
export function cerradaEnElProveedor(config: unknown): boolean {
  return esObjeto(configComoObjeto(config).cerradaEnElProveedor)
}

/**
 * Pone la nota en UN UPDATE que mezcla en la base y filtra el estado: no pisa las demás llaves de `config` (ni una escritura
 * bloqueada que esté en curso), y un PENDING o un DISABLED no la estrenan. Devuelve cuántas filas tocó.
 */
export function anotarCerradaEnElProveedor(linkId: string): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "DeliveryChannelLink"
       SET "config" = (CASE WHEN jsonb_typeof("config") = 'object' THEN "config" ELSE '{}'::jsonb END)
                      || jsonb_build_object('cerradaEnElProveedor', jsonb_build_object('desde', ${new Date().toISOString()}::text))
     WHERE "id" = ${linkId} AND "status" IN ('ACTIVE', 'PAUSED')`
}

/** La huella rechazada vigente, o `null`. */
export function leerMenuRechazado(config: unknown): MenuRechazado | null {
  const r = configComoObjeto(config).menuRechazado
  if (!esObjeto(r) || typeof r.huella !== 'string') return null
  return { huella: r.huella, en: typeof r.en === 'string' ? r.en : '' }
}

/**
 * Los problemas de la última publicación, a la vista del dueño. Siempre una lista (vacía si no hay o si la columna no tiene la
 * forma). Sólo pasan las entradas con `sku` y `problema` de texto, y de cada una sólo esos dos campos: una basura heredada en la
 * columna no tumba a quien pregunta, y nada más de lo guardado sale por aquí.
 */
export function leerMenuProblemas(config: unknown): ProblemaDeMenu[] {
  const m = configComoObjeto(config).menuProblemas
  if (!esObjeto(m) || !Array.isArray(m.problemas)) return []
  const problemas: ProblemaDeMenu[] = []
  for (const p of m.problemas as unknown[]) {
    if (esObjeto(p) && typeof p.sku === 'string' && typeof p.problema === 'string') problemas.push({ sku: p.sku, problema: p.problema })
  }
  return problemas
}

/** ¿Es la MISMA publicación? (misma huella y misma hora: otra publicación de la misma huella es otra revisión). */
export function mismaPublicacion(a: MenuEnRevision | null, b: Pick<MenuEnRevision, 'huella' | 'publicadaEn'>): boolean {
  return !!a && a.huella === b.huella && a.publicadaEn === b.publicadaEn
}

/**
 * Lee `config` y `lastMenuHash` con `FOR UPDATE`, le pasa lo leído a `cambio` y, si éste devuelve un parche, lo MEZCLA en
 * `config` (superficial: cada llave del parche reemplaza la suya; `null` la deja en null) y escribe. Devuelve si escribió.
 * Sin fila (el vínculo se borró) no llama a `cambio` y devuelve `false`.
 *
 * Con `db` usa la transacción del llamador (la fila queda bloqueada hasta que ésta termine); sin ella abre una propia.
 * 🔴 `cambio` corre con la fila bloqueada: que no hable con la red.
 */
export async function escribirLlavesDelSistema(
  linkId: string,
  cambio: (fila: { config: Record<string, unknown>; lastMenuHash: string | null }) => Record<string, Prisma.InputJsonValue | null> | null,
  db?: Prisma.TransactionClient,
): Promise<boolean> {
  const escribir = async (tx: Prisma.TransactionClient): Promise<boolean> => {
    const [fila] = await tx.$queryRaw<Array<{ config: Prisma.JsonValue; lastMenuHash: string | null }>>`
      SELECT "config", "lastMenuHash" FROM "DeliveryChannelLink" WHERE "id" = ${linkId} FOR UPDATE`
    if (!fila) return false
    const config = configComoObjeto(fila.config)
    const parche = cambio({ config, lastMenuHash: fila.lastMenuHash ?? null })
    if (!parche) return false
    await tx.deliveryChannelLink.update({
      where: { id: linkId },
      data: { config: { ...config, ...parche } as Prisma.InputJsonObject },
    })
    return true
  }
  return db ? escribir(db) : prisma.$transaction(escribir)
}
