/**
 * IVA por producto, bloque C3, contra una base de pruebas propia: la NOTA DE EXTRACCIÓN de un ticket que entró en la factura GLOBAL (Tarea 2)
 * — y, en la Tarea 4, la factura del cliente que sale de ella —.
 * - una por (global, ticket); se recaptura sólo antes del envío (C3-17) o tras un rechazo DEFINITIVO, con identidad nueva (M4); lo enviado
 *   en duda se recupera PRIMERO por su identidad, sin pedir el XML de la global (C3-20);
 * - `CFDI_EXTRACCION_EMITIDA` se escribe en un solo lugar, una sola vez por la llave única, con su actor (C3-22/C3-23), y el job repone el
 *   que se perdió si el proceso cayó entre el timbre y el registro (C3-23/C3-24).
 * El PAC es SIEMPRE un doble de prueba (Facturapi nunca real); su `downloadXml` arma el XML de lo que se le mandó (`xmlDeLaFila`).
 */
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))
jest.mock('@/services/storage.service', () => ({
  ...jest.requireActual('@/services/storage.service'),
  uploadFileToStorage: jest.fn(async () => 'https://test/file'),
}))
import { Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import {
  contarExcluidasPorConfiguracion,
  filtrosDeExclusion,
  issueGlobalForEmisor,
  listarExcluidasDeLaGlobal,
  loadGlobalCandidates,
} from '@/services/fiscal/cfdiGlobal.service'
import {
  emitRefundCreditNote,
  getRefundCreditNoteStatus,
  MOTIVO_EXTRAIDA_SIN_FACTURA,
  olvidarGlobalesEvaluadas,
} from '@/services/fiscal/cfdiCreditNote.service'
import { closedPeriodFor } from '@/services/fiscal/globalPeriod'
import {
  emitirExtraccion,
  llaveDeExtraccion,
  motivoExtraccionCancelada,
  motivoExtraccionSinGlobal,
} from '@/services/fiscal/cfdiExtraccion.service'
import {
  anotarIntencionDeCancelar,
  cancelCfdi,
  defaultCancelDeps,
  extraccionesPendientes,
  issueCfdiForOrder,
  listCfdisForVenue,
  MOTIVO_AUTOFACTURA_CON_DEVOLUCION,
} from '@/services/fiscal/cfdi.service'
import { MOTIVO_REMANENTE_NO_TRAZABLE } from '@/services/fiscal/nominativaPorExtraccion'
import { replaceCfdi } from '@/services/fiscal/cfdiReplacement.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import { ProviderHttpError } from '@/services/fiscal/providers/facturapi.provider'
import * as cfdiService from '@/services/fiscal/cfdi.service'
import * as reconcileService from '@/services/fiscal/cfdiReconcile.service'
import * as finalizadorCfdi from '@/services/fiscal/finalizadorCfdi'
import { CfdiReconcileJob } from '@/jobs/cfdiReconcile.job'
import { xmlDeLaFila } from '../../__helpers__/xml-del-pac'
import { encenderIvaPorProducto } from '../../__helpers__/iva-por-producto'

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

const NOW = new Date('2026-06-03T17:00:00Z')
const CLAVE_CAFE = { satProductKey: '50201706', satUnitKey: 'H87' }
const receptor = { rfc: 'EKU9003173C9', razonSocial: 'ESCUELA KEMPER URGATE', regimenFiscal: '601', codigoPostal: '64000', usoCfdi: 'G03' }
const MAYO = new Date('2026-05-15T12:00:00Z')
const valid = () => ({
  providerInvoiceId: randomUUID(),
  uuid: randomUUID(),
  serie: 'E',
  folio: String(Math.floor(Math.random() * 1e6)),
  totalCents: 0,
  stampedAt: new Date(),
  status: 'valid' as const,
})

/** Sondea cada 20 ms hasta 5 s. */
async function esperarHasta(fn: () => Promise<boolean>) {
  for (let i = 0; i < 250; i++) {
    if (await fn()) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('esperarHasta: no se cumplió en 5 s')
}

describe('C3 · la nota de extracción de un ticket que está en la factura global', () => {
  const fixture = `extraccion-${randomUUID()}`
  const m1 = fixture
  let venueId: string
  let p16: string
  let p0: string
  let fiscalEmisorId: string
  let s1: string
  let s2: string
  const provider = {
    name: 'facturapi',
    createInvoice: jest.fn(),
    createGlobalInvoice: jest.fn(),
    createCreditNote: jest.fn(),
    cancelInvoice: jest.fn(),
    findByExternalId: jest.fn(),
    getInvoice: jest.fn(),
    downloadXml: jest.fn(),
    downloadPdf: jest.fn(),
  }

  beforeAll(async () => {
    await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
    venueId = (await prisma.venue.create({ data: { id: fixture, organizationId: fixture, name: fixture, slug: fixture } })).id
    await encenderIvaPorProducto(venueId)
    const category = await prisma.menuCategory.create({ data: { venueId, name: fixture, slug: fixture } })
    p16 = (
      await prisma.product.create({ data: { venueId, categoryId: category.id, name: `${fixture}-16`, sku: `${fixture}-16`, price: 116 } })
    ).id
    p0 = (
      await prisma.product.create({
        data: {
          venueId,
          categoryId: category.id,
          name: `${fixture}-0`,
          sku: `${fixture}-0`,
          price: 200,
          ivaTratamiento: 'IVA_0',
          satProductKey: CLAVE_CAFE.satProductKey, // T4: la factura del cliente lleva la clave y la unidad REALES del producto
          satUnitKey: CLAVE_CAFE.satUnitKey,
        },
      })
    ).id
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
    await prisma.merchantAccount.create({ data: { id: m1, providerId: fixture, externalMerchantId: m1, credentialsEncrypted: {} } })
    await prisma.merchantFiscalConfig.create({
      data: { merchantAccountId: m1, fiscalEmisorId, facturacionEnabled: true, autofacturaEnabled: true, includeInGlobal: true },
    })
    s1 = (await prisma.staff.create({ data: { email: `${fixture}-s1@staff.test`, firstName: 'Extrae', lastName: 'Uno' } })).id
    s2 = (await prisma.staff.create({ data: { email: `${fixture}-s2@staff.test`, firstName: 'Extrae', lastName: 'Dos' } })).id
  })

  async function limpiarVentas() {
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
    await limpiarVentas()
    olvidarGlobalesEvaluadas()
    finalizadorCfdi.olvidarReparaciones() // M2: la reparación compartida recuerda en memoria del proceso
    jest.clearAllMocks()
    for (const f of Object.values(provider)) if (typeof f === 'function') (f as jest.Mock).mockReset()
    jest.mocked(resolveFiscalProvider).mockReturnValue(provider as any)
    provider.createInvoice.mockImplementation(async () => valid())
    provider.createGlobalInvoice.mockImplementation(async () => valid())
    provider.createCreditNote.mockImplementation(async () => valid())
    provider.findByExternalId.mockResolvedValue(null)
    provider.getInvoice.mockResolvedValue(null)
    provider.downloadXml.mockImplementation(async (id: string) => xmlDeLaFila(prisma, id))
    provider.downloadPdf.mockResolvedValue(Buffer.from('%PDF'))
  })
  afterEach(() => jest.restoreAllMocks())
  afterAll(async () => {
    if (!venueId) return
    await limpiarVentas()
    await prisma.staff.deleteMany({ where: { id: { in: [s1, s2].filter(Boolean) } } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisorId } })
    await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
    await prisma.merchantAccount.deleteMany({ where: { id: m1 } })
    await prisma.paymentProvider.deleteMany({ where: { id: fixture } })
    await prisma.venue.delete({ where: { id: venueId } })
    await prisma.organization.delete({ where: { id: fixture } })
  })

  /** Una venta de mayo cobrada con tarjeta del comercio m1 (entra a la global de mayo); su folio es su `orderNumber`. */
  async function venta(renglones: Array<{ productId: string; precio: number }>) {
    const total = renglones.reduce((s, r) => s + r.precio, 0)
    return prisma.order.create({
      data: {
        venueId,
        orderNumber: `F-${randomUUID().slice(0, 8)}`,
        subtotal: total,
        taxAmount: 0,
        total,
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        items: {
          create: renglones.map(r => ({
            productId: r.productId,
            productName: 'Producto',
            quantity: 1,
            unitPrice: r.precio,
            taxAmount: 0,
            total: r.precio,
          })),
        },
        payments: {
          create: {
            venueId,
            merchantAccountId: m1,
            amount: total,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: total,
            method: 'CREDIT_CARD',
            status: 'COMPLETED',
            createdAt: MAYO,
          },
        },
      },
      include: { items: true },
    })
  }
  /** La global de mayo, timbrada con el doble del PAC (y con su XML: `completarArchivos` escribe `xmlConceptos`). */
  async function laGlobal() {
    const g = await issueGlobalForEmisor({ emisorId: fiscalEmisorId, now: NOW, sandbox: true })
    expect(g.status).toBe('STAMPED')
    const fila = await prisma.cfdi.findUniqueOrThrow({ where: { id: g.cfdi.id } })
    expect(fila.xmlConceptos).not.toBeNull()
    return fila
  }
  const extraer = (orderId: string, staffId: string | null = null, over: Record<string, unknown> = {}) =>
    emitirExtraccion({ venueId, orderId, sandbox: true, staffId, comprobarNominativa: async () => [] }, over)
  const laExtraccion = (globalId: string, orderId: string) =>
    prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: llaveDeExtraccion(globalId, orderId) } })
  /** El PAC sí tenía el egreso que se le mandó con esa identidad (la respuesta se perdió en el camino). */
  function timbradaEnElPac(enviado: { externalId: string }) {
    const pac = valid()
    provider.findByExternalId.mockImplementation(async (id: string) => (id === enviado.externalId ? pac : null))
    provider.getInvoice.mockImplementation(async (id: string) => (id === pac.providerInvoiceId ? pac : null))
    return pac
  }
  const eventos = (orderId: string) =>
    prisma.activityLog.findMany({ where: { action: 'CFDI_EXTRACCION_EMITIDA', data: { path: ['orderId'], equals: orderId } } })

  it('🔴 el ticket mezclado sale de la global: Público en General, G02, PUE, relacionado con la global, NoIdentificacion = folio; un evento con su actor', async () => {
    const t = await venta([
      { productId: p0, precio: 200 },
      { productId: p16, precio: 58 },
    ])
    const g = await laGlobal()
    const r = await extraer(t.id, s1)
    expect(r.status).toBe('STAMPED')
    const enviado = provider.createCreditNote.mock.calls[0][0]
    expect(enviado).toMatchObject({
      externalId: `${llaveDeExtraccion(g.id, t.id)}#1`,
      metodoPago: 'PUE',
      formaPago: '04',
      relationship: '01',
      relatedUuids: [g.uuid],
      receptor: { rfc: 'XAXX010101000', razonSocial: 'PÚBLICO EN GENERAL', regimenFiscal: '616', usoCfdi: 'G02' },
    })
    expect(enviado.items.map((i: any) => [i.unitPriceCents, i.sku, i.satProductKey])).toEqual([
      [5800, t.orderNumber, '84111506'],
      [20000, t.orderNumber, '84111506'],
    ])
    const ext = await laExtraccion(g.id, t.id)
    expect(ext).toMatchObject({ status: 'STAMPED', type: 'EGRESO', orderId: t.id, totalCents: 25800, flow: 'STAFF_B' })
    expect((ext.entrada as any).remanentes.map((x: any) => x.orderItemId).sort()).toEqual(t.items.map(i => i.id).sort())
    const logs = await eventos(t.id)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ entityId: ext.id, staffId: s1, data: { generacion: 1 } }) // T4 (pendiente 2 de la T2)
  })

  it('🔴 C3-17: B lee la extracción reservada SIN enviar; A adquiere el envío; B intenta recapturar ⇒ su CAS (con `enviadoAt: null`) pierde: UN solo egreso, nunca dos identidades', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const g = await laGlobal()
    const key = llaveDeExtraccion(g.id, t.id)
    let soltarA!: () => void, soltarB!: () => void, soltarPacA!: () => void
    const pausaA = new Promise<void>(r => (soltarA = r))
    const pausaB = new Promise<void>(r => (soltarB = r))
    const pacA = new Promise<void>(r => (soltarPacA = r))
    // El PAC de A no contesta hasta que B terminó: así, cuando B intenta su CAS, la fila de A sigue STAMPING con su versión, y lo ÚNICO que
    // la protege es la marca de envío.
    provider.createCreditNote.mockImplementationOnce(async () => {
      await pacA
      return valid()
    })
    let bLeyo = false
    const a = extraer(t.id, null, { antesDeEnviar: () => pausaA })
    let b: ReturnType<typeof extraer> | undefined
    try {
      await esperarHasta(async () => (await prisma.cfdi.count({ where: { idempotencyKey: key, status: 'STAMPING' } })) === 1)
      b = extraer(t.id, null, { despuesDeLeerLaExtraccion: () => ((bLeyo = true), pausaB) })
      await esperarHasta(async () => bLeyo)
      soltarA() // A adquiere `enviadoAt` y manda (su PAC se queda esperando)
      await esperarHasta(async () => !!(await prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: key } })).enviadoAt)
      soltarB()
      await Promise.allSettled([b])
    } finally {
      soltarA()
      soltarB()
      soltarPacA()
    }
    const [ra, rb] = await Promise.allSettled([a, b!])
    expect(ra).toMatchObject({ status: 'fulfilled', value: { status: 'STAMPED' } })
    expect(rb).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringMatching(/se está procesando/) }),
    })
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    expect((await prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: key } })).attempts).toBe(1)
  })

  it('🔴 M4: una extracción enviada y RECHAZADA en definitiva por el PAC se reintenta: consulta la identidad anterior y recaptura con identidad nueva (#2)', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const g = await laGlobal()
    const key = llaveDeExtraccion(g.id, t.id)
    provider.createCreditNote.mockRejectedValueOnce(new ProviderHttpError(422, 'invoice_stamping_validation_error', 'falla'))
    expect((await extraer(t.id)).status).toBe('STAMP_FAILED')
    expect(await laExtraccion(g.id, t.id)).toMatchObject({ status: 'STAMP_FAILED', falloDefinitivo: true, attempts: 1 })
    expect(await extraer(t.id, s1)).toMatchObject({ status: 'STAMPED' })
    expect(provider.findByExternalId).toHaveBeenCalledWith(`${key}#1`) // primero, la identidad anterior
    expect(provider.createCreditNote.mock.calls.map(c => c[0].externalId)).toEqual([`${key}#1`, `${key}#2`])
    expect(await laExtraccion(g.id, t.id)).toMatchObject({ status: 'STAMPED', attempts: 2 })
    expect(await prisma.cfdi.count({ where: { idempotencyKey: key } })).toBe(1)
    expect(await eventos(t.id)).toHaveLength(1)
  })

  it('🔴 C3-20/C3-22: la respuesta del egreso se perdió y la global se quedó sin XML: se recupera PRIMERO por su identidad (sin pedir el XML) y registra CFDI_EXTRACCION_EMITIDA con su actor, una sola vez', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const g = await laGlobal()
    provider.createCreditNote.mockRejectedValueOnce(new Error('ECONNRESET'))
    expect((await extraer(t.id, s1)).status).not.toBe('STAMPED')
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    timbradaEnElPac(provider.createCreditNote.mock.calls.at(-1)![0])
    await prisma.cfdi.update({ where: { id: g.id }, data: { xmlConceptos: Prisma.DbNull } })
    const reparar = jest.fn()
    expect(await extraer(t.id, s1, { repararArchivos: reparar })).toMatchObject({ status: 'STAMPED' })
    expect(reparar).not.toHaveBeenCalled()
    expect(await eventos(t.id)).toMatchObject([{ staffId: s1 }]) // la RECUPERACIÓN registra (no espera a la siguiente llamada)
    expect(await extraer(t.id, s1)).toMatchObject({ status: 'STAMPED' })
    const logs = await eventos(t.id)
    expect(logs).toHaveLength(1)
    expect(logs[0].staffId).toBe(s1)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })

  it('🔴 C3-23: dos recuperaciones a la vez del mismo timbre ⇒ UN solo `CFDI_EXTRACCION_EMITIDA` (la llave única, no un conteo)', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    provider.createCreditNote.mockRejectedValueOnce(new Error('ECONNRESET'))
    await extraer(t.id, s1)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    timbradaEnElPac(provider.createCreditNote.mock.calls.at(-1)![0])
    await Promise.allSettled([extraer(t.id, s1), extraer(t.id, s1)])
    expect(await eventos(t.id)).toHaveLength(1)
  })

  // 🔴 C3-24 (v7): la caída se provoca en la ESCRITURA REAL del evento —el `create` del cliente global que usa `registrarExtraccionEmitida`—,
  // no espiando la exportación. Precedente: `tests/integration/payments/paymentDashboard.protocolo.integration.test.ts:344`. Sólo cae UNA vez
  // y sólo esa acción.
  const caerAlRegistrar = () => {
    const real = prisma.activityLog.create.bind(prisma.activityLog)
    let pendiente = true
    return jest.spyOn(prisma.activityLog, 'create').mockImplementation((async (args: Parameters<typeof real>[0]) => {
      if (pendiente && (args as { data?: { action?: string } }).data?.action === 'CFDI_EXTRACCION_EMITIDA') {
        pendiente = false
        throw new Error('caída simulada entre el timbre y el registro')
      }
      return real(args)
    }) as never)
  }
  /** El timbre queda guardado y el evento no: el estado exacto de un proceso que cayó entre finalizar y registrar. */
  async function timbreSinEvento() {
    const t = await venta([{ productId: p16, precio: 116 }])
    const g = await laGlobal()
    const sonda = caerAlRegistrar()
    await expect(extraer(t.id, s1)).rejects.toThrow('caída simulada')
    sonda.mockRestore()
    const ext = await laExtraccion(g.id, t.id)
    expect(ext).toMatchObject({ status: 'STAMPED', uuid: expect.any(String) }) // el timbre se guardó
    expect(await eventos(t.id)).toHaveLength(0) // el evento no
    return { t, ext }
  }
  /**
   * Una pasada REAL del job (`runNow`) sin salir a la red: el barrido horario de cancelaciones, la conciliación de timbres atorados y la
   * reparación de archivos se apagan con espías ENTRE módulos (el job los importa de otro módulo, así que el espía sí los sustituye). 🔴 M2
   * (pre-flight): el job llama a `repararArchivosCompartido`, NO a `repararArchivosDe` (que ésa invoca por dentro): se espía la que el job
   * llama. La pasada de eventos de extracción corre tal cual.
   */
  async function pasadaDelJob() {
    const reparar = jest.spyOn(finalizadorCfdi, 'repararArchivosCompartido').mockResolvedValue('OK' as never)
    const espias = [
      jest.spyOn(cfdiService, 'tocaRevisarCancelaciones').mockReturnValue(false),
      jest.spyOn(reconcileService, 'reconcileStuckCfdi').mockResolvedValue({ outcome: 'SKIPPED' } as never),
      reparar,
    ]
    try {
      await new CfdiReconcileJob().runNow()
      return { repararLlamadasCon: reparar.mock.calls.map(c => c[0]) } // antes del `mockRestore`, que también borra las llamadas
    } finally {
      espias.forEach(e => e.mockRestore())
    }
  }
  const haceOnceMinutos = () => new Date(Date.now() - 11 * 60_000)
  /** Timbrada (y tocada por última vez) hace 11 min: fuera de la ventana del camino del usuario (T4: el corte mira `stampedAt` y `updatedAt`). */
  const timbradaHaceOnce = () => {
    const t = haceOnceMinutos()
    return { stampedAt: t, updatedAt: t }
  }

  it('🔴 C3-23/C3-24: el timbre se guarda y el proceso cae ANTES del evento; NADIE vuelve a llamar ⇒ la pasada del job lo registra, una vez (sin actor: se perdió con el proceso)', async () => {
    const { t, ext } = await timbreSinEvento()
    await prisma.cfdi.update({ where: { id: ext.id }, data: timbradaHaceOnce() }) // fuera de la ventana del camino del usuario
    await pasadaDelJob()
    const logs = await eventos(t.id)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ entityId: ext.id, staffId: null })
  })
  it('🔴 C3-24 (M2): el aislamiento es REAL — con una fila de archivos incompletos seleccionable el job llama a `repararArchivosCompartido` (interceptada) y no sale a la red', async () => {
    const { ext } = await timbreSinEvento()
    await prisma.cfdi.update({ where: { id: ext.id }, data: { xmlConceptos: Prisma.DbNull, ...timbradaHaceOnce() } })
    provider.downloadXml.mockClear()
    const { repararLlamadasCon } = await pasadaDelJob()
    expect(repararLlamadasCon).toContain(ext.id) // sin esto, la prueba de arriba podría estar corriendo la reparación real sin saberlo
    expect(provider.downloadXml).not.toHaveBeenCalled()
  })
  it('🔴 C3-23 (v8): timbrada → cae antes del evento → se CANCELA antes del barrido ⇒ el barrido registra exactamente UN evento de emisión histórica, también en un segundo barrido', async () => {
    const { t, ext } = await timbreSinEvento()
    await prisma.cfdi.update({
      where: { id: ext.id },
      data: { ...timbradaHaceOnce(), status: 'CANCELLED', cancelStatus: 'ACCEPTED' },
    }) // cancelada y confirmada; conserva uuid y stampedAt
    await pasadaDelJob()
    await pasadaDelJob() // barrido repetido: el `NOT EXISTS` y el índice único lo dejan en uno
    const logs = await eventos(t.id)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ entityId: ext.id, staffId: null })
  })
  it('🔴 C3-23: recién timbrada (menos de 10 min) el job NO la toca: el camino del usuario puede estar registrándola con su actor', async () => {
    const { t } = await timbreSinEvento()
    await pasadaDelJob()
    expect(await eventos(t.id)).toHaveLength(0)
  })
  it('🔴 C3-23: sin duplicados — la siguiente llamada del usuario la registra con SU actor; después ni el job ni otra llamada agregan otro', async () => {
    const { t, ext } = await timbreSinEvento()
    expect(await extraer(t.id, s1)).toMatchObject({ status: 'STAMPED' })
    await prisma.cfdi.update({ where: { id: ext.id }, data: timbradaHaceOnce() })
    await pasadaDelJob()
    await extraer(t.id, s2)
    const logs = await eventos(t.id)
    expect(logs).toHaveLength(1)
    expect(logs[0].staffId).toBe(s1)
  })
  it('🔴 B15: el actor ya no existe (dado de baja) ⇒ el evento se escribe igual, sin actor (nunca revienta el pedido cada vez)', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    expect(await extraer(t.id, 'staff-que-no-existe')).toMatchObject({ status: 'STAMPED' })
    const logs = await eventos(t.id)
    expect(logs).toHaveLength(1)
    expect(logs[0].staffId).toBeNull()
    expect(logs[0].data).toMatchObject({ unknownStaffId: 'staff-que-no-existe' }) // T4 (pendiente 3): como `logAction`
  })
  it('🔴 T4 (pendiente 1): timbrada hace rato pero recién FINALIZADA o recuperada (updatedAt reciente) ⇒ el job no le gana al usuario', async () => {
    const { t, ext } = await timbreSinEvento()
    await prisma.cfdi.update({ where: { id: ext.id }, data: { stampedAt: haceOnceMinutos() } }) // el timbre del PAC es viejo; la fila, de ahora
    await pasadaDelJob()
    expect(await eventos(t.id)).toHaveLength(0)
  })
  // ─── Tarea 4: la factura del cliente — primero se comprueba, luego se extrae y la factura sale de lo extraído ───────────────────────────
  const issue = (orderId: string, flow?: 'STAFF_B' | 'AUTOFACTURA_A') =>
    issueCfdiForOrder(
      { orderId, receptor, sandbox: true, expectedVenueId: venueId, ...(flow ? { flow } : {}) },
      { resolveProvider: () => provider as any },
    )
  const extracciones = (orderId: string) => prisma.cfdi.count({ where: { orderId, idempotencyKey: { startsWith: 'cfdi-extraccion-' } } })
  const articulo = (t: Awaited<ReturnType<typeof venta>>, cual: 'pan' | 'cafe') =>
    t.items.find(i => i.productId === (cual === 'pan' ? p16 : p0))!
  /** Un reembolso por ARTÍCULOS como lo guarda el dashboard (`processorData.refundedItems` con cantidad e importe). */
  async function refundItems(t: Awaited<ReturnType<typeof venta>>, cuales: Array<{ id: 'pan' | 'cafe'; amountCents?: number }>) {
    const filas = cuales.map(c => {
      const it = articulo(t, c.id)
      return { orderItemId: it.id, quantity: 1, amountCents: c.amountCents ?? Math.round(Number(it.total) * 100) }
    })
    const cents = filas.reduce((s, f) => s + f.amountCents, 0)
    return prisma.payment.create({
      data: {
        venueId,
        orderId: t.id,
        type: 'REFUND',
        amount: -cents / 100,
        tipAmount: 0,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -cents / 100,
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        processorData: { refundedItems: filas },
      },
    })
  }
  /** Un reembolso por IMPORTE (sin artículos). */
  const refundAmount = (t: { id: string }, pesos: number) =>
    prisma.payment.create({
      data: {
        venueId,
        orderId: t.id,
        type: 'REFUND',
        amount: -pesos,
        tipAmount: 0,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -pesos,
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
      },
    })
  /** Pausa determinista tras la comprobación previa: el gancho marca que llegó y espera a que la prueba la suelte. */
  function pausaTrasLaComprobacion() {
    let soltar!: () => void
    let alcanzada = false
    const pausa = new Promise<void>(r => (soltar = r))
    return { gancho: () => ((alcanzada = true), pausa), soltar: () => soltar(), alcanzada: async () => alcanzada }
  }
  /** La cuenta de cobro de la venta pasa a OTRO emisor del mismo negocio (un cambio de configuración real). Devuelve cómo deshacerlo. */
  async function cambiarEmisorDeLaVenta() {
    const otro = await prisma.fiscalEmisor.create({
      data: {
        venueId,
        rfc: 'BBB010101BBB',
        legalName: `${fixture}-otro`,
        regimenFiscal: '601',
        lugarExpedicion: '01000',
        csdStatus: 'ACTIVE',
      },
    })
    await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { fiscalEmisorId: otro.id } })
    return async () => {
      await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { fiscalEmisorId } })
      await prisma.fiscalEmisor.delete({ where: { id: otro.id } })
    }
  }

  it('🔴 C3-11: el PAC timbra la extracción y se pierde la respuesta ⇒ el reintento la RECUPERA por su identidad (sin comprobación previa) y sigue a la factura del cliente, sin segundo egreso', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    provider.createCreditNote.mockRejectedValueOnce(new Error('ECONNRESET'))
    expect((await issue(t.id)).status).not.toBe('STAMPED')
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    timbradaEnElPac(provider.createCreditNote.mock.calls.at(-1)![0]) // el PAC sí la tenía
    const previaVista = jest.fn(async () => undefined)
    const r = await issueCfdiForOrder(
      { orderId: t.id, receptor, sandbox: true, expectedVenueId: venueId },
      { despuesDeLaComprobacionPrevia: previaVista, resolveProvider: () => provider as any },
    )
    expect(r).toMatchObject({ status: 'STAMPED', cfdi: { type: 'INGRESO', totalCents: 11600 } })
    expect(previaVista).not.toHaveBeenCalled() // lo enviado se recupera sin comprobación previa (C3-20)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    expect(await extracciones(t.id)).toBe(1)
  })

  it('C3-11: la extracción enviada e incierta que el PAC NO tiene ⇒ se detiene «se está procesando», sin segundo egreso ni factura', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    provider.createCreditNote.mockRejectedValueOnce(new Error('ECONNRESET'))
    await issue(t.id)
    await expect(issue(t.id)).rejects.toThrow(/se está procesando/)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    expect(provider.createInvoice).not.toHaveBeenCalled()
  })

  it('🔴 C3-20: extracción timbrada con la respuesta perdida; DESPUÉS se apaga la facturación ⇒ el reintento recupera la extracción PRIMERO (sin segundo egreso) y la factura del cliente —efecto nuevo— se detiene con su motivo', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    provider.createCreditNote.mockRejectedValueOnce(new Error('ECONNRESET'))
    await issue(t.id)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    timbradaEnElPac(provider.createCreditNote.mock.calls.at(-1)![0])
    await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { facturacionEnabled: false } })
    try {
      await expect(issue(t.id)).rejects.toThrow(/Facturación no habilitada/)
      expect(
        await prisma.cfdi.findFirstOrThrow({ where: { orderId: t.id, idempotencyKey: { startsWith: 'cfdi-extraccion-' } } }),
      ).toMatchObject({ status: 'STAMPED' })
      expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
      expect(provider.createInvoice).not.toHaveBeenCalled()
    } finally {
      await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { facturacionEnabled: true } })
    }
  })

  it('🔴 C3-12: tras la comprobación previa se apaga la autofactura ⇒ la reserva repite la preparación real y NO extrae (cero egresos)', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    const p = pausaTrasLaComprobacion()
    const pedido = issueCfdiForOrder(
      { orderId: t.id, receptor, sandbox: true, expectedVenueId: venueId, flow: 'AUTOFACTURA_A' },
      { despuesDeLaComprobacionPrevia: p.gancho, resolveProvider: () => provider as any },
    )
    try {
      await esperarHasta(p.alcanzada)
      await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { autofacturaEnabled: false } })
      p.soltar()
      expect(await pedido).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [expect.stringMatching(/Autofactura no habilitada/)] })
      expect(await extracciones(t.id)).toBe(0)
      expect(provider.createCreditNote).not.toHaveBeenCalled()
    } finally {
      p.soltar()
      await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { autofacturaEnabled: true } })
    }
  })

  it('🔴 C3-12: tras la comprobación previa la venta pasa a otro emisor ⇒ no extrae (cero egresos)', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    const p = pausaTrasLaComprobacion()
    const pedido = issueCfdiForOrder(
      { orderId: t.id, receptor, sandbox: true, expectedVenueId: venueId },
      { despuesDeLaComprobacionPrevia: p.gancho, resolveProvider: () => provider as any },
    )
    let deshacer: (() => Promise<void>) | undefined
    try {
      await esperarHasta(p.alcanzada)
      deshacer = await cambiarEmisorDeLaVenta()
      p.soltar()
      expect(await pedido).toMatchObject({
        status: 'VALIDATION_FAILED',
        reasons: expect.arrayContaining([expect.stringMatching(/emisor/i)]),
      })
      expect(await extracciones(t.id)).toBe(0)
      expect(provider.createCreditNote).not.toHaveBeenCalled()
    } finally {
      p.soltar()
      await deshacer?.()
    }
  })

  it('🔴 C3-16: desde el dashboard la extracción registra al staff; desde la autofactura, null', async () => {
    const a = await venta([{ productId: p16, precio: 116 }])
    const b = await venta([{ productId: p16, precio: 58 }])
    await laGlobal()
    const ra = await issueCfdiForOrder(
      { orderId: a.id, receptor, sandbox: true, expectedVenueId: venueId, flow: 'STAFF_B', staffId: s1 },
      { resolveProvider: () => provider as any },
    )
    expect(ra.status).toBe('STAMPED')
    expect((await issue(b.id, 'AUTOFACTURA_A')).status).toBe('STAMPED')
    const actor = async (orderId: string) => {
      await esperarHasta(async () => (await eventos(orderId)).length === 1)
      return (await eventos(orderId))[0].staffId
    }
    expect(await actor(a.id)).toBe(s1)
    expect(await actor(b.id)).toBeNull()
  })

  it('🔴 C3-1: autofactura deshabilitada ⇒ ni extracción ni factura («Autofactura no habilitada»)', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { autofacturaEnabled: false } })
    try {
      await expect(issue(t.id, 'AUTOFACTURA_A')).rejects.toThrow(/Autofactura no habilitada/)
      expect(provider.createCreditNote).not.toHaveBeenCalled()
      expect(await extracciones(t.id)).toBe(0)
    } finally {
      await prisma.merchantFiscalConfig.update({ where: { merchantAccountId: m1 }, data: { autofacturaEnabled: true } })
    }
  })

  it('🔴 G1 (A7-R10): devolución completada + autofactura de un ticket en la global ⇒ cero extracciones, cero egresos', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    await refundAmount(t, 40)
    expect(await issue(t.id, 'AUTOFACTURA_A').catch(e => e)).toMatchObject({
      status: 'VALIDATION_FAILED',
      reasons: [MOTIVO_AUTOFACTURA_CON_DEVOLUCION],
    })
    expect(provider.createCreditNote).not.toHaveBeenCalled()
    expect(await extracciones(t.id)).toBe(0)
  })

  it('🔴 G1 (A7-R10): la devolución entra ENTRE la comprobación previa y la reserva ⇒ la reserva la ve bajo el candado de la orden y no extrae', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    const p = pausaTrasLaComprobacion()
    const pedido = issueCfdiForOrder(
      { orderId: t.id, receptor, sandbox: true, expectedVenueId: venueId, flow: 'AUTOFACTURA_A' },
      { despuesDeLaComprobacionPrevia: p.gancho, resolveProvider: () => provider as any },
    )
    try {
      await esperarHasta(p.alcanzada)
      await refundAmount(t, 40)
      p.soltar()
      expect(await pedido).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_AUTOFACTURA_CON_DEVOLUCION] })
      expect(await extracciones(t.id)).toBe(0)
      expect(provider.createCreditNote).not.toHaveBeenCalled()
    } finally {
      p.soltar()
    }
  })

  it('🔴 C3-1/C3-P6: un artículo devuelto en parte ⇒ se detiene ANTES de extraer, con su motivo', async () => {
    const t = await venta([
      { productId: p0, precio: 200 },
      { productId: p16, precio: 58 },
    ])
    await laGlobal()
    const parcial = await refundItems(t, [{ id: 'pan', amountCents: 2900 }])
    expect((await emitRefundCreditNote({ venueId, refundPaymentId: parcial.id, sandbox: true })).status).toBe('STAMPED')
    expect(await issue(t.id)).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_REMANENTE_NO_TRAZABLE] })
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1) // sólo la nota de la devolución; ninguna extracción
    expect(await extracciones(t.id)).toBe(0)
  })

  it('🔴 C3-7: la comprobación previa pasa; ENTRA una devolución parcial; la reserva de la extracción la ve bajo su candado y no extrae', async () => {
    const t = await venta([
      { productId: p0, precio: 200 },
      { productId: p16, precio: 58 },
    ])
    await laGlobal()
    const p = pausaTrasLaComprobacion()
    const pedido = issueCfdiForOrder(
      { orderId: t.id, receptor, sandbox: true, expectedVenueId: venueId },
      { despuesDeLaComprobacionPrevia: p.gancho, resolveProvider: () => provider as any },
    )
    try {
      await esperarHasta(p.alcanzada) // el gancho marca que la comprobación previa ya pasó
      const parcial = await refundItems(t, [{ id: 'pan', amountCents: 2900 }])
      expect((await emitRefundCreditNote({ venueId, refundPaymentId: parcial.id, sandbox: true })).status).toBe('STAMPED')
      p.soltar()
      expect(await pedido).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [MOTIVO_REMANENTE_NO_TRAZABLE] })
      expect(await extracciones(t.id)).toBe(0)
      expect(provider.createCreditNote).toHaveBeenCalledTimes(1) // sólo la devolución
    } finally {
      p.soltar()
    }
  })

  it('🔴 C3-2/C3-3: global con el ticket ($258) y la devolución del pan ya notada ⇒ extracción por $200 y factura con el CAFÉ (clave y unidad reales); una nota posterior sale bien', async () => {
    const t = await venta([
      { productId: p0, precio: 200 },
      { productId: p16, precio: 58 },
    ])
    await laGlobal()
    const reembolso = await refundItems(t, [{ id: 'pan' }])
    expect((await emitRefundCreditNote({ venueId, refundPaymentId: reembolso.id, sandbox: true })).status).toBe('STAMPED')
    const r = await issue(t.id)
    expect(r.status).toBe('STAMPED')
    expect(await extracciones(t.id)).toBe(1)
    const ext = await prisma.cfdi.findFirstOrThrow({ where: { orderId: t.id, idempotencyKey: { startsWith: 'cfdi-extraccion-' } } })
    expect(ext).toMatchObject({
      type: 'EGRESO',
      status: 'STAMPED',
      totalCents: 20000,
      receptorRfc: 'XAXX010101000',
      usoCfdi: 'G02',
      metodoPago: 'PUE',
    })
    expect((ext.entrada as any).remanentes.map((x: any) => x.orderItemId)).toEqual([articulo(t, 'cafe').id])
    const [payload] = provider.createInvoice.mock.calls.at(-1)!
    expect(payload.items).toEqual([
      expect.objectContaining({
        ...CLAVE_CAFE,
        unitPriceCents: 20000,
        taxIncluded: true,
        taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0, withholding: false }],
      }),
    ])
    expect(payload.receptor).toMatchObject({ rfc: receptor.rfc })
    expect(r.cfdi).toMatchObject({ type: 'INGRESO', totalCents: 20000, isGlobal: false })
    expect(r.cfdi.entrada as any).toMatchObject({
      clasificacion: 'MIXTA',
      paidCents: 20000,
      renglones: [{ orderItemId: articulo(t, 'cafe').id, tratamiento: 'IVA_0' }],
      extraccion: { cfdiId: ext.id, uuid: ext.uuid, generacion: 1, brutoPorTratamiento: { IVA_0: 20000 }, diferencias: [] },
    })
    const otra = await refundAmount(t, 50) // una devolución posterior va contra la factura del cliente (C2)
    expect((await emitRefundCreditNote({ venueId, refundPaymentId: otra.id, sandbox: true })).status).toBe('STAMPED')
  })

  it('🔴 C3-P8: si el dueño cambió la clave SAT del producto después de la global, la factura del cliente lleva la nueva; el dinero no cambia', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    await prisma.product.update({ where: { id: p16 }, data: { satProductKey: '50181900' } })
    try {
      const r = await issue(t.id)
      const [payload] = provider.createInvoice.mock.calls.at(-1)!
      expect(payload.items).toEqual([expect.objectContaining({ satProductKey: '50181900', unitPriceCents: 11600 })])
      expect(r.cfdi.totalCents).toBe(11600)
    } finally {
      await prisma.product.update({ where: { id: p16 }, data: { satProductKey: null } })
    }
  })

  it('🔴 T4 ronda 1: la EXTRACCIÓN se rechaza en definitiva ⇒ vuelve su fila (EGRESO) con el motivo dicho como de la extracción; la factura del cliente no se pide', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    provider.createCreditNote.mockRejectedValueOnce(
      new ProviderHttpError(422, 'invoice_stamping_validation_error', 'El código postal del receptor no es válido'),
    )
    const r = await issue(t.id)
    expect(r).toMatchObject({
      status: 'STAMP_FAILED',
      cfdi: {
        type: 'EGRESO',
        falloDefinitivo: true,
        lastError: expect.stringMatching(/^No se pudo sacar la venta de la factura global: /),
      },
    })
    expect(provider.createInvoice).not.toHaveBeenCalled()
  })

  it('🔴 la factura del cliente se RECHAZA en definitiva: la extracción queda timbrada y el reintento sólo emite la factura', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    provider.createInvoice.mockRejectedValueOnce(
      new ProviderHttpError(422, 'invoice_stamping_validation_error', 'RFC del receptor inválido'),
    )
    expect((await issue(t.id)).status).toBe('STAMP_FAILED')
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    provider.createInvoice.mockImplementation(async () => valid())
    expect((await issue(t.id)).status).toBe('STAMPED')
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1) // una sola extracción
    expect(await extracciones(t.id)).toBe(1)
  })

  it('error de red en la factura del cliente: el reintento RECUPERA el envío incierto (no recaptura)', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    provider.createInvoice.mockRejectedValueOnce(new Error('ECONNRESET'))
    await issue(t.id)
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    timbradaEnElPac(provider.createInvoice.mock.calls.at(-1)![0])
    expect((await issue(t.id)).status).toBe('STAMPED')
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
  })

  it('🔴 dos pedidos a la vez (barrera tras la admisión del primero): una sola extracción y una sola factura', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    let soltar!: () => void
    const pausa = new Promise<void>(r => (soltar = r))
    const a = issueCfdiForOrder(
      { orderId: t.id, receptor, sandbox: true, expectedVenueId: venueId },
      { despuesDeLaAdmision: () => pausa, resolveProvider: () => provider as any },
    )
    let b: Promise<unknown> | undefined
    try {
      await esperarHasta(
        async () =>
          (await prisma.cfdi.count({ where: { orderId: t.id, idempotencyKey: { startsWith: 'cfdi-extraccion-' }, status: 'STAMPED' } })) ===
          1,
      )
      b = issueCfdiForOrder(
        { orderId: t.id, receptor, sandbox: true, expectedVenueId: venueId },
        { resolveProvider: () => provider as any },
      )
    } finally {
      soltar()
    }
    const rs = await Promise.allSettled([a, b!])
    expect(rs.filter(x => x.status === 'fulfilled' && (x.value as any).status === 'STAMPED')).not.toHaveLength(0)
    expect(await extracciones(t.id)).toBe(1)
    expect(await prisma.cfdi.count({ where: { orderId: t.id, type: 'INGRESO', isGlobal: false, status: 'STAMPED' } })).toBe(1)
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
  })

  it('autofactura del ticket en la global: mismo flujo, y la extracción nunca se ofrece como su factura (H19)', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    expect((await issue(t.id, 'AUTOFACTURA_A')).status).toBe('STAMPED')
    expect((await prisma.cfdi.findFirst({ where: { orderId: t.id, status: 'STAMPED', type: 'INGRESO' } }))?.isGlobal).toBe(false)
    expect(await extracciones(t.id)).toBe(1)
    expect(
      await prisma.cfdi.findFirstOrThrow({ where: { orderId: t.id, idempotencyKey: { startsWith: 'cfdi-extraccion-' } } }),
    ).toMatchObject({
      flow: 'AUTOFACTURA_A', // B14
    })
  })

  it('🔴 M10: la nota de extracción con la cancelación en trámite ⇒ la factura del cliente no sale: 409 `CFDI_CANCEL_PENDING` con el folio de la nota', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    provider.createInvoice.mockRejectedValueOnce(new ProviderHttpError(422, 'invoice_stamping_validation_error', 'falla'))
    await issue(t.id) // extracción timbrada, la factura rechazada en definitiva
    expect(await extracciones(t.id)).toBe(1)
    const ext = await prisma.cfdi.findFirstOrThrow({ where: { orderId: t.id, idempotencyKey: { startsWith: 'cfdi-extraccion-' } } })
    await prisma.cfdi.update({ where: { id: ext.id }, data: { cancelStatus: 'REQUESTED', cancelIntento: 1, cancelAcusadaAt: new Date() } })
    provider.createInvoice.mockImplementation(async () => valid())
    const err = await issue(t.id).catch(e => e)
    expect(err).toMatchObject({ code: 'CFDI_CANCEL_PENDING', message: expect.stringMatching(/cancelación en trámite/) })
    expect(err.message).toContain(`${ext.serie}-${ext.folio}`)
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
  })

  it('🔴 C3-13/C3-19: el antecedente manda — extracción con su global ya no vigente, o cancelada ⇒ se detiene con su motivo, nunca la factura por la orden completa', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const g = await laGlobal()
    provider.createInvoice.mockRejectedValueOnce(new ProviderHttpError(422, 'invoice_stamping_validation_error', 'falla'))
    await issue(t.id)
    expect(await extracciones(t.id)).toBe(1)
    const ext = await prisma.cfdi.findFirstOrThrow({ where: { orderId: t.id, idempotencyKey: { startsWith: 'cfdi-extraccion-' } } })
    provider.createInvoice.mockImplementation(async () => valid())
    await prisma.cfdi.update({ where: { id: g.id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    expect(await issue(t.id)).toMatchObject({ status: 'VALIDATION_FAILED', cfdi: null, reasons: [motivoExtraccionSinGlobal(ext)] })
    await prisma.cfdi.update({ where: { id: ext.id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    expect(await issue(t.id)).toMatchObject({ status: 'VALIDATION_FAILED', cfdi: null, reasons: [motivoExtraccionCancelada(ext)] })
    expect(provider.createInvoice).toHaveBeenCalledTimes(1) // sólo el primer intento (rechazado)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })

  it('🔴 T4 paso 4 (lo que verifica la Tarea 7): la sustituta de la factura del cliente conserva lo extraído —conceptos, montos y `extraccion`—, no la orden', async () => {
    const t = await venta([
      { productId: p0, precio: 200 },
      { productId: p16, precio: 58 },
    ])
    await laGlobal()
    const reembolso = await refundItems(t, [{ id: 'pan' }])
    expect((await emitRefundCreditNote({ venueId, refundPaymentId: reembolso.id, sandbox: true })).status).toBe('STAMPED')
    const r = await issue(t.id)
    expect(r.status).toBe('STAMPED')
    provider.cancelInvoice.mockResolvedValue({ status: 'canceled', cancelledAt: new Date() })
    const s = await replaceCfdi({ cfdiId: r.cfdi.id, sandbox: true, expectedVenueId: venueId })
    expect(s.status).toBe('REPLACED')
    expect(s.sustituta).toMatchObject({ totalCents: 20000, replacesCfdiId: r.cfdi.id })
    const [payload] = provider.createInvoice.mock.calls.at(-1)!
    expect(payload.items).toEqual((r.cfdi.entrada as any).params.items)
    expect(payload.relation).toEqual({ tipoRelacion: '04', relatedUuids: [r.cfdi.uuid] })
    expect((s.sustituta.entrada as any).extraccion).toEqual((r.cfdi.entrada as any).extraccion)
  })

  // ─── Tarea 5: un ticket extraído nunca vuelve a otra global (con extracciones REALES; `cfdiGlobal.service.ts` no cambia, Codex C3-15) ───────────
  const periodoMayo = closedPeriodFor('MENSUAL', NOW)
  const emisorGlobal = () => prisma.fiscalEmisor.findUniqueOrThrow({ where: { id: fiscalEmisorId } })

  it('🔴 la global se canceló POR FUERA con la extracción viva: el ticket no vuelve a entrar en otra global del periodo y se cuenta YA_EXTRAIDO', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const otro = await venta([{ productId: p16, precio: 58 }])
    const g = await laGlobal()
    provider.createInvoice.mockRejectedValueOnce(new ProviderHttpError(422, 'invoice_stamping_validation_error', 'falla'))
    await issue(t.id) // extracción timbrada; la factura del cliente se rechaza
    expect(await extracciones(t.id)).toBe(1)
    await prisma.cfdi.update({ where: { id: g.id }, data: { status: 'CANCELLED', cancelStatus: 'CANCELLED' } }) // como lo dejaría el webhook
    const ids = await loadGlobalCandidates(await emisorGlobal(), periodoMayo, true)
    expect(ids).toContain(otro.id)
    expect(ids).not.toContain(t.id)
    // C3-21: la clase vive en el LISTADO real (C1 Tarea 12, firma de objeto); `contarExcluidasPorConfiguracion` sólo cuenta sus tres motivos.
    const r = await listarExcluidasDeLaGlobal({ venueId, emisorId: fiscalEmisorId, now: NOW, principalId: g.id }) // su periodo, por su id
    // C3-21 (v6): t cuenta UNA vez como YA_EXTRAIDO; `otro` volvió a ser candidato con la principal cancelada ⇒ CORREGIDA_DESPUES. Total 2.
    expect(r.totales).toMatchObject({ total: 2, porMotivo: { YA_EXTRAIDO: 1, CORREGIDA_DESPUES: 1 } })
    expect(r.excluidas.filter(x => x.orderId === t.id).map(x => x.motivo)).toEqual(['YA_EXTRAIDO'])
    expect(r.excluidas.filter(x => x.orderId === otro.id).map(x => x.motivo)).toEqual(['CORREGIDA_DESPUES'])
    expect(await contarExcluidasPorConfiguracion(await emisorGlobal(), periodoMayo, true)).not.toHaveProperty('YA_EXTRAIDO')
  })

  it('🔴 v8 · C1-45: extracción CANCELADA → global cancelada ⇒ el ticket NO vuelve a ninguna global (ni a una complementaria): sigue YA_EXTRAIDO con «pídelo a soporte», nunca CORREGIDA_DESPUES', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const g = await laGlobal()
    provider.createInvoice.mockRejectedValueOnce(new ProviderHttpError(422, 'invoice_stamping_validation_error', 'falla'))
    await issue(t.id) // extracción timbrada; la factura del cliente se rechaza
    const ext = await prisma.cfdi.findFirstOrThrow({ where: { orderId: t.id, idempotencyKey: { startsWith: 'cfdi-extraccion-' } } })
    provider.cancelInvoice.mockResolvedValueOnce({ status: 'canceled', cancelledAt: new Date() })
    await cancelCfdi({ cfdiId: ext.id, motivo: '02', sandbox: true, expectedVenueId: venueId }) // la extracción se cancela y se confirma
    expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: ext.id } })).toMatchObject({ status: 'CANCELLED' })
    await prisma.cfdi.update({ where: { id: g.id }, data: { status: 'CANCELLED', cancelStatus: 'CANCELLED' } }) // y después la global, por fuera
    // con la v7 de C1 (`EXTRAIDO` sólo con extracción VIVA) el ticket quedaba sin ingreso vivo, sin global viva y sin `EXTRAIDO`: candidato de la complementaria
    expect(await loadGlobalCandidates(await emisorGlobal(), periodoMayo, true)).not.toContain(t.id)
    const r = await listarExcluidasDeLaGlobal({ venueId, emisorId: fiscalEmisorId, now: NOW, principalId: g.id })
    // v9 (Codex C3-26): el listado devuelve `texto` y `detalle`, nunca `nota`; `texto` es lo que consume la pantalla y es `TEXTO_EXCLUSION_GLOBAL.YA_EXTRAIDO` de C1 (Tarea 6), que menciona soporte
    expect(r.excluidas.filter(x => x.orderId === t.id)).toEqual([
      expect.objectContaining({ motivo: 'YA_EXTRAIDO', texto: expect.stringMatching(/soporte/i) }),
    ])
    expect(r.totales!.porMotivo.CORREGIDA_DESPUES ?? 0).toBe(0)
    expect(await prisma.order.count({ where: { id: t.id, AND: filtrosDeExclusion() } })).toBe(0) // el mismo predicado compartido de C1
  })

  it('🔴 C3-13: $258 con el pan ($58) devuelto, extracción por $200 y la factura del cliente rechazada; la global se cancela POR FUERA ⇒ el reintento se DETIENE con su motivo; nunca factura los $258', async () => {
    const t = await venta([
      { productId: p0, precio: 200 },
      { productId: p16, precio: 58 },
    ])
    const g = await laGlobal()
    const reembolso = await refundItems(t, [{ id: 'pan' }])
    expect((await emitRefundCreditNote({ venueId, refundPaymentId: reembolso.id, sandbox: true })).status).toBe('STAMPED')
    provider.createInvoice.mockRejectedValueOnce(
      new ProviderHttpError(422, 'invoice_stamping_validation_error', 'RFC del receptor inválido'),
    )
    expect((await issue(t.id)).status).toBe('STAMP_FAILED')
    const ext = await prisma.cfdi.findFirstOrThrow({ where: { orderId: t.id, idempotencyKey: { startsWith: 'cfdi-extraccion-' } } })
    expect(ext.totalCents).toBe(20000)
    await prisma.cfdi.update({ where: { id: g.id }, data: { status: 'CANCELLED', cancelStatus: 'CANCELLED' } }) // como la dejaría el webhook
    provider.createInvoice.mockImplementation(async () => valid())
    const llamadas = provider.createInvoice.mock.calls.length
    expect(await issue(t.id)).toMatchObject({ status: 'VALIDATION_FAILED', reasons: [expect.stringMatching(/ya no está vigente/)] })
    expect(provider.createInvoice.mock.calls.length).toBe(llamadas) // ningún envío nuevo
    expect(await prisma.cfdi.count({ where: { orderId: t.id, type: 'INGRESO', isGlobal: false, totalCents: 25800 } })).toBe(0)
    // `logAction` está interceptado por `integration-setup` (no escribe en la base): el rastro se lee en la llamada, una sola vez.
    const sinGlobal = jest.mocked(logAction).mock.calls.filter(([x]) => x.action === 'CFDI_EXTRACCION_SIN_GLOBAL')
    expect(sinGlobal).toEqual([
      [expect.objectContaining({ entity: 'Cfdi', entityId: ext.id, venueId, data: { orderId: t.id, extraidoCents: 20000 } })],
    ])
  })

  it('🔴 EXTRAIDA_SIN_FACTURA: devolución de un ticket ya extraído cuya factura del cliente aún no está timbrada ⇒ la nota espera con su motivo; al timbrarse, va contra ELLA', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    provider.createInvoice.mockRejectedValueOnce(new ProviderHttpError(422, 'invoice_stamping_validation_error', 'falla'))
    expect((await issue(t.id)).status).toBe('STAMP_FAILED') // extracción timbrada; la factura del cliente, rechazada
    const reembolso = await refundAmount(t, 50)
    expect((await getRefundCreditNoteStatus(venueId, reembolso.id))!.eligibility).toEqual({
      eligible: false,
      reason: 'EXTRAIDA_SIN_FACTURA',
      message: MOTIVO_EXTRAIDA_SIN_FACTURA,
    })
    const egresos = () => prisma.cfdi.count({ where: { orderId: t.id, type: 'EGRESO' } })
    expect(await egresos()).toBe(1) // sólo la extracción
    await expect(emitRefundCreditNote({ venueId, refundPaymentId: reembolso.id, sandbox: true })).rejects.toThrow(
      MOTIVO_EXTRAIDA_SIN_FACTURA,
    )
    expect(await egresos()).toBe(1) // sin reserva alguna
    provider.createInvoice.mockImplementation(async () => valid())
    expect((await issue(t.id)).status).toBe('STAMPED')
    const sustento = await getRefundCreditNoteStatus(venueId, reembolso.id)
    expect(sustento!.eligibility.reason).not.toBe('EXTRAIDA_SIN_FACTURA') // con la factura del cliente timbrada, la original es ELLA
  })

  // ─── Tarea 6 (Codex C3-5): las dos órdenes de la carrera «cancelar la extracción / factura del cliente», con barreras deterministas ──────
  const rechazoDefinitivo = () => new ProviderHttpError(422, 'invoice_stamping_validation_error', 'falla') // RECHAZOS_CONFIRMADOS
  const laExtraccionDe = (orderId: string) =>
    prisma.cfdi.findFirstOrThrow({ where: { orderId, idempotencyKey: { startsWith: 'cfdi-extraccion-' } } })
  const cancelarExtraccion = (cfdiId: string, deps = defaultCancelDeps) =>
    cancelCfdi({ cfdiId, motivo: '02', sandbox: true, expectedVenueId: venueId }, deps)
  const facturasDelCliente = (orderId: string) =>
    prisma.cfdi.count({ where: { orderId, type: 'INGRESO', isGlobal: false, status: 'STAMPED' } })
  /**
   * ¿Alguien ESPERA la fila de ESTA orden? (pg_locks) Quien pide una fila ocupada toma su candado de TUPLA y espera, sin que se le conceda, a la
   * transacción dueña. El candado de tupla es de esa fila (su `ctid`, que un `FOR UPDATE` no mueve) y `pg_blocking_pids` confirma que quien lo
   * tiene está bloqueado: una espera sobre cualquier otra orden de la base no cuenta. Los candados de fila concedidos no aparecen por fila en
   * pg_locks: quién la tiene lo dice el gancho de la barrera.
   */
  const alguienEsperaLaOrden = async (orderId: string) =>
    (
      await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM "Order" o
        JOIN pg_locks t ON t.locktype = 'tuple' AND t.relation = '"Order"'::regclass
          AND t.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND t.page = (o.ctid::text::point)[0]::int AND t.tuple = (o.ctid::text::point)[1]::int
        WHERE o.id = ${orderId} AND cardinality(pg_blocking_pids(t.pid)) > 0`
    )[0].n > 0

  it('🔴 orden 1: extracción timbrada y la factura del cliente rechazada en definitiva; se pide cancelar la extracción (en trámite) ⇒ la factura ya no sale (409 `CFDI_CANCEL_PENDING`)', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    provider.createInvoice.mockRejectedValueOnce(rechazoDefinitivo())
    expect((await issue(t.id)).status).toBe('STAMP_FAILED')
    const ext = await laExtraccionDe(t.id)
    provider.cancelInvoice.mockResolvedValueOnce({ status: 'pending', cancelledAt: null })
    await cancelarExtraccion(ext.id)
    provider.createInvoice.mockImplementation(async () => valid())
    const err = await issue(t.id).catch(e => e)
    // M10: el texto REAL de la T4 nombra la nota de extracción y en qué va (acusada ⇒ «en trámite»), con el código estable.
    expect(err).toMatchObject({ code: 'CFDI_CANCEL_PENDING', message: expect.stringMatching(/cancelación en trámite/) })
    expect(err.message).toContain(`${ext.serie}-${ext.folio}`)
    expect(await facturasDelCliente(t.id)).toBe(0)
    expect(provider.createInvoice).toHaveBeenCalledTimes(1) // sólo el rechazado
  })

  it('🔴 orden 2: con la factura del cliente emitida, la extracción que la sostiene NO se cancela (y el PAC no se toca)', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    const r = await issue(t.id)
    expect(r.status).toBe('STAMPED')
    const factura = await prisma.cfdi.findUniqueOrThrow({ where: { id: r.cfdi.id } })
    const ext = await laExtraccionDe(t.id)
    await expect(cancelarExtraccion(ext.id)).rejects.toThrow(`Esta nota sostiene la factura ${factura.serie}-${factura.folio} del cliente`)
    expect(provider.cancelInvoice).not.toHaveBeenCalled()
    expect((await prisma.cfdi.findUniqueOrThrow({ where: { id: ext.id } })).cancelStatus).toBeNull()
  })

  it('🔴 la factura del cliente con el envío INCIERTO (error de red) también sostiene la extracción: no se cancela', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    provider.createInvoice.mockRejectedValueOnce(new Error('ECONNRESET'))
    await issue(t.id)
    expect(await prisma.cfdi.findFirstOrThrow({ where: { orderId: t.id, type: 'INGRESO', isGlobal: false } })).toMatchObject({
      status: 'STAMP_FAILED',
      falloDefinitivo: false,
      uuid: null,
    })
    const ext = await laExtraccionDe(t.id)
    await expect(cancelarExtraccion(ext.id)).rejects.toThrow(/sostiene una factura del cliente que sigue en proceso/)
    expect(provider.cancelInvoice).not.toHaveBeenCalled()
    expect((await prisma.cfdi.findUniqueOrThrow({ where: { id: ext.id } })).cancelStatus).toBeNull()
  })

  it('🔴 a la vez, la factura primero: su admisión se pausa con el candado de la orden tomado; la cancelación ESPERA y, al entrar, ve la factura que la sostiene', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const g = await laGlobal()
    // Extracción timbrada y factura del cliente sin pedir: la PRIMERA admisión es la que reserva. (Con una factura rechazada antes, la admisión
    // que sólo la encuentra suelta el candado antes de la que la reclama, y la cancelación entraría entre las dos: sería «la cancelación primero».)
    expect((await extraer(t.id)).status).toBe('STAMPED')
    const ext = await laExtraccion(g.id, t.id)
    const otra = await venta([{ productId: p16, precio: 58 }]) // otra orden del negocio, ajena a la carrera
    const barrera = pausaTrasLaComprobacion() // la misma barrera, aquí tras la admisión
    let soltarPac!: () => void
    const pac = new Promise<void>(r => (soltarPac = r))
    provider.createInvoice.mockImplementationOnce(async () => (await pac, valid())) // el PAC no contesta hasta que la cancelación terminó
    const factura = issueCfdiForOrder(
      { orderId: t.id, receptor, sandbox: true, expectedVenueId: venueId },
      { despuesDeLaAdmision: barrera.gancho, resolveProvider: () => provider as any },
    )
    let cancelacion: Promise<unknown> | undefined
    try {
      await esperarHasta(barrera.alcanzada) // la factura tiene todos los candados de la admisión
      cancelacion = cancelarExtraccion(ext.id)
      await esperarHasta(() => alguienEsperaLaOrden(t.id)) // la cancelación está formada en el candado de la orden
      expect(await alguienEsperaLaOrden(otra.id)).toBe(false) // la espera es de ESTA orden: sobre otra no cuenta
      barrera.soltar()
      await Promise.allSettled([cancelacion]) // entra con la factura del cliente RESERVADA, todavía sin timbrar
    } finally {
      barrera.soltar()
      soltarPac()
    }
    const [rf, rc] = await Promise.allSettled([factura, cancelacion!])
    expect(rf).toMatchObject({ status: 'fulfilled', value: { status: 'STAMPED' } })
    expect(rc).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringMatching(/sostiene una factura del cliente que sigue en proceso/) }),
    })
    expect(provider.cancelInvoice).not.toHaveBeenCalled()
    expect((await prisma.cfdi.findUniqueOrThrow({ where: { id: ext.id } })).cancelStatus).toBeNull()
    expect(await facturasDelCliente(t.id)).toBe(1)
  })

  it('🔴 a la vez, la cancelación primero: la intención se pausa con el candado de la orden tomado; la factura ESPERA y, al entrar, ve la cancelación (409 `CFDI_CANCEL_PENDING`)', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    provider.createInvoice.mockRejectedValueOnce(rechazoDefinitivo())
    expect((await issue(t.id)).status).toBe('STAMP_FAILED') // extracción timbrada, la factura del cliente rechazada en definitiva
    const ext = await laExtraccionDe(t.id)
    provider.createInvoice.mockImplementation(async () => valid())
    provider.cancelInvoice.mockResolvedValue({ status: 'pending', cancelledAt: null })
    const barrera = pausaTrasLaComprobacion()
    const cancelacion = cancelarExtraccion(ext.id, {
      ...defaultCancelDeps,
      anotarIntencion: (id, v, p) => anotarIntencionDeCancelar(id, v, p, { despuesDeLosCandados: barrera.gancho }),
    })
    let factura: Promise<unknown> | undefined
    try {
      await esperarHasta(barrera.alcanzada) // la cancelación tiene los candados de la emisión
      factura = issue(t.id) // pasa lo que se lee sin candados (la extracción aún sin cancelación) y se forma en el de la orden
      await esperarHasta(() => alguienEsperaLaOrden(t.id))
    } finally {
      barrera.soltar()
    }
    const [rc, rf] = await Promise.allSettled([cancelacion, factura!])
    expect(rc).toMatchObject({ status: 'fulfilled', value: { intencionNueva: true } })
    // M10: el código estable y el folio de la nota; el estado del texto (anotada, enviándose o en trámite) depende de cuánto avanzó al soltar.
    expect(rf).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'CFDI_CANCEL_PENDING', message: expect.stringContaining(`${ext.serie}-${ext.folio}`) }),
    })
    expect(await facturasDelCliente(t.id)).toBe(0)
    expect(provider.createInvoice).toHaveBeenCalledTimes(1) // sólo el rechazado
  })

  it('🔴 a la vez, la cancelación ENTRE las dos admisiones de la factura rechazada (la que la encuentra y la que la reclama): la factura no sale (409 `CFDI_CANCEL_PENDING`)', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    provider.createInvoice.mockRejectedValueOnce(rechazoDefinitivo())
    expect((await issue(t.id)).status).toBe('STAMP_FAILED') // extracción timbrada, la factura del cliente rechazada en definitiva
    const ext = await laExtraccionDe(t.id)
    provider.createInvoice.mockImplementation(async () => valid())
    provider.cancelInvoice.mockResolvedValue({ status: 'pending', cancelledAt: null })
    // Con la factura rechazada, volver a pedirla pasa por DOS admisiones: una que sólo ENCUENTRA la fila (el gancho cae aquí, con el candado de
    // la orden tomado) y, tras consultar al PAC fuera de transacción, otra que la RECLAMA. La cancelación espera en el candado, entra en medio
    // y la segunda admisión debe verla bajo el mismo candado.
    const barrera = pausaTrasLaComprobacion()
    const factura = issueCfdiForOrder(
      { orderId: t.id, receptor, sandbox: true, expectedVenueId: venueId },
      { despuesDeLaAdmision: barrera.gancho, resolveProvider: () => provider as any },
    )
    let cancelacion: Promise<unknown> | undefined
    try {
      await esperarHasta(barrera.alcanzada) // la primera admisión tiene el candado de la orden
      cancelacion = cancelarExtraccion(ext.id)
      await esperarHasta(() => alguienEsperaLaOrden(t.id)) // la cancelación está formada en él
    } finally {
      barrera.soltar()
    }
    const [rf, rc] = await Promise.allSettled([factura, cancelacion!])
    // La invariante: nunca una factura viva sobre una extracción en cancelación. La cancelación se cumple y la factura no sale.
    expect(rc).toMatchObject({ status: 'fulfilled', value: { intencionNueva: true } })
    expect(rf).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'CFDI_CANCEL_PENDING', message: expect.stringContaining(`${ext.serie}-${ext.folio}`) }),
    })
    expect(await facturasDelCliente(t.id)).toBe(0)
    expect(
      await prisma.cfdi.count({ where: { orderId: t.id, type: 'INGRESO', isGlobal: false, status: { in: ['STAMPING', 'STAMPED'] } } }),
    ).toBe(0) // ni en proceso
    expect(provider.createInvoice).toHaveBeenCalledTimes(1) // sólo el rechazado
  })

  it('🔴 C3-19 (C3-P9 = B): cancelación CONFIRMADA de la extracción ⇒ volver a pedir la factura se DETIENE con soporte, sin egreso nuevo; y con la global también cancelada, nunca cae a la ruta ordinaria', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    const g = await laGlobal()
    provider.createInvoice.mockRejectedValueOnce(rechazoDefinitivo())
    await issue(t.id)
    const ext = await laExtraccionDe(t.id)
    provider.cancelInvoice.mockResolvedValueOnce({ status: 'canceled', cancelledAt: new Date() })
    await cancelarExtraccion(ext.id)
    expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: ext.id } })).toMatchObject({ status: 'CANCELLED' })
    provider.createInvoice.mockImplementation(async () => valid())
    const detenida = { status: 'VALIDATION_FAILED', cfdi: null, reasons: [motivoExtraccionCancelada(ext)] }
    expect(await issue(t.id)).toMatchObject(detenida)
    await prisma.cfdi.update({ where: { id: g.id }, data: { status: 'CANCELLED', cancelStatus: 'CANCELLED' } }) // la global, por fuera
    expect(await issue(t.id)).toMatchObject(detenida)
    expect(await extracciones(t.id)).toBe(1)
    expect(await facturasDelCliente(t.id)).toBe(0)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    expect(provider.createInvoice).toHaveBeenCalledTimes(1) // sólo el rechazado
  })

  // ─── Tarea 8 (Codex C3-6/C3-10/C3-14): se ve — «falta» sólo sin ninguna factura del cliente VIVA; «en proceso» si está en recuperación ─────
  /** La fila de la nota de extracción en la lista de facturas (la primera página basta: el venue de la prueba sólo tiene esta venta). */
  const filaDeLaExtraccion = async () =>
    (await listCfdisForVenue({ venueId, page: 1, pageSize: 20 })).cfdis.find((c: any) => c.esExtraccion)
  /**
   * `n` notas de extracción timbradas, cada una de su venta y SIN factura del cliente; de tres en tres con el mismo `stampedAt`: el corte de
   * una página de 20 cae DENTRO de un empate (lo desempata el id).
   */
  async function extraccionesSinFactura(n: number) {
    const ordenes = Array.from({ length: n }, () => ({ id: randomUUID(), orderNumber: `F-${randomUUID().slice(0, 8)}` }))
    await prisma.order.createMany({
      data: ordenes.map(o => ({ ...o, venueId, subtotal: 116, taxAmount: 0, total: 116, paymentStatus: 'PAID' as const })),
    })
    await prisma.cfdi.createMany({
      data: ordenes.map((o, i) => ({
        venueId,
        fiscalEmisorId,
        orderId: o.id,
        type: 'EGRESO' as const,
        status: 'STAMPED' as const,
        flow: 'STAFF_B' as const,
        idempotencyKey: llaveDeExtraccion('global-de-prueba', o.id),
        receptorRfc: 'XAXX010101000',
        receptorNombre: 'PÚBLICO EN GENERAL',
        receptorRegimen: '616',
        receptorCp: '01000',
        usoCfdi: 'G02',
        formaPago: '04',
        metodoPago: 'PUE',
        subtotalCents: 10000,
        taxCents: 1600,
        totalCents: 11600,
        serie: 'E',
        folio: String(i + 1),
        uuid: randomUUID(),
        stampedAt: new Date(NOW.getTime() - Math.floor(i / 3) * 1000),
      })),
    })
  }

  it('🔴 C3-10: timeout DESPUÉS del POST de la factura del cliente ⇒ la extracción dice «en proceso», no «falta»; al recuperarla, «timbrada»', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    provider.createInvoice.mockRejectedValueOnce(new Error('ETIMEDOUT')) // enviada, incierta
    await issue(t.id)
    expect(await extraccionesPendientes([venueId], { limit: 20 })).toMatchObject({ total: 0, enProceso: 1, items: [] })
    expect(await filaDeLaExtraccion()).toMatchObject({ facturaDelCliente: 'EN_PROCESO', facturaDelClientePendiente: false })
    timbradaEnElPac(provider.createInvoice.mock.calls.at(-1)![0])
    expect((await issue(t.id)).status).toBe('STAMPED')
    expect(await filaDeLaExtraccion()).toMatchObject({ facturaDelCliente: 'TIMBRADA', facturaDelClientePendiente: false })
    expect(await extraccionesPendientes([venueId], { limit: 20 })).toMatchObject({ total: 0, enProceso: 0, items: [] })
  })

  it('🔴 C3-10: sustitución incierta de la factura del cliente ⇒ «en proceso» o «timbrada», nunca «falta»', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    const r = await issue(t.id)
    expect(r.status).toBe('STAMPED')
    provider.createInvoice.mockRejectedValueOnce(new Error('ETIMEDOUT'))
    await replaceCfdi({ cfdiId: r.cfdi.id, sandbox: true, expectedVenueId: venueId }).catch(() => undefined)
    // la sustituta quedó viva sin timbrar (envío incierto) y la original sigue viva: las dos sostienen la venta
    expect(await prisma.cfdi.count({ where: { orderId: t.id, type: 'INGRESO', isGlobal: false } })).toBe(2)
    expect((await filaDeLaExtraccion())?.facturaDelCliente).not.toBe('FALTA')
    expect(await extraccionesPendientes([venueId], { limit: 20 })).toMatchObject({ total: 0, items: [] })
    // Y si la original se cancela POR FUERA (portal del SAT, como la dejaría el webhook), la sustituta en recuperación sigue sosteniendo
    // la venta: «en proceso», nunca «falta» (con la regla de v2 —sólo STAMPED o STAMPING— aquí decía «falta»).
    await prisma.cfdi.update({ where: { id: r.cfdi.id }, data: { status: 'CANCELLED', cancelStatus: 'CANCELLED' } })
    expect(await filaDeLaExtraccion()).toMatchObject({ facturaDelCliente: 'EN_PROCESO', facturaDelClientePendiente: false })
    expect(await extraccionesPendientes([venueId], { limit: 20 })).toMatchObject({ total: 0, enProceso: 1, items: [] })
  })

  it('🔴 C3-10: la factura del cliente cancelada y CONFIRMADA ⇒ «falta» (hay que volver a facturar la venta)', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    const r = await issue(t.id)
    expect(r.status).toBe('STAMPED')
    provider.cancelInvoice.mockResolvedValueOnce({ status: 'canceled', cancelledAt: new Date() })
    await cancelCfdi({ cfdiId: r.cfdi.id, motivo: '02', sandbox: true, expectedVenueId: venueId })
    expect(await prisma.cfdi.findUniqueOrThrow({ where: { id: r.cfdi.id } })).toMatchObject({ status: 'CANCELLED' })
    expect(await extraccionesPendientes([venueId], { limit: 20 })).toMatchObject({
      total: 1,
      enProceso: 0,
      items: [expect.objectContaining({ orderId: t.id })],
    })
    expect(await filaDeLaExtraccion()).toMatchObject({ facturaDelCliente: 'FALTA', facturaDelClientePendiente: true })
  })

  it('🔴 ruling T8: la extracción con la cancelación EN TRÁMITE no cuenta como «falta» (facturar da el 409 de la admisión); si el SAT la rechaza, vuelve sola a «falta»', async () => {
    const t = await venta([{ productId: p16, precio: 116 }])
    await laGlobal()
    provider.createInvoice.mockRejectedValueOnce(rechazoDefinitivo())
    await issue(t.id) // extracción timbrada; la factura del cliente, rechazada en definitiva (no viva)
    const ext = await laExtraccionDe(t.id)
    expect(await extraccionesPendientes([venueId], { limit: 20 })).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: ext.id })],
    })
    await prisma.cfdi.update({ where: { id: ext.id }, data: { cancelStatus: 'REQUESTED', cancelIntento: 1, cancelAcusadaAt: new Date() } })
    provider.createInvoice.mockImplementation(async () => valid())
    // lo que haría el botón «vuelve a facturar»: el 409 de la cancelación pendiente (el mismo predicado que la lista y el MCP)
    expect(await issue(t.id).catch(e => e)).toMatchObject({ code: 'CFDI_CANCEL_PENDING' })
    expect(await extraccionesPendientes([venueId], { limit: 20 })).toMatchObject({ total: 0, enProceso: 0, items: [] })
    expect(await filaDeLaExtraccion()).toMatchObject({ facturaDelCliente: null, facturaDelClientePendiente: false })
    await prisma.cfdi.update({ where: { id: ext.id }, data: { cancelStatus: 'REJECTED' } }) // el SAT (o el receptor) la rechazó
    expect(await extraccionesPendientes([venueId], { limit: 20 })).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: ext.id })],
    })
    expect(await filaDeLaExtraccion()).toMatchObject({ facturaDelCliente: 'FALTA', facturaDelClientePendiente: true })
  })

  it('25 extracciones pendientes ⇒ total 25, 20 elementos y `siguiente`; la segunda página, los 5 restantes (sin repetir ni saltar)', async () => {
    await extraccionesSinFactura(25)
    const p1 = await extraccionesPendientes([venueId], { limit: 20 })
    expect(p1).toMatchObject({ total: 25, enProceso: 0 })
    expect(p1.items).toHaveLength(20)
    expect(p1.siguiente).not.toBeNull()
    const p2 = await extraccionesPendientes([venueId], { limit: 20, cursor: p1.siguiente! })
    expect(p2.total).toBe(25)
    expect(p2.items).toHaveLength(5)
    expect(p2.siguiente).toBeNull()
    const vistos = [...p1.items, ...p2.items].map(e => e.id)
    expect(new Set(vistos).size).toBe(25)
    const fechas = [...p1.items, ...p2.items].map(e => new Date(e.stampedAt).getTime())
    expect(fechas).toEqual([...fechas].sort((a, b) => b - a)) // la más reciente primero
  })
})
