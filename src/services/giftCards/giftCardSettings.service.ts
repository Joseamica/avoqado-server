// src/services/giftCards/giftCardSettings.service.ts
/**
 * Ajustes de tarjetas de regalo por negocio (spec 2026-10-14 § 4.3 y § 9). APAGADA por default porque toca dinero;
 * prenderla pide aceptar los términos, el plan (`GIFT_CARDS`, R9) y las llaves del servidor (R7), y crea el tender de
 * sistema. El candado de plan gatea sólo VENDER y PRENDER: cobrar, consultar y devolver nunca pasan por aquí.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { assertGiftCardKeys, giftCardKeysPresent } from './giftCardCode'
import { GiftCardError } from './giftCardErrors'
import { MAXIMO_POR_SOBRE, MINIMO_POR_SOBRE, formatoPesos, topePorOperacion } from './giftCardLimits'
import { ensureGiftCardTender } from './giftCardTender'

export const FUNCION_TARJETAS_DE_REGALO = 'GIFT_CARDS'
export const TERMINOS_VIGENTES = '2026-10-14'
const VIGENCIAS_PERMITIDAS = new Set([12, 24, 36, 60])
const MAX_MONTOS_SUGERIDOS = 6

export interface GiftCardSettingsView {
  enabled: boolean
  suggestedAmounts: number[]
  minAmount: number
  maxAmount: number
  validityMonths: number | null
  termsVersion: string
  /** Tope legal de la suma de una compra hoy (pesos). La suma debe quedar ESTRICTAMENTE debajo. */
  topePorOperacion: number
  /** `false` ⇒ el servidor no tiene las llaves y la venta está apagada (GIFT_CARD_KEYS_MISSING). */
  llavesConfiguradas: boolean
  updatedAt: string | null
}

export interface UpdateGiftCardSettingsInput {
  enabled?: boolean
  /** Obligatorio en `true` cuando la petición PRENDE la función. */
  aceptaTerminos?: boolean
  suggestedAmounts?: number[]
  minAmount?: number
  maxAmount?: number
  validityMonths?: number | null
}

interface Ajustes {
  enabled: boolean
  suggestedAmounts: Prisma.Decimal[]
  minAmount: Prisma.Decimal
  maxAmount: Prisma.Decimal
  validityMonths: number | null
  termsVersion: string
  updatedAt: Date | null
}

const SELECT_AJUSTES = {
  enabled: true,
  suggestedAmounts: true,
  minAmount: true,
  maxAmount: true,
  validityMonths: true,
  termsVersion: true,
  updatedAt: true,
} satisfies Prisma.GiftCardSettingsSelect

function porDefecto(): Ajustes {
  return {
    enabled: false,
    suggestedAmounts: [500, 1000, 2000].map(v => new Prisma.Decimal(v)),
    minAmount: MINIMO_POR_SOBRE,
    maxAmount: MAXIMO_POR_SOBRE,
    validityMonths: null,
    termsVersion: TERMINOS_VIGENTES,
    updatedAt: null,
  }
}

async function leerAjustes(venueId: string): Promise<Ajustes> {
  return (await prisma.giftCardSettings.findUnique({ where: { venueId }, select: SELECT_AJUSTES })) ?? porDefecto()
}

function vista(a: Ajustes): GiftCardSettingsView {
  return {
    enabled: a.enabled,
    suggestedAmounts: a.suggestedAmounts.map(v => v.toNumber()),
    minAmount: a.minAmount.toNumber(),
    maxAmount: a.maxAmount.toNumber(),
    validityMonths: a.validityMonths,
    termsVersion: a.termsVersion,
    topePorOperacion: topePorOperacion(new Date()).toNumber(),
    llavesConfiguradas: giftCardKeysPresent(),
    updatedAt: a.updatedAt ? a.updatedAt.toISOString() : null,
  }
}

function pesos(valor: unknown, campo: string): Prisma.Decimal {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0) throw new BadRequestError(`${campo} debe ser un monto en pesos.`)
  const d = new Prisma.Decimal(valor)
  if (d.decimalPlaces() > 2) throw new BadRequestError(`${campo} debe llevar centavos exactos.`)
  return d
}

export async function getGiftCardSettings(venueId: string): Promise<GiftCardSettingsView> {
  return vista(await leerAjustes(venueId))
}

export async function assertGiftCardsSellable(venueId: string): Promise<void> {
  const ajustes = await leerAjustes(venueId)
  if (!ajustes.enabled) {
    throw new GiftCardError(
      'GIFT_CARDS_DISABLED',
      'Las tarjetas de regalo están apagadas en este negocio. Actívalas en tu panel: Ajustes › Tarjetas de regalo.',
      403,
    )
  }
  if (!(await venueHasFeatureAccess(venueId, FUNCION_TARJETAS_DE_REGALO))) {
    throw new GiftCardError(
      'GIFT_CARDS_NOT_IN_PLAN',
      'Las tarjetas de regalo vienen en el plan Pro o como función suelta. Revísalo en tu panel: Ajustes › Plan.',
      403,
    )
  }
  assertGiftCardKeys()
}

/** r1 (A-4): un guardado a la vez por negocio (molde `floorPlan.service.ts`: candado consultivo de la transacción). */
const llaveDeAjustes = (venueId: string) => `avoqado:gift-card-settings:v1:${venueId}`

