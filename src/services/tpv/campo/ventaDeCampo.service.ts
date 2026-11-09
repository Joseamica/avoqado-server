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
import { claseDeEstado } from '@/services/shared/orderBalance'
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
      (await buscarEvidencia(paymentId)) ??
      (await createPendingSaleVerification({
        venueId: t.venueId,
        paymentId,
        staffId: t.staffId,
        isPortabilidad: v.isPortabilidad ?? false,
        serialNumbers: [t.serial],
        scannedProducts: [],
        createdAt: ficha.ocurrioAt, // la hora de la venta, no la de subida: Cash Out paga por el día de `createdAt`
      }).catch(async error => {
        // Otra petición la creó entre la lectura y la creación (400 «Verification already exists»): se toma ésa.
        const yaCreada = await buscarEvidencia(paymentId)
        if (!yaCreada) throw error
        return yaCreada
      }))
    // Al completarse la SIM ya está vendida (el escaneo frena otra venta): se suelta su reclamo, para que si regresa (RETURNED)
    // se pueda volver a vender desde el celular.
    await escribir(t, ficha.id, {
      saleVerificationId: evidencia.id,
      estado: 'COMPLETA',
      serializedItemId: null,
      ocupacion: null,
      ocupadaHasta: null,
    })
    logger.info('📱 [VENTA DE CAMPO] Venta completa', { venueId: t.venueId, staffId: t.staffId, fichaId: ficha.id, orderId, paymentId })
    return resultado({ ...ficha, orderId, paymentId, saleVerificationId: evidencia.id }, false)
  } catch (error) {
    await soltar(t, ficha.id) // el reintento sigue desde aquí
    // Después del dinero nada es definitivo: un 4xx de los pasos 7 u 8 se vuelve reintentable.
    if (error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500) throw enProceso()
    throw error
  }
}

const buscarEvidencia = (paymentId: string) => prisma.saleVerification.findUnique({ where: { paymentId }, select: { id: true } })

/** Un cobro con esta llave sobre ESTA orden también cuenta aquí. */
const sinCobros = async (t: Trabajo, orderId: string) => (await prisma.payment.count({ where: { venueId: t.venueId, orderId } })) === 0

/**
 * La cuenta de la ficha ya no está (cancelada, borrada o no existe) y no tiene ningún cobro: la ficha ya no sirve. Sin borrarla,
 * su reintento cobraría la cuenta cancelada (el efectivo ya capturado la reabre, `cuentaCancelada.ts`) y la SIM quedaría
 * reclamada para siempre.
 */
async function cuentaCanceladaSinCobro(t: Trabajo, orderId: string): Promise<boolean> {
  const orden = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } })
  return (!orden || claseDeEstado(orden.status) === 'CANCELADA') && (await sinCobros(t, orderId))
}

/** Pasos 2 a 4: la ficha de esta llave, ocupada por esta petición, o el resultado si ya está completa. */
async function tomarOCrearFicha(t: Trabajo): Promise<VentaDeCampo | ResultadoVentaDeCampo> {
  for (let vuelta = 0; vuelta < 3; vuelta++) {
    const existente = await leerFicha(t)
    if (existente) {
      const tomada = await ocuparFicha(t, existente)
      if ('repetida' in tomada || !tomada.orderId || tomada.paymentId || !(await cuentaCanceladaSinCobro(t, tomada.orderId))) {
        return tomada
      }
      // Un rechazo canceló su cuenta pero no alcanzó a borrar la ficha: se borra y la venta se revisa contra lo de HOY.
      const { count } = await prisma.ventaDeCampo.deleteMany({ where: { id: tomada.id, ocupacion: t.ocupacion } })
      if (count === 0) throw enProceso()
      continue
    }

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
  let pago: Awaited<ReturnType<typeof recordOrderPayment>>
  try {
    pago = await recordOrderPayment(t.venueId, orderId, datosDelCobro(t, precio), t.staffId, t.orgId)
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
 * El cobro de la terminal, por su esquema para heredar sus defaults (importes en centavos enteros). Si no lo pasa es determinista
 * (p. ej. un venueId que no es cuid): sale como rechazo claro y se limpia, nunca como un 500 con la ficha ocupada.
 */
function datosDelCobro(t: Trabajo, precio: Prisma.Decimal): Parameters<typeof recordOrderPayment>[2] {
  const r = recordPaymentBodySchema.safeParse({
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
  if (!r.success) {
    throw new BadRequestError(
      `El cobro no pasa el esquema de la terminal: ${r.error.issues.map(i => i.message).join('; ')}`,
      'COBRO_INVALIDO',
    )
  }
  return { ...r.data.body, authenticatedTerminalSerial: null } as unknown as Parameters<typeof recordOrderPayment>[2]
}

/** Los 409 del cobro que dicen «vuelve a intentar»: no son un rechazo de la venta. */
const COBRO_TRANSITORIO = new Set(['ORDER_PAYMENT_CONFLICT'])

/**
 * Paso 9 (Codex r3 #3). Un rechazo definitivo (4xx) sobre una cuenta sin ningún cobro la cancela y borra la ficha, y sale el
 * rechazo. Si esa limpieza falla, sale VENTA_EN_PROCESO para que el celular reintente hasta que se pueda. Un 5xx, un desconocido
 * o un 409 transitorio del cobro sólo desocupan. Devuelve el error para lanzarlo.
 */
async function limpiarTrasElCobro(t: Trabajo, fichaId: string, orderId: string, error: unknown): Promise<unknown> {
  const esAppError4xx = error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500
  if (!esAppError4xx || COBRO_TRANSITORIO.has(error.code ?? '')) {
    await soltar(t, fichaId)
    return esAppError4xx ? enProceso() : error
  }
  try {
    if (!(await sinCobros(t, orderId))) {
      await soltar(t, fichaId) // con dinero en la cuenta no se cancela nada: el rechazo queda tal cual
      return error
    }
    await cancelarCuentaSinCobrar(t.venueId, orderId, `Venta del celular rechazada: ${error.code ?? error.statusCode}`, t.staffId).catch(
      async fallo => {
        // Otra petición ya la canceló (`rechazarYaCancelada`): para la ficha es lo mismo.
        if (!(await cuentaCanceladaSinCobro(t, orderId))) throw fallo
      },
    )
    const { count } = await prisma.ventaDeCampo.deleteMany({ where: { id: fichaId, ocupacion: t.ocupacion } })
    return count === 1 ? error : enProceso() // perdió la ficha: quien la tiene verá la cuenta cancelada y la borrará
  } catch (fallo) {
    logger.warn('📱 [VENTA DE CAMPO] No se pudo limpiar la venta del cobro rechazado; queda para el reintento', {
      venueId: t.venueId,
      orderId,
      error: fallo instanceof Error ? fallo.message : String(fallo),
    })
    await soltar(t, fichaId)
    return enProceso()
  }
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
