// src/services/giftCards/giftCardOrder.service.ts
/**
 * Vender tarjetas de regalo en su PROPIA cuenta (spec 2026-10-14 § 5.1, R11 y R12). Cada sobre nace PENDING, en $0, con
 * la política congelada; se activa cuando la cuenta queda pagada (`activarSobresDeCuentaPagadaEnTx`, A6). El reintento
 * del POS deduplica por `Order[venueId, externalId]` con `externalId = 'giftcard:' + idempotencyKey` y huella del pedido.
 * Sin red NO se vende (online-only a propósito): el POS lo dice antes de llamar aquí.
 */
import { Prisma, type GiftCardDeliveryChannel, type OrderSource } from '@prisma/client'
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
import { GiftCardError } from './giftCardErrors'
import { MAX_SOBRES_POR_CUENTA, assertMontoDeSobre, assertTopeDeOperacion } from './giftCardLimits'
import { assertGiftCardsSellable, getGiftCardSettings } from './giftCardSettings.service'

export { esCuentaDeTarjetas, rechazarSiEsCuentaDeTarjetas } from './cuentaDeTarjetas'

const LLAVE = /^[A-Za-z0-9_-]{8,64}$/
const CANALES_FASE_1A = new Set<string>(['WHATSAPP', 'EMAIL', 'PRINTED', 'HANDED_TO_BUYER'])
const FUENTES = new Set<string>(['AVOQADO_ANDROID', 'AVOQADO_IOS', 'TPV', 'POS'])
const TELEFONO = /^\+?\d{10,15}$/
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const LINEA = 'Tarjeta de regalo'

export interface CreateGiftCardOrderInput {
  /** UUID que el POS genera UNA vez por venta y reenvía en cada reintento (8–64 caracteres). */
  idempotencyKey: string
  source?: 'AVOQADO_ANDROID' | 'AVOQADO_IOS' | 'TPV' | 'POS'
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
  sobres: Array<{
    id: string
    /** `XXXX-XXXX-XXXX-XXXX-X`: sólo a quien vende (permiso `giftCards:sell`), para el QR o el certificado. */
    codigo: string
    ultimos4: string
    monto: number
    pageToken: string
    deliveryChannel: GiftCardDeliveryChannel
    venceEnMeses: number | null
    termsVersion: string
  }>
}

const SELECT_CUENTA = {
  id: true,
  orderNumber: true,
  total: true,
  items: {
    where: { giftCardId: { not: null } },
    orderBy: { sequence: 'asc' },
    take: MAX_SOBRES_POR_CUENTA,
    select: {
      giftCard: {
        select: {
          id: true,
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
    const recipientPhone = texto(s.recipientPhone, 30, `El teléfono de la tarjeta ${n}`)?.replace(/[\s().-]/g, '') ?? null
    const recipientEmail = texto(s.recipientEmail, 160, `El correo de la tarjeta ${n}`)?.toLowerCase() ?? null
    if (s.deliveryChannel === 'WHATSAPP' && (!recipientPhone || !TELEFONO.test(recipientPhone))) {
      throw new BadRequestError(`La tarjeta ${n} se entrega por WhatsApp: captura un teléfono de 10 dígitos.`)
    }
    if (s.deliveryChannel === 'EMAIL' && (!recipientEmail || !CORREO.test(recipientEmail))) {
      throw new BadRequestError(`La tarjeta ${n} se entrega por correo: captura un correo válido.`)
    }
    if (recipientPhone && !TELEFONO.test(recipientPhone)) throw new BadRequestError(`El teléfono de la tarjeta ${n} no es válido.`)
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

function huellaDeLaCuenta(c: CuentaGuardada): string {
  const sobres = c.items.map(i => i.giftCard).filter((s): s is SobreGuardado => s != null)
  return huella({
    purchaserName: sobres[0]?.purchaserName ?? null,
    purchaserContact: sobres[0]?.purchaserContact ?? null,
    sobres: sobres.map(s => ({
      monto: s.initialAmount.toFixed(2),
      deliveryChannel: s.deliveryChannel,
      recipientName: s.recipientName,
      recipientPhone: s.recipientPhone,
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
    sobres: sobres.map(s => ({
      id: s.id,
      codigo: formatGiftCardCode(decryptGiftCardCode(s.codeEnc)),
      ultimos4: s.codeLast4,
      monto: Number(s.initialAmount),
      pageToken: s.pageToken,
      deliveryChannel: s.deliveryChannel,
      venceEnMeses: s.validityMonths,
      termsVersion: s.termsVersion,
    })),
  }
}

function reintentoOConflicto(cuenta: CuentaGuardada, huellaPedida: string): CreateGiftCardOrderResult {
  if (huellaDeLaCuenta(cuenta) !== huellaPedida) {
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
  const fuente = (input.source && FUENTES.has(input.source) ? input.source : 'POS') as OrderSource

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
