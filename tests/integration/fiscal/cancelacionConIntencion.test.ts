// C2 · Tarea 2 (plan v7; Codex C2-5, C2-6, C2-7, C2-11, C2-20 a C2-29, C2-32): la cancelación anota una intención identificada; cada
// intento se envía UNA vez, por su dueño (`SELECT … FOR UPDATE` + token) y con una consulta antes; lo incierto queda EN DUDA y sólo se
// CONSULTA; un rechazo confirmado cierra; un intento nuevo lo pide una persona; estado y sellos en la misma transacción.
//
// El proveedor doble guarda el estado de cancelación de cada factura COMO EL PAC REAL: un DELETE sobre una factura sin trámite crea uno
// `pending` (o la cancela, con `cancelacionInmediata`); sobre una con trámite `pending`/`verifying` lanza 409
// `invoice_cancellation_in_progress` (el doble de v4 devolvía el mismo trámite: mentía, Codex C2-24); `fijarEstado` simula al receptor;
// `perderRespuesta()` hace que el próximo DELETE sí cree el trámite pero lance `ETIMEDOUT`.
// La bitácora se mide en la BASE (como en liberarAlCancelar): la integración la simula por defecto (integration-setup.ts).
jest.unmock('@/services/dashboard/activity-log.service')
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))
jest.mock('@/services/storage.service', () => ({
  buildStoragePath: (s: string) => s,
  uploadFileToStorage: jest.fn(async () => 'https://test/file'),
}))
import { readFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import {
  issueCfdiForOrder,
  cancelCfdi,
  anotarIntencionDeCancelar,
  enviarCancelacion,
  estadoDeCancelacion,
  refreshPendingCancellation,
  sincronizarCancelacionExterna,
  aplicarCancelacion,
  defaultCancelDeps,
  defaultRefreshDeps,
  dondeBuscarCancelacionesPendientes,
  PLAZO_DE_LA_DUDA_MS,
  MOTIVO_SIN_SOLICITUD_EN_EL_PLAZO,
  dondeBuscarCierresRecientes,
  tomarEnvio,
} from '@/services/fiscal/cfdi.service'
import { ProviderUnavailableError } from '@/errors/AppError'
import {
  MOTIVO_ORIGINAL_EN_CANCELACION,
  MOTIVO_ORIGINAL_CANCELACION_ENVIANDOSE,
  MOTIVO_ORIGINAL_CANCELACION_EN_DUDA,
  emitRefundCreditNote,
  getRefundCreditNoteStatus,
  loadRefundForCreditNoteFromDb,
} from '@/services/fiscal/cfdiCreditNote.service'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import { ProviderHttpError } from '@/services/fiscal/providers/facturapi.provider'
import { encenderIvaPorProducto } from '../../__helpers__/iva-por-producto'
import { xmlDeLaFila } from '../../__helpers__/xml-del-pac'

const { isDisposableH1Url } = require('../../../scripts/h1-test-database.cjs')
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
// Sólo las bases fiscales locales existentes o una desechable H1 validada por el lanzador.
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !(
    ['/av_db_25_iva_test', '/av_db_25_iva_test_b3c', '/avoqado_h1a_test_20260808'].includes(database.pathname) ||
    isDisposableH1Url(database)
  )
)
  throw new Error('Dedicated test DB required')

const receptor = { rfc: 'EKU9003173C9', razonSocial: 'ESCUELA KEMPER URGATE', regimenFiscal: '601', codigoPostal: '64000', usoCfdi: 'G03' }
const valid = () => ({
  providerInvoiceId: randomUUID(),
  uuid: randomUUID(),
  serie: 'F',
  folio: '1',
  totalCents: 11600,
  stampedAt: new Date(),
  status: 'valid' as const,
})

/** Sondea cada 20 ms hasta 3 s. */
async function esperarHasta(fn: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('esperarHasta: no se cumplió en 3 s')
}
/** Deja pasar a los dos cuando llegan los dos. */
function barreraDeDos() {
  let n = 0
  let soltar!: () => void
  const abierta = new Promise<void>(r => (soltar = r))
  return {
    esperar: async () => {
      n += 1
      if (n === 2) soltar()
      await abierta
    },
  }
}

