/**
 * Activar el celular de campo (App de campo, bloque 1): el código que dio el supervisor + el PIN de la persona dan una
 * credencial del aparato, una sesión y tokens propios del celular. Un celular vivo por persona: activar otro desvincula
 * al anterior y corta SÓLO sus sesiones (la PAX de la persona sigue).
 */
import { CelularDeCampo, CodigoDeCelular, Prisma } from '@prisma/client'
import { randomBytes } from 'crypto'
import AppError, { ConflictError, ForbiddenError, GoneError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { newCommandCredential } from '@/services/tpv/command-credential.service'
import prisma from '@/utils/prismaClient'
import { INTENTOS_DEL_CODIGO } from './codigoDeCelular.service'
import { pinCoincide } from './credencial'
import { sucursalesDeCampoDeLaPersona } from './personasDeCampo'
import { crearSesionDeCelular, revocarSesionesDelCelular, SesionDeCelular, sucursalesParaElCelular } from './sesionDeCelular'

export type AparatoDelCelular = { aparatoId: string; marca?: string; modelo?: string; versionAndroid?: string; versionApp?: string }

/** Ventana en que el MISMO aparato puede repetir una activación cuya respuesta se perdió. */
const VENTANA_DE_REINTENTO_MS = 10 * 60 * 1000

/** Celulares vinculados a la persona al activar uno nuevo: uno por diseño (cada activación desvincula los anteriores). */
const TOPE_DE_VINCULADOS = 50

/** Centinela interno: el CAS del consumo no encontró la fila (revierte la transacción; nunca sale del módulo). */
class CodigoCambio extends Error {}

const codigoUsado = () => new ConflictError('Ese código ya se usó. Pide uno nuevo a tu supervisor.', 'CODIGO_USADO')

/**
 * Sólo sus sucursales de promotora (S13, A8). Sin ninguna → 403; ninguna con PIN → 409. No compara ningún PIN: eso va
 * después de reservar el intento.
 */
async function sucursalesConPin(codigo: CodigoDeCelular) {
  const sucursales = await sucursalesDeCampoDeLaPersona(codigo.staffId, codigo.organizationId)
  if (sucursales.length === 0)
    throw new ForbiddenError('No tienes una sucursal activa. Pídele a tu supervisor que te asigne una.', 'SIN_SUCURSAL')
  if (!sucursales.some(s => s.pin)) throw new ConflictError('Todavía no tienes PIN: pídele a tu supervisor que te ponga uno.', 'SIN_PIN')
  return sucursales
}

const codigoAnulado = () =>
  new AppError('Ese código se anuló por PINes incorrectos. Pide uno nuevo a tu supervisor.', 401, true, 'CODIGO_ANULADO', {
    intentosRestantes: 0,
  })

/** Releer el código (sólo si sigue siendo ESTE código: uno regenerado ya no es el que mandaron). */
async function releer(codigo: CodigoDeCelular) {
  const fila = await prisma.codigoDeCelular.findUnique({ where: { codigo: codigo.codigo } })
  return fila?.id === codigo.id ? fila : null
}

async function anular(codigo: CodigoDeCelular, ahora: Date) {
  await prisma.codigoDeCelular.updateMany({ where: { id: codigo.id, codigo: codigo.codigo, anuladoAt: null }, data: { anuladoAt: ahora } })
}

/** El código cambió mientras tanto (otra activación lo usó, se anuló o venció): se contesta lo que dice la base. */
async function rechazoPorEstado(codigo: CodigoDeCelular, ahora: Date): Promise<never> {
  const fila = await releer(codigo)
  if (!fila) throw new NotFoundError('Ese código no existe. Pide uno nuevo a tu supervisor.', 'CODIGO_INVALIDO')
  if (fila.usadoAt) throw codigoUsado()
  if (fila.anuladoAt || fila.intentos >= INTENTOS_DEL_CODIGO) {
    await anular(codigo, ahora)
    throw codigoAnulado()
  }
  throw new GoneError('Ese código ya venció. Pide uno nuevo a tu supervisor.', 'CODIGO_VENCIDO')
}

/**
 * Reserva UN intento antes de comparar el PIN (atómico: `intentos < 5` en el mismo UPDATE). Sin esto, una ráfaga en
 * paralelo probaba más de 5 PINes, y el bueno que perdía el CAS del consumo contestaba distinto que los malos.
 * Devuelve cuántos intentos van contando éste.
 */
async function reservarIntento(codigo: CodigoDeCelular, ahora: Date): Promise<number> {
  const { count } = await prisma.codigoDeCelular.updateMany({
    where: {
      id: codigo.id,
      codigo: codigo.codigo,
      usadoAt: null,
      anuladoAt: null,
      expiraAt: { gt: ahora },
      intentos: { lt: INTENTOS_DEL_CODIGO },
    },
    data: { intentos: { increment: 1 } },
  })
  if (count === 0) return rechazoPorEstado(codigo, ahora)
  return (await releer(codigo))?.intentos ?? INTENTOS_DEL_CODIGO
}

async function cuerpo(celular: CelularDeCampo, credencial: string, sesion: SesionDeCelular, repetida: boolean) {
  const [persona, sucursales] = await Promise.all([
    prisma.staff.findUnique({ where: { id: celular.staffId }, select: { firstName: true, lastName: true } }),
    sucursalesParaElCelular(celular),
  ])
  return {
    celularId: celular.id,
    credencial,
    persona: { staffId: celular.staffId, nombre: `${persona?.firstName ?? ''} ${persona?.lastName ?? ''}`.trim() },
    sesion,
    sucursales,
    horaDelServidor: new Date().toISOString(),
    repetida,
  }
}

/** PIN malo con el intento ya reservado: al quinto, anula el código. */
async function pinMalo(codigo: CodigoDeCelular, intentos: number, ahora: Date): Promise<never> {
  if (intentos >= INTENTOS_DEL_CODIGO) {
    await anular(codigo, ahora)
    throw codigoAnulado()
  }
  throw new AppError('El PIN no es correcto.', 401, true, 'PIN_INCORRECTO', { intentosRestantes: INTENTOS_DEL_CODIGO - intentos })
}

/**
 * El código ya se usó: sólo el MISMO aparato, dentro de 10 min, con el celular aún vinculado y el PIN bueno recupera su
 * activación (la respuesta se perdió). La credencial nueva va en el CAS de la sesión: quien pierde no cambia nada (R3-4).
 * Cada PIN aquí también reserva su intento (con 5 ya no hay reintento): si no, el reintento sería una puerta sin tope.
 */
async function reintentar(codigo: CodigoDeCelular, e: { pin: string; aparato: AparatoDelCelular }, ahora: Date) {
  const enVentana = codigo.usadoAt!.getTime() >= ahora.getTime() - VENTANA_DE_REINTENTO_MS
  if (codigo.usadoPorAparatoId !== e.aparato.aparatoId || !enVentana || codigo.intentos >= INTENTOS_DEL_CODIGO) throw codigoUsado()
  const celular = await prisma.celularDeCampo.findFirst({ where: { codigoId: codigo.id, staffIdVinculado: { not: null } } })
  if (!celular) throw codigoUsado()
  const { count } = await prisma.codigoDeCelular.updateMany({
    where: { id: codigo.id, codigo: codigo.codigo, usadoAt: { not: null }, intentos: { lt: INTENTOS_DEL_CODIGO } },
    data: { intentos: { increment: 1 } },
  })
  if (count === 0) throw codigoUsado()
  const sucursales = await sucursalesDeCampoDeLaPersona(codigo.staffId, codigo.organizationId)
  const sucursal = sucursales.find(s => pinCoincide(s.pin, e.pin))
  if (!sucursal) throw codigoUsado()
  const { token, hash } = newCommandCredential()
  const sesion = await crearSesionDeCelular(celular, sucursal, { nuevaCredencialHash: hash })
  return { status: 200 as const, body: await cuerpo(celular, token, sesion, true) }
}

export async function activarCelular(e: { codigo: string; pin: string; aparato: AparatoDelCelular }) {
  const ahora = new Date()
  const codigo = await prisma.codigoDeCelular.findUnique({ where: { codigo: e.codigo } })
  if (!codigo) throw new NotFoundError('Ese código no existe. Pide uno nuevo a tu supervisor.', 'CODIGO_INVALIDO')
  if (codigo.usadoAt) return reintentar(codigo, e, ahora)
  if (codigo.anuladoAt) throw new GoneError('Ese código se anuló. Pide uno nuevo a tu supervisor.', 'CODIGO_ANULADO')
  if (codigo.expiraAt <= ahora) throw new GoneError('Ese código ya venció. Pide uno nuevo a tu supervisor.', 'CODIGO_VENCIDO')

  const sucursales = await sucursalesConPin(codigo)
  const intentos = await reservarIntento(codigo, ahora)
  const sucursal = sucursales.find(s => pinCoincide(s.pin, e.pin))
  if (!sucursal) return pinMalo(codigo, intentos, ahora)

  const { token: credencial, hash: credencialHash } = newCommandCredential()
  let nuevo: CelularDeCampo
  let anteriores: { id: string; organizationId: string }[]
  try {
    ;({ nuevo, anteriores } = await prisma.$transaction(async tx => {
      // El código se gasta UNA vez: la otra activación que llega a la vez encuentra 0 filas. El intento ya está
      // reservado, así que aquí no se mira `intentos` (y se vuelve a 0: el PIN fue bueno).
      const { count } = await tx.codigoDeCelular.updateMany({
        where: { id: codigo.id, codigo: codigo.codigo, usadoAt: null, anuladoAt: null, expiraAt: { gt: ahora } },
        data: { usadoAt: ahora, usadoPorAparatoId: e.aparato.aparatoId, intentos: 0 },
      })
      if (count === 0) throw new CodigoCambio()
      const anteriores = await tx.celularDeCampo.findMany({
        where: { staffIdVinculado: codigo.staffId },
        select: { id: true, organizationId: true },
        take: TOPE_DE_VINCULADOS,
      })
      if (anteriores.length > 0) {
        await tx.celularDeCampo.updateMany({
          where: { id: { in: anteriores.map(a => a.id) }, staffIdVinculado: { not: null } },
          data: { staffIdVinculado: null, sesionId: null, desvinculadoAt: ahora, motivoDesvinculo: 'CELULAR_NUEVO' },
        })
      }
      const nuevo = await tx.celularDeCampo.create({
        data: {
          organizationId: codigo.organizationId,
          staffId: codigo.staffId,
          staffIdVinculado: codigo.staffId,
          credencialHash,
          sesionId: null,
          pinSal: randomBytes(16).toString('base64'),
          aparatoId: e.aparato.aparatoId,
          marca: e.aparato.marca,
          modelo: e.aparato.modelo,
          versionAndroid: e.aparato.versionAndroid,
          versionApp: e.aparato.versionApp,
          codigoId: codigo.id,
        },
      })
      return { nuevo, anteriores }
    }))
  } catch (error) {
    // Se contesta lo que dice la base, igual que a un PIN malo que llega tarde: el PIN bueno no se delata.
    if (error instanceof CodigoCambio) return rechazoPorEstado(codigo, ahora)
    // Otra activación de la misma persona (con otro código) creó su celular a la vez: el único de `staffIdVinculado`.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictError('Otra activación de tu celular está en proceso. Intenta de nuevo.', 'ENTRADA_EN_PROCESO')
    }
    throw error
  }

  for (const a of anteriores) await revocarSesionesDelCelular(a.id, 'campo_celular_nuevo')
  const sesion = await crearSesionDeCelular(nuevo, sucursal)

  // Sin credencial, PIN ni código: la bitácora no guarda secretos.
  for (const a of anteriores) {
    void logAction({
      staffId: codigo.staffId,
      // Un celular de OTRA organización no se apunta con una sucursal de ésta.
      venueId: a.organizationId === codigo.organizationId ? sucursal.venueId : null,
      organizationId: a.organizationId,
      action: 'CAMPO_CELULAR_DESVINCULADO',
      entity: 'CelularDeCampo',
      entityId: a.id,
      data: { motivo: 'CELULAR_NUEVO', celularNuevoId: nuevo.id },
    })
  }
  void logAction({
    staffId: codigo.staffId,
    venueId: sucursal.venueId,
    organizationId: codigo.organizationId,
    action: 'CAMPO_CELULAR_ACTIVADO',
    entity: 'CelularDeCampo',
    entityId: nuevo.id,
    data: { aparatoId: nuevo.aparatoId, marca: nuevo.marca, modelo: nuevo.modelo, versionApp: nuevo.versionApp },
  })
  return { status: 201 as const, body: await cuerpo(nuevo, credencial, sesion, false) }
}
