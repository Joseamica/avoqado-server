/**
 * El horario de la TIENDA en el proveedor, igual al de Avoqado, sin que nadie se acuerde de publicarlo (Tarea 19).
 *
 * 🔴 POR QUÉ IMPORTA: el horario de `resolveDeliveryHours` ya viaja dentro del menú, pero hay proveedores donde la TIENDA tiene
 * un horario aparte, y una tienda sin él se toma como abierta las 24 h: pedidos de madrugada que nadie va a cocinar, y cada
 * rechazo cuenta contra la tasa de éxito que exige el proveedor.
 *
 * 🔴 POR HUELLA, como el menú: se compara la huella del horario resuelto contra la última publicada (`config.horarioPublicado`).
 * Sin cambios no hay red. La huella se guarda SÓLO cuando el proveedor aceptó todo (`publishStoreHours` devolvió `ok`), con la
 * fila bloqueada (`escribirLlavesDelSistema`) y sin tocar las demás llaves. Si algo falla a medias NO se guarda: la siguiente
 * pasada vuelve a calcular y el adaptador vuelve a leer lo que el proveedor de verdad tiene.
 *
 * 🔴 NUNCA un horario ESTIMADO (ronda 1): si nadie configuró horario (`fuente: 'ESTIMADO'`), no se toca al proveedor ni la huella
 * (`SKIPPED_ESTIMATED`): lo que el dueño tenga en el portal del proveedor no se pisa con una suposición, y lo último publicado se
 * queda. Sin 🚨 propio: el horario se resuelve con `avisar: false` porque el menú, en la misma pasada, ya avisa (uno por pasada).
 *
 * Los turnos del mismo día que se enciman o se tocan se FUSIONAN antes de todo (09–14 + 13–18 ⇒ 09–18): la huella es la de una
 * sola franja y al proveedor nunca le llegan turnos encimados (que rechazaría a media publicación).
 *
 * 🔴 NUNCA una semana toda cerrada: publicarla dejaría la tienda sin horario, que es justo lo que el proveedor puede tomar como
 * 24 h. Se devuelve `SKIPPED_EMPTY`, se conserva lo último que se publicó y se avisa con 🚨 UNA vez (la marca vive en
 * `horarioPublicado.vacioAvisadoEn` y se borra en cuanto algún día vuelve a abrir, publique o no (mismo horario, otro horario o
 * uno que el proveedor rechaza); si no, las siguientes vacaciones pasarían en silencio con la tienda abierta en el proveedor).
 *
 * Una falla que se repite (el mismo paso rechazado, un login que no está habilitado) grita 🚨 la primera vez por (vínculo, huella
 * deseada) y después va como `warn` durante 6 h (`primeraFalla`, en memoria): no 288 🚨 al día por vínculo.
 *
 * Las horas son las del negocio (hora local de pared, «HH:MM»): no hay conversión de zona; el proveedor las lee en la hora de
 * la tienda.
 */
import { createHash } from 'node:crypto'

import type { DeliveryChannelLink } from '@prisma/client'

import logger from '@/config/logger'

import { adapterFor, hasAdapter } from './adapterRegistry'
import { resolveDeliveryHours, type HorarioSemanal, type RangoHorario } from './deliveryHours.service'
import { configComoObjeto, escribirLlavesDelSistema } from './llavesDelSistema'
import { DeliveryWriteNotSentError, type ActionResult } from './types'

/**
 * `NO_PUBLISHER`: el proveedor no recibe el horario de la tienda (o no hay adaptador). Es normal y no se avisa.
 * `SKIPPED_EMPTY`: todos los días cerrados; no se publica nada y se conserva lo último.
 * `SKIPPED_ESTIMATED`: nadie configuró horario (es un estimado); no se publica nada y se conserva lo último.
 */
export type HoursSyncOutcome = 'PUBLISHED' | 'UNCHANGED' | 'NO_PUBLISHER' | 'SKIPPED_EMPTY' | 'SKIPPED_ESTIMATED' | 'FAILED'

export interface HoursSyncResult {
  outcome: HoursSyncOutcome
  error?: string
}

/** `config.horarioPublicado`: la huella publicada y cuándo (ISO, UTC), y si ya se avisó de una semana toda cerrada. */
export interface HorarioPublicado {
  huella?: string
  en?: string
  vacioAvisadoEn?: string
}

/** Lo publicado según `config`, o `null`. De lo guardado sólo pasan esos tres campos de texto: una basura no estorba. */
export function leerHorarioPublicado(config: unknown): HorarioPublicado | null {
  const h = configComoObjeto(config).horarioPublicado
  if (typeof h !== 'object' || h === null || Array.isArray(h)) return null
  const o = h as Record<string, unknown>
  return {
    ...(typeof o.huella === 'string' ? { huella: o.huella } : {}),
    ...(typeof o.en === 'string' ? { en: o.en } : {}),
    ...(typeof o.vacioAvisadoEn === 'string' ? { vacioAvisadoEn: o.vacioAvisadoEn } : {}),
  }
}

const DIAS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

