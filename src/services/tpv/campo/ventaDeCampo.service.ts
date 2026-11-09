/**
 * La venta de SIM desde el celular del promotor (App de campo, bloque 0, Tarea 4).
 *
 * No es un escritor nuevo: orquesta los MISMOS servicios que la PAX (`sellSerializedItem` → `recordOrderPayment` → SIM
 * vendida → evidencia pendiente), así que la venta deja exactamente lo que deja una de la terminal. La ficha
 * `VentaDeCampo` (una por llave) recuerda en qué paso va: el reintento con la misma llave reanuda ahí y nunca duplica.
 *
 * Quién trabaja la ficha: cada petición que la toma le pone su `ocupacion` (cuid) por 60 s, y TODA escritura posterior va
 * condicionada a esa ocupación. Si da 0 filas, esa petición perdió la ficha: deja de escribir y responde VENTA_EN_PROCESO.
 * Se valida contra lo de HOY al subir (founder, 8-nov). Plan: docs/superpowers/plans/2026-11-08-app-de-campo-bloque-0-tuberia.md.
 */
import { Prisma, VentaDeCampo } from '@prisma/client'
import cuid from 'cuid'
import logger from '@/config/logger'
import AppError, { BadRequestError, ConflictError, ValidationError } from '@/errors/AppError'
import { SimCustodyError } from '@/lib/sim-custody-error-codes'
import { recordPaymentBodySchema } from '@/schemas/tpv.schema'
import type { VentaDeCampoBody } from '@/schemas/tpv/campo.schema'
import { logAction } from '@/services/dashboard/activity-log.service'
import { cancelarCuentaSinCobrar } from '@/services/dashboard/order.dashboard.service'
import { serializedInventoryService } from '@/services/serialized-inventory/serializedInventory.service'
import { sellSerializedItem } from '@/services/tpv/order.tpv.service'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { createPendingSaleVerification } from '@/services/tpv/sale-verification.service'
import prisma from '@/utils/prismaClient'
import { OrigenHora, resolverHoraDelCelular } from './horaDelCelular'

const VIGENCIA_DE_LA_OCUPACION_MS = 60_000

export interface ResultadoVentaDeCampo {
  orderId: string
  paymentId: string
  saleVerificationId: string
  repetida: boolean
  precio: string
  hora: string
}

/** Lo que una petición sabe de su venta. */
interface Trabajo {
  venueId: string
  orgId: string
  staffId: string
  llave: string
  serial: string
  ocupacion: string
  v: VentaDeCampoBody
  hora: Date
  origen: OrigenHora
}

const enProceso = () => new ConflictError('Esta venta se está procesando. Reintenta en un momento.', 'VENTA_EN_PROCESO')
const llaveReusada = () => new ConflictError('Esta llave ya se usó en otra venta.', 'LLAVE_REUSADA')

const leerFicha = (t: Trabajo) => prisma.ventaDeCampo.findUnique({ where: { venueId_llave: { venueId: t.venueId, llave: t.llave } } })

/** Escritura de quien tiene la ficha: 0 filas = la perdió, y deja de escribir. */
async function escribir(t: Trabajo, id: string, data: Prisma.VentaDeCampoUpdateManyMutationInput): Promise<void> {
  const { count } = await prisma.ventaDeCampo.updateMany({ where: { id, ocupacion: t.ocupacion }, data })
  if (count === 0) throw enProceso()
}

/** Deja la ficha libre para el reintento (sin efecto si ya no es suya). */
const soltar = (t: Trabajo, id: string) =>
  prisma.ventaDeCampo.updateMany({ where: { id, ocupacion: t.ocupacion }, data: { ocupacion: null, ocupadaHasta: null } })

const resultado = (f: VentaDeCampo, repetida: boolean): ResultadoVentaDeCampo => ({
  orderId: f.orderId!,
  paymentId: f.paymentId!,
  saleVerificationId: f.saleVerificationId!,
  repetida,
  precio: new Prisma.Decimal(f.precio).toFixed(2),
  hora: f.ocurrioAt.toISOString(),
})

