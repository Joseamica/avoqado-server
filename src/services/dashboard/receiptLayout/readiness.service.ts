import prisma from '@/utils/prismaClient'
import { NotFoundError } from '@/errors/AppError'
import { normalizeTerminalBrand } from '@/lib/providerDeviceCompatibility'
import { buildVenueInfo, type ReceiptVenueInfo } from '@/services/shared/receiptLayout'

/**
 * Los tipos de terminal que INTERPRETAN la receta del ticket (spec § 7.5).
 *
 * 🔴 Impresoras (`PRINTER_*`) y KDS quedan FUERA a propósito: son periféricos, no apps con
 * intérprete. Contarlas daría un «no soporta» permanente que asusta al negocio sin informarle
 * de nada — y la lista de aparatos existe justamente para no mentirle.
 */
const TIPOS_QUE_INTERPRETAN = ['TPV_ANDROID', 'TPV_IOS', 'POS_ANDROID', 'POS_IOS', 'POS_DESKTOP'] as const

/**
 * Versión mínima que sabe interpretar una receta, para un aparato de este TIPO y esta MARCA.
 *
 * 🔴 Sin variable = `MAX_SAFE_INTEGER` a propósito: los intérpretes son las fases 3 (Android,
 * iOS) y 4 (terminales), y `POS_DESKTOP` ni siquiera está en el alcance del spec. Al desplegar,
 * NINGÚN aparato aplica el diseño — y el banner tiene que decirlo. Cada fase pone su número
 * cuando su app esté publicada, en el MISMO cambio. Ponerlo antes vuelve el banner una mentira.
 *
 * 🔴 La terminal Android se mide por MARCA, nunca por tipo: la PAX y la Nexgo comparten
 * `Terminal.type` y `versionCode`, pero imprimen con motores distintos (Neptune contra AngelPay).
 * Un mínimo por tipo contaría como «ya lo aplica» a la marca que todavía no tiene el intérprete.
 * Por eso `RECEIPT_LAYOUT_MIN_TPV_ANDROID` se IGNORA, y una marca que no es PAX ni Nexgo nunca
 * se da por soportada.
 *
 * Pura (el entorno entra por parámetro) para poder probarla sin recargar el módulo.
 */
const MARCAS_DE_TERMINAL_ANDROID = ['PAX', 'NEXGO'] as const

export function minimoDeVersion(type: string, brand: string | null | undefined, env: NodeJS.ProcessEnv = process.env): number {
  let variable: string
  if (type === 'TPV_ANDROID') {
    const marca = normalizeTerminalBrand(brand)
    if (!marca || !(MARCAS_DE_TERMINAL_ANDROID as readonly string[]).includes(marca)) return Number.MAX_SAFE_INTEGER
    variable = `RECEIPT_LAYOUT_MIN_TPV_ANDROID_${marca}`
  } else {
    variable = `RECEIPT_LAYOUT_MIN_${type}`
  }
  const valor = Number(env[variable])
  return env[variable] !== undefined && Number.isInteger(valor) && valor >= 0 ? valor : Number.MAX_SAFE_INTEGER
}

/** «2.18.3-dev» → [2, 18, 3]. Lo que no empieza con número → null (versión desconocida = no soporta). */
export function parseVersionName(v: string | null | undefined): [number, number, number] | null {
  const m = v?.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!m) return null
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

/**
 * Las tablets mandan `x-app-version` como NOMBRE de versión y el registro lo guarda en
 * `Terminal.version` (deviceRegistry.service.ts). No escriben `TerminalHealth`, así que medirlas
 * por `appVersionCode` las daba SIEMPRE por «versión desconocida», aun actualizadas.
 * Sin la variable del mínimo, ninguna cuenta: la fase de cada app la pone al publicarse.
 */
export function posSoportaDiseno(
  type: 'POS_ANDROID' | 'POS_IOS',
  version: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const minimum = parseVersionName(env[`RECEIPT_LAYOUT_MIN_${type}_VERSION`])
  const actual = parseVersionName(version)
  if (!minimum || !actual) return false
  for (let i = 0; i < 3; i++) if (actual[i] !== minimum[i]) return actual[i] > minimum[i]
  return true
}

