/**
 * Activar el celular de campo (App de campo, bloque 1): el código que dio el supervisor + el PIN de la persona dan una
 * credencial del aparato, una sesión y tokens propios del celular. Un celular vivo por persona: activar otro desvincula
 * al anterior y corta SÓLO sus sesiones (la PAX de la persona sigue).
 */
import { CelularDeCampo, CodigoDeCelular, Prisma } from '@prisma/client'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import AppError, { ConflictError, ForbiddenError, GoneError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { newCommandCredential } from '@/services/tpv/command-credential.service'
import prisma from '@/utils/prismaClient'
import { INTENTOS_DEL_CODIGO } from './codigoDeCelular.service'
import { sucursalesDeLaPersona } from './personasDeCampo'
import { crearSesionDeCelular, revocarSesionesDelCelular, SesionDeCelular, sucursalesParaElCelular } from './sesionDeCelular'

export type AparatoDelCelular = { aparatoId: string; marca?: string; modelo?: string; versionAndroid?: string; versionApp?: string }

/** Ventana en que el MISMO aparato puede repetir una activación cuya respuesta se perdió. */
const VENTANA_DE_REINTENTO_MS = 10 * 60 * 1000

const codigoUsado = () => new ConflictError('Ese código ya se usó. Pide uno nuevo a tu supervisor.', 'CODIGO_USADO')

/** Tiempo constante: se comparan los sha256 (mismo largo), no los PINes. */
function pinCoincide(guardado: string | null, pin: string): boolean {
  if (!guardado) return false
  const a = createHash('sha256').update(guardado).digest()
  const b = createHash('sha256').update(pin).digest()
  return timingSafeEqual(a, b)
}

/** La primera sucursal cuyo PIN coincide, o null. Sin sucursales → 403; ninguna con PIN → 409. */
async function sucursalDelPin(codigo: CodigoDeCelular, pin: string) {
  const sucursales = await sucursalesDeLaPersona(codigo.staffId, codigo.organizationId)
  if (sucursales.length === 0)
    throw new ForbiddenError('No tienes una sucursal activa. Pídele a tu supervisor que te asigne una.', 'SIN_SUCURSAL')
  if (!sucursales.some(s => s.pin)) throw new ConflictError('Todavía no tienes PIN: pídele a tu supervisor que te ponga uno.', 'SIN_PIN')
  return sucursales.find(s => pinCoincide(s.pin, pin)) ?? null
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

/** PIN malo sobre un código vivo: cuenta el intento y, al quinto, anula el código. */
async function pinMalo(codigo: CodigoDeCelular, ahora: Date): Promise<never> {
  await prisma.codigoDeCelular.updateMany({
    where: { id: codigo.id, codigo: codigo.codigo, usadoAt: null, anuladoAt: null },
    data: { intentos: { increment: 1 } },
  })
  const intentos =
    (await prisma.codigoDeCelular.findUnique({ where: { id: codigo.id }, select: { intentos: true } }))?.intentos ?? INTENTOS_DEL_CODIGO
  if (intentos >= INTENTOS_DEL_CODIGO) {
    await prisma.codigoDeCelular.updateMany({
      where: { id: codigo.id, codigo: codigo.codigo, anuladoAt: null },
      data: { anuladoAt: ahora },
    })
    throw new AppError('Ese código se anuló por PINes incorrectos. Pide uno nuevo a tu supervisor.', 401, true, 'CODIGO_ANULADO', {
      intentosRestantes: 0,
    })
  }
  throw new AppError('El PIN no es correcto.', 401, true, 'PIN_INCORRECTO', { intentosRestantes: INTENTOS_DEL_CODIGO - intentos })
}

/**
 * El código ya se usó: sólo el MISMO aparato, dentro de 10 min, con el celular aún vinculado y el PIN bueno recupera su
 * activación (la respuesta se perdió). La credencial nueva va en el CAS de la sesión: quien pierde no cambia nada (R3-4).
 * Los PINes malos aquí también cuentan (con 5 ya no hay reintento): si no, el reintento sería una puerta sin tope.
 */
async function reintentar(codigo: CodigoDeCelular, e: { pin: string; aparato: AparatoDelCelular }, ahora: Date) {
  const enVentana = codigo.usadoAt!.getTime() >= ahora.getTime() - VENTANA_DE_REINTENTO_MS
  if (codigo.usadoPorAparatoId !== e.aparato.aparatoId || !enVentana || codigo.intentos >= INTENTOS_DEL_CODIGO) throw codigoUsado()
  const celular = await prisma.celularDeCampo.findFirst({ where: { codigoId: codigo.id, staffIdVinculado: { not: null } } })
  if (!celular) throw codigoUsado()
  const sucursales = await sucursalesDeLaPersona(codigo.staffId, codigo.organizationId)
  const sucursal = sucursales.find(s => pinCoincide(s.pin, e.pin))
  if (!sucursal) {
    await prisma.codigoDeCelular.updateMany({ where: { id: codigo.id }, data: { intentos: { increment: 1 } } })
    throw codigoUsado()
  }
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

  const sucursal = await sucursalDelPin(codigo, e.pin)
  if (!sucursal) return pinMalo(codigo, ahora)

  const { token: credencial, hash: credencialHash } = newCommandCredential()
  let nuevo: CelularDeCampo
  let anteriores: { id: string; organizationId: string }[]
  try {
    ;({ nuevo, anteriores } = await prisma.$transaction(async tx => {
      // El código se gasta UNA vez: la otra activación que llega a la vez encuentra 0 filas.
      const { count } = await tx.codigoDeCelular.updateMany({
        where: {
          id: codigo.id,
          codigo: codigo.codigo,
          usadoAt: null,
          anuladoAt: null,
          expiraAt: { gt: ahora },
          intentos: { lt: INTENTOS_DEL_CODIGO },
        },
        data: { usadoAt: ahora, usadoPorAparatoId: e.aparato.aparatoId },
      })
      if (count === 0) throw codigoUsado()
      const anteriores = await tx.celularDeCampo.findMany({
        where: { staffIdVinculado: codigo.staffId },
        select: { id: true, organizationId: true },
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
      venueId: sucursal.venueId,
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
