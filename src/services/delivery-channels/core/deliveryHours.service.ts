/**
 * ¿A qué horas acepta pedidos este canal de delivery?
 *
 * 🔴 POR QUÉ EXISTE: hasta hoy se publicaba 24/7 a los marketplaces, y eso mete pedidos a
 * las 3 de la mañana que nadie va a cocinar. Cada uno hay que rechazarlo, y Uber cuenta los
 * rechazos contra la tasa de inyección que exige (99.9%; revoca por debajo de 99%). Un
 * horario inventado no cuesta unos pedidos: cuesta la integración.
 *
 * 🔴 EL PROBLEMA DE FONDO, dicho sin rodeos: **Avoqado NO guarda a qué hora abre un
 * negocio.** No hay modelo de horarios; el job nocturno lo admite en un comentario
 * (`businessHoursStart: '', // Not tracked per venue yet`). Lo único parecido es el horario
 * semanal del módulo de RESERVAS, que sólo tienen los venues que lo usan.
 *
 * Así que esto resuelve en cascada, de lo más confiable a lo menos, y —esto es lo que
 * importa— DICE de dónde sacó el dato. Un horario adivinado que se presenta como certeza es
 * peor que no tenerlo: nadie lo revisa.
 *
 * El horario que devuelve es NEUTRAL (mismo formato que reservas). Traducirlo al idioma de
 * cada proveedor es trabajo del adaptador — el núcleo no habla Uber.
 */
import type { DeliveryChannelLink } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

export interface RangoHorario {
  open: string // "HH:MM", hora local del negocio
  close: string
}

export interface DiaHorario {
  enabled: boolean
  ranges: RangoHorario[]
}

export type HorarioSemanal = Record<'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday', DiaHorario>

export type FuenteHorario =
  | 'CANAL' // lo configuraron para ESTE canal de delivery — el mejor dato
  | 'RESERVAS' // el horario del módulo de reservas del mismo venue
  | 'ESTIMADO' // 🚨 nadie lo configuró: es una suposición y hay que decirlo

export interface HorarioResuelto {
  horario: HorarioSemanal
  fuente: FuenteHorario
}

const DIAS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

/**
 * El default cuando NADIE configuró nada. Es el mismo que el schema documenta para reservas
 * ("Mon-Sat 09:00-22:00, Sunday closed"), y se elige ese a propósito en vez de 24/7:
 *
 * Equivocarse hacia MENOS horas hace que el negocio pierda ventas — se nota rápido y se
 * arregla. Equivocarse hacia 24/7 mete pedidos de madrugada que nadie cocina, y eso se paga
 * con la tasa de inyección. De los dos errores, sólo uno es reversible.
 */
const ESTIMADO: HorarioSemanal = DIAS.reduce((acc, dia) => {
  acc[dia] = dia === 'sunday' ? { enabled: false, ranges: [] } : { enabled: true, ranges: [{ open: '09:00', close: '22:00' }] }
  return acc
}, {} as HorarioSemanal)

/**
 * "HH:MM" de verdad, no sólo con forma de.
 *
 * 🔴 El primer intento sólo revisaba el patrón `\d{2}:\d{2}`, y con eso `25:00` a `30:00`
 * pasaba como horario válido —incluso el `close > open` daba true, porque comparar textos
 * dice que "30:00" es mayor que "25:00"—. Se habría publicado a Uber tal cual. Lo atrapó el
 * propio test de "rechaza el horario entero si un solo día está roto".
 */
function esHora(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{2}:\d{2}$/.test(v)) return false
  const [h, m] = v.split(':').map(Number)
  return h >= 0 && h <= 23 && m >= 0 && m <= 59
}

/** ¿Esto que sacamos de un Json tiene forma de horario semanal, o es basura? */
export function esHorarioValido(v: unknown): v is HorarioSemanal {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return DIAS.every(dia => {
    const d = o[dia] as DiaHorario | undefined
    if (!d || typeof d.enabled !== 'boolean' || !Array.isArray(d.ranges)) return false
    // Un día prendido sin rangos publicaría "abierto de nunca a nunca". Se rechaza el
    // horario ENTERO: publicar la mitad buena y la mitad rota es peor que caer al estimado,
    // porque nadie se entera de la mitad rota.
    if (d.enabled && d.ranges.length === 0) return false
    return d.ranges.every(r => esHora(r?.open) && esHora(r?.close) && r.close > r.open)
  })
}

export async function resolveDeliveryHours(link: DeliveryChannelLink): Promise<HorarioResuelto> {
  // 1. Lo configurado para ESTE canal. Es el mejor dato porque el horario de delivery a
  //    menudo NO es el del local: muchos restaurantes dejan de repartir antes de cerrar.
  const delCanal = (link.config as { deliveryHours?: unknown } | null)?.deliveryHours
  if (esHorarioValido(delCanal)) return { horario: delCanal, fuente: 'CANAL' }
  if (delCanal !== undefined && delCanal !== null) {
    logger.warn('⚠️ [DeliveryHours] el canal tiene un horario con forma inválida — se ignora', { linkId: link.id, venueId: link.venueId })
  }

  // 2. El horario de reservas del mismo venue: dato real del negocio, aunque sea de otro
  //    módulo. Es infinitamente mejor que suponer.
  const reservas = await prisma.reservationSettings
    .findUnique({ where: { venueId: link.venueId }, select: { operatingHours: true } })
    .catch(() => null)
  if (esHorarioValido(reservas?.operatingHours)) return { horario: reservas!.operatingHours as HorarioSemanal, fuente: 'RESERVAS' }

  // 3. Nadie lo configuró. Se estima, y se GRITA — un horario adivinado que se presenta como
  //    certeza es peor que no tenerlo, porque nadie lo revisa.
  logger.warn('🚨 [DeliveryHours] el venue NO tiene horario configurado — se publica un ESTIMADO (L-S 09:00-22:00)', {
    linkId: link.id,
    venueId: link.venueId,
    provider: link.provider,
    accion: 'configura config.deliveryHours en el canal, o el horario del módulo de reservas',
  })
  return { horario: ESTIMADO, fuente: 'ESTIMADO' }
}
