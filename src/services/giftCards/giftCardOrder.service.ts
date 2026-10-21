// src/services/giftCards/giftCardOrder.service.ts
/**
 * Vender tarjetas de regalo en su PROPIA cuenta (spec 2026-10-14 § 5.1, R11 y R12). Cada sobre nace PENDING, en $0, con
 * la política congelada; se activa cuando la cuenta queda pagada (`activarSobresDeCuentaPagadaEnTx`, A6). El reintento
 * del POS deduplica por `Order[venueId, externalId]` con `externalId = 'giftcard:' + idempotencyKey` y huella del pedido.
 * Sin red NO se vende (online-only a propósito): el POS lo dice antes de llamar aquí.
 */
import { Prisma, type GiftCardDeliveryChannel, type GiftCardStatus, type OrderSource, type OrderStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { operationHash } from '@/utils/operationHash'
import { validateStaffVenue } from '@/utils/staff-venue.util'
import { assertVenueSalesEnabled } from '@/services/venueSalesGuard'
import { turnoAbiertoDelNegocio } from '@/services/shared/turnoDeCaja'
import {
  decryptGiftCardCode,
  encryptGiftCardCode,
  formatGiftCardCode,
  generateGiftCardCode,
  generateOpaqueToken,
  hashGiftCardCode,
} from './giftCardCode'
import { telefonoDeTarjeta, urlDeLaPagina } from './giftCardEntrega'
import { GiftCardError } from './giftCardErrors'
import { MAX_SOBRES_POR_CUENTA, assertMontoDeSobre, assertTopeDeOperacion } from './giftCardLimits'
import { assertGiftCardsSellable, getGiftCardSettings } from './giftCardSettings.service'

export { esCuentaDeTarjetas, rechazarSiEsCuentaDeTarjetas } from './cuentaDeTarjetas'

const LLAVE = /^[A-Za-z0-9_-]{8,64}$/
const CANALES_FASE_1A = new Set<string>(['WHATSAPP', 'EMAIL', 'PRINTED', 'HANDED_TO_BUYER'])
/**
 * C1 (cierre): NUNCA `POS`. `source = POS` + `externalId` es la marca de una cuenta integrada de SoftRestaurant
 * (`cierreDelCobroSaldaLaCuenta`): cobrada en la terminal, su cierre —y con él la activación de los sobres— sería de SoftRestaurant.
 */
const FUENTES = new Set<string>(['AVOQADO_ANDROID', 'AVOQADO_IOS', 'TPV'])
/** Sin `source` (o con uno que ya no se acepta), la fuente autónoma de los otros creadores de cuentas propias del POS (vales). */
const FUENTE_POR_OMISION = 'AVOQADO_ANDROID'
const TELEFONO = /^\+?\d{10,15}$/
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const LINEA = 'Tarjeta de regalo'
/** S-6 y C5: WhatsApp y correo dicen de parte de quién va la tarjeta. Sólo se exige en una venta NUEVA (C3/Q44). */
export const TEXTO_FALTA_DE_PARTE_DE = 'Para mandarla por WhatsApp o correo falta «De parte de».'

export interface CreateGiftCardOrderInput {
  /** UUID que el POS genera UNA vez por venta y reenvía en cada reintento (8–64 caracteres). */
  idempotencyKey: string
  source?: 'AVOQADO_ANDROID' | 'AVOQADO_IOS' | 'TPV'
  purchaserName?: string | null
  purchaserContact?: string | null
  sobres: Array<{
    /** Pesos, con centavos exactos. */
    amount: number
    deliveryChannel: GiftCardDeliveryChannel
    recipientName?: string | null
    recipientPhone?: string | null
    recipientEmail?: string | null
    message?: string | null
  }>
}

export interface CreateGiftCardOrderResult {
  orderId: string
  orderNumber: string
  /** Pesos. */
  total: number
  replay: boolean
  /**
   * A5 r1: estado de la CUENTA al responder (`CONFIRMED` al crearla). Un reintento después de cancelarla responde
   * `CANCELLED` y cada sobre `DEACTIVATED`: el POS no debe entregar esos códigos. Opcional por compatibilidad.
   */
  status?: OrderStatus
  sobres: Array<{
    id: string
    /** `XXXX-XXXX-XXXX-XXXX-X`: sólo a quien vende (permiso `giftCards:sell`), para el QR o el certificado. */
    codigo: string
    ultimos4: string
    monto: number
    pageToken: string
    /** 1b Q22 (aditivo): la liga pública de la tarjeta, armada por el servidor. */
    pageUrl: string
    deliveryChannel: GiftCardDeliveryChannel
    venceEnMeses: number | null
    termsVersion: string
    /** A5 r1: estado del sobre al responder (`PENDING` hasta que la cuenta se paga). */
    status?: GiftCardStatus
  }>
}

const SELECT_CUENTA = {
  id: true,
  orderNumber: true,
  total: true,
  status: true,
  items: {
    where: { giftCardId: { not: null } },
    orderBy: { sequence: 'asc' },
    take: MAX_SOBRES_POR_CUENTA,
    select: {
      giftCard: {
        select: {
          id: true,
          status: true,
          codeEnc: true,
          codeLast4: true,
          initialAmount: true,
          pageToken: true,
          deliveryChannel: true,
          validityMonths: true,
          termsVersion: true,
          recipientName: true,
          recipientPhone: true,
          recipientEmail: true,
          message: true,
          purchaserName: true,
          purchaserContact: true,
          ventaHuella: true,
        },
      },
    },
  },
} satisfies Prisma.OrderSelect

type CuentaGuardada = Prisma.OrderGetPayload<{ select: typeof SELECT_CUENTA }>
type SobreGuardado = NonNullable<CuentaGuardada['items'][number]['giftCard']>

interface SobrePedido {
  monto: Prisma.Decimal
  deliveryChannel: GiftCardDeliveryChannel
  recipientName: string | null
  recipientPhone: string | null
  recipientEmail: string | null
  message: string | null
}

function texto(valor: string | null | undefined, maximo: number, campo: string): string | null {
  const t = typeof valor === 'string' ? valor.trim() : ''
  if (t.length > maximo) throw new BadRequestError(`${campo} pasa de ${maximo} caracteres.`)
  return t.length > 0 ? t : null
}

function normalizarPedido(input: CreateGiftCardOrderInput): {
  sobres: SobrePedido[]
  purchaserName: string | null
  purchaserContact: string | null
} {
  const sobres = Array.isArray(input.sobres) ? input.sobres : []
  if (sobres.length === 0) throw new BadRequestError('Agrega al menos una tarjeta de regalo.')
  if (sobres.length > MAX_SOBRES_POR_CUENTA) {
    throw new BadRequestError(`Una venta lleva como máximo ${MAX_SOBRES_POR_CUENTA} tarjetas de regalo.`)
  }
  const normalizados = sobres.map((s, i): SobrePedido => {
    const n = i + 1
    if (typeof s.amount !== 'number' || !Number.isFinite(s.amount))
      throw new BadRequestError(`El monto de la tarjeta ${n} debe ser un número en pesos.`)
    if (s.deliveryChannel === 'CUSTOMER_CARD') {
      throw new BadRequestError('Cargar una tarjeta de regalo a la tarjeta del cliente llega en una siguiente versión.')
    }
    if (!CANALES_FASE_1A.has(s.deliveryChannel)) {
      throw new BadRequestError(`Elige cómo se entrega la tarjeta ${n}: WhatsApp, correo, impresa o en manos del comprador.`)
    }
    const telefonoEscrito = texto(s.recipientPhone, 30, `El teléfono de la tarjeta ${n}`)?.replace(/[\s().-]/g, '') ?? null
    // Q25: se guarda canónico (así se compara en phone/*). NUNCA lanza aquí: lo usa también el reintento de una venta de la 1a.
    const recipientPhone = telefonoEscrito && (telefonoDeTarjeta(telefonoEscrito) ?? telefonoEscrito)
    const recipientEmail = texto(s.recipientEmail, 160, `El correo de la tarjeta ${n}`)?.toLowerCase() ?? null
    // La regex de la 1a se aplica a lo ESCRITO, no al convertido: un «00…» de la 1a puede quedar con menos de 10 dígitos (Q44).
    if (s.deliveryChannel === 'WHATSAPP' && (!telefonoEscrito || !TELEFONO.test(telefonoEscrito))) {
      throw new BadRequestError(`La tarjeta ${n} se entrega por WhatsApp: captura un teléfono de 10 dígitos.`)
    }
    if (s.deliveryChannel === 'EMAIL' && (!recipientEmail || !CORREO.test(recipientEmail))) {
      throw new BadRequestError(`La tarjeta ${n} se entrega por correo: captura un correo válido.`)
    }
    if (telefonoEscrito && !TELEFONO.test(telefonoEscrito)) throw new BadRequestError(`El teléfono de la tarjeta ${n} no es válido.`)
    if (recipientEmail && !CORREO.test(recipientEmail)) throw new BadRequestError(`El correo de la tarjeta ${n} no es válido.`)
    return {
      monto: new Prisma.Decimal(s.amount),
      deliveryChannel: s.deliveryChannel,
      recipientName: texto(s.recipientName, 120, `El nombre de quien recibe la tarjeta ${n}`),
      recipientPhone,
      recipientEmail,
      message: texto(s.message, 200, `El mensaje de la tarjeta ${n}`),
    }
  })
  return {
    sobres: normalizados,
    purchaserName: texto(input.purchaserName, 120, 'El nombre del comprador'),
    purchaserContact: texto(input.purchaserContact, 160, 'El contacto del comprador'),
  }
}

function huella(p: {
  purchaserName: string | null
  purchaserContact: string | null
  sobres: Array<Omit<SobrePedido, 'monto'> & { monto: string }>
}): string {
  return operationHash(p)
}

function huellaDelPedido(p: ReturnType<typeof normalizarPedido>): string {
  return huella({ ...p, sobres: p.sobres.map(s => ({ ...s, monto: s.monto.toFixed(2) })) })
}

/** Sólo para ventas de la 1a (sin `ventaHuella`): el teléfono guardado pasa por la misma forma que el pedido (Q44). */
function huellaDeLaCuenta(c: CuentaGuardada): string {
  const sobres = c.items.map(i => i.giftCard).filter((s): s is SobreGuardado => s != null)
  return huella({
    purchaserName: sobres[0]?.purchaserName ?? null,
    purchaserContact: sobres[0]?.purchaserContact ?? null,
    sobres: sobres.map(s => ({
      monto: s.initialAmount.toFixed(2),
      deliveryChannel: s.deliveryChannel,
      recipientName: s.recipientName,
      recipientPhone: s.recipientPhone && (telefonoDeTarjeta(s.recipientPhone) ?? s.recipientPhone),
      recipientEmail: s.recipientEmail,
      message: s.message,
    })),
  })
}

function respuesta(c: CuentaGuardada, replay: boolean): CreateGiftCardOrderResult {
  const sobres = c.items.map(i => i.giftCard).filter((s): s is SobreGuardado => s != null)
  return {
    orderId: c.id,
    orderNumber: c.orderNumber,
    total: Number(c.total),
    replay,
    status: c.status,
    sobres: sobres.map(s => ({
      id: s.id,
      codigo: formatGiftCardCode(decryptGiftCardCode(s.codeEnc)),
      ultimos4: s.codeLast4,
      monto: Number(s.initialAmount),
      pageToken: s.pageToken,
      pageUrl: urlDeLaPagina(s.pageToken),
      deliveryChannel: s.deliveryChannel,
      venceEnMeses: s.validityMonths,
      termsVersion: s.termsVersion,
      status: s.status,
    })),
  }
}

/**
 * Q37: se compara contra la huella con que se CREÓ la venta (la de la primera tarjeta), no contra los datos de hoy, que
 * cambiar el destino (S4) edita. Una venta de la 1a no la tiene: se recalcula de lo guardado.
 */
function reintentoOConflicto(cuenta: CuentaGuardada, huellaPedida: string): CreateGiftCardOrderResult {
  const guardada = cuenta.items[0]?.giftCard?.ventaHuella ?? huellaDeLaCuenta(cuenta)
  if (guardada !== huellaPedida) {
    throw new GiftCardError(
      'IDEMPOTENCY_KEY_REUSED',
      'Esta llave ya creó otra venta de tarjetas con datos distintos. Genera una llave nueva para esta venta.',
      409,
    )
  }
  return respuesta(cuenta, true)
}

export async function createGiftCardOrder(
  venueId: string,
  staffId: string,
  input: CreateGiftCardOrderInput,
): Promise<CreateGiftCardOrderResult> {
  if (!LLAVE.test(input?.idempotencyKey ?? '')) {
    throw new BadRequestError('idempotencyKey debe tener de 8 a 64 caracteres (letras, números, guion o guion bajo).')
  }
  const externalId = `giftcard:${input.idempotencyKey}`
  const pedido = normalizarPedido(input)
  const huellaPedida = huellaDelPedido(pedido)

  // El reintento primero: si el plan venció entre el intento y el reintento, el POS recibe la cuenta que YA existe.
  const previa = await prisma.order.findUnique({ where: { venueId_externalId: { venueId, externalId } }, select: SELECT_CUENTA })
  if (previa) return reintentoOConflicto(previa, huellaPedida)

  // Sólo la venta NUEVA (C3/Q44): un reintento de la 1a nunca recibe estos 400.
  if (!pedido.purchaserName && pedido.sobres.some(s => s.deliveryChannel === 'WHATSAPP' || s.deliveryChannel === 'EMAIL')) {
    throw new BadRequestError(TEXTO_FALTA_DE_PARTE_DE, 'GIFT_CARD_PURCHASER_REQUIRED')
  }
  pedido.sobres.forEach((s, i) => {
    if (s.recipientPhone && telefonoDeTarjeta(s.recipientPhone) === null) {
      throw new BadRequestError(`El teléfono de la tarjeta ${i + 1} no es válido.`, 'GIFT_CARD_PHONE_INVALID')
    }
  })

  await assertGiftCardsSellable(venueId)
  await assertVenueSalesEnabled(venueId)
  const staff = await validateStaffVenue(staffId, venueId)
  const ajustes = await getGiftCardSettings(venueId)
  const limites = { minAmount: new Prisma.Decimal(ajustes.minAmount), maxAmount: new Prisma.Decimal(ajustes.maxAmount) }
  for (const s of pedido.sobres) assertMontoDeSobre(s.monto, limites)
  const total = pedido.sobres.reduce((suma, s) => suma.plus(s.monto), new Prisma.Decimal(0))
  assertTopeDeOperacion(total, new Date())

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
  if (!venue) throw new NotFoundError('Negocio no encontrado')
  const codigos = pedido.sobres.map(() => {
    const c = generateGiftCardCode()
    return { ...c, hash: hashGiftCardCode(c.normalized), enc: encryptGiftCardCode(c.normalized), pageToken: generateOpaqueToken() }
  })
  const fuente = (input.source && FUENTES.has(input.source) ? input.source : FUENTE_POR_OMISION) as OrderSource

  try {
    const cuenta = await prisma.$transaction(
      async tx => {
        const turno = await turnoAbiertoDelNegocio(tx, venueId)
        const ids: string[] = []
        for (let i = 0; i < pedido.sobres.length; i++) {
          const s = pedido.sobres[i]
          const c = codigos[i]
          const creado = await tx.giftCard.create({
            data: {
              venueId,
              organizationId: venue.organizationId,
              codeHash: c.hash,
              codeEnc: c.enc,
              codeLast4: c.last4,
              pageToken: c.pageToken,
              initialAmount: s.monto,
              balance: new Prisma.Decimal(0),
              status: 'PENDING',
              validityMonths: ajustes.validityMonths,
              termsVersion: ajustes.termsVersion,
              purchaserName: pedido.purchaserName,
              purchaserContact: pedido.purchaserContact,
              recipientName: s.recipientName,
              recipientPhone: s.recipientPhone,
              recipientEmail: s.recipientEmail,
              message: s.message,
              deliveryChannel: s.deliveryChannel,
              deliveryStatus: 'PENDING',
              source: 'POS',
              ventaHuella: huellaPedida,
            },
            select: { id: true },
          })
          ids.push(creado.id)
        }
        return tx.order.create({
          data: {
            venueId,
            shiftId: turno?.id ?? null,
            orderNumber: `ORD-${Date.now()}`,
            externalId,
            type: 'TAKEOUT',
            source: fuente,
            status: 'CONFIRMED',
            paymentStatus: 'PENDING',
            kitchenStatus: 'PENDING',
            contratoDePrecio: 'IVA_INCLUIDO',
            subtotal: total,
            discountAmount: new Prisma.Decimal(0),
            taxAmount: new Prisma.Decimal(0),
            tipAmount: new Prisma.Decimal(0),
            total,
            remainingBalance: total,
            customerName: pedido.purchaserName,
            createdById: staff ?? null,
            servedById: staff ?? null,
            version: 1,
            items: {
              create: pedido.sobres.map((s, i) => ({
                productId: null,
                productName: LINEA,
                quantity: 1,
                unitPrice: s.monto,
                discountAmount: new Prisma.Decimal(0),
                taxAmount: new Prisma.Decimal(0),
                total: s.monto,
                ivaTratamiento: 'NO_OBJETO' as const,
                giftCardId: ids[i],
                sequence: i,
              })),
            },
          },
          select: SELECT_CUENTA,
        })
      },
      { timeout: 15_000, maxWait: 5_000 },
    )
    return respuesta(cuenta, false)
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const ganadora = await prisma.order.findUnique({ where: { venueId_externalId: { venueId, externalId } }, select: SELECT_CUENTA })
      if (ganadora) return reintentoOConflicto(ganadora, huellaPedida)
    }
    throw error
  }
}