describe('C2 · cancelación con intención identificada (integración)', () => {
  const fixture = `cancel-intencion-${randomUUID()}`
  let venueId: string
  let productId: string
  let fiscalEmisorId: string
  const provider = {
    name: 'facturapi',
    createInvoice: jest.fn(),
    createGlobalInvoice: jest.fn(),
    cancelInvoice: jest.fn(),
    getCancellationStatus: jest.fn(),
    findByExternalId: jest.fn(),
    getInvoice: jest.fn(),
    downloadXml: jest.fn(),
    downloadPdf: jest.fn(),
  }

  // ── El PAC doble, con estado por factura ──
  const estados = new Map<string, string>()
  let perder = false
  let cancelacionInmediata = false
  const fijarEstado = (facturapiId: string, s: string) => estados.set(facturapiId, s)
  const perderRespuesta = () => {
    perder = true
  }
  function instalarPac() {
    provider.getCancellationStatus.mockImplementation(async (id: string) => {
      const s = estados.get(id) ?? 'none'
      return { status: s, cancelledAt: s === 'canceled' ? new Date() : null }
    })
    provider.cancelInvoice.mockImplementation(async ({ providerInvoiceId }: { providerInvoiceId: string }) => {
      const s = estados.get(providerInvoiceId) ?? 'none'
      if (s === 'pending' || s === 'verifying')
        throw new ProviderHttpError(409, 'invoice_cancellation_in_progress', 'La factura ya tiene una solicitud de cancelación en curso')
      if (s === 'canceled') throw new ProviderHttpError(400, 'invoice_not_cancelable', 'La factura ya está cancelada')
      const nuevo = cancelacionInmediata ? 'canceled' : 'pending'
      estados.set(providerInvoiceId, nuevo)
      if (perder) {
        perder = false
        throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
      }
      return { status: nuevo, cancelledAt: nuevo === 'canceled' ? new Date() : null }
    })
  }

  const issue = (orderId: string) => issueCfdiForOrder({ orderId, receptor, sandbox: true, expectedVenueId: venueId })
  const fila = (id: string) => prisma.cfdi.findUniqueOrThrow({ where: { id }, include: { fiscalEmisor: true } })
  const sellosDe = (id: string) => prisma.orderItemSelloIva.count({ where: { cfdiId: id } })
  const bitacora = (entityId: string, action: string) => prisma.activityLog.findMany({ where: { entityId, action }, take: 10 })
  const depsDeCancelar = () => ({ ...defaultCancelDeps })
  const depsDeConsulta = () => ({ ...defaultRefreshDeps })
  const cancelar = (cfdiId: string, extra: Record<string, unknown> = {}, deps = depsDeCancelar()) =>
    cancelCfdi({ cfdiId, motivo: '02', sandbox: true, expectedVenueId: venueId, ...extra } as any, deps)

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
    venueId = (await prisma.venue.create({ data: { id: fixture, organizationId: fixture, name: fixture, slug: fixture } })).id
    await encenderIvaPorProducto(venueId)
    const category = await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })
    productId = (await prisma.product.create({ data: { venueId, categoryId: category.id, name: fixture, sku: fixture, price: 116 } })).id
    fiscalEmisorId = (
      await prisma.fiscalEmisor.create({
        data: {
          venueId,
          rfc: 'AAA010101AAA',
          legalName: fixture,
          regimenFiscal: '601',
          lugarExpedicion: '01000',
          csdStatus: 'ACTIVE',
          globalPeriodicity: 'MENSUAL',
          invoiceCashSales: true,
        },
      })
    ).id
    await prisma.paymentProvider.create({
      data: { id: fixture, code: fixture, name: fixture, type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
    await prisma.merchantAccount.create({
      data: { id: fixture, providerId: fixture, externalMerchantId: fixture, credentialsEncrypted: {} },
    })
    await prisma.merchantFiscalConfig.create({
      data: { merchantAccountId: fixture, fiscalEmisorId, facturacionEnabled: true, autofacturaEnabled: true, includeInGlobal: true },
    })
  })

  async function cleanOrders() {
    // Regla (8-oct): si el fixture no llegó a crearse, `venueId` es undefined y `deleteMany({ where: { venueId } })` BORRARÍA LA TABLA.
    if (!venueId) return
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.orderItemSelloIva.deleteMany({ where: { cfdi: { venueId } } })
    await prisma.cfdiGlobalOrden.deleteMany({ where: { cfdi: { venueId } } })
    await prisma.cfdi.deleteMany({ where: { venueId } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
  }
  beforeEach(async () => {
    await cleanOrders()
    jest.resetAllMocks()
    estados.clear()
    perder = false
    cancelacionInmediata = false
    jest.mocked(resolveFiscalProvider).mockReturnValue(provider as any)
    provider.createInvoice.mockImplementation(async () => valid())
    provider.findByExternalId.mockResolvedValue(null)
    // C2 T7 (D5): la nota exige el XML de su original; el doble devuelve el que el PAC timbraría con lo que se le mandó.
    provider.downloadXml.mockImplementation(async (id: string) => xmlDeLaFila(prisma, id))
    provider.downloadPdf.mockResolvedValue(Buffer.from('%PDF'))
    instalarPac()
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_16' } })
  })
  afterEach(() => jest.restoreAllMocks())
  afterAll(async () => {
    if (!venueId) return
    await cleanOrders()
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    if (fiscalEmisorId) await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisorId } }) // id undefined = toda la tabla
    await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
    await prisma.merchantAccount.deleteMany({ where: { id: fixture } })
    await prisma.paymentProvider.deleteMany({ where: { id: fixture } })
    await prisma.venue.delete({ where: { id: venueId } })
    await prisma.organization.delete({ where: { id: fixture } })
  })
  async function order(amount = 116) {
    return prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        subtotal: amount,
        taxAmount: 0,
        total: amount,
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        items: { create: { productId, productName: 'Producto', quantity: 1, unitPrice: amount, taxAmount: 0, total: amount } },
        payments: {
          create: {
            venueId,
            merchantAccountId: fixture,
            amount,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: amount,
            method: 'CREDIT_CARD',
            status: 'COMPLETED',
            createdAt: new Date('2026-05-15T12:00:00Z'),
          },
        },
      },
      include: { items: true },
    })
  }
  /** Una factura individual timbrada (con sus sellos) de una orden nueva. */
  async function timbrada() {
    const o = await order()
    const r = await issue(o.id)
    expect(r.status).toBe('STAMPED')
    const f = await fila(r.cfdi.id)
    expect(f.facturapiId).toBeTruthy()
    return { o, f }
  }
  /** Una nota de crédito reservada y en pausa ANTES del envío (fila EGRESO STAMPING, sin enviar, apuntando a la original). */
  async function reservarNotaSinEnviar(orderId: string, original: { id: string }, over: Record<string, unknown> = {}) {
    return prisma.cfdi.create({
      data: {
        venueId,
        fiscalEmisorId,
        orderId,
        type: 'EGRESO',
        status: 'STAMPING',
        flow: 'STAFF_B',
        receptorRfc: receptor.rfc,
        receptorNombre: receptor.razonSocial,
        receptorRegimen: receptor.regimenFiscal,
        receptorCp: receptor.codigoPostal,
        usoCfdi: 'G02',
        formaPago: '04',
        metodoPago: 'PUE',
        subtotalCents: 862,
        taxCents: 138,
        totalCents: 1000,
        protocoloIva: 1,
        attempts: 1,
        idempotencyKey: `cfdi-refund-${randomUUID()}`,
        entrada: { v: 1, tipo: 'EGRESO', originalCfdiId: original.id },
        ...over,
      } as any,
    })
  }
  async function refund(orderId: string, amount = 10) {
    return prisma.payment.create({
      data: {
        venueId,
        orderId,
        type: 'REFUND',
        amount: -amount,
        tipAmount: 0,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -amount,
        method: 'CASH',
        status: 'COMPLETED',
      },
    })
  }

  it('🔴 la intención y el token quedan escritos ANTES de que el PAC conteste; la consulta va antes del POST', async () => {
    const { f } = await timbrada()
    provider.cancelInvoice.mockImplementation(async () => {
      expect(await fila(f.id)).toMatchObject({
        status: 'STAMPED',
        cancelStatus: 'REQUESTED',
        cancelMotivo: '02',
        cancelIntento: 1,
        cancelEnviadaAt: expect.any(Date),
      })
      expect(provider.getCancellationStatus).toHaveBeenCalled()
      return { status: 'canceled', cancelledAt: new Date() }
    })
    await cancelar(f.id)
    expect(provider.cancelInvoice).toHaveBeenCalledTimes(1)
    expect(await fila(f.id)).toMatchObject({ status: 'CANCELLED', cancelStatus: 'CANCELLED' })
  })

  it('🔴 C2-11: dos peticiones a la vez, las dos con la intención anotada ⇒ UN solo dueño y UN solo POST', async () => {
    const { f } = await timbrada()
    const barrera = barreraDeDos() // los dos pasan la anotación antes de pedir el envío
    const anotarConBarrera: typeof anotarIntencionDeCancelar = async (...a) => {
      const r = await anotarIntencionDeCancelar(...a)
      await barrera.esperar()
      return r
    }
    const deps = { ...depsDeCancelar(), anotarIntencion: anotarConBarrera }
    const r = await Promise.all([1, 2].map(() => cancelar(f.id, {}, deps)))
    expect(provider.cancelInvoice).toHaveBeenCalledTimes(1)
    expect(r.filter(x => x.enTramitePorOtro)).toHaveLength(1)
    expect(await fila(f.id)).toMatchObject({ cancelStatus: 'REQUESTED', cancelIntento: 1, cancelAcusadaAt: expect.any(Date) })
  })

  it('🔴 C2-24: el PAC recibe la solicitud, se pierde la respuesta y el receptor RECHAZA antes de verse en trámite ⇒ queda EN DUDA, la consulta cierra REJECTED; un solo DELETE; un intento nuevo sólo si la persona lo pide', async () => {
    const { f } = await timbrada()
    perderRespuesta()
    expect(await cancelar(f.id)).toMatchObject({ enDuda: true })
    expect(estadoDeCancelacion(await fila(f.id), new Date(Date.now() + 2 * 60_000))).toBe('CANCELACION_EN_DUDA')
    fijarEstado(f.facturapiId!, 'rejected') // el receptor rechazó la solicitud que nunca vimos en trámite
    const despues = new Date(Date.now() + 2 * 60_000)
    await refreshPendingCancellation(await fila(f.id), { sandbox: true }, { ...depsDeConsulta(), now: () => despues })
    expect(await fila(f.id)).toMatchObject({
      status: 'STAMPED',
      cancelStatus: 'REJECTED',
      cancelIntento: 1,
      lastError: expect.stringMatching(/rechaz/),
    })
    await refreshPendingCancellation(await fila(f.id), { sandbox: true }, { ...depsDeConsulta(), now: () => despues })
    expect(provider.cancelInvoice).toHaveBeenCalledTimes(1) // ni el barrido ni una segunda consulta reenvían; no queda en recuperación
    await cancelar(f.id) // la persona pulsa otra vez: intento NUEVO, con su consulta previa
    expect(await fila(f.id)).toMatchObject({ cancelStatus: 'REQUESTED', cancelIntento: 2, cancelAcusadaAt: expect.any(Date) })
    expect(provider.cancelInvoice).toHaveBeenCalledTimes(2) // el segundo DELETE es un intento NUEVO y explícito
  })

  // C2 · T10 ronda 1 (I-1): el espejo de C2-24 desde la pantalla. La lista vieja todavía ofrece «Consultar estado» sobre una factura que
  // el barrido ya cerró REJECTED; pulsarlo (con el MISMO motivo que mandaba el botón viejo) NO puede crear ni enviar el intento 2.
  it('🔴 T10 ronda 1 (I-1): tras el cierre REJECTED, «Consultar estado» (`soloConsultar`) no anota ni manda nada: un solo DELETE, intento 1', async () => {
    const { f } = await timbrada()
    perderRespuesta()
    expect(await cancelar(f.id)).toMatchObject({ enDuda: true })
    fijarEstado(f.facturapiId!, 'rejected')
    const despues = new Date(Date.now() + 2 * 60_000)
    await refreshPendingCancellation(await fila(f.id), { sandbox: true }, { ...depsDeConsulta(), now: () => despues })
    expect(await fila(f.id)).toMatchObject({ cancelStatus: 'REJECTED', cancelIntento: 1 })
    const consultasAntes = provider.getCancellationStatus.mock.calls.length

    const r = await cancelar(f.id, { soloConsultar: true })
    expect(r).toMatchObject({ applied: false, intencionNueva: false, cancelStatus: 'REJECTED', estado: 'RECHAZADA' })
    expect(provider.cancelInvoice).toHaveBeenCalledTimes(1)
    expect(provider.getCancellationStatus.mock.calls.length).toBe(consultasAntes) // rechazada: ni siquiera se consulta
    expect(await fila(f.id)).toMatchObject({
      status: 'STAMPED',
      cancelStatus: 'REJECTED',
      cancelIntento: 1,
      cancelEnviadaAt: expect.any(Date),
    })
    // Sin `soloConsultar` (o sin motivo) la consulta tampoco: sin motivo y sin la bandera, nada.
    await expect(cancelar(f.id, { motivo: undefined })).rejects.toThrow(/motivo de cancelación es requerido/)
    expect(provider.cancelInvoice).toHaveBeenCalledTimes(1)
  })

  it('control — T10 ronda 1 (I-1): EN DUDA y el PAC ya la tiene en trámite ⇒ «Consultar estado» la ACUSA (sólo GET), sin DELETE ni intento nuevo', async () => {
    const { f } = await timbrada()
    perderRespuesta()
    expect(await cancelar(f.id)).toMatchObject({ enDuda: true })
    expect(provider.cancelInvoice).toHaveBeenCalledTimes(1)
    const r = await cancelar(f.id, { soloConsultar: true }) // el doble dejó el trámite `pending`: el PAC lo tiene
    expect(r).toMatchObject({ applied: false, intencionNueva: false, cancelStatus: 'REQUESTED', estado: 'EN_TRAMITE' })
    expect(provider.cancelInvoice).toHaveBeenCalledTimes(1)
    expect(await fila(f.id)).toMatchObject({ cancelStatus: 'REQUESTED', cancelIntento: 1, cancelAcusadaAt: expect.any(Date) })
  })

  // Ronda 2 (N1, cambia a propósito): un «sin solicitud» sobre un envío EN DUDA sólo cierra pasado `PLAZO_DE_LA_DUDA_MS`; la consulta que
  // cierra el intento del dueño dormido es la de las 24 h (antes: a los 2 min).
  it('🔴 C2-20/C2-24: el dueño toma el envío y se DUERME antes del POST; la consulta (none, pasado el plazo de la duda) cierra REJECTED; el dueño despierta, relee que ya no es dueño y NO manda nada', async () => {
    const { f } = await timbrada()
    let soltar!: () => void
    const dormido = new Promise<void>(r => (soltar = r))
    const enviarDormido: typeof enviarCancelacion = async (...a) => {
      await dormido
      return enviarCancelacion(...a)
    }
    const a = cancelar(f.id, {}, { ...depsDeCancelar(), enviar: enviarDormido })
    await esperarHasta(async () => !!(await fila(f.id)).cancelEnviadaAt)
    const despues = new Date(Date.now() + PLAZO_DE_LA_DUDA_MS + 60_000)
    await refreshPendingCancellation(await fila(f.id), { sandbox: true }, { ...depsDeConsulta(), now: () => despues })
    expect(await fila(f.id)).toMatchObject({ cancelStatus: 'REJECTED', lastError: MOTIVO_SIN_SOLICITUD_EN_EL_PLAZO })
    soltar()
    expect(await a).toMatchObject({ applied: false, cancelStatus: 'REJECTED' })
    expect(provider.cancelInvoice).not.toHaveBeenCalled()
    expect(await fila(f.id)).toMatchObject({ cancelStatus: 'REJECTED', cancelIntento: 1 })
  })

  it('🔴 C2-32 (Codex): A toma la foto (REQUESTED, intento 4) y consulta; entretanto B aplica un negativo del MISMO intento (REJECTED); A recibe «cancelada» ⇒ gana el hecho: CANCELLED, sellos liberados y registro confirmado', async () => {
    const { f } = await timbrada()
    const hace2min = new Date(Date.now() - 2 * 60_000)
    await prisma.cfdi.update({
      where: { id: f.id },
      data: { cancelStatus: 'REQUESTED', cancelIntento: 4, cancelRequestedAt: hace2min, cancelEnviadaAt: hace2min, cancelMotivo: '02' },
    })
    const foto = await fila(f.id)
    const sellosAntes = await sellosDe(f.id)
    expect(sellosAntes).toBeGreaterThan(0)
    fijarEstado(f.facturapiId!, 'canceled')
    let soltar!: () => void
    const pausa = new Promise<void>(r => (soltar = r))
    const a = refreshPendingCancellation(foto, { sandbox: true }, { ...depsDeConsulta(), despuesDeConsultar: () => pausa })
    await esperarHasta(async () => provider.getCancellationStatus.mock.calls.length === 1)
    // B: el negativo del mismo intento, con su CAS de foto (sin acuse), por el escritor real
    expect(
      await aplicarCancelacion(f.id, { cancelStatus: 'REJECTED', lastError: 'El SAT no tiene la solicitud…' }, foto.attempts, 'PENDIENTE', {
        cancelIntento: 4,
        cancelEnviadaAt: hace2min,
        cancelAcusadaAt: null,
      }),
    ).not.toBeNull()
    expect(await fila(f.id)).toMatchObject({ status: 'STAMPED', cancelStatus: 'REJECTED', cancelIntento: 4 })
    soltar()
    await a
    expect(await fila(f.id)).toMatchObject({ status: 'CANCELLED', cancelStatus: 'CANCELLED', cancelIntento: 4 })
    expect(await sellosDe(f.id)).toBeLessThan(sellosAntes) // misma transacción que el estado (C2-21)
    expect(await bitacora(f.id, 'CFDI_CANCEL_CONFIRMED')).toHaveLength(1)
  })

  it('🔴 C2-32: nada rebaja un CANCELLED — un negativo atrasado del mismo intento no escribe; y el hecho de OTRO intento tampoco entra', async () => {
    const { f } = await timbrada()
    await prisma.cfdi.update({
      where: { id: f.id },
      data: { cancelStatus: 'REQUESTED', cancelIntento: 4, cancelRequestedAt: new Date(), cancelEnviadaAt: new Date() },
    })
    const v = (await fila(f.id)).attempts
    expect(
      await aplicarCancelacion(f.id, { status: 'CANCELLED', cancelStatus: 'CANCELLED' }, v, 'PENDIENTE', { cancelIntento: 3 }),
    ).toBeNull() // otro intento
    expect(
      await aplicarCancelacion(f.id, { status: 'CANCELLED', cancelStatus: 'CANCELLED' }, v, 'PENDIENTE', { cancelIntento: 4 }),
    ).not.toBeNull()
    expect(
      await aplicarCancelacion(f.id, { cancelStatus: 'REJECTED', lastError: 'tarde' }, v, 'PENDIENTE', { cancelIntento: 4 }),
    ).toBeNull()
    expect(await fila(f.id)).toMatchObject({ status: 'CANCELLED', cancelStatus: 'CANCELLED' })
  })

  it('🔴 C2-32: un negativo nunca sube desde REJECTED (sólo el hecho confirmado lo hace)', async () => {
    const { f } = await timbrada()
    await prisma.cfdi.update({ where: { id: f.id }, data: { cancelStatus: 'REJECTED', cancelIntento: 4, cancelRequestedAt: new Date() } })
    const v = (await fila(f.id)).attempts
    expect(
      await aplicarCancelacion(f.id, { cancelStatus: 'REJECTED', lastError: 'otra vez' }, v, 'PENDIENTE', { cancelIntento: 4 }),
    ).toBeNull()
    expect(await aplicarCancelacion(f.id, { cancelAcusadaAt: new Date() }, v, 'PENDIENTE', { cancelIntento: 4 })).toBeNull()
    expect(await fila(f.id)).toMatchObject({ cancelStatus: 'REJECTED', lastError: null, cancelAcusadaAt: null })
  })

  it('🔴 C2-28: A toma la foto (enviada, sin acuse) y consulta «sin solicitud»; entretanto B guarda el acuse; A aplica tarde ⇒ su CAS pierde, la fila sigue REQUESTED con su acuse y la respuesta atrasada queda registrada', async () => {
    const espiaLogger = jest.spyOn(logger, 'info')
    const { f } = await timbrada()
    const hace2min = new Date(Date.now() - 2 * 60_000)
    await prisma.cfdi.update({
      where: { id: f.id },
      data: { cancelStatus: 'REQUESTED', cancelIntento: 1, cancelRequestedAt: hace2min, cancelEnviadaAt: hace2min, cancelMotivo: '02' },
    })
    const foto = await fila(f.id)
    fijarEstado(f.facturapiId!, 'rejected') // ronda 2 (N1): un «sin solicitud» en duda ya no escribe; la atrasada es un «rechazada»
    let soltar!: () => void
    const pausa = new Promise<void>(r => (soltar = r))
    const a = refreshPendingCancellation(foto, { sandbox: true }, { ...depsDeConsulta(), despuesDeConsultar: () => pausa })
    await esperarHasta(async () => provider.getCancellationStatus.mock.calls.length === 1)
    fijarEstado(f.facturapiId!, 'pending')
    await refreshPendingCancellation(await fila(f.id), { sandbox: true }, depsDeConsulta()) // B: guarda el acuse
    soltar()
    await a
    expect(await fila(f.id)).toMatchObject({ status: 'STAMPED', cancelStatus: 'REQUESTED', cancelAcusadaAt: expect.any(Date) })
    expect(espiaLogger).toHaveBeenCalledWith(
      expect.stringMatching(/respuesta atrasada ignorada/),
      expect.objectContaining({ cfdiId: f.id }),
    )
    espiaLogger.mockRestore()
  })

  it('🔴 lo detectado: un POST tardío (fuera de la relectura) abre un trámite que el receptor acepta ⇒ el webhook marca CANCELLED y deja CFDI_CANCELACION_TARDIA; si queda en trámite, vuelve a REQUESTED acusada, con el mismo registro', async () => {
    const { f } = await timbrada()
    await prisma.cfdi.update({
      where: { id: f.id },
      data: {
        cancelStatus: 'REJECTED',
        cancelIntento: 1,
        cancelEnviadaAt: new Date(),
        cancelMotivo: '02',
        lastError: 'El SAT no tiene la solicitud…',
      },
    })
    fijarEstado(f.facturapiId!, 'pending')
    await sincronizarCancelacionExterna(await fila(f.id), { sandbox: true })
    expect(await fila(f.id)).toMatchObject({ status: 'STAMPED', cancelStatus: 'REQUESTED', cancelAcusadaAt: expect.any(Date) })
    fijarEstado(f.facturapiId!, 'canceled')
    await refreshPendingCancellation(await fila(f.id), { sandbox: true })
    expect(await fila(f.id)).toMatchObject({ status: 'CANCELLED' })
    const tardias = await bitacora(f.id, 'CFDI_CANCELACION_TARDIA')
    expect(tardias).toHaveLength(1)
    expect(tardias[0].data).toMatchObject({
      cancelIntento: 1,
      lastError: 'El SAT no tiene la solicitud…',
      cancelStatus: 'REQUESTED',
    })
  })

  it('🔴 C2-22: 01 rechazada → 02 → repetir 02 ⇒ la misma intención (sin el UUID sustituto viejo), un solo intento y un solo envío', async () => {
    const { f } = await timbrada()
    await prisma.cfdi.update({
      where: { id: f.id },
      data: { cancelStatus: 'REJECTED', cancelMotivo: '01', cancelSubstituteUuid: 'UUID-VIEJO', cancelIntento: 1 },
    })
    await cancelar(f.id)
    expect(await fila(f.id)).toMatchObject({ cancelMotivo: '02', cancelSubstituteUuid: null, cancelIntento: 2 })
    expect(await cancelar(f.id)).toMatchObject({ enTramitePorOtro: true })
    expect(await fila(f.id)).toMatchObject({ cancelIntento: 2, cancelStatus: 'REQUESTED' })
    expect(provider.cancelInvoice).toHaveBeenCalledTimes(1)
  })

  it('C2: otra cancelación en trámite con OTRO motivo ⇒ conflicto con su texto, sin PAC', async () => {
    const { f } = await timbrada()
    await cancelar(f.id) // 02 en trámite
    await expect(cancelar(f.id, { motivo: '03' })).rejects.toThrow(/otro motivo/)
    expect(provider.cancelInvoice).toHaveBeenCalledTimes(1)
  })

  it('🔴 C2-21: estado y sellos en la MISMA transacción — si la transacción de afuera se revierte después del CAS y de liberar los sellos, no queda nada', async () => {
    const { f } = await timbrada()
    await prisma.cfdi.update({ where: { id: f.id }, data: { cancelStatus: 'REQUESTED', cancelIntento: 1, cancelRequestedAt: new Date() } })
    const sellosAntes = await sellosDe(f.id)
    expect(sellosAntes).toBeGreaterThan(0)
    await expect(
      prisma.$transaction(async tx => {
        expect(
          await aplicarCancelacion(
            f.id,
            { status: 'CANCELLED', cancelStatus: 'CANCELLED' },
            f.attempts,
            'PENDIENTE',
            { cancelIntento: 1 },
            tx,
          ),
        ).not.toBeNull()
        throw new Error('falla después de liberar')
      }),
    ).rejects.toThrow('falla después de liberar')
    expect(await fila(f.id)).toMatchObject({ status: 'STAMPED', cancelStatus: 'REQUESTED' })
    expect(await sellosDe(f.id)).toBe(sellosAntes)
  })

  it('🔴 respuesta tardía: el desenlace del intento 1 llega cuando ya hay un intento 2 ⇒ no lo pisa', async () => {
    const { f } = await timbrada()
    await prisma.cfdi.update({
      where: { id: f.id },
      data: { cancelStatus: 'REQUESTED', cancelIntento: 2, cancelRequestedAt: new Date(), cancelEnviadaAt: new Date() },
    })
    expect(
      await aplicarCancelacion(f.id, { cancelStatus: 'REJECTED', lastError: 'viejo' }, f.attempts, 'PENDIENTE', { cancelIntento: 1 }),
    ).toBeNull()
    expect(await fila(f.id)).toMatchObject({ cancelStatus: 'REQUESTED', cancelIntento: 2 })
  })

  it('🔴 carrera inversa (C2-6): una nota reservada y en pausa antes del envío ⇒ cancelar la original se rechaza nombrando la nota', async () => {
    const { o, f } = await timbrada()
    await reservarNotaSinEnviar(o.id, f)
    await expect(cancelar(f.id)).rejects.toThrow(/una nota de crédito en proceso/)
    expect(provider.cancelInvoice).not.toHaveBeenCalled()
    expect(provider.getCancellationStatus).not.toHaveBeenCalled()
    expect((await fila(f.id)).cancelStatus).toBeNull()
  })

  it('C2-6: una nota TIMBRADA se nombra por su folio; una nota heredada (sin protocolo) de la misma venta también bloquea', async () => {
    const { o, f } = await timbrada()
    const nota = await reservarNotaSinEnviar(o.id, f, { status: 'STAMPED', serie: 'NC', folio: '7', uuid: randomUUID() })
    await expect(cancelar(f.id)).rejects.toThrow(
      'Esta factura tiene la nota de crédito NC-7 vigente; el SAT exige cancelar primero lo relacionado.',
    )
    await prisma.cfdi.delete({ where: { id: nota.id } })
    await reservarNotaSinEnviar(
      o.id,
      { id: 'otra' },
      { status: 'STAMPED', protocoloIva: null, entrada: undefined, serie: 'NC', folio: '8', uuid: randomUUID() },
    )
    await expect(cancelar(f.id)).rejects.toThrow(/NC-8/)
    expect(provider.cancelInvoice).not.toHaveBeenCalled()
  })

  it('control — una nota muerta (validación fallida) no estorba: la cancelación sale', async () => {
    const { o, f } = await timbrada()
    await reservarNotaSinEnviar(o.id, f, { status: 'VALIDATION_FAILED' })
    await cancelar(f.id)
    expect(provider.cancelInvoice).toHaveBeenCalledTimes(1)
    expect(await fila(f.id)).toMatchObject({ cancelStatus: 'REQUESTED', cancelIntento: 1 })
  })

  it('🔴 G5b/M7: la cancelación REQUESTED de ANTES del despliegue queda enviada y acusada (backfill de la migración): la consulta la cierra con el texto verdadero y un «Cancelar» NO manda otro DELETE', async () => {
    const { f } = await timbrada()
    const hace2h = new Date(Date.now() - 2 * 60 * 60_000)
    await prisma.cfdi.update({
      where: { id: f.id },
      data: {
        cancelStatus: 'REQUESTED',
        cancelMotivo: '02',
        cancelRequestedAt: hace2h,
        cancelIntento: 0,
        cancelEnviadaAt: null,
        cancelAcusadaAt: null,
      },
    })
    // La sentencia EXACTA de la migración, acotada a esta fila (la base de integración es compartida).
    const sql = readFileSync(join(__dirname, '../../../prisma/migrations/20261008090000_cfdi_intento_de_cancelacion/migration.sql'), 'utf8')
    const update = sql.slice(sql.indexOf('UPDATE "Cfdi"'))
    expect(update).toMatch(/WHERE "cancelStatus" = 'REQUESTED';\s*$/)
    await prisma.$executeRawUnsafe(
      update.replace(/WHERE "cancelStatus" = 'REQUESTED';\s*$/, `WHERE "cancelStatus" = 'REQUESTED' AND id = $1`),
      f.id,
    )
    const despues = await fila(f.id)
    expect(despues).toMatchObject({ cancelIntento: 1, cancelEnviadaAt: hace2h, cancelAcusadaAt: hace2h })
    expect(estadoDeCancelacion(despues, new Date())).toBe('EN_TRAMITE')
    // Pulsar «Cancelar» sobre ella: la misma intención, ya enviada ⇒ sólo consulta (el PAC la tiene en trámite).
    fijarEstado(f.facturapiId!, 'pending')
    expect(await cancelar(f.id)).toMatchObject({ enTramitePorOtro: true, estado: 'EN_TRAMITE' })
    expect(provider.cancelInvoice).not.toHaveBeenCalled()
    // El receptor la rechaza: la consulta la cierra con el porqué verdadero (no «no se llegó a enviar»).
    fijarEstado(f.facturapiId!, 'rejected')
    await refreshPendingCancellation(await fila(f.id), { sandbox: true })
    expect(await fila(f.id)).toMatchObject({ cancelStatus: 'REJECTED', lastError: expect.stringMatching(/^El receptor rechazó/) })
    expect(provider.cancelInvoice).not.toHaveBeenCalled()
  })

  it('C2-7: el filtro del barrido con cursor, contra la base (orden `cancelRequestedAt`, `id`; ninguna se salta)', async () => {
    const t0 = new Date(Date.now() - 3 * 60 * 60_000)
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const { f } = await timbrada()
      await prisma.cfdi.update({ where: { id: f.id }, data: { cancelStatus: 'REQUESTED', cancelRequestedAt: t0 } }) // misma hora: desempata el id
      ids.push(f.id)
    }
    ids.sort()
    const cutoff = new Date(Date.now() - 60 * 60_000)
    const pagina = (cursor: { requestedAt: Date; id: string } | null) =>
      prisma.cfdi.findMany({
        where: { venueId, AND: [dondeBuscarCancelacionesPendientes(cutoff, cursor)] },
        orderBy: [{ cancelRequestedAt: 'asc' }, { id: 'asc' }],
        take: 2,
        select: { id: true, cancelRequestedAt: true },
      })
    const p1 = await pagina(null)
    expect(p1.map(x => x.id)).toEqual(ids.slice(0, 2))
    const p2 = await pagina({ requestedAt: p1[1].cancelRequestedAt!, id: p1[1].id })
    expect(p2.map(x => x.id)).toEqual([ids[2]])
    expect(await pagina({ requestedAt: t0, id: ids[2] })).toEqual([])
  })

  // 🔴 Tarea 3: la nota mira la cancelación en trámite de su original (`ORIGINAL_CANCEL_PENDING`) y la revisa bajo su candado.
  it('el orden inverso: la intención de cancelar ya está ⇒ la nota no se reserva (Tarea 3)', async () => {
    const { o, f } = await timbrada()
    await cancelar(f.id)
    const reembolso = await refund(o.id, 10)
    await expect(emitRefundCreditNote({ venueId, refundPaymentId: reembolso.id, sandbox: true })).rejects.toThrow(/cancelación en trámite/)
  })

  // ── C2 · Tarea 3: ninguna nota contra una original con cancelación en trámite. `REQUESTED` cubre ANOTADA, ENVIANDO, EN DUDA y EN
  // TRÁMITE; el botón (`getRefundCreditNoteStatus`, que también lee el MCP) lo DICE con su texto, y nada se reserva.
  const sinNota = async () => expect(await prisma.cfdi.count({ where: { venueId, type: 'EGRESO' } })).toBe(0)
  it.each([
    [
      'ANOTADA (sin enviar)',
      async (f: { id: string; attempts: number }) =>
        expect(await anotarIntencionDeCancelar(f.id, f.attempts, { motivo: '02' })).toMatchObject({ estado: 'ANOTADA' }),
      'ANOTADA',
      MOTIVO_ORIGINAL_CANCELACION_ENVIANDOSE,
    ],
    [
      'EN DUDA (la respuesta del PAC se perdió)',
      async (f: { id: string }) => {
        perderRespuesta()
        expect(await cancelar(f.id)).toMatchObject({ enDuda: true })
        // T10 (M2 de la T3): el botón lee el estado AHORA; el envío se fecha 2 min atrás para que ya esté pasado el umbral.
        await prisma.cfdi.update({ where: { id: f.id }, data: { cancelEnviadaAt: new Date(Date.now() - 2 * 60_000) } })
      },
      'CANCELACION_EN_DUDA',
      MOTIVO_ORIGINAL_CANCELACION_EN_DUDA,
    ],
    ['EN TRÁMITE (acusada)', async (f: { id: string }) => void (await cancelar(f.id)), 'EN_TRAMITE', MOTIVO_ORIGINAL_EN_CANCELACION],
    // T10 (M2 de la T3), cambio A PROPÓSITO: cada estado con su texto (antes los tres decían «en trámite ante el SAT»).
  ] as const)('🔴 T3: con la cancelación %s el botón dice por qué y la nota no se reserva', async (_caso, preparar, estado, mensaje) => {
    const { o, f } = await timbrada()
    await preparar(f)
    expect(estadoDeCancelacion(await fila(f.id), new Date(Date.now() + 2 * 60_000))).toBe(estado)
    const reembolso = await refund(o.id, 10)
    expect((await getRefundCreditNoteStatus(venueId, reembolso.id))!.eligibility).toEqual({
      eligible: false,
      reason: 'ORIGINAL_CANCEL_PENDING',
      message: mensaje,
    })
    await expect(emitRefundCreditNote({ venueId, refundPaymentId: reembolso.id, sandbox: true })).rejects.toThrow(mensaje)
    await sinNota()
  })

  it('control — T3: una cancelación RECHAZADA no estorba: el botón vuelve a ofrecer la nota', async () => {
    const { o, f } = await timbrada()
    await cancelar(f.id)
    fijarEstado(f.facturapiId!, 'rejected')
    await refreshPendingCancellation(await fila(f.id), { sandbox: true })
    expect((await fila(f.id)).cancelStatus).toBe('REJECTED')
    const reembolso = await refund(o.id, 10)
    expect((await getRefundCreditNoteStatus(venueId, reembolso.id))!.eligibility).toEqual({ eligible: true, reason: null, message: null })
  })

  it('🔴 T3 bajo candado: el botón se pintó con la original vigente y la intención se anota ANTES de que la nota tome el candado ⇒ la revisión bajo candado la detiene; ni fila ni PAC', async () => {
    const { o, f } = await timbrada()
    const reembolso = await refund(o.id, 10)
    const lecturas: Array<string | null> = []
    const cargar: typeof loadRefundForCreditNoteFromDb = async (...args) => {
      const r = await loadRefundForCreditNoteFromDb(...args)
      lecturas.push(r?.original?.cancelStatus ?? null)
      // La revisión inicial (fuera de la transacción) vio la original vigente; entre ella y el candado de la orden llega la intención.
      if (lecturas.length === 1)
        expect(await anotarIntencionDeCancelar(f.id, f.attempts, { motivo: '02' })).toMatchObject({ estado: 'ANOTADA' })
      return r
    }
    const createCreditNote = jest.fn(async () => {
      throw new Error('la nota NO debía llegar al PAC')
    })
    await expect(
      emitRefundCreditNote(
        { venueId, refundPaymentId: reembolso.id, sandbox: true },
        { loadRefundForCreditNote: cargar, resolveProvider: (() => ({ ...provider, createCreditNote })) as any },
      ),
      // T10 (M2 de la T3), cambio A PROPÓSITO: la intención sólo está ANOTADA ⇒ «se está enviando al SAT».
    ).rejects.toThrow(MOTIVO_ORIGINAL_CANCELACION_ENVIANDOSE)
    expect(lecturas).toEqual([null, 'REQUESTED'])
    expect(createCreditNote).not.toHaveBeenCalled()
    await sinNota()
  })

  // ── C2 · Tarea 2 · ronda de arreglos 1 (task-2-review.md) ─────────────────────────────────────────────────────────────────────

  /** Un envío cuyo POST se queda en vuelo hasta que la prueba lo suelte (el PAC doble registra el trámite al soltarlo). */
  function postEnVuelo() {
    let soltar!: () => void
    let entro!: () => void
    const dentro = new Promise<void>(r => (entro = r))
    const gate = new Promise<void>(r => (soltar = r))
    const pacReal = provider.cancelInvoice.getMockImplementation()!
    provider.cancelInvoice.mockImplementationOnce(async (q: any) => {
      entro()
      await gate
      return pacReal(q)
    })
    return { dentro, soltar }
  }

  it('🔴 I2 (escenario de la revisión): una consulta concurrente a los 61 s del token, con el POST todavía en vuelo ⇒ no cierra nada; el POST aterriza y el dueño acusa', async () => {
    const { f } = await timbrada()
    const vuelo = postEnVuelo()
    const a = cancelar(f.id)
    await vuelo.dentro
    const enVuelo = await fila(f.id)
    expect(enVuelo).toMatchObject({ cancelStatus: 'REQUESTED', cancelEnviadaAt: expect.any(Date), cancelAcusadaAt: null })
    const a61s = new Date(enVuelo.cancelEnviadaAt!.getTime() + 61_000) // el PAC todavía no tiene la solicitud
    await refreshPendingCancellation(enVuelo, { sandbox: true }, { ...depsDeConsulta(), now: () => a61s })
    expect(await fila(f.id)).toMatchObject({ cancelStatus: 'REQUESTED', lastError: null })
    vuelo.soltar()
    expect(await a).toMatchObject({ applied: true, cancelStatus: 'REQUESTED', estado: 'EN_TRAMITE' })
    expect(await fila(f.id)).toMatchObject({ cancelStatus: 'REQUESTED', cancelAcusadaAt: expect.any(Date) })
    expect(provider.cancelInvoice).toHaveBeenCalledTimes(1)
  })

  it('🔴 I2 (b): si una consulta ya cerró el intento (pasado el umbral) y DESPUÉS aterriza el POST del dueño, el dueño no lo descarta: REQUESTED acusada + CFDI_CANCELACION_TARDIA', async () => {
    const { f } = await timbrada()
    const vuelo = postEnVuelo()
    const a = cancelar(f.id)
    await vuelo.dentro
    const enVuelo = await fila(f.id)
    const tarde = new Date(enVuelo.cancelEnviadaAt!.getTime() + PLAZO_DE_LA_DUDA_MS + 1_000) // ronda 2 (N1): pasado el plazo de la duda
    await refreshPendingCancellation(enVuelo, { sandbox: true }, { ...depsDeConsulta(), now: () => tarde })
    expect(await fila(f.id)).toMatchObject({ cancelStatus: 'REJECTED', cancelIntento: 1 })
    vuelo.soltar() // el PAC registra el trámite y contesta «pending»
    expect(await a).toMatchObject({ cancelStatus: 'REQUESTED' })
    expect(await fila(f.id)).toMatchObject({
      status: 'STAMPED',
      cancelStatus: 'REQUESTED',
      cancelIntento: 1,
      cancelAcusadaAt: expect.any(Date),
    })
    const tardias = await bitacora(f.id, 'CFDI_CANCELACION_TARDIA')
    expect(tardias).toHaveLength(1)
    expect(tardias[0].data).toMatchObject({ cancelIntento: 1, providerStatus: 'pending' })
    expect(provider.cancelInvoice).toHaveBeenCalledTimes(1)
  })

  it('🔴 I2 (b) con «cancelada»: el POST tardío del dueño aterriza ya cancelada sobre un intento cerrado ⇒ CANCELLED, sellos liberados, confirmación y CFDI_CANCELACION_TARDIA (nunca sube en silencio)', async () => {
    const { f } = await timbrada()
    const sellosAntes = await sellosDe(f.id)
    cancelacionInmediata = true
    const vuelo = postEnVuelo()
    const a = cancelar(f.id)
    await vuelo.dentro
    const enVuelo = await fila(f.id)
    const tarde = new Date(enVuelo.cancelEnviadaAt!.getTime() + PLAZO_DE_LA_DUDA_MS + 1_000) // ronda 2 (N1): pasado el plazo de la duda
    await refreshPendingCancellation(enVuelo, { sandbox: true }, { ...depsDeConsulta(), now: () => tarde })
    expect(await fila(f.id)).toMatchObject({ cancelStatus: 'REJECTED', cancelIntento: 1 })
    vuelo.soltar() // el PAC la cancela al instante
    expect(await a).toMatchObject({ cancelStatus: 'CANCELLED' })
    expect(await fila(f.id)).toMatchObject({ status: 'CANCELLED', cancelStatus: 'CANCELLED', cancelIntento: 1 })
    expect(await sellosDe(f.id)).toBeLessThan(sellosAntes)
    expect(await bitacora(f.id, 'CFDI_CANCELACION_TARDIA')).toHaveLength(1)
    expect(await bitacora(f.id, 'CFDI_CANCEL_CONFIRMED')).toHaveLength(1)
  })

  it('🔴 M1: la consulta previa falla ⇒ 502 (ProviderUnavailableError), ningún POST, y el intento queda CERRADO «no se llegó a enviar» (no una «en duda» falsa)', async () => {
    const { f } = await timbrada()
    provider.getCancellationStatus.mockRejectedValueOnce(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))
    await expect(cancelar(f.id)).rejects.toBeInstanceOf(ProviderUnavailableError)
    expect(provider.cancelInvoice).not.toHaveBeenCalled()
    const despues = await fila(f.id)
    expect(despues).toMatchObject({
      status: 'STAMPED',
      cancelStatus: 'REJECTED',
      cancelIntento: 1,
      lastError: expect.stringMatching(/no se llegó a enviar/i),
    })
    expect(estadoDeCancelacion(despues, new Date(Date.now() + 10 * 60_000))).toBe('RECHAZADA')
    await cancelar(f.id) // la persona la vuelve a pedir: intento nuevo, que sí sale
    expect(await fila(f.id)).toMatchObject({ cancelStatus: 'REQUESTED', cancelIntento: 2, cancelAcusadaAt: expect.any(Date) })
    expect(provider.cancelInvoice).toHaveBeenCalledTimes(1)
  })

  it('🔴 M2: una REQUESTED escrita por el código VIEJO DESPUÉS del backfill (intento 0, sin token) es legado: «Cancelar» sólo consulta, NUNCA un segundo DELETE', async () => {
    const { f } = await timbrada()
    await prisma.cfdi.update({
      where: { id: f.id },
      data: {
        cancelStatus: 'REQUESTED',
        cancelMotivo: '02',
        cancelRequestedAt: new Date(),
        cancelIntento: 0,
        cancelEnviadaAt: null,
        cancelAcusadaAt: null,
      },
    })
    expect(estadoDeCancelacion(await fila(f.id), new Date())).toBe('EN_TRAMITE')
    fijarEstado(f.facturapiId!, 'rejected') // el receptor ya la había rechazado
    expect(await cancelar(f.id)).toMatchObject({ enTramitePorOtro: true })
    expect(provider.cancelInvoice).not.toHaveBeenCalled()
    expect(await fila(f.id)).toMatchObject({
      cancelStatus: 'REJECTED',
      cancelIntento: 0,
      lastError: expect.stringMatching(/^El receptor rechazó/),
    })
  })

  // ── C2 · Tarea 2 · ronda de arreglos 2 (task-2-rereview-1.md) ─────────────────────────────────────────────────────────────────

  /** Nuestro POST se corta (ETIMEDOUT) SIN que Facturapi registre todavía la solicitud: sigue procesándola de su lado. */
  function postCortadoSinRegistro() {
    provider.cancelInvoice.mockImplementationOnce(async () => {
      throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
    })
  }

  it('🔴 N1: el POST se corta, Facturapi sigue trabajando; una consulta a los 91 s ve «sin solicitud» y NO cierra; el SAT la cancela después y la consulta la aplica', async () => {
    const { f } = await timbrada()
    postCortadoSinRegistro()
    expect(await cancelar(f.id)).toMatchObject({ enDuda: true, estado: 'CANCELACION_EN_DUDA' })
    const enDuda = await fila(f.id)
    const a91s = new Date(enDuda.cancelEnviadaAt!.getTime() + 91_000)
    expect(estadoDeCancelacion(enDuda, a91s)).toBe('CANCELACION_EN_DUDA')
    await refreshPendingCancellation(enDuda, { sandbox: true }, { ...depsDeConsulta(), now: () => a91s })
    expect(await fila(f.id)).toMatchObject({ status: 'STAMPED', cancelStatus: 'REQUESTED', cancelAcusadaAt: null, lastError: null })
    fijarEstado(f.facturapiId!, 'canceled') // Facturapi terminó y el SAT la canceló (sin webhook)
    const enUnaHora = new Date(enDuda.cancelEnviadaAt!.getTime() + 61 * 60_000)
    await refreshPendingCancellation(await fila(f.id), { sandbox: true }, { ...depsDeConsulta(), now: () => enUnaHora }) // el barrido
    expect(await fila(f.id)).toMatchObject({ status: 'CANCELLED', cancelStatus: 'CANCELLED', cancelIntento: 1 })
    expect(await bitacora(f.id, 'CFDI_CANCEL_CONFIRMED')).toHaveLength(1)
    expect(provider.cancelInvoice).toHaveBeenCalledTimes(1)
  })

  it('🔴 N1: pasadas 24 h EN DUDA y el SAT sigue sin la solicitud ⇒ se cierra «no se llegó a cancelar», con ActivityLog', async () => {
    const { f } = await timbrada()
    postCortadoSinRegistro()
    await cancelar(f.id)
    const enDuda = await fila(f.id)
    const a24h = new Date(enDuda.cancelEnviadaAt!.getTime() + PLAZO_DE_LA_DUDA_MS + 1_000)
    await refreshPendingCancellation(enDuda, { sandbox: true }, { ...depsDeConsulta(), now: () => a24h })
    expect(await fila(f.id)).toMatchObject({
      status: 'STAMPED',
      cancelStatus: 'REJECTED',
      cancelIntento: 1,
      lastError: MOTIVO_SIN_SOLICITUD_EN_EL_PLAZO,
    })
    const registros = await bitacora(f.id, 'CFDI_CANCEL_NOT_APPLIED')
    expect(registros).toHaveLength(1)
    expect(registros[0].data).toMatchObject({ providerStatus: 'none', estadoPrevio: 'CANCELACION_EN_DUDA', cancelIntento: 1 })
  })

  it('🔴 N1: el barrido vuelve a consultar los cierres recientes de intentos ENVIADOS; si el SAT terminó cancelándola, la vía externa la aplica (CFDI_CANCELACION_TARDIA)', async () => {
    const { f } = await timbrada()
    // Un envío cerrado hace un momento (p. ej. «rechazada» sobre un envío en duda): REJECTED, intento 1, con token y sin acuse.
    await prisma.cfdi.update({
      where: { id: f.id },
      data: {
        cancelStatus: 'REJECTED',
        cancelIntento: 1,
        cancelEnviadaAt: new Date(),
        cancelMotivo: '02',
        lastError: 'El receptor rechazó…',
      },
    })
    // Dos que NO entran: una intención nunca enviada (sin token) y una cancelación de antes de C2 (intento 0).
    const { f: sinToken } = await timbrada()
    await prisma.cfdi.update({ where: { id: sinToken.id }, data: { cancelStatus: 'REJECTED', cancelIntento: 1, cancelEnviadaAt: null } })
    const { f: legado } = await timbrada()
    await prisma.cfdi.update({
      where: { id: legado.id },
      data: { cancelStatus: 'REJECTED', cancelIntento: 0, cancelEnviadaAt: new Date() },
    })
    const desde = new Date(Date.now() - PLAZO_DE_LA_DUDA_MS)
    const recientes = await prisma.cfdi.findMany({
      where: { venueId, AND: [dondeBuscarCierresRecientes(desde, null)] },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: 50,
      include: { fiscalEmisor: true },
    })
    expect(recientes.map(r => r.id)).toEqual([f.id])
    fijarEstado(f.facturapiId!, 'canceled')
    await sincronizarCancelacionExterna(recientes[0], { sandbox: true }) // lo que el barrido llama para cada cierre reciente
    expect(await fila(f.id)).toMatchObject({ status: 'CANCELLED', cancelStatus: 'CANCELLED' })
    expect(await bitacora(f.id, 'CFDI_CANCELACION_TARDIA')).toHaveLength(1)
  })

  it('🔴 N7: el token del envío se fija DESPUÉS de tomar el candado de la fila (la espera del candado no se come la ventana del envío)', async () => {
    const { f } = await timbrada()
    await prisma.cfdi.update({
      where: { id: f.id },
      data: { cancelStatus: 'REQUESTED', cancelIntento: 1, cancelRequestedAt: new Date(), cancelMotivo: '02' },
    })
    let soltar!: () => void
    let tomado!: () => void
    const candado = new Promise<void>(r => (tomado = r))
    const gate = new Promise<void>(r => (soltar = r))
    const holder = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Cfdi" WHERE id = ${f.id} FOR UPDATE`
        tomado()
        await gate
      },
      { timeout: 15000 },
    )
    await candado
    const pedido = new Date()
    const toma = tomarEnvio(f.id, 1, pedido)
    await new Promise(r => setTimeout(r, 1_500))
    soltar()
    await holder
    const token = await toma
    expect(token).not.toBeNull()
    expect(token!.getTime()).toBeGreaterThanOrEqual(pedido.getTime() + 1_400)
    expect((await fila(f.id)).cancelEnviadaAt).toEqual(token)
  })
})