export async function registrarVentaDeCampo(
  ctx: { venueId: string; orgId: string; staffId: string },
  v: VentaDeCampoBody,
): Promise<ResultadoVentaDeCampo> {
  // Paso 1
  const { hora, origen } = resolverHoraDelCelular(
    { ocurrioAt: v.ocurrioAt ? new Date(v.ocurrioAt) : undefined, origen: v.origenHora },
    new Date(),
  )
  const t: Trabajo = { ...ctx, llave: v.llave, serial: v.serialNumber, ocupacion: cuid(), v, hora, origen }

  // Pasos 2 a 4
  const tomada = await tomarOCrearFicha(t)
  if ('repetida' in tomada) return tomada
  const ficha = tomada

  // Paso 5
  let orderId = ficha.orderId
  if (!orderId) {
    try {
      const orden = await sellSerializedItem(
        t.venueId,
        {
          serialNumber: t.serial,
          price: new Prisma.Decimal(ficha.precio).toNumber(),
          notes: v.notas,
          isPortabilidad: v.isPortabilidad,
          terminalId: null,
        },
        t.staffId,
        {
          enLaTransaccion: async (tx, order) => {
            const { count } = await tx.ventaDeCampo.updateMany({
              where: { id: ficha.id, ocupacion: t.ocupacion, orderId: null },
              data: { orderId: order.id },
            })
            if (count === 0) throw enProceso() // perdió la ficha: su orden se revierte con la transacción
          },
        },
      )
      orderId = orden.id
    } catch (error) {
      // Sin orden confirmada la ficha se borra (y suelta la SIM); con orden (falló después del commit) sólo se suelta.
      const { count } = await prisma.ventaDeCampo.deleteMany({ where: { id: ficha.id, ocupacion: t.ocupacion, orderId: null } })
      if (count === 0) await soltar(t, ficha.id)
      throw error
    }
  }

  // Paso 6
  const paymentId = ficha.paymentId ?? (await cobrar(t, ficha, orderId))

  try {
    await marcarLaSim(t, ficha, orderId) // Paso 7
    // Paso 8
    const evidencia =
      (await prisma.saleVerification.findUnique({ where: { paymentId }, select: { id: true } })) ??
      (await createPendingSaleVerification({
        venueId: t.venueId,
        paymentId,
        staffId: t.staffId,
        isPortabilidad: v.isPortabilidad ?? false,
        serialNumbers: [t.serial],
        scannedProducts: [],
        createdAt: ficha.ocurrioAt, // la hora de la venta, no la de subida: Cash Out paga por el día de `createdAt`
      }))
    await escribir(t, ficha.id, { saleVerificationId: evidencia.id, estado: 'COMPLETA', ocupacion: null, ocupadaHasta: null })
    logger.info('📱 [VENTA DE CAMPO] Venta completa', { venueId: t.venueId, staffId: t.staffId, fichaId: ficha.id, orderId, paymentId })
    return resultado({ ...ficha, orderId, paymentId, saleVerificationId: evidencia.id }, false)
  } catch (error) {
    await soltar(t, ficha.id) // el reintento sigue desde aquí
    throw error
  }
}

/** Pasos 2 a 4: la ficha de esta llave, ocupada por esta petición, o el resultado si ya está completa. */
async function tomarOCrearFicha(t: Trabajo): Promise<VentaDeCampo | ResultadoVentaDeCampo> {
  for (let vuelta = 0; vuelta < 3; vuelta++) {
    const existente = await leerFicha(t)
    if (existente) return ocuparFicha(t, existente)

    let revisada: { serializedItemId: string; precio: Prisma.Decimal }
    try {
      revisada = await revisarContraHoy(t)
    } catch (error) {
      if (await leerFicha(t)) continue // Codex r3 #4: la otra petición con esta llave ya vendió
      throw error
    }

    try {
      return await prisma.ventaDeCampo.create({
        data: {
          venueId: t.venueId,
          staffId: t.staffId,
          llave: t.llave,
          serialNumber: t.serial,
          serializedItemId: revisada.serializedItemId,
          precio: revisada.precio,
          ocurrioAt: t.hora,
          origenHora: t.origen,
          ocupacion: t.ocupacion,
          ocupadaHasta: new Date(Date.now() + VIGENCIA_DE_LA_OCUPACION_MS),
        },
      })
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error
      // Con la llave (o con las dos a la vez): paso 2. Sólo con la SIM: otra llave la tiene, aquí o en otra sucursal.
      if (!(await leerFicha(t)) && String(error.meta?.target).includes('serializedItemId')) {
        throw new ConflictError('Esta SIM ya está en otra venta del celular.', 'SIM_EN_OTRA_VENTA')
      }
    }
  }
  throw enProceso()
}

