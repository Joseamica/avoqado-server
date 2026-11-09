/**
 * Customer Portal Public Service
 *
 * Handles:
 * - Customer login (email + password, sólo cuentas que ya la tienen; las nuevas entran con código)
 * - Portal data (credits + reservations)
 *
 * Uses existing Customer.password field — no new tables.
 */

import bcrypt from 'bcryptjs'
import { CreditPurchaseStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { withDeadlockRetry, type TxConReintento } from '@/utils/serializableRetry'
import { getStampCardStatus } from '@/services/wallet/stampLedger.service'
import { BadRequestError, ConflictError, UnauthorizedError } from '@/errors/AppError'
import { generateCustomerSession, type ContactoProbado } from '@/jwt.service'
import { normalizarTelefonoMx, phonesMatch } from '@/utils/phone'
import type { CustomerAuthContext } from '@/middlewares/customerAuth.middleware'
import { apartarReto, consumirReto, pedirCodigo } from '@/services/public/otpAuth.public.service'
import { fichaConContacto, repetirSiChoca, tapar, type SesionEmitida } from '@/services/public/sesionDeCliente.service'

/**
 * 🔴 Toda cuenta nueva se crea con código (auditoría de seguridad 2026-09-30/10-01, decisión del founder del 1-oct): `verifyOtp`
 * prueba que el correo o el teléfono son de quien entra. El registro con contraseña le entregaba a cualquiera la cuenta de un
 * cliente que existía sin contraseña (y por teléfono le cambiaba el correo) y dejaba «apartar» el correo de alguien antes de
 * que reservara. Responde SIEMPRE lo mismo y no consulta nada: tampoco dice si el contacto ya existe o está desactivado. La
 * ruta sigue viva para que una página vieja en caché le muestre al cliente qué hacer.
 */
export function registerCustomer(): never {
  throw new BadRequestError(
    'Para crear tu cuenta, entra con un código: te lo mandamos a tu WhatsApp o a tu correo.',
    'CUSTOMER_REGISTER_USE_CODE',
  )
}

/**
 * Login with email + password
 */
export async function loginCustomer(venueId: string, email: string, password: string) {
  const customer = await prisma.customer.findUnique({
    where: { venueId_email: { venueId, email } },
  })

  if (!customer || !customer.password) {
    throw new UnauthorizedError('Correo o contraseña incorrectos')
  }

  const valid = await bcrypt.compare(password, customer.password)
  if (!valid) {
    throw new UnauthorizedError('Correo o contraseña incorrectos')
  }

  // Fase 0.B: una cuenta desactivada por el venue no recibe token por ninguna puerta.
  // Se comprueba DESPUÉS del password para no revelar el estado a quien no lo sabe.
  if (customer.active === false) {
    throw new UnauthorizedError('Esta cuenta está desactivada', 'CUSTOMER_INACTIVE')
  }

  // S7 (P2-1, codex-plan2-r1 #2): la sesión única, SIN contactos probados. La contraseña prueba la ficha, no su correo: el panel
  // cambia el correo sin probarlo (`customer.dashboard.service.ts` `updateCustomer`) y la contraseña sigue igual.
  const token = generateCustomerSession({ sub: customer.id, venueId, v: customer.versionDeSesion, contactos: [] })

  return {
    token,
    customer: {
      id: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone,
    },
  }
}

/**
 * Update customer profile (authenticated)
 */
export async function updateProfile(venueId: string, customerId: string, data: { firstName?: string; lastName?: string; phone?: string }) {
  // 🔴 El teléfono ya no se cambia desde aquí (auditoría 2026-10-01): sin probar que era suyo, alguien ponía el de otra persona y
  // el portal le mostraba sus reservas de invitado con su `cancelSecret`. Lo cambia el negocio desde su dashboard (`updateCustomer`):
  // entrar con código desde otro número abre OTRA cuenta, no mueve ésta. Una página vieja que manda el MISMO teléfono (en cualquier
  // formato) sigue guardando los nombres.
  if (data.phone) {
    const actual = await prisma.customer.findFirst({ where: { id: customerId, venueId }, select: { phone: true } })
    if (data.phone !== actual?.phone && !phonesMatch(data.phone, actual?.phone)) {
      throw new BadRequestError(
        'El teléfono no se cambia desde aquí. Para actualizarlo sin perder tu historial, pide ayuda al negocio.',
        'CUSTOMER_PHONE_CHANGE_NOT_ALLOWED',
      )
    }
  }

  const customer = await withDeadlockRetry(
    tx =>
      tx.customer.update({
        where: { id: customerId },
        data: {
          ...(data.firstName !== undefined ? { firstName: data.firstName } : {}),
          ...(data.lastName !== undefined ? { lastName: data.lastName } : {}),
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
        },
      }),
    { etiqueta: 'updateProfile' },
  )

  return { customer }
}

/**
 * Get all customer portal data (requires authenticated customer)
 *
 * S7 (P2-1): las reservas de INVITADA (con su `cancelSecret`) se buscan sólo con los contactos que ESTA sesión probó; antes, con el
 * teléfono y el correo de la ficha, que el panel puede cambiar sin probar. Sin contactos (token de reservas de hoy, contraseña) sólo
 * se ven las de la ficha y `invitadaRequiereEntrar` le pide a la tienda «Entra otra vez para ver tus reservas como invitada».
 */
export async function getCustomerPortal(venueId: string, customerId: string, auth?: { contactos: ContactoProbado[] }) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, venueId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      loyaltyPoints: true,
      totalVisits: true,
    },
  })

  const contactos = auth?.contactos ?? []
  const invitadaRequiereEntrar = contactos.length === 0
  if (!customer) {
    return { customer: null, credits: { purchases: [] }, reservations: { upcoming: [], past: [] }, invitadaRequiereEntrar }
  }

  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  // Sus reservas, y las de invitada con un contacto probado (en su forma probada y, si es el mismo, en la que guarda la ficha).
  const contactFilter = [
    { customerId: customer.id },
    ...contactos.map(c =>
      c.tipo === 'PHONE'
        ? {
            guestPhone: {
              in: [
                c.valor,
                ...(customer.phone && customer.phone !== c.valor && phonesMatch(c.valor, customer.phone) ? [customer.phone] : []),
              ],
            },
          }
        : { guestEmail: { equals: c.valor, mode: 'insensitive' as const } },
    ),
  ]

  const [purchases, upcomingReservations, pastReservations] = await Promise.all([
    prisma.creditPackPurchase.findMany({
      where: {
        venueId,
        customerId: customer.id,
        status: CreditPurchaseStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      include: {
        creditPack: { select: { name: true } },
        itemBalances: {
          where: {
            remainingQuantity: { gt: 0 },
            product: { allowCreditRedemption: true },
          },
          include: {
            product: { select: { id: true, name: true, type: true, imageUrl: true } },
          },
        },
      },
      orderBy: { expiresAt: 'asc' },
    }),

    prisma.reservation.findMany({
      where: {
        venueId,
        startsAt: { gte: now },
        status: { in: ['PENDING', 'CONFIRMED'] },
        OR: contactFilter,
      },
      select: {
        confirmationCode: true,
        cancelSecret: true,
        status: true,
        startsAt: true,
        endsAt: true,
        duration: true,
        partySize: true,
        guestName: true,
        spotIds: true,
        product: { select: { id: true, name: true, price: true } },
      },
      orderBy: { startsAt: 'asc' },
      take: 20,
    }),

    prisma.reservation.findMany({
      where: {
        venueId,
        startsAt: { lt: now, gte: thirtyDaysAgo },
        OR: contactFilter,
      },
      select: {
        confirmationCode: true,
        status: true,
        startsAt: true,
        endsAt: true,
        duration: true,
        partySize: true,
        guestName: true,
        product: { select: { id: true, name: true, price: true } },
      },
      orderBy: { startsAt: 'desc' },
      take: 20,
    }),
  ])

  // 🔴 De esto depende que el boton "Guardar mi tarjeta" aparezca en el widget. Se
  // consulta la configuracion ANTES del avance: si el negocio no usa sellos, leer una
  // cartilla que no existe es una consulta por cada apertura del portal, en TODOS los
  // venues — y la mayoria no usa sellos.
  const stampCard = await (async () => {
    const apagada = { enabled: false as const, stampsEarned: 0, stampsRequired: 0, rewardLabel: '' }
    try {
      const config = await prisma.loyaltyConfig.findUnique({
        where: { venueId },
        select: { stampsEnabled: true },
      })
      if (!config?.stampsEnabled) return apagada
      const estado = await getStampCardStatus(venueId, customer.id)
      return {
        enabled: true as const,
        stampsEarned: estado.stampsEarned,
        stampsRequired: estado.stampsRequired,
        rewardLabel: estado.rewardLabel,
      }
    } catch {
      // El portal es donde el cliente ve sus reservaciones y sus creditos. Que no se
      // pueda leer una cartilla no puede dejarlo sin nada: se degrada a "sin tarjeta".
      return apagada
    }
  })()

  return {
    customer,
    credits: { purchases },
    reservations: {
      upcoming: upcomingReservations,
      past: pastReservations,
    },
    stampCard,
    invitadaRequiereEntrar,
  }
}

