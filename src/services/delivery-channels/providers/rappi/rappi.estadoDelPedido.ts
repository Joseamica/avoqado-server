/**
 * Lo que sabemos que RAPPI ya hizo con un pedido, guardado en la fila de su aviso (Tarea 9 del plan «Rappi fase 2»).
 *
 * Vive en `DeliveryOrderEvent.resourcePayload`: en Uber ahí va el pedido que se trae con un GET, pero Rappi manda el pedido
 * completo en el webhook, así que la columna estaba libre — y así no hace falta migración de esquema (decisión T2 del plan).
 *  · `aceptacion`: Rappi YA aceptó el pedido. Se anota ANTES de registrar la venta: un reintento con la marca no vuelve a
 *    aceptar (Rappi contestaría 400) y registra.
 *  · `listo`: el contador de «listo para el repartidor» (Tarea 13). Rappi deja de ejecutar acciones después de la TERCERA
 *    solicitud y considera mal uso lo que siga: se cuenta ANTES de llamar (`reservarLlamadaDeListo`) y se cierra cuando ya no
 *    tiene caso (`cerrarListo`). Vive en la base, así que un reinicio no lo olvida.
 *
 * 🔴 Nunca registrar un pedido a ciegas ni dos veces. Si el proceso muere entre el sí de Rappi y la marca, el reintento recibe
 * un 400 al aceptar; entonces el único que puede decir si el pedido es nuestro es su HISTORIAL del lado de Rappi
 * (`GET …/orders/{id}/events`, `leerHistorial`). Sin historial no se registra: si NO se pudo leer queda `HISTORIAL_NO_LEIDO`
 * (reintentable: el job vuelve a preguntar), y si se leyó sin evidencia, `ACEPTACION_INCIERTA` (terminal), con 🚨.
 */
import { DeliveryProvider, Prisma } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

