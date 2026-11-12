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
import { formatInTimeZone } from 'date-fns-tz'
import { CreditPurchaseStatus, Prisma, StampRewardStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { withDeadlockRetry, type TxConReintento } from '@/utils/serializableRetry'
import { DEFAULT_TIMEZONE } from '@/utils/datetime'
import { utcTs } from '@/utils/sqlDates'
import { getStampCardStatus } from '@/services/wallet/stampLedger.service'
import AppError, { BadRequestError, ConflictError, UnauthorizedError } from '@/errors/AppError'
import { decryptGiftCardCode, formatGiftCardCode } from '@/services/giftCards/giftCardCode'
import { esSobreDeSaldoAFavorSql } from '@/services/giftCards/giftCardLedger'
import { revalidarSesionEnTx } from '@/services/giftCards/giftCardClaim.service'
import { fromActiveCursor, toActiveCursor } from '@/services/online-ordering/inbox.service'
import { esVentaCerrada } from '@/services/shared/orderBalance'
import { generateCustomerSession, type ContactoProbado } from '@/jwt.service'
import { normalizarTelefonoMx, phonesMatch } from '@/utils/phone'
import type { CustomerAuthContext } from '@/middlewares/customerAuth.middleware'
import { apartarReto, consumirReto, requestOtp } from '@/services/public/otpAuth.public.service'
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
export async function getCustomerPortal(venueId: string, customerId: string, auth?: SesionDelPortal) {
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

  // S13: UNA lectura de la configuración de lealtad para la cartilla, los puntos y el premio.
  const config = await seccion('lealtad', venueId, () =>
    prisma.loyaltyConfig.findUnique({ where: { venueId }, select: { active: true, stampsEnabled: true, redemptionRate: true } }),
  )

  // 🔴 De esto depende que el boton "Guardar mi tarjeta" aparezca en el widget. Se
  // consulta la configuracion ANTES del avance: si el negocio no usa sellos, leer una
  // cartilla que no existe es una consulta por cada apertura del portal, en TODOS los
  // venues — y la mayoria no usa sellos.
  const stampCard = await (async () => {
    const apagada = { enabled: false as const, stampsEarned: 0, stampsRequired: 0, rewardLabel: '' }
    try {
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

  // S13 (P2-6): «Mi cuenta». Cada sección es opcional: lo apagado sale `null`, y una sección que no se pudo leer también (con su `warn`)
  // sin dejar a la clienta sin el resto. Un 401 (la sesión cambió bajo el candado, R1) nunca se esconde. Secuenciales a propósito:
  // cada sección ocupa a lo más dos conexiones del pool a la vez (su página y su total).
  const ahora = new Date()
  const puntos = config?.active
    ? {
        saldo: customer.loyaltyPoints,
        valor: new Prisma.Decimal(customer.loyaltyPoints).mul(config.redemptionRate).toDecimalPlaces(2).toNumber(),
      }
    : null
  const premio =
    config?.active && config.stampsEnabled
      ? await seccion('premio', venueId, () =>
          prisma.stampReward.findFirst({
            where: {
              venueId,
              customerId: customer.id,
              status: StampRewardStatus.PENDING,
              OR: [{ expiresAt: null }, { expiresAt: { gt: ahora } }],
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, rewardLabel: true },
          }),
        )
      : null
  const descuentos = await seccion('descuentos', venueId, () => listarMisDescuentos(venueId, customer.id, {}))
  const zona = (await seccion('zona del negocio', venueId, () => zonaDelNegocio(venueId))) ?? DEFAULT_TIMEZONE
  const saldoAFavor = await seccion('saldo a favor', venueId, () => miSaldoAFavor(venueId, customer.id, zona, ahora))
  const tarjetas = await seccion('tarjetas', venueId, () => listarMisTarjetas(venueId, customer.id, auth ?? { contactos: [] }, {}, zona))
  const pedidos = await seccion('pedidos', venueId, () => listarMisPedidos(venueId, customer.id, {}))

  return {
    customer,
    credits: { purchases },
    reservations: {
      upcoming: upcomingReservations,
      past: pastReservations,
    },
    stampCard,
    invitadaRequiereEntrar,
    puntos,
    premioDisponible: premio ? { id: premio.id, etiqueta: premio.rewardLabel } : null,
    descuentos,
    saldoAFavor,
    tarjetas,
    pedidos,
    // R7': el aviso firmado que S7 puso en la sesión al entrar; los tokens anteriores no lo traen.
    otraFicha: auth?.otraFicha ?? null,
  }
}

// ---- S13 (P2-6): «Mi cuenta», sus listas y su paginación ----

/** Lo que el portal necesita de la sesión. Los tokens de hoy (reservas, pedidos) también llegan aquí. */
export type SesionDelPortal = Pick<CustomerAuthContext, 'contactos'> &
  Partial<Pick<CustomerAuthContext, 'tipo' | 'v' | 'verifiedPhone' | 'otraFicha'>>

/** Una sección de «Mi cuenta» que falla sale `null` (con su `warn`); un 401 sube: la sesión ya no vale. */
async function seccion<T>(nombre: string, venueId: string, leer: () => Promise<T>): Promise<T | null> {
  try {
    return await leer()
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 401) throw error
    logger.warn(`[MiCuenta] no se pudo leer la sección «${nombre}»`, {
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/** ¿La sesión probó un contacto? (sesión con contactos, o el token de pedidos de hoy con su teléfono; nunca el de reservas de hoy). */
function proboContacto(auth: SesionDelPortal): boolean {
  if (auth.tipo === 'RESERVAS_DE_HOY') return false
  return auth.contactos.length > 0 || (auth.tipo === 'PEDIDOS_DE_HOY' && !!auth.verifiedPhone)
}

async function zonaDelNegocio(venueId: string): Promise<string> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  return venue?.timezone || DEFAULT_TIMEZONE
}

export interface PaginaDeMiCuenta<T> {
  items: T[]
  total: number
  nextCursor: string | null
}
export interface PedirPagina {
  cursor?: string
  limit?: number
}
type Despues = { createdAt: Date; id: string } | null

const PAGINA_POR_OMISION = 20
const PAGINA_TOPE = 50

/** El SERVIDOR impone el tamaño: 1 a 50, 20 por omisión. Un límite hostil se recorta, nunca falla. */
export function tamanoDePagina(limit?: number): number {
  const n = Math.trunc(Number(limit))
  if (limit === undefined || !Number.isFinite(n)) return PAGINA_POR_OMISION
  return Math.min(Math.max(n, 1), PAGINA_TOPE)
}

/** El cursor es el de la etapa 1 («<createdAt ISO>_<id>», `ACTIVE_CURSOR_PATTERN`); mal formado ⇒ 400 en español. */
const leerCursor = (cursor?: string): Despues => (cursor ? fromActiveCursor(cursor) : null)

/** Orden `(createdAt DESC, id DESC)`: la página sigue DESPUÉS de la última fila de la anterior. */
const despuesDe = (d: Despues): Prisma.Sql => (d ? Prisma.sql`AND (t."createdAt", t.id) < (${utcTs(d.createdAt)}, ${d.id})` : Prisma.empty)

function cortar<F extends { createdAt: Date; id: string }>(filas: F[], tamano: number): { pagina: F[]; nextCursor: string | null } {
  const pagina = filas.slice(0, tamano)
  return { pagina, nextCursor: filas.length > tamano ? toActiveCursor(pagina[pagina.length - 1]) : null }
}

const pesos = (d: Prisma.Decimal | number | string) => new Prisma.Decimal(d).toDecimalPlaces(2).toNumber()

// pedidos

/**
 * Sus pedidos en línea. El cursor lo aporta `OnlineOrder` (`createdAt`, `id`). Manda la `Order` de la clienta: el `MATERIALIZED` y el
 * `LATERAL … LIMIT 1` obligan a partir de `Order(customerId)` y a buscar su `OnlineOrder` por `orderId` (único), así nunca se recorren
 * filas de otras clientas (R5', medido en `miCuenta.integration.test.ts`).
 * ponytail: recorre el historial de UNA clienta en cada página (10,000 pedidos medidos); si alguien pasa de ahí, índice
 * `Order(venueId, customerId, createdAt)` con CONCURRENTLY.
 */
export function sqlDePedidos(venueId: string, customerId: string, d: Despues, tamano: number): Prisma.Sql {
  return Prisma.sql`
    WITH suyas AS MATERIALIZED (
      SELECT o.id, o."orderNumber", o.total, o."paymentStatus"::text AS "paymentStatus"
      FROM "Order" o
      WHERE o."customerId" = ${customerId} AND o."venueId" = ${venueId}
    )
    SELECT t.id, t."createdAt", t.status, t."trackingToken", s."orderNumber", s.total, s."paymentStatus"
    FROM suyas s
    CROSS JOIN LATERAL (
      SELECT oo.id, oo."createdAt", oo.status::text AS status, oo."trackingToken"
      FROM "OnlineOrder" oo
      WHERE oo."orderId" = s.id AND oo."venueId" = ${venueId}
      LIMIT 1
    ) t
    WHERE TRUE ${despuesDe(d)}
    ORDER BY t."createdAt" DESC, t.id DESC
    LIMIT ${tamano + 1}`
}

export function sqlDeTotalDePedidos(venueId: string, customerId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS total
    FROM "Order" o
    CROSS JOIN LATERAL (
      SELECT 1 FROM "OnlineOrder" oo WHERE oo."orderId" = o.id AND oo."venueId" = ${venueId} LIMIT 1
    ) t
    WHERE o."customerId" = ${customerId} AND o."venueId" = ${venueId}`
}

export interface MiPedido {
  folio: string
  estado: string
  pagado: boolean
  total: number
  trackingToken: string
  creadoEl: string
}

/** GET /venues/:venueSlug/customer/orders?cursor=&limit= — y la primera página del portal. */
export async function listarMisPedidos(venueId: string, customerId: string, pedir: PedirPagina): Promise<PaginaDeMiCuenta<MiPedido>> {
  const tamano = tamanoDePagina(pedir.limit)
  const d = leerCursor(pedir.cursor)
  const [filas, [cuenta]] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        id: string
        createdAt: Date
        status: string
        trackingToken: string
        orderNumber: string
        total: Prisma.Decimal
        paymentStatus: string
      }>
    >(sqlDePedidos(venueId, customerId, d, tamano)),
    prisma.$queryRaw<Array<{ total: number }>>(sqlDeTotalDePedidos(venueId, customerId)),
  ])
  const { pagina, nextCursor } = cortar(filas, tamano)
  return {
    items: pagina.map(f => ({
      folio: f.orderNumber,
      estado: f.status,
      pagado: esVentaCerrada(f.paymentStatus),
      total: pesos(f.total),
      trackingToken: f.trackingToken,
      creadoEl: f.createdAt.toISOString(),
    })),
    total: cuenta?.total ?? 0,
    nextCursor,
  }
}

// tarjetas y saldo a favor

export type EstadoDeTarjeta = 'ACTIVA' | 'BLOQUEADA' | 'DESACTIVADA' | 'VENCIDA'

/** R6: el estado que ve la clienta; sólo ACTIVA está disponible (el saldo de las demás se muestra, pero no como utilizable). */
function estadoDe(t: { status: string; expiresAt: Date | null }, ahora: Date): EstadoDeTarjeta {
  if (t.status !== 'ACTIVE' && t.status !== 'BLOCKED') return 'DESACTIVADA'
  if (t.expiresAt && t.expiresAt.getTime() <= ahora.getTime()) return 'VENCIDA'
  return t.status === 'BLOCKED' ? 'BLOQUEADA' : 'ACTIVA'
}

/**
 * Las tarjetas que ELLA guardó: con su `customerId` y que NO son saldo a favor (EL predicado, `esSobreDeSaldoAFavorSql`). El predicado
 * va dentro de un `(SELECT …)` escalar a propósito: así Postgres lo evalúa por cada tarjeta suya con el índice `[giftCardId, createdAt]`
 * de la libreta, en vez de convertirlo en un anti-join que recorra la libreta de todo el negocio (R5').
 */
const susTarjetas = (venueId: string, customerId: string) =>
  Prisma.sql`g."venueId" = ${venueId} AND g."customerId" = ${customerId} AND NOT (SELECT ${esSobreDeSaldoAFavorSql('g')})`

/**
 * El cursor lo aporta `GiftCard` (`createdAt`, `id`), desde el índice `(venueId, customerId)`.
 * ponytail: ordena las tarjetas de UNA clienta (500 medidas); si alguien junta miles, índice `(venueId, customerId, createdAt)`.
 */
export function sqlDeTarjetas(venueId: string, customerId: string, d: Despues, tamano: number): Prisma.Sql {
  return Prisma.sql`
    SELECT t.id, t."createdAt", t."codeLast4", t."codeEnc", t.balance, t.status, t."expiresAt"
    FROM (
      SELECT g.id, g."createdAt", g."codeLast4", g."codeEnc", g.balance, g.status::text AS status, g."expiresAt"
      FROM "GiftCard" g
      WHERE ${susTarjetas(venueId, customerId)}
    ) t
    WHERE TRUE ${despuesDe(d)}
    ORDER BY t."createdAt" DESC, t.id DESC
    LIMIT ${tamano + 1}`
}

export function sqlDeTotalDeTarjetas(venueId: string, customerId: string): Prisma.Sql {
  return Prisma.sql`SELECT count(*)::int AS total FROM "GiftCard" g WHERE ${susTarjetas(venueId, customerId)}`
}

export interface MiTarjeta {
  id: string
  last4: string
  saldo: number
  venceEl: string | null
  /** Sólo con una sesión que probó un contacto, revalidada bajo el candado de la ficha (R1), y sólo de una tarjeta ACTIVA. */
  codigo: string | null
  estado: EstadoDeTarjeta
  disponible: boolean
}

type FilaDeTarjeta = {
  id: string
  createdAt: Date
  codeLast4: string
  codeEnc: string
  balance: Prisma.Decimal
  status: string
  expiresAt: Date | null
}

/**
 * GET /venues/:venueSlug/customer/gift-cards?cursor=&limit= — y la primera página del portal. Con contacto probado, la página se lee
 * DENTRO de una transacción corta que toma la ficha `FOR SHARE` y revalida la sesión (R1/R1'); el código se descifra después del commit.
 */
export async function listarMisTarjetas(
  venueId: string,
  customerId: string,
  auth: SesionDelPortal,
  pedir: PedirPagina,
  zona?: string,
): Promise<PaginaDeMiCuenta<MiTarjeta>> {
  const tamano = tamanoDePagina(pedir.limit)
  const d = leerCursor(pedir.cursor)
  const revela = proboContacto(auth)
  const zonaDeVencer = zona ?? (await zonaDelNegocio(venueId))
  const leidas = revela
    ? await withDeadlockRetry(
        async tx => {
          await revalidarSesionEnTx(tx, venueId, { ...auth, customerId })
          const filas = await tx.$queryRaw<FilaDeTarjeta[]>(sqlDeTarjetas(venueId, customerId, d, tamano))
          const [cuenta] = await tx.$queryRaw<Array<{ total: number }>>(sqlDeTotalDeTarjetas(venueId, customerId))
          return { filas, total: cuenta?.total ?? 0 }
        },
        { etiqueta: 'listarMisTarjetas' },
      )
    : await Promise.all([
        prisma.$queryRaw<FilaDeTarjeta[]>(sqlDeTarjetas(venueId, customerId, d, tamano)),
        prisma.$queryRaw<Array<{ total: number }>>(sqlDeTotalDeTarjetas(venueId, customerId)),
      ]).then(([filas, [cuenta]]) => ({ filas, total: cuenta?.total ?? 0 }))
  const ahora = new Date()
  const { pagina, nextCursor } = cortar(leidas.filas, tamano)
  return {
    items: pagina.map(f => {
      const estado = estadoDe(f, ahora)
      return {
        id: f.id,
        last4: f.codeLast4,
        saldo: pesos(f.balance),
        venceEl: f.expiresAt ? formatInTimeZone(f.expiresAt, zonaDeVencer, 'yyyy-MM-dd') : null,
        codigo: revela && estado === 'ACTIVA' ? formatGiftCardCode(decryptGiftCardCode(f.codeEnc)) : null,
        estado,
        disponible: estado === 'ACTIVA',
      }
    }),
    total: leidas.total,
    nextCursor,
  }
}

export interface MiSaldoAFavor {
  last4: string
  saldo: number
  /** Siempre `null`: el saldo a favor se gasta con el teléfono de la clienta y su código nunca se enseña (S8a, `giftCardCuenta.service.ts`). */
  codigo: null
  venceEl: string | null
  estado: EstadoDeTarjeta
  disponible: boolean
}

/** Su sobre vivo, UNO, el que elige `prepararSobreDeSaldoAFavorEnTx` (`giftCardLedger.ts`): ACTIVE o BLOCKED, el más viejo. */
async function miSaldoAFavor(venueId: string, customerId: string, zona: string, ahora: Date): Promise<MiSaldoAFavor | null> {
  const [s] = await prisma.$queryRaw<Array<{ codeLast4: string; balance: Prisma.Decimal; status: string; expiresAt: Date | null }>>`
    SELECT g."codeLast4", g.balance, g.status::text AS status, g."expiresAt"
    FROM "GiftCard" g
    WHERE g."venueId" = ${venueId} AND g."customerId" = ${customerId} AND g.status IN ('ACTIVE', 'BLOCKED')
      AND ${esSobreDeSaldoAFavorSql('g')}
    ORDER BY g."createdAt" ASC, g.id ASC
    LIMIT 1`
  if (!s) return null
  const estado = estadoDe(s, ahora)
  return {
    last4: s.codeLast4,
    saldo: pesos(s.balance),
    codigo: null,
    venceEl: s.expiresAt ? formatInTimeZone(s.expiresAt, zona, 'yyyy-MM-dd') : null,
    estado,
    disponible: estado === 'ACTIVA',
  }
}

// descuentos

const vigenteAhora = (alias: 'cd' | 'd', ahora: Date) =>
  Prisma.sql`(${Prisma.raw(alias)}."validFrom" IS NULL OR ${Prisma.raw(alias)}."validFrom" <= ${utcTs(ahora)})
    AND (${Prisma.raw(alias)}."validUntil" IS NULL OR ${Prisma.raw(alias)}."validUntil" >= ${utcTs(ahora)})`

/** Cuántas veces usó ELLA el descuento `d` (de la tabla `usos` de su historial; 0 si nunca). */
const susUsos = Prisma.sql`COALESCE((SELECT u.n FROM usos u WHERE u."discountId" = d.id), 0)`

/**
 * R3/R4: los descuentos que le tocan, en UNA consulta: los asignados (`CustomerDiscount`) y los de su grupo, vigentes HOY por la
 * INTERSECCIÓN de las fechas de la asignación y del catálogo (`vigenteHasta` = la menor; `LEAST` ignora los nulos), activos y no
 * agotados. Un descuento que llega por los dos caminos sale una vez, con la vigencia más larga. No mira el horario del día (un happy
 * hour asignado es suyo aunque hoy no sea su hora). El cursor lo aporta `Discount` (`createdAt`, `id`).
 *  - Agotado por clienta (codex-s13-r2 #2): la asignación con `maxUses` usa su propio contador (es el override del esquema); sin él,
 *    hereda `Discount.maxUsesPerCustomer`, igual que el de su grupo.
 *  - Sus usos (`usos`) se cuentan UNA vez y desde SUS órdenes (`Order(customerId)` → `OrderDiscount(orderId)`; el `OFFSET 0` impide
 *    que Postgres lo cambie por un recorrido de las aplicaciones del descuento, que son de todas las clientas). Es `MATERIALIZED` y
 *    sólo se lee dentro del `CASE`: si ningún candidato tiene límite por clienta, no se calcula (R5', medido en
 *    `miCuenta.integration.test.ts`).
 *    ponytail: recorre el historial de UNA clienta (10,000 órdenes medidas); si alguien pasa de ahí, índice
 *    `Order(venueId, customerId)` o un contador por (clienta, descuento).
 */
function cteDeDescuentos(venueId: string, customerId: string, ahora: Date): Prisma.Sql {
  return Prisma.sql`
    WITH usos AS MATERIALIZED (
      SELECT x."discountId", count(*)::int AS n
      FROM "Order" o
      CROSS JOIN LATERAL (
        SELECT od."discountId" FROM "OrderDiscount" od WHERE od."orderId" = o.id AND od."discountId" IS NOT NULL OFFSET 0
      ) x
      WHERE o."customerId" = ${customerId} AND o."venueId" = ${venueId}
      GROUP BY x."discountId"
    ),
    candidatos AS (
      SELECT d.id, d.name, d.type::text AS type, d.value, d."createdAt", LEAST(cd."validUntil", d."validUntil") AS hasta
      FROM "CustomerDiscount" cd
      JOIN "Discount" d ON d.id = cd."discountId"
      WHERE cd."customerId" = ${customerId} AND cd.active AND d."venueId" = ${venueId} AND d.active
        AND ${vigenteAhora('cd', ahora)} AND ${vigenteAhora('d', ahora)}
        AND (d."maxTotalUses" IS NULL OR d."currentUses" < d."maxTotalUses")
        AND CASE
          WHEN cd."maxUses" IS NOT NULL THEN cd."usageCount" < cd."maxUses"
          WHEN d."maxUsesPerCustomer" IS NOT NULL THEN ${susUsos} < d."maxUsesPerCustomer"
          ELSE TRUE
        END
      UNION ALL
      SELECT d.id, d.name, d.type::text AS type, d.value, d."createdAt", d."validUntil" AS hasta
      FROM "Customer" c
      JOIN "Discount" d ON d."customerGroupId" = c."customerGroupId" AND d."venueId" = c."venueId"
      WHERE c.id = ${customerId} AND c."venueId" = ${venueId} AND d.active
        AND ${vigenteAhora('d', ahora)}
        AND (d."maxTotalUses" IS NULL OR d."currentUses" < d."maxTotalUses")
        AND CASE WHEN d."maxUsesPerCustomer" IS NOT NULL THEN ${susUsos} < d."maxUsesPerCustomer" ELSE TRUE END
    ),
    uno AS (
      SELECT DISTINCT ON (id) id, name, type, value, "createdAt", hasta
      FROM candidatos
      ORDER BY id, hasta DESC NULLS FIRST
    )`
}

export function sqlDeDescuentos(venueId: string, customerId: string, ahora: Date, d: Despues, tamano: number): Prisma.Sql {
  return Prisma.sql`${cteDeDescuentos(venueId, customerId, ahora)}
    SELECT t.id, t.name, t.type, t.value, t."createdAt", t.hasta
    FROM uno t
    WHERE TRUE ${despuesDe(d)}
    ORDER BY t."createdAt" DESC, t.id DESC
    LIMIT ${tamano + 1}`
}

export function sqlDeTotalDeDescuentos(venueId: string, customerId: string, ahora: Date): Prisma.Sql {
  return Prisma.sql`${cteDeDescuentos(venueId, customerId, ahora)} SELECT count(*)::int AS total FROM uno`
}

export interface MiDescuento {
  nombre: string
  tipo: string
  valor: number
  vigenteHasta: string | null
}

/** GET /venues/:venueSlug/customer/discounts?cursor=&limit= — y la primera página del portal (R4). */
export async function listarMisDescuentos(venueId: string, customerId: string, pedir: PedirPagina): Promise<PaginaDeMiCuenta<MiDescuento>> {
  const tamano = tamanoDePagina(pedir.limit)
  const d = leerCursor(pedir.cursor)
  const ahora = new Date()
  const [filas, [cuenta]] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; name: string; type: string; value: Prisma.Decimal; createdAt: Date; hasta: Date | null }>>(
      sqlDeDescuentos(venueId, customerId, ahora, d, tamano),
    ),
    prisma.$queryRaw<Array<{ total: number }>>(sqlDeTotalDeDescuentos(venueId, customerId, ahora)),
  ])
  const { pagina, nextCursor } = cortar(filas, tamano)
  return {
    items: pagina.map(f => ({
      nombre: f.name,
      tipo: f.type,
      valor: new Prisma.Decimal(f.value).toNumber(),
      vigenteHasta: f.hasta ? f.hasta.toISOString() : null,
    })),
    total: cuenta?.total ?? 0,
    nextCursor,
  }
}

// ---- S8 (P2-1): cambiar de número ----

const RETO_DE_CAMBIO = 'CUSTOMER_PHONE_CHANGE' as const

/**
 * Cambiar de número pide una sesión que ya probó un contacto, o el token de pedidos de hoy (firma el teléfono). El token de reservas de
 * hoy ya lo frena S6; una sesión sin contactos (contraseña) se frena aquí (R1): la contraseña prueba la ficha, no un contacto.
 */
function exigirContactoProbado(auth: CustomerAuthContext): void {
  if (!proboContacto(auth)) {
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
  // D17: si WhatsApp no lo aceptó, 503 `OTP_SEND_FAILED` (nunca «te lo enviamos»).
  return requestOtp({ venueId, channel: 'whatsapp', destination: nuevo, ip }, RETO_DE_CAMBIO)
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
