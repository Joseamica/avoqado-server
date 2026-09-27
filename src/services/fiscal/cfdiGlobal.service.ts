// La reserva global congela el periodo completo; sólo su entrada llega al PAC.
import { CsdStatus, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { ConflictError } from '../../errors/AppError'
import { uploadFileToStorage } from '../storage.service'
import { resolveFiscalProvider } from './fiscalProvider.factory'
import {
  buildGlobalInvoiceParams,
  GlobalInvoiceLine,
  GlobalLineItemInput,
  groupOrderIntoGlobalLines,
  reconcileGlobalLines,
} from './cfdiPayloadBuilder'
import { splitIvaIncluded } from './ivaMath'
import {
  esCobroElegible,
  importeConceptoCents,
  motivosDeOrden,
  reconstruirConceptos,
  totalDelDocumentoCents,
  OrdenParaConceptos,
  renglonConTratamiento,
  consultarIntentoCapturado,
  enviarIntentoCapturado,
  finalizarEmision,
  IssueCfdiDeps,
} from './cfdi.service'
import { closedPeriodFor, ClosedPeriod } from './globalPeriod'
import { validateBeforeStamp } from './cfdiValidation'
import { mapFormaPago } from './satCatalog'
import { GlobalInvoiceParams } from './providers/fiscal-provider.interface'
import { tomarAdmisionCompartida, bloquearOrdenesParaFacturar } from './admisionIva'
import { liberarSellosDe, sellarRenglones } from './sellosIva'
import { CFDI_VIVO } from './exclusionGlobal'
import { clasificarOrden, resolverTratamiento } from './ivaDeRenglon'
import type { IvaTratamiento } from './ivaTratamiento'
import { huellaDeEntrada } from './entradaDocumental'

export type IssueGlobalStatus = 'STAMPED' | 'NOTHING_TO_INVOICE' | 'SKIPPED' | 'VALIDATION_FAILED' | 'STAMP_FAILED'
export interface IssueGlobalResult {
  status: IssueGlobalStatus
  cfdi?: any
  reasons?: string[]
  reason?: string
  period?: ClosedPeriod
  candidateCount?: number
  excluidasPorIvaMixto?: number
}
export interface GlobalEmisor {
  id: string
  venueId: string
  globalPeriodicity: any
  serie: string | null
  lugarExpedicion: string
  csdStatus: CsdStatus
  providerKeyEnc: string | null
  provider: any
  invoiceCashSales: boolean
}
export interface IssueGlobalDeps {
  loadEmisor: (id: string) => Promise<GlobalEmisor | null>
  findExistingGlobal: (key: string) => Promise<any | null>
  /** Sólo ids; páginas completas y ordenadas, la elegibilidad se relee en la reserva. */
  loadGlobalCandidates: (emisorId: string, start: Date, end: Date, cash: boolean, venueId: string) => Promise<string[]>
  resolveProvider: typeof resolveFiscalProvider
  storeArtifact: IssueCfdiDeps['storeArtifact']
  persistCfdi: IssueCfdiDeps['persistCfdi']
  reserveCfdi: IssueCfdiDeps['reserveCfdi']
  persistArtifacts: IssueCfdiDeps['persistArtifacts']
  runInTransaction: NonNullable<IssueCfdiDeps['runInTransaction']>
  loadVenueSlug: (venueId: string) => Promise<string>
}
interface EntradaGlobal {
  version: 1
  tipo: 'GLOBAL'
  fiscalEmisorId: string
  globalPeriod: { periodicidad: string; meses: string; anio: number }
  montos: { subtotalCents: number; taxCents: number; totalCents: number }
  excluidasPorIvaMixto: number
  ordenes: Array<{ orderId: string; huella: string; renglones: Array<{ orderItemId: string; tratamiento: IvaTratamiento }> }>
  params: GlobalInvoiceParams
}
const PAGE = 100
const PROCESANDO = 'La factura de esta venta se está procesando; intenta de nuevo en unos minutos.'

/** Hash más forma/identidad/dinero: JSON válido no implica una entrada fiscal válida. */
function leerGlobal(cfdi: any): EntradaGlobal {
  const e = cfdi.entrada as EntradaGlobal | null
  const cents = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
  const ids = new Set<string>()
  const itemIds = new Set<string>()
  if (
    !e ||
    e.version !== 1 ||
    e.tipo !== 'GLOBAL' ||
    e.fiscalEmisorId !== cfdi.fiscalEmisorId ||
    !e.montos ||
    !Object.values(e.montos).every(cents) ||
    !cents(e.excluidasPorIvaMixto) ||
    e.montos.subtotalCents + e.montos.taxCents !== e.montos.totalCents ||
    e.montos.subtotalCents !== cfdi.subtotalCents ||
    e.montos.taxCents !== cfdi.taxCents ||
    e.montos.totalCents !== cfdi.totalCents ||
    !e.globalPeriod ||
    huellaDeEntrada(e.globalPeriod) !== huellaDeEntrada(cfdi.globalPeriod) ||
    !Array.isArray(e.ordenes) ||
    !e.ordenes.every(o => {
      if (!o || typeof o.orderId !== 'string' || ids.has(o.orderId) || !/^[a-f0-9]{64}$/.test(o.huella) || !Array.isArray(o.renglones))
        return false
      ids.add(o.orderId)
      return o.renglones.every(r => {
        if (!r || typeof r.orderItemId !== 'string' || itemIds.has(r.orderItemId) || r.tratamiento !== 'IVA_16') return false
        itemIds.add(r.orderItemId)
        return true
      })
    }) ||
    !e.params ||
    !Array.isArray(e.params.items) ||
    e.params.items.length !== e.ordenes.length ||
    e.params.externalId !== undefined ||
    e.params.idempotencyKey !== undefined ||
    e.params.receptor?.tax_id !== 'XAXX010101000' ||
    e.params.receptor?.tax_system !== '616' ||
    e.params.use !== 'S01' ||
    e.params.receptor.legal_name !== 'PÚBLICO EN GENERAL' ||
    typeof e.params.receptor.address?.zip !== 'string' ||
    !e.params.global ||
    e.params.global.months !== e.globalPeriod.meses ||
    e.params.global.year !== e.globalPeriod.anio ||
    !['day', 'week', 'fortnight', 'month', 'two_months'].includes(e.params.global.periodicity) ||
    typeof e.params.payment_form !== 'string' ||
    !e.params.items.every(
      i =>
        i &&
        typeof i === 'object' &&
        i.quantity === 1 &&
        typeof i.taxIncluded === 'boolean' &&
        i.satProductKey === '01010101' &&
        i.satUnitKey === 'ACT' &&
        i.description === 'Venta' &&
        cents(i.unitPriceCents) &&
        i.discountCents === 0 &&
        i.objetoImp === '02' &&
        Array.isArray(i.taxes) &&
        i.taxes.length === 1 &&
        i.taxes[0]?.type === 'IVA' &&
        i.taxes[0].rate === 0.16 &&
        i.taxes[0].factor === 'Tasa' &&
        i.taxes[0].withholding === false,
    ) ||
    huellaDeEntrada(e) !== cfdi.entradaHuella
  )
    throw new ConflictError('La entrada fiscal de esta factura requiere revisión de soporte.')
  const totals = e.params.items.reduce(
    (sum, i) => {
      const part = i.taxIncluded
        ? splitIvaIncluded(i.unitPriceCents, 0.16)
        : { netCents: i.unitPriceCents, taxCents: Math.round(i.unitPriceCents * 0.16) }
      return { netCents: sum.netCents + part.netCents, taxCents: sum.taxCents + part.taxCents }
    },
    { netCents: 0, taxCents: 0 },
  )
  if (totals.netCents !== e.montos.subtotalCents || totals.taxCents !== e.montos.taxCents)
    throw new ConflictError('La entrada fiscal de esta factura requiere revisión de soporte.')
  return e
}

export async function issueGlobalForEmisor(
  params: { emisorId: string; now: Date; sandbox: boolean },
  overrides: Partial<IssueGlobalDeps> = {},
): Promise<IssueGlobalResult> {
  const deps = { ...defaultDeps, ...overrides }
  const emisor = await deps.loadEmisor(params.emisorId)
  if (!emisor) throw new Error(`FiscalEmisor ${params.emisorId} not found`)
  if (emisor.csdStatus !== 'ACTIVE') return { status: 'SKIPPED', reason: 'CSD inactivo' }
  const period = closedPeriodFor(emisor.globalPeriodicity, params.now)
  const key = `cfdi-global-${emisor.id}-${period.anio}-${period.meses}-${period.satPeriodicidad}`
  const shared = { ...deps, findExistingCfdi: deps.findExistingGlobal }
  let cfdi = await deps.findExistingGlobal(key)
  if (cfdi && (cfdi.venueId !== emisor.venueId || cfdi.fiscalEmisorId !== emisor.id)) throw new Error('Emisor fiscal not found')
  if (cfdi?.status === 'STAMPED')
    return { status: 'STAMPED', cfdi, period, candidateCount: 0, excluidasPorIvaMixto: cfdi.entrada?.excluidasPorIvaMixto ?? 0 }
  if (cfdi && cfdi.protocoloIva === null) return emitirGlobalLegacy(cfdi, emisor, period, deps, params.sandbox)
  if (cfdi && !['STAMPING', 'STAMP_FAILED', 'VALIDATION_FAILED'].includes(cfdi.status)) throw new ConflictError(PROCESANDO)
  if (cfdi) {
    leerGlobal(cfdi)
    const provider = deps.resolveProvider(emisor, { sandbox: params.sandbox })
    const recovered = await consultarIntentoCapturado(cfdi, provider, deps.runInTransaction)
    if (recovered)
      return {
        ...(await finalizarEmision(cfdi, recovered, provider, await deps.loadVenueSlug(emisor.venueId), shared)),
        period,
        candidateCount: cfdi.entrada.ordenes.length,
        excluidasPorIvaMixto: cfdi.entrada.excluidasPorIvaMixto,
      }
  }
  const candidateIds = await deps.loadGlobalCandidates(
    emisor.id,
    period.periodStart,
    period.periodEnd,
    emisor.invoiceCashSales,
    emisor.venueId,
  )
  const previous = cfdi
  const reserved = await deps
    .runInTransaction(async tx => {
      const venue = await tx.venue.findUniqueOrThrow({ where: { id: emisor.venueId }, select: { organizationId: true } })
      // Match admission order: all order/product locks precede the shared organization lock.
      const oldIds: string[] = []
      if (previous) {
        let after: string | undefined
        for (;;) {
          const page = await tx.cfdiGlobalOrden.findMany({
            where: { cfdiId: previous.id, ...(after ? { orderId: { gt: after } } : {}) },
            orderBy: { orderId: 'asc' },
            take: PAGE,
            select: { orderId: true },
          })
          oldIds.push(...page.map(x => x.orderId))
          if (page.length < PAGE) break
          after = page[page.length - 1].orderId
        }
      }
      const ids = [...new Set([...oldIds, ...candidateIds])].sort()
      await bloquearOrdenesParaFacturar(tx, ids, emisor.venueId)
      await tomarAdmisionCompartida(tx, venue.organizationId)
      const current = await tx.cfdi.findUnique({ where: { idempotencyKey: key } })
      if (!previous && current) return { cfdi: current, fresh: false, reasons: [] as string[], empty: false }
      if (previous) {
        const claimed = await tx.cfdi.updateMany({
          where: {
            id: previous.id,
            status: previous.status,
            attempts: previous.attempts,
            protocoloIva: 1,
            OR: [{ enviadoAt: null }, { falloDefinitivo: true }],
          },
          data: { status: 'STAMPING' },
        })
        if (claimed.count !== 1) throw new ConflictError(PROCESANDO)
        await liberarSellosDe(tx, previous.id)
        await tx.cfdiGlobalOrden.deleteMany({ where: { cfdiId: previous.id } })
      }
      const captured = await capturarGlobal(tx, emisor, period, candidateIds, previous?.id)
      if (!captured.entrada.ordenes.length && !previous)
        return { cfdi: null, fresh: true, reasons: [], empty: true, excluded: captured.entrada.excluidasPorIvaMixto }
      const reasons = captured.reasons
      const attempts = (previous?.attempts ?? 0) + (reasons.length ? 0 : 1)
      const data = {
        ...baseGlobalCfdiData(emisor, key, period, captured.entrada),
        status: reasons.length ? 'VALIDATION_FAILED' : 'STAMPING',
        protocoloIva: 1,
        entrada: captured.entrada as unknown as Prisma.InputJsonValue,
        entradaHuella: huellaDeEntrada(captured.entrada),
        attempts,
        enviadoAt: null,
        falloDefinitivo: false,
        facturapiId: null,
        uuid: null,
        lastError: reasons.length ? reasons.join(' | ') : null,
      }
      let saved
      if (previous) {
        const changed = await tx.cfdi.updateMany({
          where: { id: previous.id, status: 'STAMPING', attempts: previous.attempts },
          data: data as any,
        })
        if (changed.count !== 1) throw new ConflictError(PROCESANDO)
        saved = await tx.cfdi.findUniqueOrThrow({ where: { id: previous.id } })
      } else saved = await deps.reserveCfdi(data, tx)
      if (!reasons.length) {
        for (let at = 0; at < captured.entrada.ordenes.length; at += PAGE) {
          const page = captured.entrada.ordenes.slice(at, at + PAGE)
          await tx.cfdiGlobalOrden.createMany({ data: page.map(o => ({ cfdiId: saved.id, orderId: o.orderId, huella: o.huella })) })
          await sellarRenglones(tx, { cfdiId: saved.id, intento: attempts, renglones: page.flatMap(o => o.renglones) })
        }
      }
      return { cfdi: saved, fresh: true, reasons, empty: !captured.entrada.ordenes.length, excluded: captured.entrada.excluidasPorIvaMixto }
    })
    .catch(err => {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictError(PROCESANDO)
      throw err
    })
  cfdi = reserved.cfdi
  if (reserved.empty) return { status: 'NOTHING_TO_INVOICE', period, candidateCount: 0, excluidasPorIvaMixto: reserved.excluded ?? 0 }
  if (!cfdi || cfdi.protocoloIva !== 1) throw new ConflictError(PROCESANDO)
  const entrada = leerGlobal(cfdi)
  const counts = { period, candidateCount: entrada.ordenes.length, excluidasPorIvaMixto: entrada.excluidasPorIvaMixto }
  if (cfdi.status === 'STAMPED') return { status: 'STAMPED', cfdi, ...counts }
  if (reserved.reasons.length) return { status: 'VALIDATION_FAILED', cfdi, reasons: reserved.reasons, ...counts }
  const provider = deps.resolveProvider(emisor, { sandbox: params.sandbox })
  const recovered = reserved.fresh ? null : await consultarIntentoCapturado(cfdi, provider, deps.runInTransaction)
  // A concurrent unsent reservation belongs to its original caller; only that caller can send it.
  if (!reserved.fresh && !recovered) throw new ConflictError(PROCESANDO)
  return {
    ...(await enviarIntentoCapturado(
      cfdi,
      { tipo: 'GLOBAL', params: entrada.params },
      recovered,
      provider,
      await deps.loadVenueSlug(emisor.venueId),
      shared,
    )),
    ...counts,
  }
}

function candidateWhere(emisor: GlobalEmisor, period: ClosedPeriod): Prisma.OrderWhereInput {
  const config = { fiscalEmisorId: emisor.id, includeInGlobal: true, facturacionEnabled: true }
  return {
    venueId: emisor.venueId,
    paymentStatus: 'PAID',
    updatedAt: { gte: period.periodStart, lt: period.periodEnd },
    payments: {
      some: {
        status: 'COMPLETED',
        AND: [COBRO_ELEGIBLE],
        OR: [{ merchantAccount: { fiscalConfig: config } }, { ecommerceMerchant: { fiscalConfig: config } }],
      },
    },
    AND: filtrosDeExclusion(emisor.id, emisor.invoiceCashSales),
  }
}
const COBRO_ELEGIBLE: Prisma.PaymentWhereInput = { OR: [{ type: { in: ['REGULAR', 'FAST'] } }, { type: null }] }
const ORDER_SELECT = {
  id: true,
  orderNumber: true,
  subtotal: true,
  taxAmount: true,
  total: true,
  discountAmount: true,
  serviceChargeAmount: true,
  promotions: { select: { id: true }, take: 1 },
  payments: {
    where: { status: 'COMPLETED' as const, ...COBRO_ELEGIBLE },
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    select: { method: true, tenderSatFormaPago: true, amount: true, type: true },
  },
  items: {
    orderBy: { id: 'asc' as const },
    select: {
      id: true,
      ivaTratamiento: true,
      productName: true,
      quantity: true,
      unitPrice: true,
      discountAmount: true,
      taxAmount: true,
      total: true,
      weightQuantity: true,
      modifiers: { select: { name: true, price: true, quantity: true } },
      product: { select: { ivaTratamiento: true, taxRate: true, objetoImp: true, satProductKey: true, satUnitKey: true } },
    },
  },
} satisfies Prisma.OrderSelect

async function capturarGlobal(tx: Prisma.TransactionClient, emisor: GlobalEmisor, period: ClosedPeriod, ids: string[], self?: string) {
  const lines: GlobalInvoiceLine[] = []
  const ordenes: EntradaGlobal['ordenes'] = []
  let excluidasPorIvaMixto = 0
  for (let at = 0; at < ids.length; at += PAGE) {
    const orders = await tx.order.findMany({
      where: {
        ...candidateWhere(emisor, period),
        id: { in: ids.slice(at, at + PAGE) },
        cfdis: { none: { isGlobal: false, type: 'INGRESO', ...CFDI_VIVO } },
        enGlobales: { none: { cfdi: { ...CFDI_VIVO, ...(self ? { id: { not: self } } : {}) } } },
      },
      select: ORDER_SELECT,
      orderBy: { id: 'asc' },
      take: PAGE,
    })
    for (const order of orders) {
      const renglones = order.items.map(it => ({
        orderItemId: it.id,
        tratamiento: resolverTratamiento({
          selladoIva: it.ivaTratamiento,
          productoIva: it.product?.ivaTratamiento,
          tieneProducto: !!it.product,
        }),
      }))
      if (clasificarOrden(renglones.map(r => r.tratamiento)) === 'MIXTA') {
        excluidasPorIvaMixto++
        continue
      }
      const orderLines = globalLinesFromOrder(order)
      if (!orderLines.length) continue
      lines.push(...orderLines)
      ordenes.push({ orderId: order.id, huella: huellaDeEntrada({ renglones, lineas: orderLines }), renglones })
    }
  }
  const montos = reconcileGlobalLines(lines)
  const params: GlobalInvoiceParams = lines.length
    ? buildGlobalInvoiceParams(emisor, lines, period)
    : {
        receptor: {
          legal_name: 'PÚBLICO EN GENERAL',
          tax_id: 'XAXX010101000',
          tax_system: '616',
          address: { zip: emisor.lugarExpedicion },
        },
        items: [],
        payment_form: '99',
        use: 'S01',
        global: { periodicity: period.facturaPeriodicity, months: period.meses, year: period.anio },
      }
  const reasons = lines.length
    ? validateBeforeStamp({
        csdStatus: emisor.csdStatus,
        formaPago: params.payment_form,
        receptor: {
          rfc: 'XAXX010101000',
          razonSocial: 'PÚBLICO EN GENERAL',
          regimenFiscal: '616',
          codigoPostal: emisor.lugarExpedicion,
          usoCfdi: 'S01',
        },
        items: params.items,
        expectedSubtotalCents: montos.subtotalCents,
        expectedTaxCents: montos.taxCents,
        expectedTotalCents: montos.totalCents,
        isGlobal: true,
      }).reasons
    : ['No hay tickets por facturar en el periodo.']
  const entrada: EntradaGlobal = {
    version: 1,
    tipo: 'GLOBAL',
    fiscalEmisorId: emisor.id,
    globalPeriod: { periodicidad: period.satPeriodicidad, meses: period.meses, anio: period.anio },
    montos,
    excluidasPorIvaMixto,
    ordenes,
    params,
  }
  return { entrada, reasons }
}
function baseGlobalCfdiData(emisor: GlobalEmisor, key: string, period: ClosedPeriod, entrada: EntradaGlobal) {
  return {
    venueId: emisor.venueId,
    fiscalEmisorId: emisor.id,
    orderId: null,
    flow: 'GLOBAL_C' as const,
    idempotencyKey: key,
    isGlobal: true,
    globalPeriod: { periodicidad: period.satPeriodicidad, meses: period.meses, anio: period.anio },
    type: 'INGRESO' as const,
    receptorRfc: 'XAXX010101000',
    receptorNombre: 'PÚBLICO EN GENERAL',
    receptorRegimen: '616',
    receptorCp: emisor.lugarExpedicion,
    usoCfdi: 'S01',
    formaPago: entrada.params.payment_form,
    metodoPago: 'PUE',
    ...entrada.montos,
  }
}

/** Histórico: identidad sin versión y reintentos compatibles, sin inventar sellos ni entrada. */
async function emitirGlobalLegacy(
  cfdi: any,
  emisor: GlobalEmisor,
  period: ClosedPeriod,
  deps: IssueGlobalDeps,
  sandbox: boolean,
): Promise<IssueGlobalResult> {
  const provider = deps.resolveProvider(emisor, { sandbox })
  const shared = { ...deps, findExistingCfdi: deps.findExistingGlobal }
  let found
  try {
    found = cfdi.facturapiId ? await provider.getInvoice(cfdi.facturapiId) : await provider.findByExternalId(cfdi.idempotencyKey)
  } catch {
    throw new ConflictError(PROCESANDO)
  }
  if (found?.status === 'canceled')
    throw new ConflictError('Esta cuenta ya tiene una factura cancelada en el PAC; revísala antes de volver a facturar.')
  if (found?.status === 'valid' && found.uuid)
    return {
      ...(await finalizarEmision(cfdi, found, provider, await deps.loadVenueSlug(emisor.venueId), shared)),
      period,
      candidateCount: 0,
      excluidasPorIvaMixto: 0,
    }
  if (found) throw new ConflictError(PROCESANDO)
  if (
    !['STAMPING', 'STAMP_FAILED', 'VALIDATION_FAILED'].includes(cfdi.status) ||
    (cfdi.status === 'STAMPING' && Date.now() - new Date(cfdi.updatedAt ?? cfdi.createdAt).getTime() < 3 * 60000)
  )
    throw new ConflictError(PROCESANDO)
  const ids = await deps.loadGlobalCandidates(emisor.id, period.periodStart, period.periodEnd, emisor.invoiceCashSales, emisor.venueId)
  const reserved = await deps.runInTransaction(async tx => {
    await bloquearOrdenesParaFacturar(tx, ids, emisor.venueId)
    const venue = await tx.venue.findUniqueOrThrow({ where: { id: emisor.venueId }, select: { organizationId: true } })
    await tomarAdmisionCompartida(tx, venue.organizationId)
    const captured = await capturarGlobal(tx, emisor, period, ids, cfdi.id)
    if (!captured.entrada.ordenes.length) return { cfdi: null, ...captured }
    const { count } = await tx.cfdi.updateMany({
      where: { id: cfdi.id, status: cfdi.status, attempts: cfdi.attempts, protocoloIva: null },
      data: {
        ...baseGlobalCfdiData(emisor, cfdi.idempotencyKey, period, captured.entrada),
        attempts: { increment: 1 },
        status: captured.reasons.length ? 'VALIDATION_FAILED' : 'STAMPING',
        lastError: captured.reasons.join(' | ') || null,
      },
    })
    if (count !== 1) throw new ConflictError(PROCESANDO)
    return { cfdi: await tx.cfdi.findUniqueOrThrow({ where: { id: cfdi.id } }), ...captured }
  })
  if (!reserved.cfdi)
    return { status: 'NOTHING_TO_INVOICE', period, candidateCount: 0, excluidasPorIvaMixto: reserved.entrada.excluidasPorIvaMixto }
  cfdi = reserved.cfdi
  const counts = { period, candidateCount: reserved.entrada.ordenes.length, excluidasPorIvaMixto: reserved.entrada.excluidasPorIvaMixto }
  if (reserved.reasons.length) return { status: 'VALIDATION_FAILED', cfdi, reasons: reserved.reasons, ...counts }
  const where = { id: cfdi.id, status: 'STAMPING' as const, attempts: cfdi.attempts }
  let stamped
  try {
    stamped = await provider.createGlobalInvoice({ ...reserved.entrada.params, externalId: cfdi.idempotencyKey })
  } catch (err) {
    const updated = await deps.persistCfdi({ status: 'STAMP_FAILED', lastError: err instanceof Error ? err.message : String(err) }, where)
    if (!updated) throw new ConflictError(PROCESANDO)
    return { status: 'STAMP_FAILED', cfdi: updated, ...counts }
  }
  if (stamped.status !== 'valid' || !stamped.uuid) {
    await deps.persistCfdi({ facturapiId: stamped.providerInvoiceId }, where)
    throw new ConflictError(PROCESANDO)
  }
  return { ...(await finalizarEmision(cfdi, stamped, provider, await deps.loadVenueSlug(emisor.venueId), shared)), ...counts }
}
const defaultDeps: IssueGlobalDeps = {
  loadEmisor: id => prisma.fiscalEmisor.findUnique({ where: { id } }),
  findExistingGlobal: idempotencyKey => prisma.cfdi.findUnique({ where: { idempotencyKey } }),
  loadGlobalCandidates: async (id, periodStart, periodEnd, invoiceCashSales, venueId) => {
    const ids: string[] = []
    let after: string | undefined
    for (;;) {
      const page = await prisma.order.findMany({
        where: {
          ...candidateWhere({ id, venueId, invoiceCashSales } as GlobalEmisor, { periodStart, periodEnd } as ClosedPeriod),
          ...(after ? { id: { gt: after } } : {}),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: PAGE,
      })
      ids.push(...page.map(o => o.id))
      if (page.length < PAGE) return ids
      after = page[page.length - 1].id
    }
  },
  resolveProvider: resolveFiscalProvider,
  storeArtifact: uploadFileToStorage,
  reserveCfdi: (data, tx = prisma) => tx.cfdi.create({ data: data as any }),
  runInTransaction: work => prisma.$transaction(work, { timeout: 60000 }),
  persistCfdi: async (data, where) => {
    if (!where) throw new Error('La escritura del intento global exige versión y estado de origen.')
    const { count } = await prisma.cfdi.updateMany({ where, data })
    return count === 1 ? prisma.cfdi.findFirst({ where: { id: where.id as string } }) : null
  },
  persistArtifacts: async (idempotencyKey, data, attempts) => {
    const { count } = await prisma.cfdi.updateMany({ where: { idempotencyKey, attempts, status: 'STAMPED' }, data })
    return count === 1 ? prisma.cfdi.findUnique({ where: { idempotencyKey } }) : null
  },
  loadVenueSlug: async id => (await prisma.venue.findUniqueOrThrow({ where: { id }, select: { slug: true } })).slug,
}

/**
 * Exclusiones de la consulta de candidatos: ningún cobro elegible bajo OTRO emisor (una cuenta cobrada
 * con comercios de RFC distinto no entra completa en la global de ninguno — Codex, pasada 5), y sin
 * efectivo salvo que el emisor haya optado por declararlo.
 */
function filtrosDeExclusion(emisorId: string, invoiceCashSales: boolean): Prisma.OrderWhereInput[] {
  // Un comercio «incompatible» = sin configuración, de otro emisor, con facturación apagada o fuera de la
  // global. Basta UN cobro elegible así para que la orden no entre completa bajo este emisor.
  const configIncompatible: Prisma.MerchantFiscalConfigWhereInput = {
    OR: [{ fiscalEmisorId: { not: emisorId } }, { facturacionEnabled: false }, { includeInGlobal: false }],
  }
  const filtros: Prisma.OrderWhereInput[] = [
    {
      payments: {
        none: {
          status: 'COMPLETED',
          AND: [COBRO_ELEGIBLE],
          OR: [
            {
              merchantAccountId: { not: null },
              merchantAccount: { OR: [{ fiscalConfig: { is: null } }, { fiscalConfig: configIncompatible }] },
            },
            {
              ecommerceMerchantId: { not: null },
              ecommerceMerchant: { OR: [{ fiscalConfig: { is: null } }, { fiscalConfig: configIncompatible }] },
            },
          ],
        },
      },
    },
  ]
  if (!invoiceCashSales) filtros.push({ payments: { none: { status: 'COMPLETED', method: 'CASH', AND: [COBRO_ELEGIBLE] } } })
  return filtros
}

/** Fila de orden tal como la carga `loadGlobalCandidates` (PURA para poder probarla sin Prisma). */
export interface GlobalCandidateOrder {
  id: string
  orderNumber: string | null
  subtotal: any
  taxAmount: any
  total: any
  discountAmount?: any
  serviceChargeAmount?: any
  promotions?: Array<{ id: string }> | null
  payments: Array<{ method: any; tenderSatFormaPago: string | null; amount?: any; type?: string | null }>
  items: Array<{
    id?: string
    ivaTratamiento?: IvaTratamiento | null
    productName?: string | null
    quantity: number
    unitPrice: any
    discountAmount: any
    taxAmount: any
    total?: any
    weightQuantity?: any
    modifiers?: Array<{ name?: string | null; price: any; quantity?: number }> | null
    product: { taxRate: any; objetoImp: string | null; ivaTratamiento?: IvaTratamiento | null } | null
  }>
}

/**
 * One order → one or more global lines, grouped by each product's REAL tax rate (16/8/0/exento).
 * taxAmount=0 ⇒ gross (IVA-included) prices, e.g. TPV. Non-zero taxAmount ⇒ separated-tax source.
 *
 * 🔴 MISMA verdad de dinero que la factura individual (`conceptosDesdeRenglon`, descuento de orden,
 * cobros elegibles): con `unitPrice × quantity` la global declaraba MENOS de lo cobrado en cualquier
 * ticket con extras (Testarudo, 21-sep-2026). Y la misma BARRERA: si el documento de una orden no
 * cuadra con lo cobrado, la orden se EXCLUYE de la global (con aviso) — nunca se declara mal.
 */
export function globalLinesFromOrder(o: GlobalCandidateOrder): GlobalInvoiceLine[] {
  const tratamientos = o.items.map(it =>
    resolverTratamiento({ selladoIva: it.ivaTratamiento, productoIva: it.product?.ivaTratamiento, tieneProducto: !!it.product }),
  )
  if (clasificarOrden(tratamientos) === 'MIXTA') return []
  o = { ...o, items: o.items.map(renglonConTratamiento) }
  const peso = (d: any): number => Math.round(Number(d) * 100)
  const pays = o.payments.filter(p => esCobroElegible(p))
  const paidCents = pays.reduce((sum, p) => sum + peso(p.amount ?? 0), 0)
  if (paidCents <= 0) {
    logger.warn(`[cfdiGlobal] orden ${o.id} sin cobros elegibles; excluida de la global`)
    return []
  }
  const sinRenglones = o.items.length === 0
  const priceIncludesIva = peso(o.taxAmount) === 0 || sinRenglones
  const method = pays[0]?.method
  const formaPago = method ? mapFormaPago(method, pays[0]?.tenderSatFormaPago) : '99'
  const meta = { orderId: o.id, orderNumber: o.orderNumber, formaPago, priceIncludesIva }

  // Preferred path: derive per-product tax groups from the items.
  if (!sinRenglones) {
    const { items: conceptos, motivos } = reconstruirConceptos(o as OrdenParaConceptos, o.id)
    if (motivos.length > 0) {
      logger.warn(`[cfdiGlobal] orden ${o.id} fuera del sobre seguro; excluida de la global: ${motivos.join(' | ')}`)
      return []
    }
    const documentoCents = totalDelDocumentoCents({ items: conceptos as any, pricesIncludeIva: priceIncludesIva })
    if (documentoCents !== paidCents) {
      logger.warn(
        `[cfdiGlobal] orden ${o.id}: el documento (${documentoCents}) no coincide con lo cobrado (${paidCents}); excluida de la global`,
      )
      return []
    }
    const lineItems: GlobalLineItemInput[] = conceptos.map(it => {
      const rate = it.product ? Number(it.product.taxRate) : 0.16
      const objetoImp = it.product?.objetoImp ?? (rate > 0 ? '02' : '01')
      const lineNet = importeConceptoCents(it) - peso(it.discountAmount)
      // Gross items already include IVA; net items add their separated tax to reach the paid gross.
      const grossCents = priceIncludesIva ? lineNet : Math.round(lineNet * (1 + rate))
      return { grossCents, taxRate: rate, objetoImp }
    })
    return groupOrderIntoGlobalLines(lineItems, meta)
  }

  // Fallback (order with no items): one line for what was PAID (never `order.total`, which may carry
  // the tip), IVA included, assuming 16%. Las exclusiones de ORDEN aplican igual sin renglones.
  const motivosOrden = motivosDeOrden(o as OrdenParaConceptos)
  if (motivosOrden.length > 0) {
    logger.warn(`[cfdiGlobal] orden ${o.id} sin renglones fuera del sobre seguro; excluida: ${motivosOrden.join(' | ')}`)
    return []
  }
  const totalCents = paidCents
  const { netCents, taxCents } = splitIvaIncluded(totalCents, 0.16)
  return [
    {
      ...meta,
      totalCents,
      subtotalCents: netCents,
      taxCents,
      taxRate: 0.16,
      objetoImp: '02',
    },
  ]
}
