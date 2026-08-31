// src/services/mobile/deviceRegistry.service.ts

/**
 * Device registry — registro PASIVO de dispositivos, estilo Square.
 *
 * Un POS móvil (Sunmi, iPhone, tablet Android) que instala Avoqado y hace login se
 * auto-registra como `Terminal`. Antes sólo existían las terminales que un admin daba
 * de alta a mano (PAX compradas, onboarding), así que un teléfono operando en un venue
 * era invisible: ni renglón, ni última conexión, ni forma de saber cuál falló.
 *
 * Square hace exactamente esto: en su Dashboard "you can see every device signed into
 * the Point of Sale app". Su device code es una vía ALTERNA de autenticación, no un
 * requisito — por eso aquí no pedimos código ni aprobación. El flujo de `activationCode`
 * que ya existe para las PAX se queda como está y no se toca.
 *
 * ── Invariantes que NO se negocian ────────────────────────────────────────────────
 *
 * 1. NUNCA BLOQUEA. Esto corre en cada request autenticado de un POS, o sea en el
 *    camino del cobro. Cualquier error se registra y se sigue. Un dispositivo que
 *    tarda en aparecer en una lista es infinitamente mejor que un cobro que no pasa.
 *
 * 2. `deviceUid` NO es identidad nueva. Es EL MISMO `deviceId` del outbox offline
 *    (`PosSyncIntent.deviceId`) y de la elección de árbitro del hub LAN. Ver
 *    `.claude/rules/offline-first-y-hub-lan.md` §2.4: si un POS presenta dos
 *    identidades distintas se ve como dos peers y la elección deja de ser estable.
 *
 * 3. DISPOSITIVO Y STAFF SON EJES SEPARADOS. Tres meseros usando un teléfono son UN
 *    renglón que muestra el último que entró, no tres renglones. Igual que Square.
 *
 * 4. NUNCA se borra un dispositivo, se retira (`status = RETIRED`). `Order.terminalId`
 *    y `Payment.terminalId` apuntan a `Terminal`: borrar rompe la atribución de ventas.
 */

import { DeviceFormFactor, Prisma, TerminalStatus, TerminalType } from '@prisma/client'

import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { resolveDeviceModel } from '../../config/deviceCatalog'
import { logAction } from '../dashboard/activity-log.service'

/** Plataformas que pueden auto-registrarse. Espeja `X-Device-Platform`. */
export type DevicePlatformHeader = 'IOS' | 'ANDROID' | 'DESKTOP'

const PLATFORM_TO_TERMINAL_TYPE: Record<DevicePlatformHeader, TerminalType> = {
  IOS: TerminalType.POS_IOS,
  ANDROID: TerminalType.POS_ANDROID,
  DESKTOP: TerminalType.POS_DESKTOP,
}

/** Lo que el dispositivo reporta de sí mismo (headers `X-Device-*`). */
export interface DeviceIdentity {
  /** = `PosSyncIntent.deviceId`. Único obligatorio: sin esto no hay registro. */
  deviceUid: string
  platform: DevicePlatformHeader
  /** Crudo, como lo reporta el SO: "Apple", "samsung", "SUNMI". */
  manufacturer?: string | null
  /** Crudo: "iPhone16,2", "SM-X710", "A910S". */
  modelIdentifier?: string | null
  /** Lo que el cliente dedujo. El catálogo del server puede corregirlo. */
  formFactor?: DeviceFormFactor | null
  osVersion?: string | null
  appVersion?: string | null
  /**
   * Serial de hardware, cuando el aparato lo expone (Sunmi y PAX sí; iPhone nunca —
   * por eso Square marca su `manufacturers_id` como "where available"). Si viene y
   * ya existe una Terminal provisionada con ese serial en el venue, el dispositivo se
   * ENGANCHA a ella en vez de crear un renglón duplicado.
   */
  serialNumber?: string | null
}

