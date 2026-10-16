// src/services/mobile/deviceCapabilityReport.service.ts
import { Prisma, TerminalType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ConflictError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { invalidateCustomerDisplayCache } from '@/services/customer-display/customerDisplayCache'
import type { ReportDeviceCapabilitiesInput } from '@/schemas/mobile/deviceCapabilities.mobile.schema'

/**
 * El reporte de capacidades del POS Android (spec §5.7.2): hechos físicos de la pantalla y, desde F0-B, qué versión de
 * diseño entiende y qué INSTALACIÓN de la app lo manda. Todas las horas son del SERVIDOR.
 *
 * | Reporte                                   | Versión     | Instalación              | Ack         | Lista de cambios          |
 * |-------------------------------------------|-------------|--------------------------|-------------|---------------------------|
 * | sin los campos nuevos (app vieja)         | `null`      | se conserva              | se limpia   | se conserva               |
 * | con la misma instalación                  | la reportada| igual                    | se conserva | igual                     |
 * | sobre una fila SIN instalación (dec. 4)   | la reportada| la nueva, desde AHORA    | se limpia   | igual                     |
 * | con otra instalación                      | la reportada| la nueva, desde AHORA    | se limpia   | + AHORA, últimas 5        |
 *
 * 🔴 El binding va en la MISMA escritura (como antes) y, cuando hay instalación, también la instalación Y la lista de cambios
 * que se leyeron: dos tablets con el mismo `deviceUid` reportando a la vez no pueden perder un cambio ni duplicar una adopción,
 * tampoco si en medio pasó A → B → A (DD6, Codex r1 #4). Si otro reporte escribió en medio, se relee y se reintenta UNA vez;
 * si vuelve a perder, 409 `CUSTOMER_DISPLAY_INSTALLATION_RACE` (la tablet reintenta en su siguiente poll).
 * 🔴 Cada `data` va LITERAL: la guarda `terminalVenueWriters.test.ts` no puede leer un esparcido de variable.
 */

export const MAX_INSTALLATION_SWITCHES = 5

export type CambioDeInstalacion =
  | { tipo: 'igual' }
  | { tipo: 'adopcion'; desde: Date }
  | { tipo: 'cambio'; desde: Date; switches: string[] }

/**
 * La lista leída, como condición del CAS (Codex r1 #4, DD6). Prisma lee igual el NULL de SQL y el `null` de JSON (el gancho
 * de F0-A deja `DbNull`): `AnyNull` acepta los dos.
 */
function laMismaLista(leida: Prisma.JsonValue | null): Prisma.TerminalWhereInput['customerDisplayInstallationSwitches'] {
  return leida === null ? { equals: Prisma.AnyNull } : { equals: leida as Prisma.InputJsonValue }
}

export function siguienteInstalacion(
  guardada: string | null,
  switchesGuardados: unknown,
  reportada: string,
  ahora: Date,
): CambioDeInstalacion {
  if (guardada === reportada) return { tipo: 'igual' }
  // Decisión 4: sobre una fila SIN instalación (primera vez o recién mudada) no hay «cambio» que contar.
  if (guardada === null) return { tipo: 'adopcion', desde: ahora }
  const previos = Array.isArray(switchesGuardados) ? switchesGuardados.filter((s): s is string => typeof s === 'string') : []
  return { tipo: 'cambio', desde: ahora, switches: [...previos, ahora.toISOString()].slice(-MAX_INSTALLATION_SWITCHES) }
}

export async function recordCapabilityReport(i: {
  venueId: string
  terminalId: string
  deviceUid: string
  staffId: string
  body: ReportDeviceCapabilitiesInput
  now: Date
}): Promise<'OK' | 'SIN_BINDING'> {
  const binding = { id: i.terminalId, venueId: i.venueId, deviceUid: i.deviceUid, type: TerminalType.POS_ANDROID }
  const { customerDisplay, displayModeProtocolVersion, customerDisplayDesignVersion: version, installationId } = i.body

  if (version === undefined || installationId === undefined) {
    // App vieja, o una nueva que bajó de versión sin borrar datos: no entiende diseños (spec §5.7.2).
    const r = await prisma.terminal.updateMany({
      where: binding,
      data: {
        customerDisplayPresent: customerDisplay.present,
        customerDisplayInvertible: customerDisplay.invertible,
        displayModeProtocolVersion,
        capabilitiesObservedAt: i.now,
        lastHeartbeat: i.now,
        customerDisplayDesignVersion: null,
        customerDisplayAck: Prisma.DbNull,
      },
    })
    if (r.count !== 1) return 'SIN_BINDING'
    invalidateCustomerDisplayCache(i.terminalId)
    return 'OK'
  }

  for (let intento = 0; intento < 2; intento++) {
    const actual = await prisma.terminal.findFirst({
      where: binding,
      select: { customerDisplayInstallationId: true, customerDisplayInstallationSwitches: true },
    })
    if (!actual) return 'SIN_BINDING'
    const cambio = siguienteInstalacion(
      actual.customerDisplayInstallationId,
      actual.customerDisplayInstallationSwitches,
      installationId,
      i.now,
    )
    const r = await prisma.terminal.updateMany({
      where: {
        ...binding,
        customerDisplayInstallationId: actual.customerDisplayInstallationId,
        customerDisplayInstallationSwitches: laMismaLista(actual.customerDisplayInstallationSwitches),
      },
      data: {
        customerDisplayPresent: customerDisplay.present,
        customerDisplayInvertible: customerDisplay.invertible,
        displayModeProtocolVersion,
        capabilitiesObservedAt: i.now,
        lastHeartbeat: i.now,
        customerDisplayDesignVersion: version,
        // Una instalación nueva (adopción o cambio) se guarda con la hora del SERVIDOR, y un ack de la anterior no puede
        // seguir ocupando el estado (spec §5.7.2). `undefined` = sin cambio.
        customerDisplayInstallationId: cambio.tipo === 'igual' ? undefined : installationId,
        customerDisplayInstallationSince: cambio.tipo === 'igual' ? undefined : cambio.desde,
        customerDisplayAck: cambio.tipo === 'igual' ? undefined : Prisma.DbNull,
        customerDisplayInstallationSwitches: cambio.tipo === 'cambio' ? cambio.switches : undefined,
      },
    })
    if (r.count === 1) {
      invalidateCustomerDisplayCache(i.terminalId) // la versión cambia el recorte de la ficha (spec §5.3)
      if (cambio.tipo === 'cambio') {
        // Decisión 5: la anomalía que un dueño audita. Fuera de toda transacción, sin poder romper el reporte.
        void logAction({
          staffId: i.staffId,
          venueId: i.venueId,
          action: 'CUSTOMER_DISPLAY_INSTALLATION_CHANGED',
          entity: 'Terminal',
          entityId: i.terminalId,
          data: { switches: cambio.switches },
        })
      }
      return 'OK'
    }
  }
  throw new ConflictError('Otra instalación de la app reportó al mismo tiempo; vuelve a intentarlo.', 'CUSTOMER_DISPLAY_INSTALLATION_RACE')
}
