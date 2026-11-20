/**
 * Máquina de efectivo QuickPay Mini · fase 1a (R4-3, R5#2, R5#3): sólo la PC emparejada registra ventas de la máquina.
 *
 *  · Emparejar (`cash-machine:configure`) entrega UNA vez una credencial de 32 bytes aleatorios; la PC la guarda con DPAPI de Windows en
 *    modo de máquina, así que un perfil copiado a otra PC no la descifra. El servidor guarda sólo su SHA-256: con 256 bits de azar no hay
 *    diccionario ni fuerza bruta que una sal o un hash lento detengan, y el hash directo deja buscarla por índice.
 *  · Cada máquina (IP del negocio) tiene un solo emisor: emparejar otra PC revoca la anterior en la misma transacción (y el índice
 *    único PARCIAL de la migración lo respalda).
 *  · El aparato sale siempre del encabezado autenticado (`X-Device-ID` → `Terminal`), nunca del cuerpo. La credencial es lo que lo
 *    prueba: un `X-Device-ID` copiado sin ella no sirve, y ella desde otro `Terminal` tampoco.
 */
import { createHash, randomBytes } from 'crypto'
import { Prisma } from '@prisma/client'

import { BadRequestError, ConflictError, ForbiddenError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { withDeadlockRetry, type TxConReintento } from '../../utils/serializableRetry'
import { logAction } from '../dashboard/activity-log.service'

export const CASH_MACHINE_NOT_PAIRED = 'CASH_MACHINE_NOT_PAIRED'

export const hashDeCredencial = (credencial: string): string => createHash('sha256').update(credencial).digest('hex')

/** El `Terminal` del encabezado `X-Device-ID` en este negocio (el registro de `list_devices`). */
export async function aparatoDe(venueId: string, deviceUid: string | null): Promise<string | null> {
  if (!deviceUid) return null
  const aparato = await prisma.terminal.findFirst({ where: { venueId, deviceUid }, select: { id: true } })
  return aparato?.id ?? null
}

/** Quién empareja: la sesión (con `cash-machine:configure`) y el aparato de su encabezado. */
export interface AutorDelEmparejamiento {
  userId: string
  deviceUid: string | null
}

async function aparatoRegistrado(venueId: string, deviceUid: string | null): Promise<string> {
  if (!deviceUid) throw new BadRequestError('X-Device-ID es requerido', 'DEVICE_ID_REQUIRED')
  const deviceId = await aparatoDe(venueId, deviceUid)
  if (!deviceId) {
    throw new ConflictError('Este aparato todavía no está registrado en el negocio. Vuelve a iniciar sesión.', 'DEVICE_NOT_REGISTERED')
  }
  return deviceId
}

/** Siempre el del aparato y luego el de la máquina: dos emparejamientos nunca se esperan en cruz. */
async function candado(tx: TxConReintento, venueId: string, que: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`avoqado:cash-machine-binding:v1:${venueId}:${que}`}, 0))::text`,
  )
}

type Revocada = { id: string; deviceId: string; machineIp: string }

/** Revoca las activas que cumplan `donde` en este negocio. A lo más dos: una por IP (índice único) y una por aparato (candado). */
async function revocarEnTx(tx: TxConReintento, venueId: string, donde: Prisma.CashMachineBindingWhereInput): Promise<Revocada[]> {
  const activas = await tx.cashMachineBinding.findMany({
    where: { venueId, active: true, ...donde },
    select: { id: true, deviceId: true, machineIp: true },
    take: 10,
  })
  if (activas.length > 0) {
    await tx.cashMachineBinding.updateMany({
      where: { venueId, id: { in: activas.map(a => a.id) } },
      data: { active: false, revokedAt: new Date() },
    })
  }
  return activas
}

/** `motivo`: `MANUAL` (se apagó la casilla), `OTRA_PC` (otra PC tomó la máquina) o `NUEVA_CREDENCIAL` (esta PC se volvió a emparejar). */
function anotarRevocadas(venueId: string, staffId: string, revocadas: Revocada[], motivo: (r: Revocada) => string, extra = {}) {
  for (const r of revocadas) {
    void logAction({
      action: 'CASH_MACHINE_UNPAIRED',
      entity: 'CashMachineBinding',
      entityId: r.id,
      venueId,
      staffId,
      data: { motivo: motivo(r), deviceId: r.deviceId, machineIp: r.machineIp, ...extra },
    })
  }
}

/**
 * `POST /mobile/venues/:venueId/cash-machine/binding`: esta PC queda como el único emisor de la máquina `machineIp`. Revoca a la PC
 * anterior de esa máquina y la credencial anterior de esta PC. La credencial sale sólo en esta respuesta.
 */
export async function emparejarAparato(
  venueId: string,
  autor: AutorDelEmparejamiento,
  machineIp: string,
): Promise<{ bindingId: string; credential: string }> {
  const deviceId = await aparatoRegistrado(venueId, autor.deviceUid)
  const credential = randomBytes(32).toString('base64url')
  const { binding, revocadas } = await withDeadlockRetry(
    async tx => {
      await candado(tx, venueId, `aparato:${deviceId}`)
      await candado(tx, venueId, `ip:${machineIp}`)
      const revocadas = await revocarEnTx(tx, venueId, { OR: [{ machineIp }, { deviceId }] })
      const binding = await tx.cashMachineBinding.create({
        data: { venueId, deviceId, machineIp, credentialHash: hashDeCredencial(credential), enabledByStaffId: autor.userId },
        select: { id: true },
      })
      return { binding, revocadas }
    },
    { etiqueta: 'emparejarAparato' },
  )
  void logAction({
    action: 'CASH_MACHINE_PAIRED',
    entity: 'CashMachineBinding',
    entityId: binding.id,
    venueId,
    staffId: autor.userId,
    data: { deviceId, machineIp, revocadas: revocadas.map(r => r.id) },
  })
  anotarRevocadas(venueId, autor.userId, revocadas, r => (r.deviceId === deviceId ? 'NUEVA_CREDENCIAL' : 'OTRA_PC'), {
    porBindingId: binding.id,
  })
  return { bindingId: binding.id, credential }
}

/** `DELETE /mobile/venues/:venueId/cash-machine/binding`: esta PC deja de ser emisor. Repetirlo no hace nada. */
export async function desemparejarAparato(venueId: string, autor: AutorDelEmparejamiento): Promise<{ revoked: boolean }> {
  const deviceId = await aparatoDe(venueId, autor.deviceUid)
  if (!deviceId) return { revoked: false }
  const revocadas = await withDeadlockRetry(
    async tx => {
      await candado(tx, venueId, `aparato:${deviceId}`)
      return revocarEnTx(tx, venueId, { deviceId })
    },
    { etiqueta: 'desemparejarAparato' },
  )
  anotarRevocadas(venueId, autor.userId, revocadas, () => 'MANUAL')
  return { revoked: revocadas.length > 0 }
}

/**
 * R4-3: sólo una credencial de ESTE mismo aparato (`deviceId` del encabezado) en este negocio registra un folio o sube una duda. Sin
 * credencial válida de este aparato, 403 `CASH_MACHINE_NOT_PAIRED`.
 *
 * Con la credencial ya revocada (otra PC tomó la máquina, o se apagó la casilla) la PC todavía ENTREGA lo que cobró sin red (decisión d,
 * Codex r1 #5): se devuelve `revocadaEn` y lo que puede escribir —repetir lo suyo, abrir su duda, o un primer cierre que la hora del
 * comprobante decide— lo decide `decidirEscrituraDelFolio` bajo el candado del folio (Codex r2 #1: aquí ya no se mira el folio, porque
 * leerlo fuera del candado le devolvía la autoridad entera a la PC revocada que sólo tenía una duda).
 */
export async function exigirAparatoEmparejado(
  venueId: string,
  deviceId: string | null,
  credencial: string | null,
): Promise<{ revocadaEn: Date | null }> {
  if (deviceId && credencial) {
    const binding = await prisma.cashMachineBinding.findFirst({
      where: { venueId, deviceId, credentialHash: hashDeCredencial(credencial) },
      select: { active: true, revokedAt: true },
    })
    if (binding?.active) return { revocadaEn: null }
    if (binding) return { revocadaEn: binding.revokedAt ?? new Date(0) }
  }
  throw new ForbiddenError('Esta PC no está emparejada con la máquina de efectivo', CASH_MACHINE_NOT_PAIRED)
}
