/**
 * Máquina de efectivo QuickPay Mini · fase 1a (R4-3, R5#2, R5#3): sólo la PC emparejada registra ventas de la máquina.
 *
 *  · Emparejar (`cash-machine:configure`) entrega UNA vez una credencial de 32 bytes aleatorios; la PC la guarda con DPAPI de Windows en
 *    modo de máquina, así que un perfil copiado a otra PC no la descifra. El servidor guarda sólo su SHA-256: con 256 bits de azar no hay
 *    diccionario ni fuerza bruta que una sal o un hash lento detengan, y el hash directo deja buscarla por índice.
 *  · D3 y r6-5 (rediseño tras la ronda 3): en la 1a UNA sola PC habilitada por NEGOCIO. Emparejar otra PC revoca la anterior en la
 *    misma transacción, bajo UN candado con la clave del negocio, y el índice único PARCIAL `(venueId) WHERE active` lo respalda: dos
 *    altas simultáneas nunca dejan dos PCs.
 *  · Recorte R1 (founder «a», 21-nov): NO se cambia de PC (ni se apaga) con cobros a medias. Mientras el negocio tenga folios sin
 *    terminar —dudas `ESPERANDO` o desenlaces RECIBIDOS (`POR_TERMINAR`)— emparejar y desemparejar contestan 409
 *    `CASH_MACHINE_FOLIOS_PENDING`: primero se terminan en el panel. Por eso una credencial revocada nunca tiene nada a medias y
 *    todo lo que mande después es incidencia con su dinero (`decisionDelFolio.ts`), sin vigencias por hora.
 *  · 🔴 La QuickPay acepta comandos locales de quien sea: al relevar una PC hay que desconectar la anterior de la máquina. La respuesta
 *    del alta dice qué PCs quedaron revocadas (`replaced`) para que el POS lo pida.
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
export const CASH_MACHINE_FOLIOS_PENDING = 'CASH_MACHINE_FOLIOS_PENDING'

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

/** r6-5: UN candado por negocio para emparejar y desemparejar (la misma clave en las dos). */
async function candado(tx: TxConReintento, venueId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`avoqado:cash-machine-binding:v2:${venueId}`}, 0))::text`)
}

type Revocada = { id: string; deviceId: string; machineIp: string }

/** Cuántos folios nombra el 409 (el total va aparte). */
const FOLIOS_EN_EL_AVISO = 20

/**
 * Recorte R1: lo que el negocio tiene a medias —una duda `ESPERANDO` o un desenlace RECIBIDO (`POR_TERMINAR`, que nace en la MISMA
 * transacción que el desenlace)— frena el relevo. Bajo el candado del negocio.
 */
async function exigirSinCobrosAMedias(tx: TxConReintento, venueId: string): Promise<void> {
  const where = { venueId, status: 'ABIERTO', kind: { in: ['ESPERANDO', 'POR_TERMINAR'] } }
  const count = await tx.cashMachineIncident.count({ where })
  if (count === 0) return
  const folios = await tx.cashMachineIncident.findMany({
    where,
    select: { referenceCC: true, kind: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: FOLIOS_EN_EL_AVISO,
  })
  throw new ConflictError(
    'La máquina tiene cobros sin terminar. Termínalos en el panel («Cobros de la máquina») antes de cambiar o apagar la PC; los que la PC acaba de subir aparecen ahí en unos minutos.',
    CASH_MACHINE_FOLIOS_PENDING,
    { count, folios: folios.map(f => ({ referenceCC: f.referenceCC, kind: f.kind })) },
  )
}

/**
 * Revoca las activas que cumplan `donde` en este negocio (a lo más una: índice único parcial por negocio), sólo si nada quedó a medias.
 * Sin una activa que revocar no hay a quién relevar: no frena (la PC que ya estaba revocada sí puede apagar su casilla).
 */
async function revocarEnTx(tx: TxConReintento, venueId: string, donde: Prisma.CashMachineBindingWhereInput): Promise<Revocada[]> {
  const activas = await tx.cashMachineBinding.findMany({
    where: { venueId, active: true, ...donde },
    select: { id: true, deviceId: true, machineIp: true },
    take: 10,
  })
  if (activas.length > 0) {
    await exigirSinCobrosAMedias(tx, venueId)
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
 * `POST /mobile/venues/:venueId/cash-machine/binding`: esta PC queda como la ÚNICA habilitada del negocio (D3), con la máquina
 * `machineIp`. Revoca la que hubiera (otra PC o la credencial anterior de ésta) en la misma transacción. La credencial sale sólo aquí;
 * `replaced` dice qué otras PCs quedaron revocadas (hay que desconectarlas de la máquina).
 */
export async function emparejarAparato(
  venueId: string,
  autor: AutorDelEmparejamiento,
  machineIp: string,
): Promise<{ bindingId: string; credential: string; replaced: Array<{ deviceId: string; machineIp: string }> }> {
  const deviceId = await aparatoRegistrado(venueId, autor.deviceUid)
  const credential = randomBytes(32).toString('base64url')
  const { binding, revocadas } = await withDeadlockRetry(
    async tx => {
      await candado(tx, venueId)
      const revocadas = await revocarEnTx(tx, venueId, {})
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
  return {
    bindingId: binding.id,
    credential,
    replaced: revocadas.filter(r => r.deviceId !== deviceId).map(r => ({ deviceId: r.deviceId, machineIp: r.machineIp })),
  }
}

/** `DELETE /mobile/venues/:venueId/cash-machine/binding`: esta PC deja de ser emisor. Repetirlo no hace nada. */
export async function desemparejarAparato(venueId: string, autor: AutorDelEmparejamiento): Promise<{ revoked: boolean }> {
  const deviceId = await aparatoDe(venueId, autor.deviceUid)
  if (!deviceId) return { revoked: false }
  const revocadas = await withDeadlockRetry(
    async tx => {
      await candado(tx, venueId)
      return revocarEnTx(tx, venueId, { deviceId })
    },
    { etiqueta: 'desemparejarAparato' },
  )
  anotarRevocadas(venueId, autor.userId, revocadas, () => 'MANUAL')
  return { revoked: revocadas.length > 0 }
}

/**
 * R4-3: sólo una credencial de ESTE mismo aparato (`deviceId` del encabezado) en este negocio registra un folio o sube una duda. Sin
 * credencial válida de este aparato, 403 `CASH_MACHINE_NOT_PAIRED`. Una credencial ya revocada todavía ENTREGA lo que la PC cobró sin
 * red (decisión d, Codex r1 #5), pero (recorte R1) nunca como venta: `revocada` lo decide bajo el candado del folio.
 */
export async function exigirAparatoEmparejado(
  venueId: string,
  deviceId: string | null,
  credencial: string | null,
): Promise<{ bindingId: string; revocada: boolean }> {
  if (deviceId && credencial) {
    const b = await prisma.cashMachineBinding.findFirst({
      where: { venueId, deviceId, credentialHash: hashDeCredencial(credencial) },
      select: { id: true, active: true },
    })
    if (b) return { bindingId: b.id, revocada: !b.active }
  }
  throw new ForbiddenError('Esta PC no está emparejada con la máquina de efectivo', CASH_MACHINE_NOT_PAIRED)
}
