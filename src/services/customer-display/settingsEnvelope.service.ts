// src/services/customer-display/settingsEnvelope.service.ts
import { Prisma, TerminalType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { armarBloqueDelAparato, type BloqueDelAparato } from './customerDisplayMobile.service'
import { SETTINGS_DEVICE_SELECT, leerFuenteDeAjustes, settingsFingerprint } from './posPollFingerprints'
import { readVenuePlanSnapshot } from './venuePlanSnapshot'
import { readVenueSignatures } from './venueSignatures'

/**
 * Lo que `/settings` suma para la pantalla del cliente (spec §5.7.2, §5.7.4): su huella —leída ANTES del cuerpo— y el
 * bloque del diseño, con el estado de cada uno. Sin `X-Device-ID` no se paga nada; con la cabecera (Android, iOS o una app
 * vieja), UNA consulta indexada —el binding—; la fuente, las firmas y el plan, sólo con versión ≥ 1 (Codex r1 #8).
 * 🔴 Nada de esto puede tumbar la ruta: un fallo aquí sale como estado del componente, nunca como error de `/settings`.
 */

export type ComponentStatus = 'ok' | 'failed' | 'not_applicable'

export const SETTINGS_BINDING_SELECT = {
  id: true,
  status: true, // la regla de la fuente efectiva (Task 7, Codex r1 #9)
  customerDisplayDesignVersion: true,
  ...SETTINGS_DEVICE_SELECT,
} satisfies Prisma.TerminalSelect
export type SettingsBinding = Prisma.TerminalGetPayload<{ select: typeof SETTINGS_BINDING_SELECT }>

export interface LecturaDeAjustes {
  binding: SettingsBinding | null
  fingerprint: string | null
  /** 'failed' = no se pudo LEER el binding: «no pude saberlo», que no es «no aplica» (Codex r1 #8). */
  bindingStatus: 'ok' | 'failed'
}

const mensaje = (error: unknown) => (error instanceof Error ? error.message : String(error))

export async function readSettingsFingerprint(venueId: string, deviceUid: string | null): Promise<LecturaDeAjustes> {
  if (!deviceUid) return { binding: null, fingerprint: null, bindingStatus: 'ok' }
  let binding: SettingsBinding | null
  try {
    // Binding EXACTO (spec §5.7.1): el bloque y la huella son de un POS_ANDROID con esta identidad en este negocio.
    binding = await prisma.terminal.findFirst({
      where: { venueId, deviceUid, type: TerminalType.POS_ANDROID },
      select: SETTINGS_BINDING_SELECT,
    })
  } catch (error) {
    logger.warn('[pantalla-del-cliente] /settings no pudo leer el aparato: sale sin huella ni bloque', { venueId, error: mensaje(error) })
    return { binding: null, fingerprint: null, bindingStatus: 'failed' }
  }
  if (!binding) return { binding: null, fingerprint: null, bindingStatus: 'ok' }
  if (binding.customerDisplayDesignVersion == null) return { binding, fingerprint: null, bindingStatus: 'ok' } // decisión 1
  try {
    // La MISMA función, la MISMA fuente y las MISMAS lecturas que el poll (Task 7): para el mismo estado, la misma huella.
    const fuente = await leerFuenteDeAjustes(venueId, binding)
    const [firmas, plan] = await Promise.all([readVenueSignatures(venueId), readVenuePlanSnapshot(venueId)])
    return { binding, fingerprint: firmas ? settingsFingerprint({ fuente, venue: firmas, plan }) : null, bindingStatus: 'ok' }
  } catch (error) {
    logger.warn('[pantalla-del-cliente] /settings sale sin huella', { venueId, error: mensaje(error) })
    return { binding, fingerprint: null, bindingStatus: 'ok' }
  }
}

export async function customerDisplayBlockFor(
  venueId: string,
  lectura: LecturaDeAjustes,
): Promise<{ status: ComponentStatus; block?: BloqueDelAparato }> {
  if (lectura.bindingStatus === 'failed') return { status: 'failed' } // conserva lo que tenías
  const binding = lectura.binding
  if (!binding || binding.customerDisplayDesignVersion == null || binding.customerDisplayDesignVersion < 1)
    return { status: 'not_applicable' }
  try {
    // `binding.id` salió del binding acotado a `venueId`: nunca un id de otro negocio llega a la caché.
    return { status: 'ok', block: await armarBloqueDelAparato(venueId, binding.id) }
  } catch (error) {
    logger.warn('[pantalla-del-cliente] /settings sale sin el bloque del diseño', { venueId, error: mensaje(error) })
    return { status: 'failed' }
  }
}
