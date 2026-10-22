/**
 * Mantener el menú del proveedor igual al de Avoqado, sin que nadie se acuerde de publicarlo.
 *
 * 🔴 POR QUÉ IMPORTA (founder, 2026-08-20): un menú desactualizado en Uber cuesta dinero de
 * dos formas, y ninguna falla visiblemente:
 *   · El cliente paga el precio VIEJO. Uber cobra lo que su menú dice; nosotros recibimos
 *     eso. Si subiste el precio y Uber no se enteró, la diferencia la come el negocio.
 *   · El cliente pide algo que ya no existe y hay que rechazar el pedido. Uber exige
 *     **99.9% de tasa de inyección** y por debajo del 99% REVOCA el acceso. Los rechazos
 *     por menú viejo se pagan con la integración entera.
 *
 * 🔴 POR HUELLA, NO POR EVENTOS. Se compara una huella del menú publicado contra la del
 * menú actual, en vez de engancharse a cada edición de producto. La diferencia es lo que
 * hace que esto SIRVA:
 *   · Un enganche por evento sólo ve los caminos que alguien se acordó de instrumentar. En
 *     este repo el menú se toca desde el dashboard, el MCP, scripts de migración y a veces
 *     SQL directo — el primero que no dispare el evento deja el menú viejo para siempre,
 *     en silencio.
 *   · La huella se AUTO-CORRIGE: si una publicación falló, o el proceso murió a media
 *     publicación, o alguien cambió algo por fuera, la siguiente pasada lo detecta sola.
 *     ⚠️ Salvo con un proveedor que REVISA el menú (`menuConRevision`): ahí un menú que se mandó
 *     y no recibe veredicto (o un proceso que murió entre reservar la pendiente y el POST) se
 *     queda «en revisión» y avisa al pasar el plazo, sin republicarse solo (ver `syncChannelMenu`).
 *   · Es idempotente por construcción: sin cambios, no publica nada.
 */
import { createHash } from 'node:crypto'

import { DeliveryChannelStatus, Prisma, type DeliveryChannelLink } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

import { adapterFor, hasAdapter } from './adapterRegistry'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'

import { resolveDeliveryHours } from './deliveryHours.service'
import { escribirLlavesDelSistema, leerMenuEnRevision, leerMenuRechazado, mismaPublicacion, type MenuEnRevision } from './llavesDelSistema'
import { buildMenuSnapshot } from './menuSnapshot.service'
import { DeliveryWriteNotSentError, type ProblemaDeMenu, type PublicacionDeMenu } from './types'

/**
 * `IN_REVIEW`: hay un menú en revisión (esperando veredicto del proveedor) y no se publica nada encima.
 * `REJECTED_UNCHANGED`: el menú es el mismo que el proveedor ya rechazó; se vuelve a mandar cuando cambie.
 */
export type MenuSyncOutcome = 'PUBLISHED' | 'UNCHANGED' | 'NO_PUBLISHER' | 'FAILED' | 'IN_REVIEW' | 'REJECTED_UNCHANGED'

/**
 * Cuánto se espera el veredicto de un menú en revisión antes de avisar con 🚨. Pasado el plazo NO se sella ni se republica
 * (diseño §4.5.1: la recuperación sin aviso nunca sella): sólo se avisa, UNA vez, y el menú sigue «en revisión».
 * 6 h: el sandbox no mandó ningún veredicto en ~5 h (M8, 22-oct), así que el plazo real no está medido.
 */
export const PLAZO_SIN_VEREDICTO_MS = 6 * 60 * 60 * 1000

export interface MenuSyncResult {
  outcome: MenuSyncOutcome
  linkId: string
  items?: number
  error?: string
}

