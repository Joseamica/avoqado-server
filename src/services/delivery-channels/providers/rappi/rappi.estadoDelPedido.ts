/**
 * Lo que sabemos que RAPPI ya hizo con un pedido, guardado en la fila de su aviso (Tarea 9 del plan «Rappi fase 2»).
 *
 * Vive en `DeliveryOrderEvent.resourcePayload`: en Uber ahí va el pedido que se trae con un GET, pero Rappi manda el pedido
 * completo en el webhook, así que la columna estaba libre — y así no hace falta migración de esquema (decisión T2 del plan).
 *  · `aceptacion`: Rappi YA aceptó el pedido. Se anota ANTES de registrar la venta: un reintento con la marca no vuelve a
 *    aceptar (Rappi contestaría 400) y registra.
 *  · `listo`: el contador de «listo para el repartidor» (Tarea 13; Rappi deja de hacerle caso a la 3.ª llamada).
 *
 * 🔴 Nunca registrar un pedido a ciegas ni dos veces. Si el proceso muere entre el sí de Rappi y la marca, el reintento recibe
 * un 400 al aceptar; entonces el único que puede decir si el pedido es nuestro es su HISTORIAL del lado de Rappi
 * (`GET …/orders/{id}/events`, `leerHistorial`). Sin historial legible no se registra: queda `ACEPTACION_INCIERTA`, con 🚨.
 */
import { Prisma } from '@prisma/client'

import prisma from '@/utils/prismaClient'

import type { RappiRespuesta } from './rappi.http'

export type EvidenciaDeAceptacion = 'HTTP_2XX' | 'HISTORIAL_TAKEN'
export type CierreDeListo = 'HTTP_2XX' | 'TRANSICION_INVALIDA' | 'TOPE'

export interface EstadoRappiDelPedido {
  aceptacion?: { en: string; evidencia: EvidenciaDeAceptacion }
  listo?: { llamadas: number; cerrado?: CierreDeListo }
}

/** Un renglón del historial de Rappi. `event_time` viene sin zona, en la de la tienda (`store_timezone`): aquí no se usa. */
export interface EventoDelHistorial {
  event?: string
  event_time?: string
}

export type VeredictoHistorial = 'ACEPTADO' | 'YA_NO_ACTIVO' | 'INCIERTO'

const EVIDENCIAS: readonly string[] = ['HTTP_2XX', 'HISTORIAL_TAKEN'] satisfies EvidenciaDeAceptacion[]
const CIERRES_DE_LISTO: readonly string[] = ['HTTP_2XX', 'TRANSICION_INVALIDA', 'TOPE'] satisfies CierreDeListo[]

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Lee el estado guardado. Lo que no tiene la forma esperada se ignora (nunca lanza): una marca rota NO cuenta como aceptación. */
export function leerEstado(resourcePayload: Prisma.JsonValue | null): EstadoRappiDelPedido {
  if (!esObjeto(resourcePayload)) return {}
  const estado: EstadoRappiDelPedido = {}

  const a = resourcePayload.aceptacion
  if (esObjeto(a) && typeof a.en === 'string' && a.en && typeof a.evidencia === 'string' && EVIDENCIAS.includes(a.evidencia)) {
    estado.aceptacion = { en: a.en, evidencia: a.evidencia as EvidenciaDeAceptacion }
  }

  const l = resourcePayload.listo
  if (esObjeto(l) && typeof l.llamadas === 'number' && Number.isInteger(l.llamadas) && l.llamadas >= 0) {
    estado.listo = { llamadas: l.llamadas }
    if (typeof l.cerrado === 'string' && CIERRES_DE_LISTO.includes(l.cerrado)) estado.listo.cerrado = l.cerrado as CierreDeListo
  }
  return estado
}

/**
 * Anota que Rappi ya aceptó el pedido. 🔴 Escribe SÓLO si el reclamo del evento sigue siendo de quien llama (`claimToken`),
 * igual que el cierre: el dueño viejo de un reclamo vencido nunca escribe encima del nuevo. Devuelve `false` si no escribió
 * (el reclamo ya es de otro): quien llama se detiene sin registrar la venta.
 *
 * 🔴 MEZCLA dentro de `resourcePayload` en un solo UPDATE (`||` de JSONB sólo cambia la llave `aceptacion`): lo demás que haya
 * ahí —el contador de «listo»— sobrevive aunque lo escriba otro proceso al mismo tiempo. Un valor que no es objeto se sustituye.
 */
