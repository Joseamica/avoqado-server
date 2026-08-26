import { WalletStampShape } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'

/**
 * El diseño de la credencial de un negocio: colores, logo y forma del sello.
 *
 * Existe porque la tarjeta que el cliente guarda en su iPhone es la del NEGOCIO, no
 * la de su proveedor de punto de venta — y hasta ahora salía con los colores de
 * Avoqado para todos. Es lo primero que un prospecto nota al ver su propia tarjeta.
 *
 * 🔴 Nunca lanza por no encontrar fila: un negocio que no ha configurado nada recibe
 * los defaults del tema y su credencial funciona igual. Obligar a configurar antes de
 * poder emitir convertiría un detalle estético en un bloqueo de operación.
 */

export interface CardDesign {
  logoUrl: string | null
  iconUrl: string | null
  backgroundColor: string
  textColor: string
  labelColor: string
  stripColor: string
  stampFilledColor: string
  /** Null = se deriva del color del sello lleno. Ver `stampStripPng.ts`. */
  stampEmptyColor: string | null
  stampShape: WalletStampShape
}

/**
 * 🔴 Tokens REALES del tema oscuro de `avoqado-android` (`designsystem/theme/Color.kt`).
 * No son una paleta inventada, y hay una prueba que falla si alguien los cambia por
 * unos "parecidos": la credencial tiene que sentirse del mismo producto que la app.
 */
export const DEFAULT_CARD_DESIGN: CardDesign = {
  logoUrl: null,
  iconUrl: null,
  backgroundColor: '#1C1C1E',
  textColor: '#FFFFFF',
  labelColor: '#98989D',
  stripColor: '#2C2C2E',
  stampFilledColor: '#7ADD2C',
  stampEmptyColor: null,
  stampShape: WalletStampShape.CIRCLE,
}

/** Los campos que un negocio puede editar. `id`, `venueId` y las fechas no. */
export type CardDesignPatch = Partial<CardDesign>

const COLOR_FIELDS = ['backgroundColor', 'textColor', 'labelColor', 'stripColor', 'stampFilledColor', 'stampEmptyColor'] as const

const HEX = /^#[0-9a-fA-F]{6}$/

/**
 * 🔴 Se valida al ESCRIBIR, no al emitir.
 *
 * Apple no rechaza un color mal formado: lo ignora y pinta la tarjeta gris. Si el
 * valor entrara a la base, el negocio guardaría "listo", vería su vista previa bien
 * —el navegador sí tolera formatos que Apple no— y el defecto aparecería semanas
 * después en el iPhone de un cliente, sin nada que lo relacione con este cambio.
 */
export function assertValidDesign(patch: CardDesignPatch): void {
  for (const field of COLOR_FIELDS) {
    const value = patch[field]
    // `undefined` = no se está tocando ese campo. `null` sólo vale donde el modelo
    // lo permite, que hoy es únicamente el color del sello vacío.
    if (value === undefined) continue
    if (value === null) {
      if (field === 'stampEmptyColor') continue
      throw new BadRequestError(`El color "${field}" no puede quedar vacío.`)
    }
    if (typeof value !== 'string' || !HEX.test(value.trim())) {
      throw new BadRequestError(`El color "${field}" debe venir como #RRGGBB (por ejemplo #7ADD2C). Llegó: "${value}".`)
    }
  }

  for (const field of ['logoUrl', 'iconUrl'] as const) {
    const value = patch[field]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string' || !/^https:\/\//i.test(value.trim())) {
      throw new BadRequestError(`La imagen "${field}" debe ser una URL https.`)
    }
  }
}

/** El diseño del negocio, o los defaults si nunca lo configuró. */
export async function getCardDesign(venueId: string): Promise<CardDesign> {
  const row = await prisma.walletCardDesign.findUnique({ where: { venueId } })
  if (!row) return { ...DEFAULT_CARD_DESIGN }

  return {
    logoUrl: row.logoUrl,
    iconUrl: row.iconUrl,
    backgroundColor: row.backgroundColor,
    textColor: row.textColor,
    labelColor: row.labelColor,
    stripColor: row.stripColor,
    stampFilledColor: row.stampFilledColor,
    stampEmptyColor: row.stampEmptyColor,
    stampShape: row.stampShape,
  }
}

/**
 * Guarda el diseño. Crea la fila la primera vez.
 *
 * 🔴 Sólo escribe las claves que vinieron. Un `PUT` que mandara el objeto completo
 * borraría el logo de un negocio cada vez que alguien cambia un color desde una
 * pantalla que no cargó ese campo.
 */
export async function saveCardDesign(venueId: string, patch: CardDesignPatch): Promise<CardDesign> {
  assertValidDesign(patch)

  const data: Record<string, unknown> = {}
  for (const key of Object.keys(patch) as (keyof CardDesign)[]) {
    if (patch[key] !== undefined) data[key] = patch[key]
  }

  await prisma.walletCardDesign.upsert({
    where: { venueId },
    create: { venueId, ...data },
    update: data,
  })

  return getCardDesign(venueId)
}
