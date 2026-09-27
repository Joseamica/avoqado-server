jest.mock('@/services/access/access.service', () => ({ hasPermission: jest.fn(() => true) }))
jest.mock('@/services/access/basePlan.service', () => ({ venuesWithFeatureAccess: jest.fn(async (ids: string[]) => new Set(ids)) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/mcp/guard', () => ({ createGuard: () => ({ venueFilter: jest.fn(), requirePermission: jest.fn() }) }))
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))
jest.mock('@/services/storage.service', () => ({
  ...jest.requireActual('@/services/storage.service'),
  uploadFileToStorage: jest.fn(async () => 'https://test/file'),
}))
import express from 'express'
import { registerCfdiTools } from '@/mcp/tools/cfdi'
import { auditMcpWrite } from '@/mcp/audit'
import { ProviderHttpError } from '@/services/fiscal/providers/facturapi.provider'
import * as admission from '@/services/fiscal/admisionIva'
import request from 'supertest'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import { emitRefundCreditNote, getRefundCreditNoteStatus } from '@/services/fiscal/cfdiCreditNote.service'
import { emitRefundCreditNoteController } from '@/controllers/dashboard/cfdi.dashboard.controller'
import { Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { issueCfdiForOrder } from '@/services/fiscal/cfdi.service'
import { huellaDeEntrada } from '@/services/fiscal/entradaDocumental'
import { encenderIvaPorProducto } from '../../__helpers__/iva-por-producto'

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || database.pathname !== '/av_db_25_iva_test') {
  throw new Error('Esta suite exige la base local av_db_25_iva_test.')
}

const receptor = { rfc: 'EKU9003173C9', razonSocial: 'ESCUELA KEMPER URGATE', regimenFiscal: '601', codigoPostal: '64000', usoCfdi: 'G03' }
const stamped = {
  providerInvoiceId: 'pac-test',
  uuid: 'UUID-TEST',
  serie: 'F',
  folio: '1',
  totalCents: 11600,
  stampedAt: new Date(),
  status: 'valid',
}

describe('egreso con entrada congelada', () => {
  const fixture = `emision-iva-${randomUUID()}`
  let venueId: string
  let productId: string
  let fiscalEmisorId: string
  const provider = {
    name: 'facturapi',
    createInvoice: jest.fn(),
    createCreditNote: jest.fn(),
    findByExternalId: jest.fn(),
    getInvoice: jest.fn(),
    downloadXml: jest.fn(),
    downloadPdf: jest.fn(),
  }
  const deps = {
    resolveProvider: jest.fn(() => provider as any),
    storeArtifact: jest.fn(async () => 'https://test/file'),
  }
  const issue = (orderId: string, extra = {}) =>
    issueCfdiForOrder({ orderId, receptor, sandbox: true, expectedVenueId: venueId, ...extra }, deps)
  const row = (orderId: string) => prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: `cfdi-order-${orderId}` } })

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
      data: { merchantAccountId: fixture, fiscalEmisorId, facturacionEnabled: true, autofacturaEnabled: true },
    })
  })
  afterEach(() => jest.restoreAllMocks())
  beforeEach(async () => {
    jest.clearAllMocks()
    jest.mocked(resolveFiscalProvider).mockReturnValue(provider as any)
    provider.createCreditNote
      .mockReset()
      .mockImplementation(async () => ({ ...stamped, uuid: randomUUID(), providerInvoiceId: randomUUID() }))
    stamped.uuid = randomUUID()
    stamped.providerInvoiceId = randomUUID()
    provider.createInvoice.mockReset().mockResolvedValue(stamped)
    provider.findByExternalId.mockReset().mockResolvedValue(null)
    provider.getInvoice.mockReset().mockResolvedValue(stamped)
    provider.downloadXml.mockResolvedValue(Buffer.from('<Comprobante/>'))
    provider.downloadPdf.mockResolvedValue(Buffer.from('%PDF'))
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_16' } })
  })
  afterAll(async () => {
    if (!venueId) return
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.orderItemSelloIva.deleteMany({ where: { cfdi: { venueId } } })
    await prisma.cfdi.deleteMany({ where: { venueId } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisorId } })
    await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
    await prisma.merchantAccount.deleteMany({ where: { id: fixture } })
    await prisma.paymentProvider.deleteMany({ where: { id: fixture } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: fixture } })
  })
  async function order() {
    return prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        subtotal: 116,
        taxAmount: 0,
        total: 116,
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        items: { create: { productId, productName: 'Producto', quantity: 1, unitPrice: 116, taxAmount: 0, total: 116 } },
        payments: { create: { venueId, amount: 116, feePercentage: 0, feeAmount: 0, netAmount: 116, method: 'CASH', status: 'COMPLETED' } },
      },
      include: { items: true },
    })
  }
  const emit = (id: string, extra = {}) => emitRefundCreditNote({ venueId, refundPaymentId: id, sandbox: true, ...extra })
  const note = (id: string) => prisma.cfdi.findUniqueOrThrow({ where: { idempotencyKey: `cfdi-refund-${id}` } })
  async function refund(orderId: string, amount = 116) {
    return prisma.payment.create({
      data: {
        venueId,
        orderId,
        type: 'REFUND',
        amount: -amount,
        tipAmount: -10,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -amount,
        method: 'CASH',
        status: 'COMPLETED',
      },
    })
  }
  async function sale(treatment: 'IVA_16' | 'IVA_0' = 'IVA_16') {
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: treatment } })
    const o = await order()
    await issue(o.id)
    return { o, original: await row(o.id), refund: await refund(o.id) }
  }
  it('rechaza original mixta por la ruta real del dashboard con 409 y texto exacto', async () => {
    const s = await sale('IVA_0')
    const app = express()
    app.post(
      '/venues/:venueId/refunds/:refundId/credit-note',
      (req, _res, next) => {
        ;(req as any).authContext = { venueId }
        next()
      },
      emitRefundCreditNoteController,
    )
    const res = await request(app).post(`/venues/${venueId}/refunds/${s.refund.id}/credit-note`)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(
      'La factura original tiene productos con IVA distinto de 16 %; la nota de crédito para esas ventas todavía no está disponible aquí. Emítela desde el portal del SAT o de tu PAC.',
    )
    expect(provider.createCreditNote).not.toHaveBeenCalled()
  })
  it('congela entrada EGRESO y versión sin sellos nuevos; catálogo posterior no cambia IVA16', async () => {
    const s = await sale()
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
    expect((await emit(s.refund.id)).status).toBe('STAMPED')
    const n = await note(s.refund.id)
    expect(n).toMatchObject({ protocoloIva: 1, attempts: 1, subtotalCents: 10000, taxCents: 1600, totalCents: 11600 })
    expect(n.enviadoAt).not.toBeNull()
    expect(n.entrada).toMatchObject({
      tipo: 'EGRESO',
      originalCfdiId: s.original.id,
      originalUuid: s.original.uuid,
      refundPaymentId: s.refund.id,
    })
    expect(n.entradaHuella).toBe(huellaDeEntrada(n.entrada))
    expect(provider.createCreditNote.mock.calls[0][0]).toMatchObject({
      externalId: `cfdi-refund-${s.refund.id}#1`,
      idempotencyKey: `cfdi-refund-${s.refund.id}#1`,
      items: [{ taxes: [{ rate: 0.16 }] }],
    })
    expect(await prisma.orderItemSelloIva.count({ where: { cfdiId: n.id } })).toBe(0)
  })
  it.each(['missing', 'hash', 'shape'])('original protocolo1 corrupta %s es negocio inelegible y jamás llega al PAC', async corruption => {
    const s = await sale()
    const entrada = structuredClone(s.original.entrada) as any
    if (corruption === 'shape') entrada.renglones[0].tratamiento = 'INVENTADO'
    await prisma.cfdi.update({
      where: { id: s.original.id },
      data:
        corruption === 'missing'
          ? { entrada: Prisma.DbNull }
          : { entrada, entradaHuella: corruption === 'hash' ? 'bad' : huellaDeEntrada(entrada) },
    })
    expect((await getRefundCreditNoteStatus(venueId, s.refund.id))?.eligibility.reason).toBe('ORIGINAL_ENTRADA_INVALIDA')
    await expect(emit(s.refund.id)).rejects.toThrow(/entrada|soporte/i)
    expect(provider.createCreditNote).not.toHaveBeenCalled()
  })
  it('respuesta perdida recupera identidad pese a original cancelada y reembolso cambiado', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    const before = await note(s.refund.id)
    await prisma.cfdi.update({ where: { id: s.original.id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    await prisma.payment.update({ where: { id: s.refund.id }, data: { status: 'PENDING', amount: -1 } })
    expect(await getRefundCreditNoteStatus(venueId, s.refund.id)).toMatchObject({ recoveryOnly: true, eligibility: { eligible: false } })
    provider.findByExternalId.mockResolvedValue({ ...stamped, uuid: randomUUID() })
    expect((await emit(s.refund.id, { lookupOnly: true })).status).toBe('STAMPED')
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    expect(provider.findByExternalId).toHaveBeenCalledWith(`${before.idempotencyKey}#1`)
    expect(await note(s.refund.id)).toMatchObject({ attempts: 1, entrada: before.entrada, totalCents: 11600 })
  })
  it('dos reembolsos distintos compiten por el mismo saldo; incierto consume capacidad', async () => {
    const s = await sale()
    const other = await refund(s.o.id)
    provider.createCreditNote.mockRejectedValue(new Error('timeout'))
    const results = await Promise.allSettled([emit(s.refund.id), emit(other.id)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })
  it('lookupOnly nunca recaptura un intento que pasó a rechazo definitivo', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    await prisma.cfdi.update({ where: { id: (await note(s.refund.id)).id }, data: { falloDefinitivo: true } })
    await expect(emit(s.refund.id, { lookupOnly: true })).rejects.toThrow(/proces/i)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    expect((await note(s.refund.id)).attempts).toBe(1)
  })
  it('legacy original sin IVA conserva excepción y congela procedencia', async () => {
    const s = await sale()
    await prisma.cfdi.update({
      where: { id: s.original.id },
      data: { protocoloIva: null, entrada: Prisma.DbNull, entradaHuella: null, subtotalCents: 11600, taxCents: 0 },
    })
    await emit(s.refund.id)
    expect(await note(s.refund.id)).toMatchObject({
      protocoloIva: 1,
      taxCents: 0,
      subtotalCents: 11600,
      entrada: { originalSinIvaHistorico: true },
    })
    expect(provider.createCreditNote.mock.calls[0][0].items[0]).toMatchObject({ objetoImp: '01', taxes: [] })
  })
  it('idempotencia STAMPED no revela una nota de otro tenant', async () => {
    const s = await sale()
    await emit(s.refund.id)
    await expect(emitRefundCreditNote({ venueId: 'otro', refundPaymentId: s.refund.id, sandbox: true })).rejects.toThrow(/no encontrado/i)
  })
  function mcp() {
    const handlers = new Map<string, (...args: any[]) => Promise<any>>()
    registerCfdiTools(
      { tool: (...args: any[]) => handlers.set(args[0], args.at(-1)) } as any,
      { staffId: 'test-staff', activeOrg: fixture, allowedVenueIds: [venueId], perVenueAccess: new Map() } as any,
    )
    return async (refundPaymentId: string, confirm?: boolean, extra = {}) =>
      JSON.parse((await handlers.get('emit_refund_credit_note')!({ venueId, refundPaymentId, confirm, ...extra }, {})).content[0].text)
  }
  it.each([undefined, true])('MCP real bloquea original mixta con confirm=%s sin PAC/audit', async confirm => {
    const s = await sale('IVA_0')
    const out = await mcp()(s.refund.id, confirm)
    expect(out.reason).toBe('ORIGINAL_IVA_MIXTO')
    expect(out.error).toContain('Emítela desde el portal del SAT o de tu PAC.')
    expect(provider.createCreditNote).not.toHaveBeenCalled()
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })
  it('MCP real recupera nota enviada con la original cancelada; preview no consulta el PAC', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    await prisma.cfdi.update({ where: { id: s.original.id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    await prisma.payment.update({ where: { id: s.refund.id }, data: { amount: -1, status: 'PENDING' } })
    const call = mcp()
    const lookups = provider.findByExternalId.mock.calls.length
    const preview = await call(s.refund.id)
    expect(preview).toMatchObject({ requiresConfirmation: true, preview: { importeAcreditadoMxn: 116 } })
    expect(provider.findByExternalId).toHaveBeenCalledTimes(lookups)
    provider.findByExternalId.mockResolvedValue({ ...stamped, uuid: randomUUID() })
    expect((await call(s.refund.id, true)).ok).toBe(true)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })
  it('POST pending guarda id; recuperación usa id y nunca segundo POST', async () => {
    const s = await sale()
    provider.createCreditNote.mockResolvedValueOnce({ ...stamped, providerInvoiceId: 'pending-note', status: 'pending', uuid: null })
    await expect(emit(s.refund.id)).rejects.toThrow(/proces/i)
    expect(await note(s.refund.id)).toMatchObject({ facturapiId: 'pending-note', status: 'STAMPING', attempts: 1 })
    provider.getInvoice.mockResolvedValueOnce({ ...stamped, uuid: randomUUID() })
    expect((await emit(s.refund.id)).status).toBe('STAMPED')
    expect(provider.getInvoice).toHaveBeenCalledWith('pending-note')
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })
  it('lookup pending es lectura: no guarda id ni cambia versión/snapshot', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    const before = await note(s.refund.id)
    provider.findByExternalId.mockResolvedValue({ ...stamped, providerInvoiceId: 'pending-found', status: 'pending', uuid: null })
    await expect(emit(s.refund.id)).rejects.toThrow(/proces/i)
    expect(await note(s.refund.id)).toEqual(before)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })
  it('incertidumbre nunca caduca; ausencia no recaptura ni cambia attempts', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    const first = await note(s.refund.id)
    await prisma.cfdi.update({ where: { id: first.id }, data: { enviadoAt: new Date(Date.now() - 61 * 60000) } })
    await expect(emit(s.refund.id)).rejects.toThrow(/proces/i)
    await expect(emit(s.refund.id)).rejects.toThrow(/proces/i)
    expect(await note(s.refund.id)).toMatchObject({ attempts: 1, entradaHuella: first.entradaHuella, falloDefinitivo: false })
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    expect(await prisma.activityLog.count({ where: { venueId, entityId: first.id, action: 'CFDI_INTENTO_INCIERTO_ESCALADO' } })).toBe(1)
  })
  it('rechazo confirmado recaptura la misma fila con versión nueva y reserva saldo propio', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new ProviderHttpError(400, 'invalid_request', 'rechazo'))
    expect((await emit(s.refund.id)).status).toBe('STAMP_FAILED')
    const first = await note(s.refund.id)
    expect(first.falloDefinitivo).toBe(true)
    expect((await emit(s.refund.id)).status).toBe('STAMPED')
    expect(await note(s.refund.id)).toMatchObject({ id: first.id, attempts: 2, falloDefinitivo: false })
    expect(provider.createCreditNote.mock.calls[1][0].externalId).toBe(`${first.idempotencyKey}#2`)
  })
  it('admisión org y recheck del reembolso ocurren dentro de la reserva', async () => {
    const s = await sale()
    const spy = jest.spyOn(admission, 'tomarAdmisionCompartida')
    await expect(
      emitRefundCreditNote(
        { venueId, refundPaymentId: s.refund.id, sandbox: true },
        {
          runInTransaction: work =>
            prisma.$transaction(async tx => {
              await tx.payment.update({ where: { id: s.refund.id }, data: { status: 'PENDING' } })
              return work(tx)
            }),
        },
      ),
    ).rejects.toThrow(/no está completado/)
    expect(spy).toHaveBeenCalledWith(expect.anything(), fixture)
    expect(provider.createCreditNote).not.toHaveBeenCalled()
    expect(await prisma.cfdi.count({ where: { idempotencyKey: `cfdi-refund-${s.refund.id}` } })).toBe(0)
  })
  it('fallo de archivos ocurre después de identidad duradera, sin otro timbre al reintentar', async () => {
    const s = await sale()
    provider.downloadXml.mockRejectedValueOnce(new Error('storage offline'))
    expect((await emit(s.refund.id)).status).toBe('STAMPED')
    expect((await note(s.refund.id)).uuid).toBeTruthy()
    expect((await emit(s.refund.id)).status).toBe('STAMPED')
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })
  it.each(['STAMPED', 'CANCELLED', 'VERSION'])('respuesta atrasada no pisa %s', async state => {
    const s = await sale()
    provider.createCreditNote.mockImplementationOnce(async () => {
      const n = await note(s.refund.id)
      await prisma.cfdi.update({
        where: { id: n.id },
        data:
          state === 'VERSION'
            ? { attempts: 2 }
            : state === 'CANCELLED'
              ? { status: 'CANCELLED', cancelStatus: 'ACCEPTED' }
              : { status: 'STAMPED', uuid: 'winner', facturapiId: 'winner' },
      })
      return { ...stamped, uuid: randomUUID() }
    })
    await expect(emit(s.refund.id)).rejects.toThrow(/proces/i)
    const n = await note(s.refund.id)
    if (state === 'VERSION') expect(n.attempts).toBe(2)
    else expect(n.status).toBe(state)
    if (state === 'STAMPED') expect(n.uuid).toBe('winner')
  })
  async function legacy() {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    const n = await note(s.refund.id)
    await prisma.cfdi.update({
      where: { id: n.id },
      data: { protocoloIva: null, entrada: Prisma.DbNull, entradaHuella: null, enviadoAt: null },
    })
    return { ...s, n: await note(s.refund.id) }
  }
  it('legacy recupera por identidad sin snapshot ni reescribir dinero desde el reembolso', async () => {
    const s = await legacy()
    await prisma.payment.update({ where: { id: s.refund.id }, data: { status: 'PENDING', amount: -1 } })
    provider.findByExternalId.mockResolvedValue({ ...stamped, uuid: randomUUID() })
    const logAction = jest.fn()
    expect((await emitRefundCreditNote({ venueId, refundPaymentId: s.refund.id, sandbox: true }, { logAction })).status).toBe('STAMPED')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ relatedUuid: undefined, relatedCfdiId: undefined }) }),
    )
    expect(provider.findByExternalId).toHaveBeenCalledWith(s.n.idempotencyKey)
    expect(await note(s.refund.id)).toMatchObject({ protocoloIva: null, entrada: null, totalCents: 11600, attempts: s.n.attempts })
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })
  it.each(['pending', 'valid'])('legacy lookup %s sin UUID es lectura, no finaliza ni emite', async status => {
    const s = await legacy()
    provider.findByExternalId.mockResolvedValue({ ...stamped, uuid: null, status })
    await expect(emit(s.refund.id)).rejects.toThrow(/proces/i)
    expect(await note(s.refund.id)).toEqual(s.n)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })
  it('legacy STAMP_FAILED conserva reintento sin identidad versionada ni entrada', async () => {
    const s = await legacy()
    const logAction = jest.fn()
    await emitRefundCreditNote({ venueId, refundPaymentId: s.refund.id, sandbox: true }, { logAction })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CFDI_CREDIT_NOTE_ISSUED',
        data: expect.objectContaining({ relatedUuid: s.original.uuid, relatedCfdiId: s.original.id }),
      }),
    )
    expect(provider.createCreditNote.mock.calls[1][0]).toMatchObject({ externalId: s.n.idempotencyKey, idempotencyKey: s.n.idempotencyKey })
    expect(provider.createCreditNote.mock.calls[1][0].protocoloIva).toBeUndefined()
    expect(await note(s.refund.id)).toMatchObject({ protocoloIva: null, entrada: null, attempts: s.n.attempts + 1, status: 'STAMPED' })
  })
  it.each(['success', 'failure', 'pending'])('legacy resultado %s no pisa cancelación concurrente', async outcome => {
    const s = await legacy()
    provider.createCreditNote.mockImplementationOnce(async () => {
      await prisma.cfdi.update({ where: { id: s.n.id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
      if (outcome === 'failure') throw new Error('late')
      return { ...stamped, uuid: outcome === 'pending' ? null : randomUUID(), status: outcome === 'pending' ? 'pending' : 'valid' }
    })
    await expect(emit(s.refund.id)).rejects.toThrow(/proces/i)
    expect(await note(s.refund.id)).toMatchObject({ status: 'CANCELLED', cancelStatus: 'ACCEPTED', facturapiId: null })
  })
  it('legacy éxito obsoleto no audita el enlace capturado sobre un ganador nuevo', async () => {
    const s = await legacy()
    const logAction = jest.fn()
    let winner: any
    provider.createCreditNote.mockImplementationOnce(async () => {
      winner = await prisma.cfdi.update({
        where: { id: s.n.id },
        data: { attempts: { increment: 1 }, status: 'STAMPED', uuid: randomUUID(), facturapiId: randomUUID() },
      })
      return { ...stamped, uuid: randomUUID() }
    })
    await expect(emitRefundCreditNote({ venueId, refundPaymentId: s.refund.id, sandbox: true }, { logAction })).rejects.toThrow(/proces/i)
    expect(await note(s.refund.id)).toEqual(winner)
    expect(logAction).not.toHaveBeenCalled()
  })
  it('saldo ignora egreso válido de otra original pero conserva atribución legacy/corrupta', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    await prisma.cfdi.update({ where: { id: s.original.id }, data: { status: 'CANCELLED', cancelStatus: 'ACCEPTED' } })
    const data = { ...s.original, id: undefined, createdAt: undefined, updatedAt: undefined }
    const newer = await prisma.cfdi.create({
      data: {
        ...data,
        idempotencyKey: randomUUID(),
        uuid: randomUUID(),
        entrada: data.entrada as Prisma.InputJsonValue,
        globalPeriod: Prisma.DbNull,
        taxBreakdown: Prisma.DbNull,
      },
    })
    const r = await refund(s.o.id)
    expect((await getRefundCreditNoteStatus(venueId, r.id))?.eligibility.eligible).toBe(true)
    const n = await note(s.refund.id)
    await prisma.cfdi.update({ where: { id: n.id }, data: { entradaHuella: 'bad' } })
    expect((await getRefundCreditNoteStatus(venueId, r.id))?.eligibility.reason).toBe('EXCEEDS_REMAINING')
    await prisma.cfdi.update({ where: { id: n.id }, data: { protocoloIva: null, entrada: Prisma.DbNull, entradaHuella: null } })
    expect((await getRefundCreditNoteStatus(venueId, r.id))?.eligibility.reason).toBe('EXCEEDS_REMAINING')
    expect(newer.id).not.toBe(s.original.id)
  })
  it.each(['money', 'original-item', 'original-tax'])('rechaza snapshot de forma válida pero semántica corrupta: %s', async corrupt => {
    const s = await sale()
    if (corrupt.startsWith('original')) {
      const e = structuredClone(s.original.entrada) as any
      if (corrupt === 'original-item') e.params.items[0].unitPriceCents = null
      else e.params.items[0].taxes[0].rate = 0
      await prisma.cfdi.update({ where: { id: s.original.id }, data: { entrada: e, entradaHuella: huellaDeEntrada(e) } })
      expect((await getRefundCreditNoteStatus(venueId, s.refund.id))?.eligibility.reason).toBe('ORIGINAL_ENTRADA_INVALIDA')
    } else {
      await expect(
        emitRefundCreditNote(
          { venueId, refundPaymentId: s.refund.id, sandbox: true },
          {
            reserveCfdi: async (data, tx = prisma) => {
              const altered = structuredClone(data) as any
              altered.entrada.montos.subtotalCents++
              altered.entrada.montos.taxCents--
              altered.subtotalCents++
              altered.taxCents--
              altered.entradaHuella = huellaDeEntrada(altered.entrada)
              return tx.cfdi.create({ data: altered })
            },
          },
        ),
      ).rejects.toThrow(/soporte/)
    }
    expect(provider.createCreditNote).not.toHaveBeenCalled()
  })
  it.each(['price', 'quantity', 'discount', 'taxIncluded-flipped', 'taxIncluded-missing', 'taxIncluded-string'])(
    'rechaza conceptos originales que contradicen la cabecera: %s',
    async corruption => {
      const s = await sale()
      const e = structuredClone(s.original.entrada) as any
      const item = e.params.items[0]
      if (corruption === 'price') item.unitPriceCents = 1
      if (corruption === 'quantity') item.quantity = 2
      if (corruption === 'discount') item.discountCents = 100
      if (corruption === 'taxIncluded-flipped') item.taxIncluded = false
      if (corruption === 'taxIncluded-missing') delete item.taxIncluded
      if (corruption === 'taxIncluded-string') item.taxIncluded = 'true'
      await prisma.cfdi.update({ where: { id: s.original.id }, data: { entrada: e, entradaHuella: huellaDeEntrada(e) } })
      expect((await getRefundCreditNoteStatus(venueId, s.refund.id))?.eligibility.reason).toBe('ORIGINAL_ENTRADA_INVALIDA')
      await expect(emit(s.refund.id)).rejects.toThrow(/soporte/)
      expect(provider.createCreditNote).not.toHaveBeenCalled()
    },
  )
  it.each([
    { taxIncluded: true, unitPriceCents: 5801, quantity: 2, discountCents: 2, subtotalCents: 10000, taxCents: 1600, totalCents: 11600 },
    { taxIncluded: false, unitPriceCents: 5001, quantity: 2, discountCents: 2, subtotalCents: 10000, taxCents: 1600, totalCents: 11600 },
    { taxIncluded: true, unitPriceCents: 10005, quantity: 0.3, discountCents: 1, subtotalCents: 2587, taxCents: 414, totalCents: 3001 },
    { taxIncluded: false, unitPriceCents: 10005, quantity: 0.3, discountCents: 1, subtotalCents: 3001, taxCents: 480, totalCents: 3481 },
  ])('admite conceptos originales válidos con descuento y redondeo: %j', async example => {
    const s = await sale()
    const e = structuredClone(s.original.entrada) as any
    const { subtotalCents, taxCents, totalCents, ...item } = example
    Object.assign(e.params.items[0], item)
    e.montos = { subtotalCents, taxCents, totalCents }
    e.paidCents = totalCents
    await prisma.cfdi.update({
      where: { id: s.original.id },
      data: { entrada: e, entradaHuella: huellaDeEntrada(e), subtotalCents, taxCents, totalCents },
    })
    await prisma.payment.update({ where: { id: s.refund.id }, data: { amount: -totalCents / 100 } })
    expect((await getRefundCreditNoteStatus(venueId, s.refund.id))?.eligibility.eligible).toBe(true)
    await emit(s.refund.id)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    expect((await note(s.refund.id)).totalCents).toBe(totalCents)
  })
  it('CSD inválido guarda intento nunca enviado, corregirlo permite primera versión1', async () => {
    const s = await sale()
    await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { csdStatus: 'EXPIRED' } })
    try {
      expect((await emit(s.refund.id)).status).toBe('VALIDATION_FAILED')
      expect(await note(s.refund.id)).toMatchObject({ attempts: 0, enviadoAt: null, protocoloIva: 1 })
      expect(provider.createCreditNote).not.toHaveBeenCalled()
    } finally {
      await prisma.fiscalEmisor.update({ where: { id: fiscalEmisorId }, data: { csdStatus: 'ACTIVE' } })
    }
    expect((await emit(s.refund.id)).status).toBe('STAMPED')
    expect((await note(s.refund.id)).attempts).toBe(1)
  })
  it('regresión: parcial, propina excluida, receptor original y forma99 fallback', async () => {
    const s = await sale()
    await prisma.payment.update({ where: { id: s.refund.id }, data: { amount: -33.33, tipAmount: -10, method: 'OTHER' } })
    await emit(s.refund.id)
    const n = await note(s.refund.id)
    expect(n.subtotalCents + n.taxCents).toBe(3333)
    expect(n.formaPago).toBe(s.original.formaPago)
    expect(provider.createCreditNote.mock.calls[0][0]).toEqual({
      receptor: {
        rfc: receptor.rfc,
        razonSocial: receptor.razonSocial,
        regimenFiscal: receptor.regimenFiscal,
        codigoPostal: receptor.codigoPostal,
        usoCfdi: 'G02',
      },
      items: [
        {
          satProductKey: '01010101',
          satUnitKey: 'ACT',
          description: `Devolución sobre factura ${s.original.serie}${s.original.folio}`,
          quantity: 1,
          unitPriceCents: 3333,
          discountCents: 0,
          objetoImp: '02',
          taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
          taxIncluded: true,
        },
      ],
      formaPago: s.original.formaPago,
      metodoPago: 'PUE',
      relationship: '01',
      relatedUuids: [s.original.uuid],
      externalId: `cfdi-refund-${s.refund.id}#1`,
      idempotencyKey: `cfdi-refund-${s.refund.id}#1`,
      protocoloIva: 1,
    })
  })
  it('carrera de la misma llave devuelve el ganador STAMPED sin otro envío', async () => {
    const s = await sale()
    const result = await emitRefundCreditNote(
      { venueId, refundPaymentId: s.refund.id, sandbox: true },
      {
        runInTransaction: async work => {
          await emit(s.refund.id)
          return prisma.$transaction(work)
        },
      },
    )
    expect(result.status).toBe('STAMPED')
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
  })
  it('original histórica positiva sigue al16 sin tasas de catálogo', async () => {
    const s = await sale()
    await prisma.cfdi.update({ where: { id: s.original.id }, data: { protocoloIva: null, entrada: Prisma.DbNull, entradaHuella: null } })
    await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'IVA_0' } })
    await emit(s.refund.id)
    expect(await note(s.refund.id)).toMatchObject({ subtotalCents: 10000, taxCents: 1600, protocoloIva: 1 })
    expect((await note(s.refund.id)).entrada).not.toHaveProperty('originalSinIvaHistorico')
  })
  it('proveedor sin soporte no reserva ni marca enviado', async () => {
    const s = await sale()
    await expect(
      emitRefundCreditNote({ venueId, refundPaymentId: s.refund.id, sandbox: true }, { resolveProvider: () => ({ name: 'other' }) as any }),
    ).rejects.toThrow(/no soporta/)
    expect(await prisma.cfdi.count({ where: { idempotencyKey: `cfdi-refund-${s.refund.id}` } })).toBe(0)
  })
  it('MCP mantiene lookupOnly entre dos llamadas aunque el intento pase a rechazado', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    const call = mcp()
    const preview = await call(s.refund.id)
    expect(preview.confirmationArgs).toMatchObject({ confirm: true, lookupOnly: true, venueId, refundPaymentId: s.refund.id })
    await prisma.cfdi.update({ where: { id: (await note(s.refund.id)).id }, data: { falloDefinitivo: true } })
    const confirmed = await call(s.refund.id, true, { lookupOnly: preview.confirmationArgs.lookupOnly })
    expect(confirmed.ok).toBe(false)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    expect((await note(s.refund.id)).attempts).toBe(1)
  })
  it('MCP confirm viejo sin flag exige preview fresco; false explícito sí permite recaptura', async () => {
    const s = await sale()
    provider.createCreditNote.mockRejectedValueOnce(new Error('timeout'))
    await emit(s.refund.id)
    const call = mcp()
    await call(s.refund.id)
    await prisma.cfdi.update({ where: { id: (await note(s.refund.id)).id }, data: { falloDefinitivo: true } })
    const fresh = await call(s.refund.id, true)
    expect(fresh).toMatchObject({ requiresConfirmation: true, confirmationArgs: { lookupOnly: false } })
    expect(provider.createCreditNote).toHaveBeenCalledTimes(1)
    expect((await call(s.refund.id, true, { lookupOnly: false })).ok).toBe(true)
    expect(provider.createCreditNote).toHaveBeenCalledTimes(2)
  })
})