/**
 * Los turnos de cada día, ordenados y FUSIONADOS cuando se enciman o se tocan (09–14 + 13–18 ⇒ 09–18; 09–14 + 14–18 ⇒ 09–18;
 * uno adentro de otro ⇒ el de afuera). Las horas son «HH:MM» validadas, así que compararlas como texto es compararlas como hora.
 */
function fusionarTurnos(horario: HorarioSemanal): HorarioSemanal {
  const salida = {} as HorarioSemanal
  for (const d of DIAS) {
    const dia = horario[d] ?? { enabled: false, ranges: [] }
    const ranges: RangoHorario[] = []
    for (const r of [...dia.ranges].sort((a, b) => (a.open < b.open ? -1 : a.open > b.open ? 1 : 0))) {
      const ultimo = ranges[ranges.length - 1]
      if (ultimo && r.open <= ultimo.close) {
        if (r.close > ultimo.close) ultimo.close = r.close
      } else {
        ranges.push({ open: r.open, close: r.close })
      }
    }
    salida[d] = { enabled: dia.enabled, ranges }
  }
  return salida
}

/** ¿Abre algún día con franjas? Sin ninguno, la semana está toda cerrada. */
function abreAlgunDia(horario: HorarioSemanal): boolean {
  return DIAS.some(d => horario[d]?.enabled === true && horario[d].ranges.length > 0)
}

/**
 * Huella del horario en forma canónica: un día cerrado es `null` aunque guarde rangos, y las franjas van ordenadas. Así
 * reordenar los turnos o dejar rangos en un día apagado no republica nada. `v` se sube si cambia CÓMO se publica y hay que
 * forzar que todos los vínculos se vuelvan a comparar contra el proveedor.
 */
function huellaDelHorario(horario: HorarioSemanal): string {
  const dias = DIAS.map(d => {
    const dia = horario[d]
    if (!dia?.enabled || dia.ranges.length === 0) return null
    return dia.ranges.map(r => `${r.open}-${r.close}`).sort()
  })
  return createHash('sha256')
    .update(JSON.stringify({ v: 1, dias }))
    .digest('hex')
}

/** Anota (con la fila bloqueada) que ya se avisó de la semana cerrada. `true` = esta pasada es la primera: le toca avisar. */
async function anotarAvisoDeSemanaCerrada(linkId: string): Promise<boolean> {
  return escribirLlavesDelSistema(linkId, ({ config }) => {
    const actual = leerHorarioPublicado(config)
    if (actual?.vacioAvisadoEn) return null
    return { horarioPublicado: { ...(actual ?? {}), vacioAvisadoEn: new Date().toISOString() } }
  })
}

/** Quita la marca de «ya se avisó de la semana cerrada» (fila releída con candado), dejando `{ huella, en }`. */
async function rearmarAvisoDeSemanaCerrada(linkId: string): Promise<boolean> {
  return escribirLlavesDelSistema(linkId, ({ config }) => {
    const actual = leerHorarioPublicado(config)
    if (!actual?.vacioAvisadoEn) return null
    return {
      horarioPublicado: {
        ...(actual.huella !== undefined ? { huella: actual.huella } : {}),
        ...(actual.en !== undefined ? { en: actual.en } : {}),
      },
    }
  })
}

/**
 * Una falla que se repite (el proveedor rechaza siempre el mismo paso, un login que no está habilitado, una lectura rara) no
 * grita 🚨 en cada pasada: serían ~288 al día por vínculo. El 🚨 sale la PRIMERA vez por (vínculo, huella deseada); las
 * siguientes, dentro de 6 h, van como `warn`. Al publicar con éxito se olvida lo del vínculo. En memoria a propósito (sin base):
 * un reinicio sólo hace que se vuelva a gritar una vez. Una sola instancia (`.claude/rules/una-sola-instancia.md`).
 */
const VIGENCIA_DEL_AVISO_MS = 6 * 60 * 60 * 1000
const avisosDeFallas = new Map<string, number>()

/** `true` = toca el 🚨 (primera vez, o ya pasaron 6 h); lo anota. */
function primeraFalla(linkId: string, huella: string): boolean {
  const ahora = Date.now()
  for (const [clave, vence] of avisosDeFallas) if (vence <= ahora) avisosDeFallas.delete(clave)
  const clave = `${linkId}|${huella}`
  if (avisosDeFallas.has(clave)) return false
  avisosDeFallas.set(clave, ahora + VIGENCIA_DEL_AVISO_MS)
  return true
}

function olvidarFallasDelVinculo(linkId: string): void {
  for (const clave of avisosDeFallas.keys()) if (clave.startsWith(`${linkId}|`)) avisosDeFallas.delete(clave)
}

/** Sólo para pruebas: vacía la memoria de avisos de fallas. */
export function _olvidarAvisosDeFallas(): void {
  avisosDeFallas.clear()
}