// ---- S8 (P2-1): cambiar de número ----

const RETO_DE_CAMBIO = 'CUSTOMER_PHONE_CHANGE' as const

/**
 * Cambiar de número pide una sesión que ya probó un contacto, o el token de pedidos de hoy (firma el teléfono). El token de reservas de
 * hoy ya lo frena S6; una sesión sin contactos (contraseña) se frena aquí (R1): la contraseña prueba la ficha, no un contacto.
 */
function exigirContactoProbado(auth: CustomerAuthContext): void {
  const probo = auth.contactos.length > 0 || (auth.tipo === 'PEDIDOS_DE_HOY' && !!auth.verifiedPhone)
  if (auth.tipo === 'RESERVAS_DE_HOY' || !probo) {
    throw new UnauthorizedError('Entra otra vez para cambiar tu número', 'CUSTOMER_REAUTH_REQUIRED')
  }
}

function telefonoNuevo(phone: string): string {
  const nuevo = normalizarTelefonoMx(phone)
  if (!nuevo) throw new BadRequestError('Teléfono inválido')
  return nuevo
}

const mismoNumero = () => new BadRequestError('Ese ya es tu número.', 'CUSTOMER_PHONE_SAME')

/** POST /venues/:venueSlug/customer/phone/request — el código va por WhatsApp al número NUEVO (reto propio, mismas reglas). */
export async function pedirCambioDeTelefono(venueId: string, auth: CustomerAuthContext, phone: string, ip?: string | null) {
  exigirContactoProbado(auth)
  const nuevo = telefonoNuevo(phone)
  const actual = await prisma.customer.findFirst({ where: { id: auth.customerId, venueId }, select: { phone: true } })
  if (phonesMatch(nuevo, actual?.phone)) throw mismoNumero()
  await pedirCodigo({ venueId, channel: 'whatsapp', destination: nuevo, ip }, RETO_DE_CAMBIO)
  return { ok: true as const }
}

