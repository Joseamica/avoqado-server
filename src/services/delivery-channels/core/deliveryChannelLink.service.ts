/**
 * Gestión de canales de delivery (DeliveryChannelLink) — CRUD + pause/resume (Task 10).
 *
 * Reglas clave:
 * - `webhookSecret` se genera una sola vez en create (crypto.randomBytes(32).toString('hex'))
 *   y JAMÁS se devuelve al caller — todo read/return pasa por `SAFE_SELECT`, que lo excluye
 *   explícitamente. El adapter (`setChannelPaused`) sí necesita el registro completo
 *   (interfaz `DeliveryProviderAdapter` recibe el link entero), así que `pauseChannelLink`
 *   lee una vez sin `select` para ese uso interno y solo strippea el secret al devolver.
 * - update/pause SIEMPRE filtran por `where: { id, venueId }` en la mutación misma
 *   (vía `updateMany` + chequeo de `count`) — tenant isolation a nivel de query, no solo
 *   de una lectura previa. Un link de otro venue → NotFoundError, nunca se toca.
 * - pause llama al adapter del proveedor (`getAdapter`, registry de `statusDispatcher.service`)
 *   best-effort: un fallo de red/proveedor NUNCA debe tumbar la mutación de status interna
 *   (mismo patrón que `dispatchOrderStatus`) — se loguea y se traga.
 * - Cada mutación escribe ActivityLog vía `logAction` (fire-and-forget, `void`, fuera de
 *   cualquier transacción) — auditoría de conexión/edición/pausa de canales.
 */