import { RAPPI_EVENTS } from './rappi.adapter'
import type { RappiRespuesta } from './rappi.http'
import { llaveDeAvisoDePedido } from './rappi.webhookIngress'

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
  if (
    esObjeto(a) &&
    typeof a.en === 'string' &&
    Number.isFinite(Date.parse(a.en)) &&
    typeof a.evidencia === 'string' &&
    EVIDENCIAS.includes(a.evidencia)
  ) {
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
export async function anotarAceptacion(
  eventRowId: string,
  claimToken: string,
  evidencia: EvidenciaDeAceptacion,
  en = new Date(),
): Promise<boolean> {
  const marca = JSON.stringify({ en: en.toISOString(), evidencia })
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
const EVENTO_TERMINAL = /^cancel|^rejected|timeout/i // `^cancel` ya cubre `canceled…`
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

// ────────────────────────────────────────────────────────────────────────────────────
//  «Listo para el repartidor»: a lo más 3 llamadas por pedido (Tarea 13)
// ────────────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 Rappi: «después de tres solicitudes, el sistema dejará de ejecutar acciones adicionales, por lo que cualquier intento
 * posterior será considerado un uso incorrecto del endpoint» (doc «managing-user-orders»), con la amenaza de revocar el acceso.
 */
export const MAX_LLAMADAS_LISTO = 3

/** Una fila `NEW_ORDER` bloqueada para contar o cerrar su «listo». */
type FilaDelAviso = { id: string; resourcePayload: Prisma.JsonValue }

/**
 * La fila del aviso `NEW_ORDER` del pedido, con `FOR UPDATE`. `storeId` es la tienda del vínculo del pedido HOY.
 *
 *  1. Por la llave ÚNICA `dedupKey` que le puso el ingreso (`llaveDeAvisoDePedido`) con esa tienda. Es el camino de siempre:
 *     una consulta por el índice único.
 *  2. 🔴 Si no está, el vínculo cambió de tienda DESPUÉS de recibir el pedido (un vínculo manual, sin consentimiento del dueño,
 *     lo permite desde SUPERADMIN), y la llave guardada lleva la tienda ORIGINAL. Se busca por lo que no cambia, el pedido: el
 *     aviso `NEW_ORDER` de Rappi con ese `externalOrderId`, acotado al vínculo que hoy tiene esa tienda (es único por
 *     proveedor y tienda), y la fila encontrada se bloquea igual. Sin esto el contador no se encontraba y cada intento salía
 *     «sin tope» (Codex b1 #4). Es un camino raro y de UNA búsqueda: `externalOrderId` no tiene índice, pero el filtro por
 *     vínculo usa el prefijo `(provider, channelLinkId)` del único compuesto del evento.
 *
 * `null` = no hay aviso por ningún camino.
 */
async function avisoBloqueado(tx: Prisma.TransactionClient, externalOrderId: string, storeId: string): Promise<FilaDelAviso | null> {
  const dedupKey = llaveDeAvisoDePedido(RAPPI_EVENTS.NEW_ORDER, storeId, externalOrderId)
  const porLlave = await tx.$queryRaw<FilaDelAviso[]>`
    SELECT "id", "resourcePayload" FROM "DeliveryOrderEvent"
     WHERE "dedupKey" = ${dedupKey}
       FOR UPDATE`
  if (porLlave[0]) return porLlave[0]

  const original = await tx.deliveryOrderEvent.findFirst({
    where: {
      provider: DeliveryProvider.RAPPI,
      eventType: RAPPI_EVENTS.NEW_ORDER,
      externalOrderId,
      channelLink: { is: { provider: DeliveryProvider.RAPPI, externalLocationId: storeId } },
    },
    // El más viejo es el aviso original; el id desempata para que la elección sea estable.
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  })
  if (!original) return null
  const porPedido = await tx.$queryRaw<FilaDelAviso[]>`
    SELECT "id", "resourcePayload" FROM "DeliveryOrderEvent"
     WHERE "id" = ${original.id}
       FOR UPDATE`
  if (porPedido[0]) {
    logger.warn('🛵 [Rappi] «listo»: el aviso del pedido se encontró por el pedido y no por su llave (el vínculo cambió de tienda)', {
      externalOrderId,
      storeId,
      eventRowId: original.id,
    })
  }
  return porPedido[0] ?? null
}

/**
 * 🔴 MEZCLA el contador dentro de `resourcePayload` (`||` de JSONB sólo cambia la llave `listo`): la marca de aceptación de
 * la Tarea 9 (`aceptacion`) y lo demás sobreviven. Se escribe con la fila bloqueada por `avisoBloqueado`, así que una
 * `anotarAceptacion` que llegue a la vez espera y mezcla sobre lo que esto dejó (o esto, sobre lo que dejó ella).
 */
function guardarListo(tx: Prisma.TransactionClient, filaId: string, listo: NonNullable<EstadoRappiDelPedido['listo']>) {
  return tx.$executeRaw`
    UPDATE "DeliveryOrderEvent"
       SET "resourcePayload" = (CASE WHEN jsonb_typeof("resourcePayload") = 'object' THEN "resourcePayload" ELSE '{}'::jsonb END)
                               || jsonb_build_object('listo', ${JSON.stringify(listo)}::jsonb)
     WHERE "id" = ${filaId}`
}

/** `sinAviso`: no se permitió porque el pedido no tiene aviso `NEW_ORDER` por ningún camino (no hay dónde contar). */
export interface ReservaDeListo {
  permitido: boolean
  sinAviso?: boolean
}

/**
 * ¿Se puede gastar una llamada de «listo» en este pedido? En UNA transacción: bloquea la fila del aviso, y si el «listo» ya
 * cerró o ya se usaron las 3, no; si no, SUMA 1 Y LO GUARDA ANTES de que salga la llamada. Así una llamada que muere a media
 * red ya contó, y un proceso que se reinicia no vuelve a empezar de cero.
 *
 * 🔴 Sin la fila del aviso por ningún camino (no debería pasar: todo pedido de Rappi nace de uno) NO se permite, con 🚨 (Codex
 * b1 #4). Permitir «sin contar» dejaba salir una llamada en CADA intento —el KDS y el barrido reintentan—, y pasar de tres es
 * el mal uso con que Rappi amenaza revocar el acceso. Un «listo» que no sale, en cambio, lo cierra Rappi solo en modo
 * automático.
 */
export async function reservarLlamadaDeListo(externalOrderId: string, storeId: string): Promise<ReservaDeListo> {
  return prisma.$transaction(async (tx): Promise<ReservaDeListo> => {
    const fila = await avisoBloqueado(tx, externalOrderId, storeId)
    if (!fila) {
      logger.error('🚨 [Rappi] «listo» sin el aviso NEW_ORDER del pedido: no hay dónde contar sus llamadas y NO sale — revisar el pedido', {
        externalOrderId,
        storeId,
      })
      return { permitido: false, sinAviso: true }
    }
    const listo = leerEstado(fila.resourcePayload).listo
    const llamadas = listo?.llamadas ?? 0
    if (listo?.cerrado || llamadas >= MAX_LLAMADAS_LISTO) return { permitido: false }
    await guardarListo(tx, fila.id, { llamadas: llamadas + 1 })
    return { permitido: true }
  })
}

/**
 * Devuelve la reserva de una llamada de «listo» que NUNCA salió: el candado de tiendas (`RappiEscrituraBloqueadaError`, un
 * `DeliveryWriteNotSentError`) saltó ANTES de la red, así que Rappi no recibió nada y no cuenta como una de sus 3 solicitudes.
 * Sin esto, cada intento bloqueado del KDS o del barrido gastaba una de las 3 y, al agotarlas, el «listo» quedaba cerrado
 * por `TOPE` sin haberle llegado nunca a Rappi.
 *
 * Resta 1 con la fila bloqueada (la misma resolución que la reserva), y SÓLO si el «listo» no cerró y el contador es mayor
 * que 0: lo cerrado no se reabre y el contador nunca queda negativo. Sin la fila del aviso no hace nada. 🔴 Quien la llama
 * SÓLO la usa cuando se SABE que la llamada no salió: ante la duda (un timeout, un 5xx) la reserva se queda — ya contó.
 */
export async function devolverLlamadaDeListo(externalOrderId: string, storeId: string): Promise<void> {
  await prisma.$transaction(async tx => {
    const fila = await avisoBloqueado(tx, externalOrderId, storeId)
    if (!fila) return
    const listo = leerEstado(fila.resourcePayload).listo
    if (!listo || listo.cerrado || listo.llamadas <= 0) return
    await guardarListo(tx, fila.id, { llamadas: listo.llamadas - 1 })
  })
}

/**
 * El «listo» de este pedido ya no se intenta más, y por qué: `HTTP_2XX` (Rappi lo recibió), `TRANSICION_INVALIDA` (su estado
 * ya no lo admite) o `TOPE` (se usaron las 3). Conserva las llamadas. 🔴 El PRIMER cierre manda: un `TOPE` que llega después
 * no borra que Rappi ya había contestado 2xx. Encuentra la fila igual que la reserva (también si el vínculo cambió de tienda);
 * sin la fila del aviso no hace nada.
 */
export async function cerrarListo(externalOrderId: string, storeId: string, como: CierreDeListo): Promise<void> {
  await prisma.$transaction(async tx => {
    const fila = await avisoBloqueado(tx, externalOrderId, storeId)
    if (!fila) return
    const listo = leerEstado(fila.resourcePayload).listo
    if (listo?.cerrado) return
    await guardarListo(tx, fila.id, { llamadas: listo?.llamadas ?? 0, cerrado: como })
  })
}

/**
 * ¿El 400 del «listo» dice que el pedido ya no admite esa transición? Entonces repetirlo daría lo mismo: se cierra.
 *
 * 🔴 Ajustar con M4 cuando se vea el 400 real (recorrido-real.md). En el sandbox el «listo» sólo contestó 424 («inténtelo
 * más tarde», que NO es esto), así que la expresión es la del plan. La forma en inglés sí se vio, al rechazar un pedido
 * tomado (M11): «[ORDER 722609056] Invalid transition from {TAKEN} to {REJECTED} state, check out …».
 *
 * Rappi envuelve el cuerpo de su servicio interno en otro `message`, con el código HTTP adelante: el 424 real llegó como
 * `{"message":"424 {\"code\":…,\"message\":\"No se pudo…\"}"}`. Por eso se busca en el texto crudo y también en cada
 * `message` y `code` de adentro, desenvolviendo hasta tres capas (así un acento escapado, `\u00f3`, también se lee).
 *
 * En español acepta el femenino y el masculino: la documentación de Rappi dice «Estado de transición inválido».
 */
const TRANSICION_INVALIDA = /transici[oó]n inv[aá]lid[ao]|invalid transition/i
const CAPAS_DEL_CUERPO = 3

export function esTransicionInvalida(raw: string): boolean {
  return textosDelCuerpo(raw).some(t => TRANSICION_INVALIDA.test(t))
}

/** El texto crudo y los `message`/`code` que trae adentro, capa por capa. */
function textosDelCuerpo(raw: string): string[] {
  const textos: string[] = []
  let capa = [raw]
  for (let i = 0; i <= CAPAS_DEL_CUERPO && capa.length > 0; i++) {
    const siguiente: string[] = []
    for (const texto of capa) {
      textos.push(texto)
      const json = jsonDentro(texto)
      if (!esObjeto(json)) continue
      for (const llave of ['message', 'code']) {
        const v = json[llave]
        if (typeof v === 'string') siguiente.push(v)
      }
    }
    capa = siguiente
  }
  return textos
}

/** El JSON de un texto: todo él, o desde su primer `{` («424 {…}»). `undefined` si no hay uno legible. */
function jsonDentro(texto: string): unknown {
  const inicio = texto.indexOf('{')
  if (inicio < 0) return undefined
  try {
    return JSON.parse(texto.slice(inicio))
  } catch {
    return undefined
  }
}