export interface RegisterDeviceResult {
  terminalId: string
  /** true = se creó el renglón en esta llamada. */
  created: boolean
  /** Nombre con el que quedó (sólo informativo; en updates no se toca). */
  name: string
}

/**
 * Nombre por defecto: modelo comercial + consecutivo por venue.
 *
 * Tres iPhone 15 Pro en un venue quedan "iPhone 15 Pro", "iPhone 15 Pro (2)",
 * "iPhone 15 Pro (3)". El consecutivo se calcula UNA VEZ al crear y se congela en
 * `name`: dar de baja el (2) NO renumera el (3), porque renumerar cambiaría el nombre
 * de un aparato que el dueño ya aprendió a reconocer.
 *
 * El renombrado manual llega en su propio trabajo y sobrescribe esto.
 */
export async function resolveDeviceName(client: Prisma.TransactionClient | typeof prisma, venueId: string, model: string): Promise<string> {
  // Cuenta cuántos dispositivos de ESTE modelo ya existen en el venue, incluidos los
  // retirados: si el (2) se dio de baja, el siguiente es (4) y no vuelve a ser (2).
  // Reusar un número haría que dos aparatos distintos compartan nombre en el histórico.
  const existing = await client.terminal.count({ where: { venueId, model } })
  return existing === 0 ? model : `${model} (${existing + 1})`
}

/**
 * Asegura o refresca un dispositivo. Idempotente por `[venueId, deviceUid]`.
 *
 * La ruta explícita de reporte de capacidades necesita conocer la terminal concreta;
 * por eso, si pierde una carrera `P2002`, relee la fila que ganó en vez de asumir que
 * ya no importa. Devuelve `null` si ni siquiera puede establecer esa identidad.
 */