/** Paso 2. */
async function ocuparFicha(t: Trabajo, f: VentaDeCampo): Promise<VentaDeCampo | ResultadoVentaDeCampo> {
  if (f.serialNumber !== t.serial || f.staffId !== t.staffId) throw llaveReusada()
  if (f.estado === 'COMPLETA') return resultado(f, true)
  const ahora = new Date()
  const { count } = await prisma.ventaDeCampo.updateMany({
    where: { id: f.id, estado: 'EN_CURSO', OR: [{ ocupadaHasta: null }, { ocupadaHasta: { lt: ahora } }] },
    data: { ocupacion: t.ocupacion, ocupadaHasta: new Date(ahora.getTime() + VIGENCIA_DE_LA_OCUPACION_MS) },
  })
  if (count === 0) throw enProceso()
  return prisma.ventaDeCampo.findUniqueOrThrow({ where: { id: f.id } })
}

/** Paso 3: sin ficha, todo se revisa contra lo de HOY. */
async function revisarContraHoy(t: Trabajo): Promise<{ serializedItemId: string; precio: Prisma.Decimal }> {
  // Codex r3 #6: la llave ya la usó un cobro de otra ruta.
  const conLaLlave = await prisma.payment.findUnique({
    where: { venueId_idempotencyKey: { venueId: t.venueId, idempotencyKey: t.llave } },
    select: { id: true },
  })
  if (conLaLlave) throw llaveReusada()

  const scan = await serializedInventoryService.scan(t.venueId, t.serial)
  if (scan.status === 'module_disabled') throw new BadRequestError('Serialized inventory module is not enabled for this venue') // el de sellSerializedItem
  if (scan.status === 'already_sold') throw new ConflictError('Esta SIM ya se vendió.', 'SIM_YA_VENDIDA')
  if (scan.status === 'not_registered' || !scan.item)
    throw new ConflictError('Esta SIM no está registrada en el inventario.', 'SIM_NO_REGISTRADA')

  try {
    await serializedInventoryService.ensureSellable(t.venueId, t.serial, { staffId: t.staffId })
  } catch (error) {
    if (error instanceof SimCustodyError) throw new ConflictError(error.message, error.code)
    throw error
  }

  const precio = new Prisma.Decimal(t.v.precioVisto)
  const actual = scan.item.category.suggestedPrice
  if (actual != null && !precio.equals(actual)) {
    const precioActual = new Prisma.Decimal(actual).toFixed(2)
    throw new ValidationError(`El precio cambió: ahora es $${precioActual}.`, 'PRECIO_CAMBIO', { precioActual })
  }
  return { serializedItemId: scan.item.id, precio }
}

