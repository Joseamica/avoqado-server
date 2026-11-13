/**
 * Cierre perdido de Mercado Pago (tarjeta D1, 12-nov): el SQL del barrido contra Postgres REAL.
 * El recorrido de dinero (cierre real, CAS, bitácora) vive en `tests/unit/services/dashboard/mercadoPagoPay.executors.test.ts`;
 * aquí se prueba lo que un mock no puede: el SQL crudo (JOIN, enum, `utcTs`, NOT EXISTS), el upsert del evento, el toque de
 * `updatedAt` que espacia las revisiones y la lectura de eventos por estado.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="<base de prueba>" npx jest --selectProjects=integration \
 *   --runTestsByPath tests/integration/mercado-pago/cierrePerdido.integration.test.ts --ci --runInBand
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { MercadoPagoCierrePerdidoJob } from '@/jobs/mercadopago-cierre-perdido.job'
import { asegurarBaseDePrueba, borrarMundoComisiones, crearMundoComisiones, MundoComisiones } from '../commission/_mundoComisiones'

let m: MundoComisiones
let mpUserId: string
let canalId: string
const procesar = jest.fn()
const cargarCredenciales = jest.fn()
const hace = (min: number) => new Date(Date.now() - min * 60_000)

function barrido() {
  return new MercadoPagoCierrePerdidoJob({
    cron: { start: jest.fn(), stop: jest.fn() },
    procesar,
    cargarCredenciales,
    logAction: jest.fn(),
  })
}

async function sesion(clave: string, data: Partial<Prisma.CheckoutSessionUncheckedCreateInput>) {
  return prisma.checkoutSession.create({
    data: {
      sessionId: `cs_mp_${m.key}_${clave}`,
      ecommerceMerchantId: canalId,
      amount: new Prisma.Decimal(100),
      expiresAt: new Date(Date.now() + 86_400_000),
      mpPaymentId: `${m.key}${clave}`,
      createdAt: hace(60),
      updatedAt: hace(60),
      ...data,
    },
  })
}

beforeAll(asegurarBaseDePrueba)
beforeEach(async () => {
  jest.clearAllMocks()
  m = await crearMundoComisiones('mp-cierre-perdido')
  mpUserId = `mpu_${m.key}`
  const proveedor = await prisma.paymentProvider.upsert({
    where: { code: 'MERCADO_PAGO' },
    create: { code: 'MERCADO_PAGO', name: 'Mercado Pago', type: 'PAYMENT_PROCESSOR' },
    update: {},
  })
  const canal = await prisma.ecommerceMerchant.create({
    data: {
      venueId: m.venueId,
      businessName: 'Liga MP',
      contactEmail: `${m.key}-mp@example.test`,
      publicKey: `pk_test_mp_${m.key}`,
      secretKeyHash: `hash-mp-${m.key}`,
      providerId: proveedor.id,
      providerMerchantId: mpUserId,
      providerCredentials: {},
    },
  })
  canalId = canal.id
  cargarCredenciales.mockResolvedValue(null)
  // Como el procesador real: encuentra la sesión del pago y la devuelve (no la escribe, para que se vea el espaciado del job).
  procesar.mockImplementation(async (_comercio: unknown, dataId: string) => {
    const s = await prisma.checkoutSession.findFirst({ where: { mpPaymentId: dataId }, select: { id: true } })
    return { estado: 'processed', razon: 'processed', detalle: null, checkoutSessionId: s?.id }
  })
})
afterEach(async () => {
  await prisma.mercadoPagoWebhookEvent.deleteMany({ where: { mpUserId } })
  await borrarMundoComisiones(m)
})

it('elige sesiones de MP sin venta (PENDING, CANCELLED, COMPLETED) y deja fuera las reembolsadas, las recientes y las que ya tienen evento abierto', async () => {
  const pendiente = await sesion('p', { status: 'PENDING' })
  const cancelada = await sesion('c', { status: 'CANCELLED' })
  const completada = await sesion('k', { status: 'COMPLETED' })
  await sesion('f', { status: 'FAILED' }) // reembolsada: fuera
  await sesion('r', { status: 'PENDING', updatedAt: hace(5) }) // revisada hace 5 min: fuera (espaciado de 15)
  await sesion('v', { status: 'PENDING', createdAt: hace(31 * 24 * 60), updatedAt: hace(31 * 24 * 60) }) // fuera de la ventana
  const conEvento = await sesion('e', { status: 'COMPLETED' })
  await prisma.mercadoPagoWebhookEvent.create({
    data: {
      mpUserId,
      dataId: conEvento.mpPaymentId!,
      requestId: 'aviso-1',
      eventType: 'payment',
      action: 'payment.updated',
      payload: {},
      processingStatus: 'error',
    },
  })

  const r = await barrido().runNow()

  const abiertos = await prisma.mercadoPagoWebhookEvent.findMany({ where: { mpUserId, requestId: { startsWith: 'barrido:' } }, take: 20 })
  expect(abiertos.map(e => e.requestId).sort()).toEqual(
    [`barrido:${cancelada.sessionId}`, `barrido:${completada.sessionId}`, `barrido:${pendiente.sessionId}`].sort(),
  )
  expect(r.encoladas).toBe(3)
  // Los tres nuevos más el que ya estaba abierto pasan por el procesador, con el comercio y las credenciales cargados una vez.
  expect(procesar).toHaveBeenCalledTimes(4)
  expect(procesar).toHaveBeenCalledWith(expect.objectContaining({ id: canalId, venueId: m.venueId }), conEvento.mpPaymentId, {
    creds: null,
    auditoriaDeRecuperacion: { eventIds: [expect.any(String)], intentos: 1 },
  })
  expect(cargarCredenciales).toHaveBeenCalledTimes(1)
  const procesados = await prisma.mercadoPagoWebhookEvent.count({ where: { mpUserId, processingStatus: 'processed' } })
  expect(procesados).toBe(4)

  // El toque de updatedAt espacia la siguiente revisión: una segunda vuelta inmediata no vuelve a elegirlas.
  const tocada = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: pendiente.id } })
  expect(tocada.updatedAt.getTime()).toBeGreaterThan(hace(1).getTime())
  procesar.mockClear()
  expect(await barrido().runNow()).toMatchObject({ encoladas: 0, pagos: 0 })
  expect(procesar).not.toHaveBeenCalled()
})

it('un evento con fallo suma su contador visible y un evento «pending» reciente se respeta (gracia de 3 min)', async () => {
  await prisma.mercadoPagoWebhookEvent.create({
    data: {
      mpUserId,
      dataId: `${m.key}x`,
      requestId: 'aviso-x',
      eventType: 'payment',
      action: 'payment.updated',
      payload: {},
      processingStatus: 'error',
    },
  })
  await prisma.mercadoPagoWebhookEvent.create({
    data: {
      mpUserId,
      dataId: `${m.key}y`,
      requestId: 'aviso-y',
      eventType: 'payment',
      action: 'payment.updated',
      payload: {},
      processingStatus: 'pending',
    },
  })
  procesar.mockResolvedValue({ estado: 'error', razon: 'fetch_failed', detalle: 'MP getPayment failed: 503' })

  await barrido().runNow()

  const x = await prisma.mercadoPagoWebhookEvent.findFirstOrThrow({ where: { mpUserId, requestId: 'aviso-x' } })
  expect(x).toMatchObject({
    processingStatus: 'error',
    errorMessage: expect.stringMatching(/^\[barrido 1\/\d+\] MP getPayment failed: 503$/),
  })
  const y = await prisma.mercadoPagoWebhookEvent.findFirstOrThrow({ where: { mpUserId, requestId: 'aviso-y' } })
  expect(y).toMatchObject({ processingStatus: 'pending', errorMessage: null })
  expect(procesar).toHaveBeenCalledTimes(1)
})
