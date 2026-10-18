/**
 * IVA por producto, plan 6b (spec D12, §5.5): qué aparatos del negocio imprimen el IVA mal. Para ENCENDER, todos los vistos en 30 días
 * deben estar en su versión mínima y no debe haber sesiones del POS sin identidad en 30 días, con 30 días completos de observación.
 * Encendido, lo mismo es sólo un AVISO: un aparato viejo nunca bloquea una venta.
 */
import { Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'

import { normalizeTerminalBrand } from '@/lib/providerDeviceCompatibility'
import { versionAlMenos } from '@/services/dashboard/receiptLayout/readiness.service'
import { OBSERVADOR_POS_DESDE, POS_SIN_APARATO_MUESTREO_MS } from '@/services/mobile/deviceRegistry.service'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'

/** Versiones que ya imprimen «IVA incluido cuando aplica» (plan 7a; fila 6b del proyecto, 12-oct). Sin mínimo ⇒ viejo. */
export const IVA_POR_PRODUCTO_MIN_TPV_VERSION_CODE = 117 // PAX 2.12.4 y Nexgo 2.12.4-nexgo-prod
export const IVA_POR_PRODUCTO_MIN_POS_ANDROID_VERSION = '2.23.0' // también el POS de Windows (avoqado-android desktop)
export const IVA_POR_PRODUCTO_MIN_POS_IOS_VERSION = '1.15.0'
export const DIAS_DE_OBSERVACION = 30
const DIA_MS = 24 * 60 * 60 * 1000
/** Los que imprimen un ticket con IVA. Impresoras y KDS no calculan IVA. SIN filtro de estado: un aparato visto cuenta. */
const TIPOS_QUE_IMPRIMEN = ['TPV_ANDROID', 'TPV_IOS', 'POS_ANDROID', 'POS_IOS', 'POS_DESKTOP']
const PAGINA = 200

export type CodigoBloqueo =
  | 'CONTABILIDAD'
  | 'DOCUMENTOS_EN_VUELO'
  | 'FACTURA_VIEJA_SIN_SELLO'
  | 'POS_EXTERNO'
  | 'APARATOS_VERIFICACION_PENDIENTE'
  | 'APARATO_VIEJO'
  | 'POS_SIN_IDENTIDAD'
  | 'AJUSTE_DE_DELIVERY' // el producto que se edita (revisión final, Minor nuevo 2)
export type Bloqueo = { codigo: CodigoBloqueo; mensaje: string; comoArreglar: string }
export type AvisoIva = { codigo: 'APARATO_VIEJO' | 'POS_SIN_IDENTIDAD'; mensaje: string }
export type DbLectura = Pick<Prisma.TransactionClient, '$queryRaw' | 'venuePosSinAparato'>
export type AparatoParaIva = {
  id: string
  name: string
  type: string
  brand: string | null
  version: string | null
  appVersionCode: number | null
}
export type RevisionDeAparatos = {
  observacion: { completa: boolean; faltanDias: number }
  viejos: AparatoParaIva[]
  sinIdentidad: { ultimaVez: Date } | null
}

export function soportaIvaPorProducto(a: AparatoParaIva): boolean {
  if (a.type === 'POS_ANDROID') return versionAlMenos(a.version, IVA_POR_PRODUCTO_MIN_POS_ANDROID_VERSION)
  if (a.type === 'POS_IOS') return versionAlMenos(a.version, IVA_POR_PRODUCTO_MIN_POS_IOS_VERSION)
  if (a.type === 'TPV_ANDROID') {
    const marca = normalizeTerminalBrand(a.brand)
    return (
      (marca === 'PAX' || marca === 'NEXGO') &&
      typeof a.appVersionCode === 'number' &&
      a.appVersionCode >= IVA_POR_PRODUCTO_MIN_TPV_VERSION_CODE
    )
  }
  return false // TPV_IOS y POS_DESKTOP (avoqado-desktop, spec §3): no hay versión que imprima bien
}

/** Todos los aparatos que imprimen, vistos desde `desde`, en páginas de 200 por id (sin tope). La versión de la terminal, de su último latido. */
export async function aparatosVistos(db: DbLectura, venueId: string, desde: Date): Promise<AparatoParaIva[]> {
  const todos: AparatoParaIva[] = []
  for (let cursor = ''; ; ) {
    const pagina = await db.$queryRaw<AparatoParaIva[]>`
      SELECT t.id, t.name, t.type::text AS type, t.brand, t.version, h."appVersionCode"
      FROM "Terminal" t
      LEFT JOIN LATERAL (
        SELECT th."appVersionCode" FROM "TerminalHealth" th
        WHERE th."venueId" = t."venueId" AND th."terminalId" = t.id
        ORDER BY th."createdAt" DESC LIMIT 1
      ) h ON true
      WHERE t."venueId" = ${venueId} AND t.type::text = ANY(${TIPOS_QUE_IMPRIMEN}::text[])
        AND t."lastHeartbeat" >= ${utcTs(desde)} AND t.id > ${cursor}
      ORDER BY t.id LIMIT ${PAGINA}`
    todos.push(...pagina)
    if (pagina.length < PAGINA) return todos
    cursor = pagina[pagina.length - 1].id
  }
}

export async function revisarAparatos(venueId: string, ahora = new Date(), db: DbLectura = prisma): Promise<RevisionDeAparatos> {
  const desde = new Date(ahora.getTime() - DIAS_DE_OBSERVACION * DIA_MS)
  const restante = OBSERVADOR_POS_DESDE.getTime() + DIAS_DE_OBSERVACION * DIA_MS - ahora.getTime()
  const viejos = (await aparatosVistos(db, venueId, desde)).filter(a => !soportaIvaPorProducto(a))
  const marca = await db.venuePosSinAparato.findUnique({ where: { venueId }, select: { ultimaVez: true } })
  // La fecha guardada es MUESTREADA (bloque A): la última petición real pudo llegar hasta una hora después.
  const vigente = marca && marca.ultimaVez.getTime() + POS_SIN_APARATO_MUESTREO_MS >= desde.getTime()
  return {
    observacion: { completa: restante <= 0, faltanDias: Math.max(0, Math.ceil(restante / DIA_MS)) },
    viejos,
    sinIdentidad: vigente ? { ultimaVez: marca.ultimaVez } : null,
  }
}

const fechaLocal = (d: Date, tz: string) => formatInTimeZone(d, tz, 'dd/MM/yyyy')
const ACTUALIZA = 'Actualiza su app: terminal 2.12.4, Android 2.23.0 o iPhone/iPad 1.15.0, o más nueva.'

/** Codex código r1 #6 (Ruling CX-6): mientras falte la observación, la fecha se SUMA a los aparatos viejos ya vistos (no los tapa). */
export function bloqueosDeAparatos(r: RevisionDeAparatos, tz: string): Bloqueo[] {
  return [
    ...(r.observacion.completa
      ? []
      : [
          {
            codigo: 'APARATOS_VERIFICACION_PENDIENTE' as const,
            mensaje: `Verificación pendiente: ${r.observacion.faltanDias === 1 ? 'falta 1 día' : `faltan ${r.observacion.faltanDias} días`}`,
            comoArreglar:
              'Avoqado necesita 30 días observando los aparatos de tu negocio antes de encender el IVA por producto. Vuelve a intentarlo después.',
          },
        ]),
    ...r.viejos.map(v => ({
      codigo: 'APARATO_VIEJO' as const,
      mensaje: `${v.name} imprime el IVA de forma incorrecta`,
      comoArreglar: ACTUALIZA,
    })),
    ...(r.sinIdentidad
      ? [
          {
            codigo: 'POS_SIN_IDENTIDAD' as const,
            mensaje: `Un celular con una versión vieja de la app se usó el ${fechaLocal(r.sinIdentidad.ultimaVez, tz)}`,
            comoArreglar: 'Actualiza las apps de tus celulares. Esta revisión pasa sola 30 días después de la última vez.',
          },
        ]
      : []),
  ]
}

export function avisosDeAparatos(r: RevisionDeAparatos, tz: string): AvisoIva[] {
  return [
    ...r.viejos.map(v => ({ codigo: 'APARATO_VIEJO' as const, mensaje: `${v.name} imprime el IVA de forma incorrecta; actualízalo` })),
    ...(r.sinIdentidad
      ? [
          {
            codigo: 'POS_SIN_IDENTIDAD' as const,
            mensaje: `Un celular con una versión vieja de la app se usó el ${fechaLocal(r.sinIdentidad.ultimaVez, tz)}; actualiza las apps de tus celulares. Este aviso se quita solo 30 días después de la última vez.`,
          },
        ]
      : []),
  ]
}