const mensaje = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Publica el horario de la tienda de un canal SÓLO si cambió (ver el encabezado). Nunca lanza. */
export async function syncChannelHours(link: DeliveryChannelLink): Promise<HoursSyncResult> {
  if (!hasAdapter(link.provider)) return { outcome: 'NO_PUBLISHER' }
  const adapter = adapterFor(link.provider)
  if (typeof adapter.publishStoreHours !== 'function') return { outcome: 'NO_PUBLISHER' }

  const contexto = { linkId: link.id, venueId: link.venueId, provider: link.provider }
  /** 🚨 la primera vez por (vínculo, huella); después, el mismo texto como `warn` sin 🚨. */
  const fallo = (deQueHorario: string, texto: string, datos: Record<string, unknown>) => {
    if (primeraFalla(link.id, deQueHorario)) logger.error(`🚨 [HoursSync] ${texto}`, { ...contexto, ...datos })
    else logger.warn(`📋 [HoursSync] ${texto} (ya se avisó; se repite sin gritar hasta 6 h)`, { ...contexto, ...datos })
  }
  let huella: string | undefined
  try {
    // Sin avisar: el 🚨 del estimado lo da el menú en la misma pasada (uno solo por pasada).
    const resuelto = await resolveDeliveryHours(link, { avisar: false })
    const { fuente } = resuelto
    // 🔴 Un estimado NUNCA se publica: no se pisa lo que el dueño tenga en el portal del proveedor con una suposición.
    if (fuente === 'ESTIMADO') return { outcome: 'SKIPPED_ESTIMATED' }

    const horario = fusionarTurnos(resuelto.horario)
    const publicado = leerHorarioPublicado(link.config)

    if (!abreAlgunDia(horario)) {
      // La copia ya trae el aviso: no se grita en cada pasada (ni se toca la base).
      if (publicado?.vacioAvisadoEn) return { outcome: 'SKIPPED_EMPTY' }
      const avisar = await anotarAvisoDeSemanaCerrada(link.id).catch(error => {
        // Sin poder anotarlo, se avisa igual: callar es peor que repetir.
        logger.warn('📋 [HoursSync] no se pudo anotar el aviso de la semana cerrada', { ...contexto, error: mensaje(error) })
        return true
      })
      if (avisar) {
        logger.error(
          '🚨 [HoursSync] el horario tiene TODOS los días cerrados: NO se publica (sin horario la tienda puede quedar abierta 24 h)',
          {
            ...contexto,
            fuente,
            accion:
              'configura al menos un día abierto en el horario de delivery del canal (o en el de reservas); el proveedor conserva el último publicado',
          },
        )
      }
      return { outcome: 'SKIPPED_EMPTY' }
    }

    // 🔴 Algún día abre: la marca de «ya se avisó de la semana cerrada» se quita SIEMPRE, antes de saber si hay algo que publicar
    // (mismo horario, otro que se publica o otro que el proveedor rechaza). Si sólo se quitara al terminar bien, reabrir con
    // OTRO horario que falla de forma persistente y volver a cerrar todo dejaría la segunda semana cerrada sin 🚨, con la
    // tienda abierta en el proveedor.
    if (publicado?.vacioAvisadoEn) {
      await rearmarAvisoDeSemanaCerrada(link.id).catch(error =>
        logger.warn('📋 [HoursSync] no se pudo rearmar el aviso de la semana cerrada (se intenta en la siguiente pasada)', {
          ...contexto,
          error: mensaje(error),
        }),
      )
    }

    const deseada = huellaDelHorario(horario)
    huella = deseada
    if (deseada === publicado?.huella) return { outcome: 'UNCHANGED' }

    let r: ActionResult
    try {
      r = await adapter.publishStoreHours(horario, link.externalLocationId)
    } catch (error) {
      if (error instanceof DeliveryWriteNotSentError) {
        logger.warn('📋 [HoursSync] el horario NO salió hacia el proveedor (falló antes de la red): se reintenta en la siguiente pasada', {
          ...contexto,
          reason: error.reason,
          error: error.message,
        })
      } else {
        fallo(deseada, 'falló la publicación del horario: la huella no se guarda y la siguiente pasada vuelve a leer al proveedor', {
          error: mensaje(error),
        })
      }
      return { outcome: 'FAILED', error: mensaje(error) }
    }

    if (!r.ok) {
      fallo(deseada, 'el proveedor no aceptó el horario: la huella no se guarda y se reintenta en la siguiente pasada', {
        status: r.status,
        cuerpo: r.raw.slice(0, 300),
      })
      return { outcome: 'FAILED', error: `HTTP ${r.status}` }
    }

    // 🔴 Sólo aquí: el proveedor ya tiene TODO el horario. El parche lleva sólo `horarioPublicado` (y quita el aviso de vacío).
    const en = new Date().toISOString()
    await escribirLlavesDelSistema(link.id, () => ({ horarioPublicado: { huella: deseada, en } }))
    olvidarFallasDelVinculo(link.id)
    logger.info('📋 [HoursSync] horario de la tienda publicado en el proveedor', { ...contexto, fuente, detalle: r.raw.slice(0, 200) })
    return { outcome: 'PUBLISHED' }
  } catch (error) {
    fallo(huella ?? '(sin huella)', 'falló la sincronización del horario', { error: mensaje(error) })
    return { outcome: 'FAILED', error: mensaje(error) }
  }
}