export interface ReceiptReadiness {
  fiscalEmisor: boolean
  logo: boolean
}

/**
 * ¿Tiene el negocio los DATOS para que el ticket salga completo? (spec § 5.5)
 * El ticket nunca inventa un dato para rellenar; el diseñador avisa antes.
 */
export async function getReceiptReadiness(venueId: string): Promise<ReceiptReadiness> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { logo: true, rfc: true, legalName: true, fiscalEmisors: { select: { id: true }, take: 1 } },
  })
  if (!venue) return { fiscalEmisor: false, logo: false }

  // 🔴 Las columnas legacy de Venue CUENTAN: son lo que la PAX imprime hoy (spec § 5.6, caso 3).
  const tieneFiscal = venue.fiscalEmisors.length > 0 || Boolean(venue.rfc) || Boolean(venue.legalName)
  return { fiscalEmisor: tieneFiscal, logo: Boolean(venue.logo) }
}

export interface ReceiptDevices {
  supporting: number
  /** `brand` normalizada (PAX, NEXGO…): «TPV_ANDROID» a secas no dice cuál terminal falta actualizar. */
  notSupporting: Array<{ name: string; platform: string; brand: string | null; appVersion: string | null }>
}

/**
 * ¿Cuántos aparatos del venue van a OBEDECER esta receta? (spec § 7.5)
 *
 * 🔴 Versión desconocida = NO soporta. Es el lado conservador: decirle al negocio que su
 * diseño ya está vivo cuando no lo sabemos es peor que decirle que falta actualizar.
 */
export async function getReceiptDevices(venueId: string, env: NodeJS.ProcessEnv = process.env): Promise<ReceiptDevices> {
  const terminales = await prisma.terminal.findMany({
    where: { venueId, type: { in: [...TIPOS_QUE_INTERPRETAN] }, status: { in: ['ACTIVE', 'INACTIVE'] } },
    // TerminalHealth es un HISTÓRICO (no hay una fila por aparato): se toma la más reciente,
    // el mismo patrón que orgTerminals.service.ts:99.
    select: {
      name: true,
      type: true,
      brand: true,
      version: true,
      healthMetrics: { take: 1, orderBy: { createdAt: 'desc' }, select: { appVersionCode: true, appVersion: true } },
    },
    take: 200,
  })

  const devices: ReceiptDevices = { supporting: 0, notSupporting: [] }
  for (const t of terminales) {
    const salud = t.healthMetrics[0]
    const esTablet = t.type === 'POS_ANDROID' || t.type === 'POS_IOS'
    const soporta = esTablet
      ? posSoportaDiseno(t.type as 'POS_ANDROID' | 'POS_IOS', t.version, env)
      : typeof salud?.appVersionCode === 'number' && salud.appVersionCode >= minimoDeVersion(t.type, t.brand, env)
    if (soporta) devices.supporting += 1
    else
      devices.notSupporting.push({
        name: t.name,
        platform: t.type,
        brand: normalizeTerminalBrand(t.brand) ?? null,
        appVersion: (esTablet ? t.version : salud?.appVersion) ?? null,
      })
  }
  return devices
}

/**
 * El venue tal como lo necesita el ticket, cargado de Prisma.
 *
 * 🔴 Reusa `buildVenueInfo` del adaptador: si la vista previa mapeara por su cuenta, dejaría
 * de predecir el ticket real — que es lo único que la hace útil. El `select` pide los emisores
 * por fecha de alta, que es el criterio del «principal» (spec § 5.6, caso 2).
 */
export async function cargarVenueInfo(venueId: string): Promise<ReceiptVenueInfo> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: {
      name: true,
      address: true,
      city: true,
      state: true,
      zipCode: true,
      phone: true,
      logo: true,
      rfc: true,
      legalName: true,
      timezone: true,
      fiscalEmisors: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          legalName: true,
          rfc: true,
          lugarExpedicion: true,
          merchantConfigs: { select: { merchantAccountId: true } },
        },
      },
    },
  })
  if (!venue) throw new NotFoundError('No se encontró el negocio', 'VENUE_NOT_FOUND')
  return buildVenueInfo(venue)
}