export async function updateGiftCardSettings(
  venueId: string,
  input: UpdateGiftCardSettingsInput,
  staffId: string,
): Promise<GiftCardSettingsView> {
  // r1 (A-4): leer, validar y escribir en UNA transacción serializada por negocio, y escribir SÓLO lo que llegó: guardar
  // montos con una foto vieja nunca vuelve a prender un interruptor que otra sesión apagó, ni se salta la validación de
  // «prendiendo». `enabled` sólo cambia cuando el cuerpo lo trae (y la ruta, C3, pide el plan sólo con `enabled: true`).
  const { actual, guardado } = await prisma.$transaction(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${llaveDeAjustes(venueId)}, 0))::text`)
    const actual = (await tx.giftCardSettings.findUnique({ where: { venueId }, select: SELECT_AJUSTES })) ?? porDefecto()

    // Se valida la MEZCLA (lo que llegó ∪ lo guardado bajo el candado): las reglas cruzadas (mínimo ≤ máximo, sugeridos
    // dentro del rango) se cumplen sobre lo que va a quedar.
    const minAmount = input.minAmount !== undefined ? pesos(input.minAmount, 'minAmount') : actual.minAmount
    const maxAmount = input.maxAmount !== undefined ? pesos(input.maxAmount, 'maxAmount') : actual.maxAmount
    if (minAmount.lessThan(MINIMO_POR_SOBRE))
      throw new BadRequestError(`El monto mínimo no puede ser menor a ${formatoPesos(MINIMO_POR_SOBRE)}.`)
    if (maxAmount.greaterThan(MAXIMO_POR_SOBRE)) {
      throw new BadRequestError(`El monto máximo no puede pasar de ${formatoPesos(MAXIMO_POR_SOBRE)} (la ley lo limita por tarjeta).`)
    }
    if (minAmount.greaterThan(maxAmount)) throw new BadRequestError('El monto mínimo no puede ser mayor que el máximo.')

    const suggestedAmounts =
      input.suggestedAmounts !== undefined
        ? (Array.isArray(input.suggestedAmounts) ? input.suggestedAmounts : []).map(v => pesos(v, 'suggestedAmounts'))
        : actual.suggestedAmounts
    if (suggestedAmounts.length === 0 || suggestedAmounts.length > MAX_MONTOS_SUGERIDOS) {
      throw new BadRequestError(`Captura de 1 a ${MAX_MONTOS_SUGERIDOS} montos sugeridos.`)
    }
    if (suggestedAmounts.some(v => v.lessThan(minAmount) || v.greaterThan(maxAmount))) {
      throw new BadRequestError(`Los montos sugeridos deben estar entre ${formatoPesos(minAmount)} y ${formatoPesos(maxAmount)}.`)
    }

    const validityMonths = input.validityMonths !== undefined ? input.validityMonths : actual.validityMonths
    if (validityMonths !== null && !VIGENCIAS_PERMITIDAS.has(validityMonths)) {
      throw new BadRequestError('La vigencia debe ser 12, 24, 36 o 60 meses, o sin vencimiento.')
    }

    const enabled = input.enabled ?? actual.enabled
    const prendiendo = enabled && !actual.enabled
    if (prendiendo) {
      if (input.aceptaTerminos !== true) {
        throw new BadRequestError('Para activar las tarjetas de regalo acepta los términos.', 'GIFT_CARD_TERMS_REQUIRED')
      }
      if (!(await venueHasFeatureAccess(venueId, FUNCION_TARJETAS_DE_REGALO))) {
        throw new GiftCardError(
          'GIFT_CARDS_NOT_IN_PLAN',
          'Las tarjetas de regalo vienen en el plan Pro o como función suelta. Revísalo en tu panel: Ajustes › Plan.',
          403,
        )
      }
      assertGiftCardKeys()
      // R4: el tender de sistema nace al prender, en ESTA transacción (si falla, no queda prendida sin tender). Es la
      // excepción a «fuera de transacciones» de A3: dos «prender» se serializan por el candado de arriba y el otro creador
      // (el cobro con saldo, A8) necesita tarjetas vendidas, que no existen antes del primer «prender». Si aun así chocara
      // (P2002), se revierte el guardado entero y el dueño lo reintenta.
      await ensureGiftCardTender(tx, venueId)
    }

    // Sólo lo que llegó, más la versión de los términos al prender y quién guardó.
    const cambios: Prisma.GiftCardSettingsUpdateInput = {
      ...(input.enabled !== undefined ? { enabled } : {}),
      ...(input.suggestedAmounts !== undefined ? { suggestedAmounts } : {}),
      ...(input.minAmount !== undefined ? { minAmount } : {}),
      ...(input.maxAmount !== undefined ? { maxAmount } : {}),
      ...(input.validityMonths !== undefined ? { validityMonths } : {}),
      ...(prendiendo ? { termsVersion: TERMINOS_VIGENTES } : {}),
      updatedById: staffId,
    }
    const guardado = await tx.giftCardSettings.upsert({
      where: { venueId },
      // Sin fila, «lo guardado» son los defaults: la fila nace con defaults ∪ lo que llegó.
      create: {
        venueId,
        enabled,
        suggestedAmounts,
        minAmount,
        maxAmount,
        validityMonths,
        termsVersion: prendiendo ? TERMINOS_VIGENTES : actual.termsVersion,
        updatedById: staffId,
      },
      update: cambios,
      select: SELECT_AJUSTES,
    })
    return { actual, guardado }
  })

  // Fuera de la transacción y después del commit (fire-and-forget).
  void logAction({
    staffId,
    venueId,
    action: 'GIFT_CARD_SETTINGS_UPDATED',
    entity: 'GiftCardSettings',
    entityId: venueId,
    data: { antes: JSON.parse(JSON.stringify(vista(actual))), despues: JSON.parse(JSON.stringify(vista(guardado))) },
  })
  return vista(guardado)
}