import crypto from 'crypto'
import { DeliveryChannelLink, DeliveryChannelStatus, DeliveryProvider, OrderAcceptanceMode, Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import { ConflictError, NotFoundError, ValidationError } from '../../../errors/AppError'
import { logAction } from '../../dashboard/activity-log.service'
import { adapterFor, hasAdapter } from './adapterRegistry'
import { esHorarioValido } from './deliveryHours.service'
import { calcularTasaInyeccion } from './injectionRate.service'
import { menuSyncStatusOf } from './menuSync.service'
import { getAdapter } from './statusDispatcher.service'

/** Select explícito — NUNCA incluye `webhookSecret`. Usado por list/create/update. */
const SAFE_SELECT = {
  id: true,
  venueId: true,
  provider: true,
  externalLocationId: true,
  externalAccountId: true,
  orderAcceptanceMode: true,
  status: true,
  autoSyncMenu: true,
  lastMenuSyncAt: true,
  lastMenuHash: true,
  config: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DeliveryChannelLinkSelect

export type DeliveryChannelLinkSafe = Omit<DeliveryChannelLink, 'webhookSecret'>

/** GET /venues/:venueId/channels — lista los canales del venue. NUNCA expone webhookSecret. */
export async function listChannelLinks(venueId: string): Promise<DeliveryChannelLinkSafe[]> {
  const links = (await prisma.deliveryChannelLink.findMany({
    where: { venueId },
    select: SAFE_SELECT,
    orderBy: { createdAt: 'desc' },
  })) as unknown as Array<DeliveryChannelLinkSafe & { autoSyncMenu: boolean; lastMenuHash: string | null; provider: DeliveryProvider }>

  // 🔴 Dos cosas que el dueño necesita VER y que hasta hoy sólo existían en el log o en la
  // base:
  //   · `menuSyncStatus` — un menú que nunca se logró publicar deja al proveedor vendiendo
  //     otra carta, o ninguna, y nadie se entera hasta que un cliente se queja.
  //   · `injectionRate` — es el número con el que el proveedor decide REVOCAR el acceso
  //     (Uber: exige 99.9%, revoca bajo 99%). Era invisible: se podía estar cayendo semanas.
  //
  // Se calculan aquí, en el listado que la pantalla ya pide, en vez de en un endpoint aparte:
  // un dato que exige una segunda llamada es un dato que la UI acaba no mostrando.
  return Promise.all(
    links.map(async l => {
      const { lastMenuHash: _oculto, ...resto } = l
      return {
        ...resto,
        menuSyncStatus: menuSyncStatusOf(l),
        // La huella misma no se expone: fuera del sincronizador no le sirve a nadie y sólo
        // invita a que alguien la use como si significara algo.
        injectionRate: await calcularTasaInyeccion({ venueId, provider: l.provider }).catch(() => null),
      }
    }),
  ) as unknown as DeliveryChannelLinkSafe[]
}

export interface CreateChannelLinkInput {
  provider: DeliveryProvider
  externalLocationId: string
  externalAccountId?: string | null
  orderAcceptanceMode?: OrderAcceptanceMode
  autoSyncMenu?: boolean
  config?: Prisma.InputJsonValue | null
}

/**
 * POST /venues/:venueId/channels — vincula un nuevo canal. Genera webhookSecret aleatorio
 * (verificado por el proveedor al firmar webhooks entrantes) y arranca en PENDING — el link
 * pasa a ACTIVE solo cuando el proveedor confirma la conexión (fuera de este service).
 */
export async function createChannelLink(
  venueId: string,
  data: CreateChannelLinkInput,
  performedBy?: string,
): Promise<DeliveryChannelLinkSafe> {
  const webhookSecret = crypto.randomBytes(32).toString('hex')

  let link: DeliveryChannelLinkSafe
  try {
    link = (await prisma.deliveryChannelLink.create({
      data: {
        venueId,
        provider: data.provider,
        externalLocationId: data.externalLocationId,
        externalAccountId: data.externalAccountId ?? null,
        webhookSecret,
        orderAcceptanceMode: data.orderAcceptanceMode ?? OrderAcceptanceMode.AUTO,
        status: DeliveryChannelStatus.PENDING,
        autoSyncMenu: data.autoSyncMenu ?? true,
        config: data.config ?? undefined,
      },
      select: SAFE_SELECT,
    })) as unknown as DeliveryChannelLinkSafe
  } catch (error: any) {
    // Fix 3 (audit, API-CONTRACT): @@unique([provider, externalLocationId]) → P2002 on a
    // duplicate link. Canonical repo pattern: productWizard.service.ts (catch P2002 →
    // ConflictError 409) — this same domain's deliveryWebhookEvent.service.ts already
    // catches P2002 for its own unique index.
    if (error?.code === 'P2002') {
      throw new ConflictError(
        `Ya existe un canal de delivery para el proveedor ${data.provider} con externalLocationId "${data.externalLocationId}"`,
      )
    }
    throw error
  }

  void logAction({
    staffId: performedBy,
    venueId,
    action: 'DELIVERY_CHANNEL_CONNECTED',
    entity: 'DeliveryChannelLink',
    entityId: link.id,
    data: { provider: data.provider, externalLocationId: data.externalLocationId },
  })

  return link
}

export interface UpdateChannelLinkInput {
  externalLocationId?: string
  externalAccountId?: string | null
  orderAcceptanceMode?: OrderAcceptanceMode
  autoSyncMenu?: boolean
  config?: Prisma.InputJsonValue | null
}

/**
 * PATCH /venues/:venueId/channels/:linkId — edita un canal existente.
 * Tenant isolation: la mutación misma filtra por `{ id: linkId, venueId }` — un link
 * de otro venue no matchea ninguna fila (`count === 0`) → NotFoundError, nada se toca.
 */
/**
 * Tope del markup de delivery, en por ciento.
 *
 * Uber se queda ~30%, así que el markup razonable vive alrededor de ahí. 200% es holgado a
 * propósito —no somos quién para decidir el precio de nadie— pero corta el dedazo: un `3000`
 * en vez de `30` publicaría a Uber un producto de $50 en $1,550. El comercio no se enteraría
 * hasta que dejaran de llegarle pedidos.
 */
const MARKUP_MAX = 200

/**
 * ¿Los precios de canal que nos mandan tienen sentido, o van a costar dinero?
 *
 * Un markup NEGATIVO publicaría por DEBAJO del precio de mostrador y, encima de la comisión
 * de Uber, cada pedido sería pérdida. Un override negativo regalaría el producto. Ninguno de
 * los dos falla en ningún lado: se publican y se cobran.
 */
function validarPrecios(v: unknown): void {
  if (v === undefined || v === null) return
  if (typeof v !== 'object' || Array.isArray(v)) throw new ValidationError('`precios` debe ser un objeto')
  const p = v as { markupPercent?: unknown; overrides?: unknown }

  if (p.markupPercent !== undefined) {
    const m = p.markupPercent
    if (typeof m !== 'number' || !Number.isFinite(m) || m < 0 || m > MARKUP_MAX) {
      throw new ValidationError(`El markup debe ser un número entre 0 y ${MARKUP_MAX} por ciento`)
    }
  }

  if (p.overrides !== undefined) {
    if (typeof p.overrides !== 'object' || p.overrides === null || Array.isArray(p.overrides)) {
      throw new ValidationError('`precios.overrides` debe ser un objeto { sku: precio }')
    }
    for (const [sku, precio] of Object.entries(p.overrides as Record<string, unknown>)) {
      if (typeof precio !== 'number' || !Number.isFinite(precio) || precio < 0) {
        throw new ValidationError(`El precio fijo de "${sku}" debe ser un número mayor o igual a 0`)
      }
    }
  }
}

/**
 * `config` es UNA columna con VARIAS cosas adentro — se MEZCLA, no se reemplaza.
 *
 * 🔴 POR QUÉ (bug hallado el 2026-08-21, antes de que existiera la pantalla): el horario de
 * delivery (`deliveryHours`) y el markup de precios (`precios`) viven los dos aquí. Escribir
 * la columna entera significa que guardar el horario BORRA el markup — y el markup es lo
 * único que evita perder dinero en cada pedido, porque Uber se queda ~30%. No falla, no
 * avisa: simplemente el comercio deja de cobrar de más y no entiende por qué.
 *
 * Es un merge SUPERFICIAL a propósito: mandar `precios` reemplaza el bloque `precios`
 * completo (quitar un override es mandar el objeto sin él), pero nunca toca `deliveryHours`.
 * Un merge profundo haría imposible borrar una llave.
 *
 * `config: null` sigue limpiando todo — es la forma explícita de borrar, y se distingue de
 * `undefined` (no lo tocaste).
 */
function mezclarConfig(actual: unknown, entrante: Prisma.InputJsonValue): Prisma.InputJsonValue {
  const base = actual && typeof actual === 'object' && !Array.isArray(actual) ? (actual as Record<string, unknown>) : {}
  if (typeof entrante !== 'object' || entrante === null || Array.isArray(entrante)) return entrante
  return { ...base, ...(entrante as Record<string, unknown>) } as Prisma.InputJsonValue
}

/**
 * Lo que llega a `config` se valida ANTES de escribirlo.
 *
 * 🔴 `esHorarioValido` ya rechaza la basura al PUBLICAR el menú, pero ahí cae al horario
 * estimado y sigue como si nada. El comercio ve su horario guardado en la pantalla y Uber
 * recibe otro — el peor de los dos mundos, porque nadie revisa lo que parece correcto. El
 * error tiene que salir donde el humano todavía puede corregirlo: al guardar.
 */
function validarConfig(entrante: Prisma.InputJsonValue): void {
  if (typeof entrante !== 'object' || entrante === null || Array.isArray(entrante)) return
  const c = entrante as Record<string, unknown>

  if (c.deliveryHours !== undefined && c.deliveryHours !== null && !esHorarioValido(c.deliveryHours)) {
    throw new ValidationError(
      'El horario de delivery no es válido: cada día necesita `enabled` y `ranges`, y cada rango horas "HH:MM" reales con cierre después de la apertura.',
    )
  }

  validarPrecios(c.precios)
}

export async function updateChannelLink(
  venueId: string,
  linkId: string,
  data: UpdateChannelLinkInput,
  performedBy?: string,
): Promise<DeliveryChannelLinkSafe> {
  if (data.config !== undefined && data.config !== null) validarConfig(data.config)

  // Leer-mezclar-escribir dentro de UNA transacción: sin ella, dos admins guardando a la vez
  // (o la pantalla de horario y la de precios) se pisan y el último gana con datos viejos.
  const link = await prisma.$transaction(async tx => {
    let config: Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined
    if (data.config === null) {
      config = Prisma.JsonNull
    } else if (data.config !== undefined) {
      // Tenant-scoped igual que la mutación: un link de otro venue no da fila y el
      // `updateMany` de abajo devuelve count 0 → NotFoundError, sin filtrar nada.
      const actual = await tx.deliveryChannelLink.findFirst({ where: { id: linkId, venueId }, select: { config: true } })
      config = mezclarConfig(actual?.config, data.config)
    }

    const result = await tx.deliveryChannelLink.updateMany({
      where: { id: linkId, venueId },
      data: {
        ...(data.externalLocationId !== undefined && { externalLocationId: data.externalLocationId }),
        ...(data.externalAccountId !== undefined && { externalAccountId: data.externalAccountId }),
        ...(data.orderAcceptanceMode !== undefined && { orderAcceptanceMode: data.orderAcceptanceMode }),
        ...(data.autoSyncMenu !== undefined && { autoSyncMenu: data.autoSyncMenu }),
        ...(config !== undefined && { config }),
      },
    })

    if (result.count === 0) {
      throw new NotFoundError('Canal de delivery no encontrado')
    }

    return tx.deliveryChannelLink.findUnique({ where: { id: linkId }, select: SAFE_SELECT })
  })

  void logAction({
    staffId: performedBy,
    venueId,
    action: 'DELIVERY_CHANNEL_UPDATED',
    entity: 'DeliveryChannelLink',
    entityId: linkId,
    data: data as Prisma.InputJsonValue,
  })

  return link as unknown as DeliveryChannelLinkSafe
}

/**
 * POST /venues/:venueId/channels/:linkId/pause — pausa o reactiva un canal.
 * Tenant isolation igual que update. Tras confirmar la mutación, notifica al proveedor
 * (`getAdapter(provider).setChannelPaused`) best-effort — un fallo de red/proveedor
 * NUNCA revierte ni bloquea el cambio de status interno, solo se loguea.
 *
 * Fix B4 (audit §10.2): un-pausar (paused:false → ACTIVE) SOLO se permite desde un
 * link ya conectado-pero-pausado (PAUSED) — un link PENDING (nunca confirmado por el
 * proveedor) o DISABLED saltando directo a ACTIVE se brincaría el lifecycle de
 * confirmación del proveedor; este endpoint no es el paso de "confirmar conexión".
 * Pausar (→PAUSED) NO tiene esta restricción — cualquier estado puede pausarse, sin
 * cambio de comportamiento. El gate vive en el WHERE del updateMany (filtro atómico,
 * evita una carrera entre leer el status y mutar); si el count sale 0 por el gate (no
 * por tenant), un segundo lookup da el mensaje de validación correcto en vez de un
 * 404 genérico.
 */
export async function pauseChannelLink(
  venueId: string,
  linkId: string,
  paused: boolean,
  performedBy?: string,
): Promise<DeliveryChannelLinkSafe> {
  const newStatus = paused ? DeliveryChannelStatus.PAUSED : DeliveryChannelStatus.ACTIVE

  const result = await prisma.deliveryChannelLink.updateMany({
    where: {
      id: linkId,
      venueId,
      ...(paused ? {} : { status: DeliveryChannelStatus.PAUSED }),
    },
    data: { status: newStatus },
  })

  if (result.count === 0) {
    if (!paused) {
      const current = await prisma.deliveryChannelLink.findFirst({ where: { id: linkId, venueId }, select: { status: true } })
      if (current) {
        throw new ValidationError(
          `No se puede reactivar un canal en estado ${current.status}. Solo un canal en estado PAUSED puede reactivarse.`,
        )
      }
    }
    throw new NotFoundError('Canal de delivery no encontrado')
  }

  // Registro completo (incluye webhookSecret) — lo necesita el adapter, pero NUNCA se
  // devuelve tal cual al caller (se strippea el secret antes de retornar, abajo).
  const fullLink = await prisma.deliveryChannelLink.findUnique({ where: { id: linkId } })

  if (!fullLink) {
    // Defensivo: updateMany confirmó count>=1 pero la fila desapareció antes del re-read
    // (borrado concurrente). No debería ocurrir en la práctica.
    throw new NotFoundError('Canal de delivery no encontrado')
  }

  // 🔴 PAUSAR TIENE QUE LLEGARLE AL PROVEEDOR. Antes esto resolvía el adaptador con el
  // registro VIEJO (`statusDispatcher`), que sólo conoce Deliverect: para Uber lanzaba, el
  // catch se lo tragaba, y el status local IGUAL pasaba a PAUSED.
  //
  // O sea que el dueño apretaba "Pausar" con la cocina ahogada, el dashboard le decía
  // PAUSADO, y Uber le seguía mandando pedidos. Un botón que miente es peor que uno que no
  // existe: con el que no existe, al menos busca otra salida.
  const motivo = paused ? 'Pausado desde el punto de venta' : undefined

  if (hasAdapter(fullLink.provider)) {
    // Proveedor DIRECTO (Uber hoy).
    const adapter = adapterFor(fullLink.provider)
    if (typeof adapter.setStoreStatus === 'function') {
      let r: { ok: boolean; status: number; raw: string }
      try {
        r = await adapter.setStoreStatus(paused, fullLink.externalLocationId, motivo)
      } catch (error) {
        r = { ok: false, status: 0, raw: error instanceof Error ? error.message : String(error) }
      }
      if (!r.ok) {
        // 🔴 Y ESTA es la otra mitad: avisarle a Uber no sirve de nada si igual pintamos
        // PAUSADO cuando él dijo que no. Se revierte el estado local y se lanza, para que el
        // dueño se entere y pueda hacer otra cosa —apagar el menú, hablar a soporte— en vez
        // de creerse protegido mientras le siguen entrando pedidos.
        await prisma.deliveryChannelLink.updateMany({ where: { id: linkId, venueId }, data: { status: fullLink.status } })
        logger.error('🚨 [DeliveryChannel] el proveedor NO aceptó la pausa — estado local revertido', {
          linkId,
          venueId,
          provider: fullLink.provider,
          paused,
          status: r.status,
          cuerpo: r.raw.slice(0, 300),
        })
        throw new ConflictError(
          paused
            ? 'No se pudo pausar el canal en el proveedor: sigue recibiendo pedidos. Reintenta o pausa desde su portal.'
            : 'No se pudo reactivar el canal en el proveedor. Reintenta o reactívalo desde su portal.',
        )
      }
    }
  } else {
    // Camino LEGADO (Deliverect): su adaptador tiene otra forma. Se queda best-effort porque
    // así estaba y no hay pedido real que lo ejercite hoy.
    try {
      const adapter = getAdapter(fullLink.provider)
      await adapter.setChannelPaused(fullLink, paused)
    } catch (error) {
      logger.error(`[🛵 DeliveryChannel] Fallo notificando pausa=${paused} al proveedor (link ${linkId}) — no se revierte el status`, {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  void logAction({
    staffId: performedBy,
    venueId,
    action: 'DELIVERY_CHANNEL_PAUSED',
    entity: 'DeliveryChannelLink',
    entityId: linkId,
    data: { paused },
  })

  const { webhookSecret: _webhookSecret, ...safeLink } = fullLink
  return safeLink
}