/**
 * Dentro de la Tx de `confirmarCambioDeTelefono`: con la ficha bajo candado, el número nuevo REEMPLAZA al viejo en `Customer.phone` y en
 * su `Consumer` (si tenía el viejo), sube `versionDeSesion` (S6 deja fuera toda sesión anterior, también las del mismo segundo) y deja
 * bitácora. Si el número es de otra ficha, 409 y no se mueve nada: el rollback devuelve el reto sin consumir.
 */
async function cambiarTelefonoEnTx(tx: TxConReintento, venueId: string, auth: CustomerAuthContext, nuevo: string, retoId: string) {
  await consumirReto(tx, retoId)
  await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${auth.customerId} AND "venueId" = ${venueId} FOR NO KEY UPDATE`
  const ficha = await tx.customer.findUniqueOrThrow({ where: { id: auth.customerId } })
  // R3: lo que probó la sesión sigue en la ficha (el panel pudo cambiarlo entre el middleware y el candado).
  const sigue =
    (!auth.verifiedPhone || phonesMatch(auth.verifiedPhone, ficha.phone)) &&
    auth.contactos.every(c =>
      c.tipo === 'PHONE' ? phonesMatch(c.valor, ficha.phone) : c.valor.trim().toLowerCase() === ficha.email?.trim().toLowerCase(),
    )
  // codex-s8-r1 #1: otra petición con una sesión de la MISMA versión ya cambió el número (y la dejó fuera) mientras ésta esperaba el
  // candado; o el panel desactivó la ficha. Los dos tokens de hoy cuentan como versión 0 (S6).
  if (!sigue || (auth.v ?? 0) < ficha.versionDeSesion) throw new UnauthorizedError('Token inválido o expirado', 'CUSTOMER_TOKEN_INVALID')
  if (ficha.active === false) throw new UnauthorizedError('Esta cuenta está desactivada', 'CUSTOMER_INACTIVE')
  if (phonesMatch(nuevo, ficha.phone)) throw mismoNumero()

  // «Otra ficha» se busca ANTES de escribir (lo ya guardado, en cualquier formato, da el 409 con su aviso; codex-s8-r2 #2) y otra vez
  // DESPUÉS (codex-s8-r1 #4: lo que otro guardó en otro formato mientras tanto; el mismo formato choca en el índice único,
  // `repetirSiChoca` repite y la primera búsqueda ya lo ve). Queda abierto sólo lo que el panel escriba en otro formato y aún sin commit
  // (deuda anotada: el panel compara por texto exacto).
  const contacto: ContactoProbado = { tipo: 'PHONE', valor: nuevo, metodo: 'WHATSAPP', probadoEn: 0 }
  const deOtraFicha = () =>
    new ConflictError('Ese número ya está en otra ficha de este negocio.', 'TELEFONO_DE_OTRA_FICHA', { otraFicha: tapar(contacto) })
  if (await fichaConContacto(tx, venueId, contacto, ficha.id)) throw deOtraFicha()
  const cambiada = await tx.customer.update({
    where: { id: ficha.id },
    data: { phone: nuevo, versionDeSesion: { increment: 1 } },
  })
  if (await fichaConContacto(tx, venueId, contacto, ficha.id)) throw deOtraFicha()
  const consumer = ficha.consumerId ? await tx.consumer.findUnique({ where: { id: ficha.consumerId } }) : null
  if (consumer?.phone && ficha.phone && phonesMatch(consumer.phone, ficha.phone)) {
    // codex-s8-r1 #3: CAS sobre el teléfono leído: otra ficha (de otro negocio) que comparta el Consumer y lo cambie a la vez no se pisa.
    await tx.consumer.updateMany({ where: { id: consumer.id, phone: consumer.phone }, data: { phone: nuevo } })
  }
  await tx.activityLog.create({
    data: {
      action: 'CUSTOMER_PHONE_CHANGED_BY_CUSTOMER',
      entity: 'Customer',
      entityId: ficha.id,
      venueId,
      data: { de: ficha.phone, a: nuevo },
    },
  })
  return cambiada
}

/** POST /venues/:venueSlug/customer/phone/verify — confirma el código y responde la sesión nueva (versión nueva, sólo el número nuevo). */
export async function confirmarCambioDeTelefono(
  venueId: string,
  auth: CustomerAuthContext,
  phone: string,
  code: string,
): Promise<SesionEmitida> {
  exigirContactoProbado(auth)
  const nuevo = telefonoNuevo(phone)
  const reto = await apartarReto({ venueId, channel: 'whatsapp', destination: nuevo, code }, RETO_DE_CAMBIO)
  const ficha = await repetirSiChoca(() =>
    withDeadlockRetry(tx => cambiarTelefonoEnTx(tx, venueId, auth, nuevo, reto.id), { etiqueta: 'confirmarCambioDeTelefono' }),
  )
  // R5: los contactos de antes menos todo teléfono, más el nuevo, recién probado.
  const contactos: ContactoProbado[] = [
    ...auth.contactos.filter(c => c.tipo !== 'PHONE'),
    { tipo: 'PHONE', valor: nuevo, metodo: 'WHATSAPP', probadoEn: Math.floor(Date.now() / 1000) },
  ]
  return {
    token: generateCustomerSession({ sub: ficha.id, venueId, v: ficha.versionDeSesion, contactos }),
    customer: { id: ficha.id, firstName: ficha.firstName, lastName: ficha.lastName, email: ficha.email, phone: ficha.phone },
    contactos,
    otraFicha: null,
  }
}