export async function anotarAceptacion(eventRowId: string, claimToken: string, evidencia: EvidenciaDeAceptacion): Promise<boolean> {
  const marca = JSON.stringify({ en: new Date().toISOString(), evidencia })
  const filas = await prisma.$executeRaw`
    UPDATE "DeliveryOrderEvent"
       SET "resourcePayload" = (CASE WHEN jsonb_typeof("resourcePayload") = 'object' THEN "resourcePayload" ELSE '{}'::jsonb END)
                               || jsonb_build_object('aceptacion', ${marca}::jsonb)
     WHERE "id" = ${eventRowId} AND "claimToken" = ${claimToken}`
  return filas === 1
}

/**
 * 🔴 Ajustar con M5 (recorrido-real.md): los nombres del vencimiento y de la cancelación TODAVÍA no se midieron en el sandbox.
 * Es la expresión inicial del plan (decisión P2); la documentación de Rappi da `canceled_with_charge` como ejemplo.
 *
 * 🔴 Su falla segura cubre SÓLO lo que nunca se aceptó: un nombre de cierre que no conoce deja el historial sin `taken` en
 * `INCIERTO`, y eso no se registra. Pero un pedido que Rappi aceptó y después canceló con un nombre que esta expresión no
 * cubre se lee `ACEPTADO` y se registraría. Eso NO lo cuida el nombre: lo cuida el aviso `ORDER_EVENT_CANCEL` guardado, que
 * el procesador busca antes de aceptar y otra vez después de registrar (Tarea 10), más la cancelación en espera.
 */
const EVENTO_TERMINAL = /^cancel|^canceled|^rejected|timeout/i
/** Medido el 21-oct en DEV: un pedido aceptado trae exactamente `taken_visible_order` (no hay un evento llamado «TAKEN»). */
const EVENTO_ACEPTADO = /^taken/i
/** Cuántos nombres del historial van a un log: el veredicto los mira todos, el log sólo los primeros. */
const NOMBRES_EN_EL_LOG = 30

export interface LecturaDelHistorial {
  veredicto: VeredictoHistorial
  /** Los nombres de sus eventos, en orden (hasta 30): van a los logs, para ajustar la expresión con lo que Rappi de verdad manda. */
  nombres: string[]
  /** Trae un `taken…` aunque también traiga un cierre: «aceptado y después cancelado o vencido» pide a una persona. */
  traeAceptacion: boolean
}

/**
 * ¿Qué dice el historial de Rappi del pedido? Un evento terminal manda sobre todo (aceptado y después cancelado o vencido:
 * ya no es venta) ⇒ `YA_NO_ACTIVO`; si no, un `taken…` ⇒ `ACEPTADO`; si no (vacío, o sólo eventos del repartidor) ⇒ `INCIERTO`.
 */
export function analizarHistorial(eventos: EventoDelHistorial[]): LecturaDelHistorial {
  const nombres = eventos.map(e => (typeof e?.event === 'string' ? e.event.trim() : '')).filter(Boolean)
  const traeAceptacion = nombres.some(n => EVENTO_ACEPTADO.test(n))
  const veredicto: VeredictoHistorial = nombres.some(n => EVENTO_TERMINAL.test(n))
    ? 'YA_NO_ACTIVO'
    : traeAceptacion
      ? 'ACEPTADO'
      : 'INCIERTO'
  return { veredicto, nombres: nombres.slice(0, NOMBRES_EN_EL_LOG), traeAceptacion }
}

/** Sólo el veredicto de `analizarHistorial`. */
export function leerHistorial(eventos: EventoDelHistorial[]): VeredictoHistorial {
  return analizarHistorial(eventos).veredicto
}

/**
 * La respuesta HTTP del historial → sus eventos. 🔴 `null` = NO se pudo leer (status distinto de 2xx, cuerpo que no es JSON o
 * que no es una lista); `[]` = sí se leyó y Rappi no tiene eventos del pedido. No son lo mismo y no se deben confundir.
 */
export function leerRespuestaDelHistorial(r: RappiRespuesta | null | undefined): EventoDelHistorial[] | null {
  if (!r?.ok) return null
  let cuerpo: unknown
  try {
    cuerpo = JSON.parse(r.raw)
  } catch {
    return null
  }
  if (!Array.isArray(cuerpo)) return null
  return cuerpo.map(e => {
    const o = esObjeto(e) ? e : {}
    return {
      ...(typeof o.event === 'string' ? { event: o.event } : {}),
      ...(typeof o.event_time === 'string' ? { event_time: o.event_time } : {}),
    }
  })
}
