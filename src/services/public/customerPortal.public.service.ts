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
import { withDeadlockRetry } from '@/utils/serializableRetry'
import { getStampCardStatus } from '@/services/wallet/stampLedger.service'
import { BadRequestError, UnauthorizedError } from '@/errors/AppError'
import { generateCustomerSession, type ContactoProbado } from '@/jwt.service'
import { phonesMatch } from '@/utils/phone'

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