export async function ensureDeviceTerminal(params: {
  venueId: string
  staffId: string
  identity: DeviceIdentity
}): Promise<RegisterDeviceResult | null> {
  const { venueId, staffId, identity } = params

  if (!identity.deviceUid || !venueId) return null

  try {
    const resolved = resolveDeviceModel(identity.manufacturer, identity.modelIdentifier, identity.formFactor)
    const now = new Date()

    // ── ¿Ya existe este dispositivo en este venue? ────────────────────────────────
    const existing = await prisma.terminal.findFirst({
      where: { venueId, deviceUid: identity.deviceUid },
      select: { id: true, name: true },
    })

    if (existing) {
      await prisma.terminal.update({
        where: { id: existing.id },
        data: {
          lastHeartbeat: now,
          lastStaffId: staffId,
          // `name` NO se toca: es del dueño en cuanto lo renombre.
          // `type`/`formFactor` tampoco: un dispositivo no cambia de clase.
          osVersion: identity.osVersion ?? undefined,
          version: identity.appVersion ?? undefined,
          modelIdentifier: identity.modelIdentifier ?? undefined,
        },
      })
      return { terminalId: existing.id, created: false, name: existing.name }
    }

    // ── ¿Es una terminal provisionada que apenas se identifica? ───────────────────
    // Un Sunmi o una PAX SÍ exponen su serial. Si ya existe el renglón que un admin
    // dio de alta con ese serial, le enganchamos el deviceUid en vez de duplicar.
    // Sin esto, comprar una terminal y luego instalarle la app produciría DOS
    // renglones para el mismo aparato físico.
    if (identity.serialNumber) {
      const provisioned = await prisma.terminal.findFirst({
        where: { venueId, serialNumber: identity.serialNumber, deviceUid: null },
        select: { id: true, name: true },
      })

      if (provisioned) {
        await prisma.terminal.update({
          where: { id: provisioned.id },
          data: {
            deviceUid: identity.deviceUid,
            lastHeartbeat: now,
            lastStaffId: staffId,
            firstSeenAt: now,
            formFactor: resolved.formFactor,
            modelIdentifier: identity.modelIdentifier ?? undefined,
            osVersion: identity.osVersion ?? undefined,
            version: identity.appVersion ?? undefined,
            // selfRegistered se queda en false: este aparato lo dio de alta un admin.
          },
        })
        logger.info(
          `📱 [DEVICE REGISTRY] Dispositivo enganchado a terminal provisionada | venue=${venueId} serial=${identity.serialNumber}`,
        )
        return { terminalId: provisioned.id, created: false, name: provisioned.name }
      }
    }

    // ── Alta nueva ───────────────────────────────────────────────────────────────
    const name = await resolveDeviceName(prisma, venueId, resolved.model)

    const created = await prisma.terminal.create({
      data: {
        venueId,
        name,
        type: PLATFORM_TO_TERMINAL_TYPE[identity.platform] ?? TerminalType.POS_ANDROID,
        status: TerminalStatus.ACTIVE,
        brand: resolved.brand,
        model: resolved.model,
        modelIdentifier: identity.modelIdentifier ?? null,
        formFactor: resolved.formFactor,
        osVersion: identity.osVersion ?? null,
        version: identity.appVersion ?? null,
        serialNumber: identity.serialNumber || null,
        deviceUid: identity.deviceUid,
        selfRegistered: true,
        firstSeenAt: now,
        lastHeartbeat: now,
        lastStaffId: staffId,
      },
      select: { id: true, name: true },
    })

    logger.info(`📱 [DEVICE REGISTRY] Dispositivo nuevo registrado | venue=${venueId} nombre="${created.name}" staff=${staffId}`)

    // Auditamos SÓLO el alta. El refresco de última conexión es alto volumen y la regla
    // del repo pide explícitamente no auditar heartbeats — inundaría la bitácora que el
    // dueño usa para revisar anomalías. Que un aparato NUEVO entre al venue sí es
    // auditable: es lo que alguien querría poder rastrear después.
    void logAction({
      staffId,
      venueId,
      action: 'DEVICE_REGISTERED',
      entity: 'Terminal',
      entityId: created.id,
      data: {
        name: created.name,
        deviceUid: identity.deviceUid,
        platform: identity.platform,
        brand: resolved.brand,
        model: resolved.model,
        formFactor: resolved.formFactor,
      },
    })

    return { terminalId: created.id, created: true, name: created.name }
  } catch (error: any) {
    // Carrera: dos requests del mismo dispositivo nuevo llegando a la vez. El
    // @@unique([venueId, deviceUid]) deja pasar uno; el otro cae aquí. No es un
    // problema — releemos el renglón creado por el que ganó. PostgreSQL espera a que
    // termine el INSERT rival antes de resolver la violación unique, así que la fila
    // ya es visible cuando llegamos aquí.
    if (error?.code === 'P2002') {
      logger.debug(`[DEVICE REGISTRY] Alta concurrente resuelta por el índice único | venue=${venueId}`)
      try {
        const winner = await prisma.terminal.findFirst({
          where: { venueId, deviceUid: identity.deviceUid },
          select: { id: true, name: true },
        })
        return winner ? { terminalId: winner.id, created: false, name: winner.name } : null
      } catch (rereadError) {
        logger.error(`[DEVICE REGISTRY] No se pudo releer la terminal ganadora (no bloqueante) | venue=${venueId}`, rereadError)
        return null
      }
    }

    // Cualquier otra cosa: se registra y se sigue. Este código jamás puede tumbar
    // un login ni un cobro.
    logger.error(`[DEVICE REGISTRY] Falló el registro de dispositivo (no bloqueante) | venue=${venueId}`, error)
    return null
  }
}

/**
 * Contrato pasivo usado por el finish hook. Se mantiene como wrapper explícito para
 * dejar claro que login, cobros y cualquier request ordinario siguen degradando a
 * `null`: nunca convierten un problema de telemetría en un error HTTP.
 */
export async function registerDeviceSeen(params: {
  venueId: string
  staffId: string
  identity: DeviceIdentity
}): Promise<RegisterDeviceResult | null> {
  return ensureDeviceTerminal(params)
}