/** Huella estable del menú TAL COMO SE VA A PUBLICAR. */
function huella(payload: unknown): string {
  // Se hashea el payload YA TRADUCIDO, no el snapshot interno, y es deliberado: si mañana
  // arreglamos un bug del traductor, la huella cambia y el menú se republica solo. Hashear
  // el snapshot dejaría a Uber con el menú mal traducido hasta que alguien editara un
  // producto por casualidad.
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/**
 * Publica el menú de un canal SÓLO si cambió.
 *
 * @param force Publica aunque la huella coincida. Es para `store.menu_refresh_request`:
 *   cuando Uber PIDE el menú, se lo damos aunque creamos que ya lo tiene — si lo pide es
 *   porque algo se le perdió, y discutirle sería confiar en nuestro registro por encima del
 *   suyo justo en el caso donde el nuestro está mal.
 *
 * 🔴 MENÚ EN REVISIÓN (`adapter.menuConRevision`): el 2xx del POST sólo dice «lo recibí, lo voy a revisar»; lo publicado lo
 * dice un veredicto aparte. Entonces:
 *   1. con un menú en revisión no se publica NADA encima, ni con `force`; pasado el plazo se avisa UNA vez y se sigue igual;
 *   2. ANTES del POST la huella queda reservada como pendiente (con su hora), decidido con la fila BLOQUEADA: así un veredicto
 *      que llega mientras el POST viaja la encuentra, y dos pasadas encimadas no mandan dos veces (ni lo ya rechazado o aprobado);
 *   3. si se SABE que no salió o que el proveedor dijo que no (4xx, `status: 0` sin red, `DeliveryWriteNotSentError`), la
 *      pendiente se suelta (si sigue siendo ésa); con 400/422 la huella queda como rechazada y no se vuelve a mandar igual; si
 *      mientras tanto un veredicto de OTRA publicación selló esa huella, el sello se quita (ver `soltarRevision`);
 *   4. si NO se sabe (timeout, red, 5xx), la pendiente se queda: la resuelve el veredicto, o avisa al pasar el plazo;
 *   5. el 2xx no escribe nada más que los problemas: lo sella (o lo limpia) el veredicto.
 * Sin `menuConRevision` todo es como siempre: el 2xx sella la huella.
 */
export async function syncChannelMenu(link: DeliveryChannelLink, opts: { force?: boolean } = {}): Promise<MenuSyncResult> {
  if (!hasAdapter(link.provider)) return { outcome: 'NO_PUBLISHER', linkId: link.id }

  const adapter = adapterFor(link.provider)
  if (typeof adapter.publishMenu !== 'function') return { outcome: 'NO_PUBLISHER', linkId: link.id }
  const conRevision = adapter.menuConRevision === true

  try {
    // 1. 🔴 Con un menú en revisión no se publica NADA encima, ni con `force`: el veredicto que llegue sería del menú
    // anterior y sellaría el nuevo (o lo tiraría). Es la salida barata: ni snapshot ni red.
    const enRevision = leerMenuEnRevision(link.config)
    if (enRevision) return await seguirEnRevision(link, enRevision)

    const snapshot = await buildMenuSnapshot(link.venueId)

    // 🔴 El horario va SIEMPRE, y entra en la huella: si el dueño cambia sus horas, el menú
    // se republica solo. Antes se publicaba 24/7 en silencio y nadie se enteraba de que su
    // negocio aparecía abierto de madrugada.
    const { horario, fuente } = await resolveDeliveryHours(link)
    const availability = typeof adapter.mapHours === 'function' ? adapter.mapHours(horario) : undefined

    // 🔴 Precios propios del canal. Uber cobra ~30% de comisión, así que casi todo comercio
    // publica más caro allá. Sin esto, este sincronizador le borraría su markup CADA 5
    // MINUTOS y perdería dinero en cada pedido sin entender por qué — es la falla que los
    // agregadores (Otter, Chowly) documentan como la más común al conectar un POS.
    const precios = (link.config as { precios?: unknown } | null)?.precios
    // Se traduce ANTES de decidir: es lo que de verdad va a viajar, y es lo que hay que
    // comparar. Cuesta CPU y nada de red.
    const payload = adapter.buildMenuPayload ? adapter.buildMenuPayload(snapshot, { availability, precios }) : snapshot
    const actual = huella(payload)

    // 2. Igual a lo publicado: nada que hacer (salvo `force`, que es justo para republicar lo que creemos que ya tienen).
    if (!opts.force && actual === link.lastMenuHash) return { outcome: 'UNCHANGED', linkId: link.id }
    // 3. Igual a lo que el proveedor ya rechazó: mandarlo otra vez daría el mismo rechazo (y cada uno cuenta contra su tasa
    // de éxito). Sale en cuanto el menú cambie.
    if (!opts.force && actual === leerMenuRechazado(link.config)?.huella) return { outcome: 'REJECTED_UNCHANGED', linkId: link.id }

    // 4. Con revisión, la pendiente se reserva ANTES del POST, decidiendo con la fila bloqueada (la copia puede ser vieja).
    let reserva: Reserva | null = null
    if (conRevision) {
      const reservada = await reservarRevision(link.id, actual, opts.force === true)
      if (!('huella' in reservada)) return { outcome: reservada.outcome, linkId: link.id }
      reserva = reservada
    }

    let r: PublicacionDeMenu
    try {
      r = await adapter.publishMenu(snapshot, link.externalLocationId, { availability, precios })
    } catch (error) {
      if (!reserva) throw error
      const msg = error instanceof Error ? error.message : String(error)
      if (error instanceof DeliveryWriteNotSentError) {
        // Se SABE que no salió (candado, token): ningún veredicto va a llegar. Se suelta y la siguiente pasada reintenta.
        await soltarRevision(link.id, reserva, { rechazada: false })
        logger.warn('📋 [MenuSync] el menú NO salió hacia el proveedor (falló antes de la red): se reintenta en la siguiente pasada', {
          linkId: link.id,
          venueId: link.venueId,
          provider: link.provider,
          reason: error.reason,
          error: msg,
        })
      } else {
        // 🔴 No se sabe si llegó (timeout, red a medias): la pendiente se QUEDA. Limpiarla tiraba un veredicto genuino que
        // llegaba después (Codex plan r2 #1). Si el veredicto no llega, se avisa al pasar el plazo.
        logger.error('🚨 [MenuSync] el POST del menú no contestó: queda EN REVISIÓN hasta el veredicto (o el aviso del plazo)', {
          linkId: link.id,
          venueId: link.venueId,
          provider: link.provider,
          error: msg,
        })
      }
      return { outcome: 'FAILED', linkId: link.id, error: msg }
    }

    const items = (payload as { items?: unknown[] })?.items?.length

    if (r.ok) {
      if (reserva) {
        // 5. 🔴 El 2xx NO sella y no toca la pendiente: «en revisión» no es «publicado», y si el veredicto llegó mientras el
        // POST viajaba, ya la selló o la limpió. Sólo se guardan los problemas.
        await guardarProblemas(link, r.problemas)
        logger.info('📋 [MenuSync] menú enviado al proveedor: queda EN REVISIÓN hasta su veredicto', {
          linkId: link.id,
          venueId: link.venueId,
          provider: link.provider,
          items,
        })
        return { outcome: 'PUBLISHED', linkId: link.id, items }
      }

      // 6. Sin revisión, el 2xx ES «publicado»: se sella en el acto, como siempre.
      await prisma.deliveryChannelLink.update({
        where: { id: link.id },
        data: { lastMenuHash: actual, lastMenuSyncAt: new Date() },
      })
      await guardarProblemas(link, r.problemas)
      logger.info('📋 [MenuSync] menú actualizado en el proveedor', {
        linkId: link.id,
        venueId: link.venueId,
        provider: link.provider,
        items,
      })
      return { outcome: 'PUBLISHED', linkId: link.id, items }
    }

    // 🔴 NO se guarda la huella si falló: guardarla haría que la siguiente pasada creyera que el proveedor ya lo tiene, y
    // el menú se quedaría viejo PARA SIEMPRE sin volver a intentar.
    const sabemosQueNo = r.status === 0 || (r.status >= 400 && r.status < 500)
    if (reserva && sabemosQueNo) {
      // Un 4xx (el proveedor dijo que no) o `status: 0` (el adaptador no salió a la red, p. ej. el menú quedó vacío tras
      // filtrar; Codex plan r3 #1): ningún veredicto va a llegar. Con 400/422 (validación), la huella queda rechazada.
      await soltarRevision(link.id, reserva, { rechazada: r.status === 400 || r.status === 422, problemas: r.problemas })
    } else {
      // Sin revisión, o con un 5xx en revisión (no se sabe si lo procesó: la pendiente se queda).
      await guardarProblemas(link, r.problemas)
    }
    logger.error(
      reserva && !sabemosQueNo
        ? '🚨 [MenuSync] el proveedor contestó con error al menú: queda EN REVISIÓN hasta el veredicto (o el aviso del plazo)'
        : '🚨 [MenuSync] el proveedor rechazó el menú — queda desactualizado',
      {
        linkId: link.id,
        venueId: link.venueId,
        provider: link.provider,
        status: r.status,
        cuerpo: r.raw.slice(0, 300),
        problemas: r.problemas?.slice(0, 10),
      },
    )
    return { outcome: 'FAILED', linkId: link.id, error: `HTTP ${r.status}` }
  } catch (error) {
    logger.error('🚨 [MenuSync] falló la sincronización del menú', {
      linkId: link.id,
      venueId: link.venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { outcome: 'FAILED', linkId: link.id, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Un menú en revisión: no se publica nada encima. Pasado el plazo sin veredicto, avisa con 🚨 UNA vez (lo anota en la
 * pendiente con la fila bloqueada: dos pasadas encimadas no avisan dos veces) y sigue igual. 🔴 Nunca sella ni republica: un
 * menú que no recibe veredicto se queda «en revisión» hasta que llegue o alguien lo destrabe (diseño §4.5.1).
 */
async function seguirEnRevision(link: DeliveryChannelLink, enRevision: MenuEnRevision): Promise<MenuSyncResult> {
  const edadMs = Date.now() - Date.parse(enRevision.publicadaEn)
  // Una hora ilegible cuenta como vencida: se avisa en vez de esperar para siempre.
  const vencida = Number.isNaN(edadMs) || edadMs > PLAZO_SIN_VEREDICTO_MS
  if (enRevision.sinVeredictoAvisadoEn || !vencida) return { outcome: 'IN_REVIEW', linkId: link.id }

  const avisadoEn = new Date().toISOString()
  const avise = await escribirLlavesDelSistema(link.id, fila => {
    const vigente = leerMenuEnRevision(fila.config)
    if (!vigente || !mismaPublicacion(vigente, enRevision) || vigente.sinVeredictoAvisadoEn) return null
    return { menuEnRevision: { ...vigente, sinVeredictoAvisadoEn: avisadoEn } }
  })
  if (avise) {
    logger.error('🚨 [MenuSync] el proveedor no ha dado veredicto del menú en el plazo: sigue EN REVISIÓN, sin sellar ni republicar', {
      linkId: link.id,
      venueId: link.venueId,
      provider: link.provider,
      publicadaEn: enRevision.publicadaEn,
      horasEsperando: Number.isNaN(edadMs) ? null : Math.floor(edadMs / 3_600_000),
      queHacer: 'Revisar en el portal del proveedor si el menú quedó aprobado o rechazado, y destrabarlo a mano.',
    })
  }
  return { outcome: 'IN_REVIEW', linkId: link.id }
}

/**
 * Reserva la pendiente ANTES del POST. 🔴 Decide con lo leído BAJO CANDADO, no con la copia del vínculo, que puede ser vieja
 * si dos pasadas se enciman (Codex plan r3 #2): sólo reserva si no hay otra pendiente y, salvo `force`, si la huella no es la
 * `lastMenuHash` vigente ni la rechazada vigente. La hora se toma dentro, justo antes de escribir: lo más cerca posible del POST.
 */
async function reservarRevision(
  linkId: string,
  huella: string,
  force: boolean,
): Promise<Reserva | { outcome: 'IN_REVIEW' | 'UNCHANGED' | 'REJECTED_UNCHANGED' | 'FAILED' }> {
  let resultado: Reserva | { outcome: 'IN_REVIEW' | 'UNCHANGED' | 'REJECTED_UNCHANGED' | 'FAILED' } = { outcome: 'FAILED' }
  await escribirLlavesDelSistema(linkId, fila => {
    if (leerMenuEnRevision(fila.config)) resultado = { outcome: 'IN_REVIEW' }
    else if (!force && fila.lastMenuHash === huella) resultado = { outcome: 'UNCHANGED' }
    else if (!force && leerMenuRechazado(fila.config)?.huella === huella) resultado = { outcome: 'REJECTED_UNCHANGED' }
    else {
      const pendiente: MenuEnRevision = { huella, publicadaEn: new Date().toISOString() }
      // Sólo con `force` la huella puede estar sellada YA al reservar: ese sello es de antes, no de un aviso ajeno.
      resultado = { ...pendiente, yaSellada: fila.lastMenuHash === huella }
      return { menuEnRevision: { ...pendiente } }
    }
    return null
  })
  // Sin fila (el vínculo se borró a media pasada) queda `FAILED`: no hay a quién publicarle.
  return resultado
}

/** La pendiente que reservó esta pasada, y si su huella YA estaba sellada al reservar (sólo pasa con `force`). No se guarda. */
type Reserva = MenuEnRevision & { yaSellada: boolean }

/**
 * Se SABE que no salió, o el proveedor dijo que no: ningún veredicto va a llegar. Suelta la pendiente SÓLO si sigue siendo la
 * misma publicación (misma huella y hora: otra ya pudo reservar la suya, y limpiarla tiraría esa revisión). Con `rechazada`, la
 * huella queda como rechazada aunque la pendiente ya no sea la suya: es un hecho sobre ESA huella. Guarda los problemas.
 *
 * 🔴 EL SELLO AJENO (T16b): tras reservar la huella, sólo un veredicto escribe `lastMenuHash`. Si al soltar vale esa huella (y no
 * estaba sellada ya al reservar), la selló un aviso de OTRA publicación mientras viajaba este POST, que el proveedor rechazó o
 * que nunca salió: el proveedor NO tiene ese menú. Se quita el sello, bajo el mismo candado y en la misma transacción que la
 * pendiente: quedaba «al día» un menú que el proveedor nunca recibió (o rechazado Y publicado a la vez).
 */
async function soltarRevision(
  linkId: string,
  reserva: Reserva,
  { rechazada, problemas }: { rechazada: boolean; problemas?: ProblemaDeMenu[] },
): Promise<void> {
  const en = new Date().toISOString()
  const sello = { ajeno: false }
  await prisma.$transaction(async tx => {
    await escribirLlavesDelSistema(
      linkId,
      fila => {
        sello.ajeno = !reserva.yaSellada && fila.lastMenuHash === reserva.huella
        const parche = {
          ...(mismaPublicacion(leerMenuEnRevision(fila.config), reserva) ? { menuEnRevision: null } : {}),
          ...(rechazada ? { menuRechazado: { huella: reserva.huella, en } } : {}),
          ...(problemas ? { menuProblemas: { en, problemas } } : {}),
        }
        return Object.keys(parche).length > 0 ? parche : null
      },
      tx,
    )
    if (sello.ajeno) await tx.deliveryChannelLink.update({ where: { id: linkId }, data: { lastMenuHash: null } })
  })
  if (sello.ajeno) {
    logger.warn(
      '📋 [MenuSync] un veredicto de OTRA publicación selló el menú mientras su POST no salió o fue rechazado: se quita el sello',
      {
        linkId,
        huella: reserva.huella,
        rechazada,
      },
    )
  }
}

/**
 * Los problemas de la última publicación, a la vista. Sólo si el adaptador los informa (`undefined` = no los informa: no se
 * toca lo guardado). Nunca lanza: perderlos no cambia lo que el proveedor recibió.
 */
async function guardarProblemas(link: DeliveryChannelLink, problemas: ProblemaDeMenu[] | undefined): Promise<void> {
  if (!problemas) return
  const en = new Date().toISOString()
  try {
    await escribirLlavesDelSistema(link.id, () => ({ menuProblemas: { en, problemas } }))
  } catch (error) {
    logger.warn('📋 [MenuSync] no se pudieron guardar los problemas del menú (la publicación no cambia)', {
      linkId: link.id,
      venueId: link.venueId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export type ResultadoDelVeredicto = 'SELLADO' | 'RECHAZO_ANOTADO' | 'NO_APLICA'
/** El resultado y la hora de la publicación que se juzgó (`null` sin pendiente): con la de la firma se mide el desfase del reloj. */
export interface VeredictoDelMenu {
  resultado: ResultadoDelVeredicto
  publicadaEn: string | null
}

/**
 * Aplica el veredicto del proveedor (aprobado o rechazado) a la pendiente VIGENTE, con la fila bloqueada y dentro de la
 * transacción `tx` del llamador: el procesador cierra el evento del aviso en esa MISMA transacción (Codex r3 #1), así que si
 * el proceso cae entre los dos, el reintento encuentra el evento cerrado y no aplica un veredicto viejo a la pendiente nueva.
 *
 * 🔴 LA REGLA DE LA HORA (diseño §4.5.1): el aviso del veredicto no dice DE QUÉ menú es. Sólo se aplica a una pendiente
 * publicada ANTES de que el proveedor lo firmara (`firmadoEnMs`, la hora de su firma). Un aviso duplicado o reprocesado,
 * firmado antes de la publicación siguiente, no la toca. SIN TOLERANCIA (Codex plan r1 #2): cualquier margen deja que un aviso
 * firmado antes de la publicación selle el menú siguiente. Sin hora de firma (o con la de la pendiente ilegible) no hay cómo
 * saberlo, y no se aplica: el menú sigue en revisión y el aviso del plazo lo hace visible.
 *  · Sin pendiente: una aprobación sólo deja la fecha (`lastMenuSyncAt`); un rechazo no anota nada. `NO_APLICA`.
 *  · Aprobación ⇒ `lastMenuHash` = la huella pendiente y la fecha; limpia la pendiente y el rechazo anterior. `SELLADO`.
 *  · Rechazo ⇒ limpia la pendiente y guarda la huella rechazada (no se republica hasta que el menú cambie). `RECHAZO_ANOTADO`.
 * Residual aceptado por el founder: un aviso viejo reenviado con una firma NUEVA justo después de publicar se tomaría como de la
 * publicación nueva (la pregunta va al proveedor).
 */
export async function aplicarVeredictoDeMenu(
  tx: Prisma.TransactionClient,
  linkId: string,
  v: { aprobado: boolean; firmadoEnMs: number | null },
): Promise<VeredictoDelMenu> {
  // Lo que decide `cambio` con la fila bloqueada (un objeto y no `let`s: TypeScript no ve las asignaciones del callback).
  const decision: { resultado: ResultadoDelVeredicto; publicadaEn: string | null; huella?: string; soloLaFecha?: boolean } = {
    resultado: 'NO_APLICA',
    publicadaEn: null,
  }
  const ahora = new Date()

  await escribirLlavesDelSistema(
    linkId,
    fila => {
      const pendiente = leerMenuEnRevision(fila.config)
      if (!pendiente) {
        decision.soloLaFecha = v.aprobado // una aprobación sin pendiente (publicación a mano, o anterior al mecanismo): sólo la fecha
        if (v.aprobado) logger.info('📋 [MenuSync] aprobación del menú sin pendiente: sólo queda la fecha', { linkId, aprobado: true })
        // El proveedor rechazó ALGO y no hay pendiente que lo explique: a la vista, no en un `info` que nadie lee.
        else
          logger.warn('📋 [MenuSync] rechazo del menú sin pendiente: no hay qué anotar; revisar en el portal del proveedor qué rechazó', {
            linkId,
            aprobado: false,
          })
        return null
      }
      decision.publicadaEn = pendiente.publicadaEn
      const publicadaMs = Date.parse(pendiente.publicadaEn)
      if (v.firmadoEnMs === null || Number.isNaN(publicadaMs)) {
        logger.warn('📋 [MenuSync] veredicto del menú sin hora de firma (o pendiente sin hora legible): no se aplica', {
          linkId,
          aprobado: v.aprobado,
          firmadoEnMs: v.firmadoEnMs,
          publicadaEn: pendiente.publicadaEn,
        })
        return null
      }
      if (v.firmadoEnMs < publicadaMs) {
        // 🔴 El aviso es de una publicación ANTERIOR (duplicado o reprocesado): sellaría (o tiraría) un menú que el proveedor
        // todavía no revisa.
        logger.warn('📋 [MenuSync] veredicto del menú firmado ANTES de publicar la pendiente: es de otra publicación, no se aplica', {
          linkId,
          aprobado: v.aprobado,
          firmadoEn: new Date(v.firmadoEnMs).toISOString(),
          publicadaEn: pendiente.publicadaEn,
        })
        return null
      }
      decision.huella = pendiente.huella
      if (v.aprobado) {
        decision.resultado = 'SELLADO'
        return { menuEnRevision: null, menuRechazado: null }
      }
      decision.resultado = 'RECHAZO_ANOTADO'
      return { menuEnRevision: null, menuRechazado: { huella: pendiente.huella, en: ahora.toISOString() } }
    },
    tx,
  )

  // Las columnas, con la fila TODAVÍA bloqueada (misma transacción): sólo lo que el veredicto decidió arriba.
  if (decision.resultado === 'SELLADO' && decision.huella) {
    await tx.deliveryChannelLink.update({ where: { id: linkId }, data: { lastMenuHash: decision.huella, lastMenuSyncAt: ahora } })
  } else if (decision.soloLaFecha) {
    await tx.deliveryChannelLink.update({ where: { id: linkId }, data: { lastMenuSyncAt: ahora } })
  }
  return { resultado: decision.resultado, publicadaEn: decision.publicadaEn }
}

/**
 * ¿Está el menú de este canal al día en el proveedor?
 *
 * Vive aquí, en UN solo lugar, y lo consumen el MCP y el REST del dashboard. Dos derivaciones
 * de lo mismo se separan: la del MCP diría "al día" mientras la del dashboard dice "nunca
 * publicado", y quien las lea no sabrá a cuál creerle.
 *
 * Se puede contestar sin adivinar porque `lastMenuHash` se guarda SÓLO cuando la publicación
 * salió bien: su ausencia con el auto-sync prendido significa exactamente "nunca se logró
 * publicar", no "todavía no toca".
 */
export type MenuSyncStatus = 'MANUAL' | 'NUNCA_PUBLICADO' | 'AL_DIA'

export function menuSyncStatusOf(link: { autoSyncMenu: boolean; lastMenuHash: string | null }): MenuSyncStatus {
  if (!link.autoSyncMenu) return 'MANUAL' // el dueño lo apagó: mantiene su menú a mano
  return link.lastMenuHash === null ? 'NUNCA_PUBLICADO' : 'AL_DIA'
}

/** Los canales que deben mantenerse sincronizados: activos y con el auto-sync prendido. */
export function syncableLinksWhere() {
  return {
    status: DeliveryChannelStatus.ACTIVE,
    // El dueño puede apagarlo si maneja su menú de Uber a mano — pero es opt-OUT: el default
    // del schema es `true`, porque el peligro es el menú viejo, no el sincronizado.
    autoSyncMenu: true,
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// DISPONIBILIDAD (agotar / revivir un producto)
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Marca en el proveedor los productos que se acabaron, y revive los que volvieron.
 *
 * 🔴 Es la operación que más veces al día importa, y es lo CONTRARIO de republicar el menú:
 * toca un item, es barata, y no puede romper nada. Sin ella el proveedor sigue vendiendo lo
 * que ya no hay — o entregas de menos, o rechazas el pedido, y cada rechazo cuenta contra la
 * tasa de inyección que Uber exige para no revocar el acceso.
 *
 * 🔴 SÓLO productos que de verdad llevan inventario, y sólo si el venue tiene la función
 * activa. Sin `INVENTORY_TRACKING` los números de stock no se mantienen y son basura:
 * agotar productos con base en basura los ESCONDE de la app sin motivo, que es peor que
 * venderlos de más.
 *
 * [mercado] Es exactamente lo que hace Square: marca agotado al llegar a cero **sólo si ese
 * producto tiene el seguimiento de inventario prendido**; si no, lo sigue vendiendo.
 *
 * ⚠️ Y NO contradice nuestra paridad de stock negativo (Square-parity, 2026-08-12): dejar
 * vender por debajo de cero es para el MOSTRADOR, donde hay una persona que ve la bodega y
 * decide. En un marketplace nadie está ahí: el cliente pide a ciegas y el rechazo lo paga el
 * negocio. Contextos distintos, decisiones distintas, a propósito.
 *
 * ⚠️ LÍMITE CONOCIDO: sólo cubre productos con inventario PROPIO. Un platillo cuya
 * disponibilidad depende de su receta (se acabó la carne ⇒ no hay hamburguesas) NO se detecta
 * todavía — hace falta explotar recetas, que es su propia rebanada.
 */
export async function syncChannelAvailability(link: DeliveryChannelLink): Promise<{ agotados: number; revividos: number }> {
  if (!hasAdapter(link.provider)) return { agotados: 0, revividos: 0 }
  const adapter = adapterFor(link.provider)
  if (typeof adapter.setItemSoldOut !== 'function') return { agotados: 0, revividos: 0 }

  if (!(await venueHasFeatureAccess(link.venueId, 'INVENTORY_TRACKING'))) return { agotados: 0, revividos: 0 }

  // (a) Productos con inventario PROPIO que se acabaron.
  const sinStock = await prisma.product.findMany({
    where: { venueId: link.venueId, active: true, inventory: { currentStock: { lte: 0 } } },
    select: { sku: true },
  })
  const deben = new Set(sinStock.map(p => p.sku).filter(Boolean) as string[])

  // (b) 🔴 Platillos que NO SE PUEDEN HACER porque falta un ingrediente. Es el caso que de
  // verdad pasa en una cocina: no se acaba "la hamburguesa", se acaba la carne — y entonces
  // TODOS los platillos que la llevan dejan de existir. Sin esto, Uber los sigue vendiendo y
  // cada uno termina en un rechazo, que es lo que cuenta contra la tasa de inyección.
  const conReceta = await prisma.product.findMany({
    where: { venueId: link.venueId, active: true, recipe: { isNot: null } },
    select: {
      sku: true,
      recipe: {
        select: {
          portionYield: true,
          lines: {
            // Un ingrediente OPCIONAL que falte no impide hacer el platillo — sólo sale sin
            // él. Contarlo agotaría platillos que sí se pueden preparar.
            where: { isOptional: false },
            select: { quantity: true, rawMaterial: { select: { currentStock: true, name: true } } },
          },
        },
      },
    },
  })

  for (const p of conReceta) {
    if (!p.sku || !p.recipe) continue
    const porciones = p.recipe.portionYield > 0 ? p.recipe.portionYield : 1
    const faltaAlgo = p.recipe.lines.some(l => {
      // Lo que se necesita para UNA porción: la receta rinde `portionYield`.
      const necesario = l.quantity.div(porciones)
      return l.rawMaterial.currentStock.lessThan(necesario)
    })
    if (faltaAlgo) deben.add(p.sku)
  }

  // Lo que ya le dijimos al proveedor. Se guarda la LISTA y no una huella: hace falta el
  // contenido para mandar sólo la diferencia — repetir el estado de 96 productos cada 5
  // minutos serían 96 llamadas por nada.
  const previo = new Set(((link.config as { soldOutSkus?: string[] } | null)?.soldOutSkus ?? []) as string[])

  const agotar = [...deben].filter(sku => !previo.has(sku))
  const revivir = [...previo].filter(sku => !deben.has(sku))
  if (agotar.length === 0 && revivir.length === 0) return { agotados: 0, revividos: 0 }

  const logrados = new Set(previo)
  for (const sku of agotar) {
    const r = await adapter.setItemSoldOut(sku, link.externalLocationId, true)
    // Sólo se registra lo que el proveedor ACEPTÓ. Guardar un fallo como hecho haría que la
    // siguiente pasada creyera que ya está agotado y nunca lo reintentara.
    if (r.ok) logrados.add(sku)
  }
  for (const sku of revivir) {
    const r = await adapter.setItemSoldOut(sku, link.externalLocationId, false)
    if (r.ok) logrados.delete(sku)
  }

  // 🔴 Se relee `config` BLOQUEANDO la fila y se cambia sólo `soldOutSkus`. `link.config` se leyó al
  // empezar la pasada, antes de las llamadas al proveedor: escribirlo de vuelta pisaba lo que el dueño
  // guardó mientras tanto (su recargo de precios, su horario) y la siguiente publicación del menú salía
  // con el precio viejo. El candado se toma DESPUÉS del HTTP, nunca durante.
  await prisma.$transaction(async tx => {
    const [fila] = await tx.$queryRaw<{ config: Prisma.JsonValue }[]>`
      SELECT "config" FROM "DeliveryChannelLink" WHERE "id" = ${link.id} FOR UPDATE`
    if (!fila) return // el canal se borró mientras tanto: no hay a quién escribirle
    const actual = fila.config && typeof fila.config === 'object' && !Array.isArray(fila.config) ? fila.config : {}
    await tx.deliveryChannelLink.update({
      where: { id: link.id },
      data: { config: { ...actual, soldOutSkus: [...logrados] } },
    })
  })

  logger.info('🥡 [MenuSync] disponibilidad actualizada en el proveedor', {
    linkId: link.id,
    venueId: link.venueId,
    agotados: agotar.length,
    revividos: revivir.length,
  })
  return { agotados: agotar.length, revividos: revivir.length }
}