/** Paso 6: el cobro de la terminal, con la llave. Devuelve el paymentId ya guardado en la ficha. */
async function cobrar(t: Trabajo, ficha: VentaDeCampo, orderId: string): Promise<string> {
  const precio = new Prisma.Decimal(ficha.precio)
  // Por el esquema del cobro de la terminal, para heredar sus defaults (importes en centavos enteros).
  const { body } = recordPaymentBodySchema.parse({
    body: {
      venueId: t.venueId,
      amount: precio.mul(100).toNumber(),
      tip: 0,
      status: 'COMPLETED',
      method: 'CASH',
      splitType: 'FULLPAYMENT',
      staffId: t.staffId,
      idempotencyKey: t.llave,
      serialNumbers: [t.serial],
      isPortabilidad: t.v.isPortabilidad,
    },
  })
  const datos = { ...body, authenticatedTerminalSerial: null } as unknown as Parameters<typeof recordOrderPayment>[2]

  let pago: Awaited<ReturnType<typeof recordOrderPayment>>
  try {
    pago = await recordOrderPayment(t.venueId, orderId, datos, t.staffId, t.orgId)
  } catch (error) {
    throw await limpiarTrasElCobro(t, ficha.id, orderId, error)
  }
  // Codex r3 #6: el cobro que devuelve la llave tiene que ser de ESTA venta.
  if (
    pago.orderId !== orderId ||
    pago.venueId !== t.venueId ||
    !new Prisma.Decimal(pago.amount).equals(precio) ||
    pago.status !== 'COMPLETED'
  ) {
    throw await limpiarTrasElCobro(t, ficha.id, orderId, llaveReusada())
  }
  await escribir(t, ficha.id, { paymentId: pago.id })
  return pago.id
}

/**
 * Paso 9 (Codex r3 #3). Un rechazo definitivo (4xx) sobre una cuenta sin ningún cobro la cancela y borra la ficha; lo demás
 * (5xx, desconocido, la cancelación falla o la cuenta ya tiene un cobro) sólo desocupa. Devuelve el error para lanzarlo.
 */
async function limpiarTrasElCobro(t: Trabajo, fichaId: string, orderId: string, error: unknown): Promise<unknown> {
  if (error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500) {
    try {
      // Un cobro con esta llave sobre ESTA orden también cuenta aquí; `cancelarCuentaSinCobrar` además se niega si hay cobros.
      if ((await prisma.payment.count({ where: { venueId: t.venueId, orderId } })) === 0) {
        await cancelarCuentaSinCobrar(t.venueId, orderId, `Venta del celular rechazada: ${error.code ?? error.statusCode}`, t.staffId)
        await prisma.ventaDeCampo.deleteMany({ where: { id: fichaId, ocupacion: t.ocupacion } })
        return error
      }
    } catch (fallo) {
      logger.warn('📱 [VENTA DE CAMPO] No se pudo cancelar la cuenta del cobro rechazado; queda para el reintento', {
        venueId: t.venueId,
        orderId,
        error: fallo instanceof Error ? fallo.message : String(fallo),
      })
    }
  }
  await soltar(t, fichaId)
  return error
}

/**
 * Paso 7 (Codex r3 #1): el cobro marca la SIM después de su commit y se traga el error (`payment.tpv.service.ts:2231`).
 * Aquí se comprueba. La custodia ya se revisó en el paso 3: revisarla otra vez tras cobrar sólo dejaría la venta trabada.
 */
async function marcarLaSim(t: Trabajo, ficha: VentaDeCampo, orderId: string): Promise<void> {
  const sim = await prisma.serializedItem.findUniqueOrThrow({ where: { id: ficha.serializedItemId! } })
  const renglon = await prisma.orderItem.findFirstOrThrow({ where: { orderId }, select: { id: true } })
  if (sim.status !== 'SOLD') {
    await serializedInventoryService.markAsSold(t.venueId, sim.serialNumber, renglon.id, undefined, {
      staffId: t.staffId,
      skipCustodyCheck: true,
    })
    return
  }
  if (sim.orderItemId === renglon.id) return
  // La carrera AJENA con la PAX: la vendió otro renglón. El dinero ya entró; no se toca y queda en la bitácora.
  const datos = { fichaId: ficha.id, orderId, orderItemId: renglon.id, otroOrderItemId: sim.orderItemId, serialNumber: sim.serialNumber }
  logger.error('🚨 [VENTA DE CAMPO] La SIM ya estaba vendida por otro renglón; la venta del celular queda cobrada', {
    venueId: t.venueId,
    ...datos,
  })
  await logAction({
    staffId: t.staffId,
    venueId: t.venueId,
    action: 'VENTA_DE_CAMPO_SIM_VENDIDA_EN_OTRA_VENTA',
    entity: 'VentaDeCampo',
    entityId: ficha.id,
    data: datos,
  })
}
