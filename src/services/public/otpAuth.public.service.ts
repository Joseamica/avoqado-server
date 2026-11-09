import { CustomerApprovalStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { withDeadlockRetry, type TxConReintento } from '../../utils/serializableRetry'
import { BadRequestError, ConflictError, ServiceUnavailableError, UnauthorizedError } from '../../errors/AppError'
import logger from '../../config/logger'
import { generateOtpCode, hashOtpCode, normalizeEmail } from '../../lib/otp'
import { sendOtpWhatsApp } from '../whatsapp.service'
import emailService from '../email.service'
import { generateCustomerToken, generateOrderingCustomerToken } from '../../jwt.service'
import { canonicalPhoneE164, normalizarTelefonoMx } from '@/utils/phone'
import { findCustomerIdByPhone } from '@/services/public/customerPhoneLookup'
import { activateCustomerAccount } from '@/services/public/customerBookingAccess.service'
import { ponerNombreSiFalta } from '@/services/customer/customerName'
import { verifyGoogleIdToken } from '@/services/consumer/auth.consumer.service'
import type { ContactoProbado } from '@/jwt.service'
import {
  consumerDelContacto,
  crearFichaConConsumer,
  entrarConContacto,
  repetirSiChoca,
  respuestaDeEntrada,
  verificarPruebaPendiente,
  type FichaNueva,
  type SesionEmitida,
} from '@/services/public/sesionDeCliente.service'

const TTL_MS = 10 * 60 * 1000
/**
 * 1b S5 (Q5): `OtpChallenge.purpose`. Este servicio es el inicio de sesión del cliente (y el de pedidos en línea, que nace con el
 * mismo default): cuenta, invalida y busca SÓLO sus retos. La caja (teléfono + código de tarjetas de regalo) usa los suyos
 * (`GIFT_CARD_PHONE`, `giftCardPhone.service.ts`): ninguno de los dos toca los del otro.
 */
const PROPOSITO = 'CUSTOMER_LOGIN'

// 🔴 Los dos pasos del reto usan ESTA función: si pedir y verificar normalizaran distinto, el reto no se encontraría.
// Sin dígitos no hay teléfono: con '' `resolveIdentity` caería al camino del correo con `email: undefined`, y Prisma ignora un
// filtro undefined — encontraría al PRIMER Consumer de la base. Se rechaza aquí, antes de tocar nada.
function destinoDelReto(channel: 'whatsapp' | 'email', destination: string): string {
  if (channel === 'email') return normalizeEmail(destination)
  const telefono = normalizarTelefonoMx(destination)
  if (!telefono) throw new BadRequestError('Teléfono inválido')
  return telefono
}

type PedirCodigo = { venueId: string; channel: 'whatsapp' | 'email'; destination: string; ip?: string | null }

export async function requestOtp(args: PedirCodigo): Promise<{ ok: true }> {
  await pedirCodigo(args)
  return { ok: true }
}

/**
 * El reto y el envío de `requestOtp`. `true` sólo si el proveedor aceptó el mensaje: `requestOtp` lo ignora (como siempre: la página no
 * dice si se mandó), pero Google lo necesita para no afirmar «te mandamos un código» cuando el correo no salió (codex-s7-r1 #2).
 */
async function pedirCodigo(args: PedirCodigo): Promise<boolean> {
  const destination = destinoDelReto(args.channel, args.destination)
  const now = Date.now()

  // Fase 0.B: todo se acota al venue. Un mismo teléfono puede tener retos vivos en dos
  // estudios distintos sin que uno invalide o rate-limite al otro.
  const venueId = args.venueId
  const last30s = await prisma.otpChallenge.count({
    where: { venueId, destination, purpose: PROPOSITO, createdAt: { gt: new Date(now - 30_000) } },
  })
  if (last30s > 0) throw new BadRequestError('Espera un momento antes de pedir otro código.')
  const lastHour = await prisma.otpChallenge.count({
    where: { venueId, destination, purpose: PROPOSITO, createdAt: { gt: new Date(now - 3_600_000) } },
  })
  if (lastHour >= 5) throw new BadRequestError('Demasiados códigos solicitados. Intenta más tarde.')

  await prisma.otpChallenge.updateMany({
    where: { venueId, destination, channel: args.channel, purpose: PROPOSITO, consumedAt: null },
    data: { consumedAt: new Date() },
  })

  const code = generateOtpCode()
  await prisma.otpChallenge.create({
    data: {
      venueId,
      channel: args.channel,
      destination,
      codeHash: hashOtpCode(code),
      expiresAt: new Date(now + TTL_MS),
      ip: args.ip ?? null,
    },
  })

  try {
    return args.channel === 'whatsapp'
      ? (await sendOtpWhatsApp(destination, code)) !== false
      : (await emailService.sendOtpCodeEmail(destination, code)) === true
  } catch (err) {
    logger.warn(`[OTP] send failed for ${args.channel}:${destination}: ${(err as Error).message}`)
    return false
  }
}

type VerifyOtpArgs = {
  venueId: string
  channel: 'whatsapp' | 'email'
  destination: string
  code: string
  /** Spec 2026-10-14 §3.3: nombre del alta. Sólo se usa si el cliente no tiene uno. */
  firstName?: string | null
}
type ResultadoDeHoy = {
  token: string
  /**
   * Fase 1: estado de aprobación de la cuenta de reservas. Sin `purpose`, el que resulta de activarla, y el controller lo compone
   * en `bookingAccess`. Con `purpose: 'ORDERING'` la cuenta no se activa: es el de la ficha sin tocar y el controller no lo responde.
   */
  approvalStatus: CustomerApprovalStatus
  customer: { id: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null }
}
/**
 * S7 (P2-1): la sesión única. Acepta WhatsApp o correo, NO activa reservas (S6 lo hace al reservar o abrir el portal) y responde la
 * `SesionEmitida` o, sin ficha y con «¿ya eres cliente?» (`alNoEncontrar: 'PREGUNTAR'`), la prueba del contacto sin crear nada.
 * `vincular` es la `pruebaPendiente` de la PRIMERA prueba: su contacto se liga a la ficha que encuentra ESTA.
 */
type VerifyOtpSesion = VerifyOtpArgs & { purpose: 'SESSION'; alNoEncontrar?: 'PREGUNTAR'; vincular?: string }

export async function verifyOtp(args: VerifyOtpSesion): Promise<SesionEmitida | FichaNueva>
export async function verifyOtp(args: VerifyOtpArgs & { purpose?: 'ORDERING' }): Promise<ResultadoDeHoy>
export async function verifyOtp(
  args: VerifyOtpArgs & { purpose?: 'ORDERING' | 'SESSION'; alNoEncontrar?: 'PREGUNTAR'; vincular?: string },
): Promise<ResultadoDeHoy | SesionEmitida | FichaNueva> {
  const destination = destinoDelReto(args.channel, args.destination)

  // H1 (pedidos en línea): verificar para PEDIR prueba un TELÉFONO; un código por correo no lo prueba. Se rechaza antes de tocar
  // el reto: no se gasta un intento y el código sigue sirviendo.
  if (args.purpose === 'ORDERING' && args.channel !== 'whatsapp') {
    throw new BadRequestError('Para pedir, verifica tu teléfono por WhatsApp.', 'ORDERING_REQUIRES_PHONE')
  }
  // S7: una prueba que no sirve se rechaza también ANTES del reto (400, sin gastar intento).
  const vinculo = args.purpose === 'SESSION' && args.vincular ? verificarPruebaPendiente(args.vincular, args.venueId) : null

  // Fase 0.B: sólo retos de ESTE venue y canal. Un reto legacy con venueId NULL no entra
  // aquí nunca (no puede probar de qué venue vino) — muere por TTL.
  const challenge = await prisma.otpChallenge.findFirst({
    where: { venueId: args.venueId, destination, channel: args.channel, purpose: PROPOSITO, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  if (!challenge || challenge.expiresAt.getTime() <= Date.now()) throw new BadRequestError('El código expiró. Pide uno nuevo.')
  // 🔴 El intento se aparta en la base ANTES de comparar (auditoría 2026-10-01): escribir `attempts + 1` sobre lo leído aquí
  // dejaba que varias verificaciones simultáneas probaran más de `maxAttempts` códigos. Este CAS y el de consumo de abajo tienen
  // una COPIA en `giftCardPhone.service.ts` (`verificarCodigoDeTelefono`, la caja): si cambias uno, revisa el otro.
  const apartado =
    challenge.attempts < challenge.maxAttempts &&
    (
      await prisma.otpChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null, attempts: { lt: challenge.maxAttempts } },
        data: { attempts: { increment: 1 } },
      })
    ).count === 1
  // Sin intento que apartar sólo se rechaza: marcar el reto como usado le quemaría el último intento correcto a quien sí lo apartó
  // y va a mitad de su verificación. Con `attempts = maxAttempts` el reto ya no admite más pruebas.
  if (!apartado) throw new BadRequestError('Demasiados intentos. Pide un código nuevo.')
  if (challenge.codeHash !== hashOtpCode(args.code)) throw new BadRequestError('Código incorrecto.')

  if (args.purpose === 'SESSION') {
    const contacto: ContactoProbado =
      args.channel === 'whatsapp'
        ? { tipo: 'PHONE', valor: destination, metodo: 'WHATSAPP', probadoEn: Math.floor(Date.now() / 1000) }
        : { tipo: 'EMAIL', valor: destination, metodo: 'EMAIL_CODE', probadoEn: Math.floor(Date.now() / 1000) }
    // R2: si dos entradas escriben el mismo contacto a la vez, la perdedora se repite entera (también el consumo del reto, que su
    // rollback devolvió) y ya ve a la ganadora.
    const entrada = await repetirSiChoca(() =>
      withDeadlockRetry(
        async tx => {
          await consumirReto(tx, challenge.id)
          return entrarConContacto(tx, args.venueId, contacto, { alNoEncontrar: args.alNoEncontrar, vinculo, firstName: args.firstName })
        },
        { etiqueta: 'verifyOtp' },
      ),
    )
    return respuestaDeEntrada(args.venueId, contacto, entrada)
  }

  // Fase 1: consumir el reto, resolver la identidad (Consumer + Customer + vínculo) y decidir
  // la aprobación viven en UNA transacción. Antes eran escrituras sueltas: si algo tronaba a
  // medias, el código quedaba quemado y el Consumer huérfano, y el cliente tenía que pedir otro.
  const { customer, approvalStatus } = await withDeadlockRetry(
    async tx => {
      await consumirReto(tx, challenge.id)

      const customer = await resolveIdentity(
        tx,
        args.venueId,
        args.channel === 'whatsapp' ? { phone: destination } : { email: destination },
      )
      // Fase 0.B: el código fue correcto, pero una cuenta desactivada por el venue no recibe
      // token. `=== false` a propósito: `active` es @default(true) en DB; un registro sin el
      // campo (mocks, selects parciales) no debe volverse "inactivo" por accidente. Al lanzar
      // aquí, el rollback devuelve el reto sin consumir — el código sigue sirviendo.
      if (customer.active === false) {
        throw new UnauthorizedError('Esta cuenta está desactivada', 'CUSTOMER_INACTIVE')
      }

      // R7: verificar el teléfono para PEDIR no activa la cuenta de reservas (no pide aprobación ni manda sus avisos).
      if (args.purpose === 'ORDERING') return { customer, approvalStatus: customer.approvalStatus }
      const conNombre = await ponerNombreSiFalta(tx, customer, args.firstName)
      const activation = await activateCustomerAccount(tx, { customerId: conNombre.id, venueId: args.venueId, origin: 'OTP' })
      return { customer: conNombre, approvalStatus: activation.approvalStatus }
    },
    { etiqueta: 'verifyOtp' },
  )

  // Post-commit: si la transacción falló, nadie recibe sesión.
  // H1: para PEDIR, el token de PEDIDOS (prueba el teléfono; reservas y portal lo rechazan). Sin `purpose`, el de siempre.
  // El teléfono va en la forma canónica (`+521…` → `+52…`), la misma con la que el pedido lo guarda y cuenta su tope.
  const token =
    args.purpose === 'ORDERING'
      ? generateOrderingCustomerToken(customer.id, args.venueId, canonicalPhoneE164(destination) ?? destination)
      : generateCustomerToken(customer.id, args.venueId)
  return {
    token,
    /** Fase 1: sin `purpose`, el controller lo compone en `bookingAccess`. */
    approvalStatus,
    customer: { id: customer.id, firstName: customer.firstName, lastName: customer.lastName, email: customer.email, phone: customer.phone },
  }
}

/**
 * 🔴 CAS, no `update` ciego. El reto se leyó FUERA de la transacción: dos verificaciones
 * simultáneas con el código correcto leían el mismo reto sin consumir y ambas emitían
 * token — el "un solo uso" no era tal. Condicionar en `consumedAt: null` deja pasar
 * exactamente a una; la que pierde recibe el mismo 400 que un código ya usado.
 */
async function consumirReto(tx: TxConReintento, challengeId: string): Promise<void> {
  const consumed = await tx.otpChallenge.updateMany({
    where: { id: challengeId, consumedAt: null },
    data: { consumedAt: new Date() },
  })
  if (consumed.count !== 1) {
    throw new BadRequestError('Ese código ya se usó. Pide uno nuevo.')
  }
}

/**
 * S7 (P2-1): Google, de respaldo. Sólo un correo que Google da por suyo (`emailTrusted`: Gmail o Workspace, el verificador de la app
 * de clientes, sin otra política) prueba el correo. Con otro correo, el SERVIDOR manda el código por correo (fuera de la Tx) y
 * responde 409: la clienta lo confirma con `auth/otp/verify`. Nunca se dice «te mandamos» si el envío no se pidió.
 */
export async function entrarConGoogle(
  venueId: string,
  idToken: string,
  opciones: { alNoEncontrar?: 'PREGUNTAR'; vincular?: string; firstName?: string | null; ip?: string | null },
): Promise<SesionEmitida | FichaNueva> {
  const vinculo = opciones.vincular ? verificarPruebaPendiente(opciones.vincular, venueId) : null
  const perfil = await verifyGoogleIdToken(idToken)
  if (!perfil.email) throw new BadRequestError('Google no compartió tu correo. Entra con un código.', 'GOOGLE_EMAIL_MISSING')
  const email = normalizeEmail(perfil.email)
  if (!perfil.emailTrusted) {
    if (!(await pedirCodigo({ venueId, channel: 'email', destination: email, ip: opciones.ip }))) {
      throw new ServiceUnavailableError(
        'No pudimos mandarte el código a tu correo. Intenta otra vez o entra con WhatsApp.',
        'OTP_SEND_FAILED',
      )
    }
    throw new ConflictError('Te mandamos un código a tu correo para confirmarlo', 'GOOGLE_EMAIL_NOT_TRUSTED')
  }
  const contacto: ContactoProbado = { tipo: 'EMAIL', valor: email, metodo: 'GOOGLE', probadoEn: Math.floor(Date.now() / 1000) }
  const entrada = await repetirSiChoca(() =>
    withDeadlockRetry(
      tx =>
        entrarConContacto(tx, venueId, contacto, {
          alNoEncontrar: opciones.alNoEncontrar,
          vinculo,
          firstName: opciones.firstName ?? perfil.firstName,
        }),
      { etiqueta: 'entrarConGoogle' },
    ),
  )
  return respuestaDeEntrada(venueId, contacto, entrada)
}

/** El alta de hoy (pedidos y reservas sin `purpose`): sin cambios de comportamiento; la creación vive en `sesionDeCliente`. */
async function resolveIdentity(tx: TxConReintento, venueId: string, key: { phone?: string; email?: string }) {
  const consumer = await consumerDelContacto(tx, key)

  const where = key.phone ? { venueId_phone: { venueId, phone: key.phone } } : { venueId_email: { venueId, email: key.email! } }
  let customer = await tx.customer.findUnique({ where: where as any })
  if (!customer) customer = await tx.customer.findFirst({ where: { venueId, consumerId: consumer.id } })

  // 🔴 Tercer intento: el mismo teléfono guardado con otro formato (`findCustomerIdByPhone`: 681 de 682 clientes lo tienen
  // como lo escribió quien los dio de alta). Salió al probar el cartel del mostrador, que manda a TODOS por este camino.
  // Se relee por Prisma: el resto de la función espera el modelo completo (`active`, `consumerId`).
  if (!customer && key.phone) {
    const elegido = await findCustomerIdByPhone(tx, venueId, key.phone)
    if (elegido) customer = await tx.customer.findUnique({ where: { id: elegido } })
  }

  if (!customer) {
    customer = await crearFichaConConsumer(tx, venueId, consumer.id, key)
  } else if (!customer.consumerId) {
    customer = await tx.customer.update({ where: { id: customer.id }, data: { consumerId: consumer.id } })
  }
  return customer
}
