/**
 * IVA por producto, bloque C3 (spec §4.5, D6; Guía del CFDI global, Apéndice 2, ejemplo III): la NOTA DE EXTRACCIÓN. Un ticket que ya
 * está en una factura global viva se factura aparte sin cancelar la global: primero un egreso relacionado con la global por lo que queda
 * de ese ticket en ella, a Público en General (G02, PUE, 84111506/ACT, NoIdentificacion = folio, la forma del ticket); después (Tarea 4) la
 * factura del cliente por exactamente eso, con los productos que la extracción congela. Una por (global, ticket); no mueve dinero.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { ConflictError } from '../../errors/AppError'
import {
  buildCreateInvoiceParams,
  conceptosDeNota,
  CREDIT_NOTE_RELATIONSHIP,
  CREDIT_NOTE_USO_CFDI,
  descripcionDeExtraccion,
} from './cfdiPayloadBuilder'
import { assembleSaleInput } from './assembleSaleInput'
import { preserveUnknownStaffId } from '../../lib/activityAuditActor'
import { validateBeforeStamp } from './cfdiValidation'
import { conceptoDesdeElPayload, MOTIVO_OCHO_SIN_REGLA, type AjusteAlCobro } from './reglaDelPac'
import { aplicarAjustes, cuadrarPorTasa, montosDesdeDocumento, SIN_FILAS_D16, type ConceptoReal } from './globalPorTratamiento'
import { bloquearOrdenParaFacturar, tomarAdmisionCompartida } from './admisionIva'
import { CFDI_VIVO, EXTRACCION_CANCELADA, globalVivaDeLaOrden, llaveDeExtraccion, PREFIJO_EXTRACCION } from './exclusionGlobal'
import { huellaDeEntrada, type EntradaDocumentalV1, type ExtraccionDeLaFactura } from './entradaDocumental'
import {
  consultarIntentoCapturado,
  enviarIntentoCapturado,
  finalizarEmision,
  folioDe,
  MOTIVO_AUTOFACTURA_CON_DEVOLUCION,
  PROCESANDO,
  ventaConDevolucion,
  type IssueReceptor,
  type LoadedOrderBundle,
  type RenglonParaCfdi,
} from './cfdi.service'
import {
  asignacionFiscal,
  cabeEnElDocumentoGlobal,
  cabeEnElSaldo,
  documentoDeConceptos,
  MOTIVO_SALDO_DEL_DOCUMENTO,
  motivoExcedeElTotal,
  resumenDeConceptos,
  restar,
  unidadesDeConceptos,
  type FiscalDeNota,
  type Redondeo,
  type TratamientoDeNota,
} from './saldoFiscal'
import {
  conceptosRemanentes,
  nominativaPorExtraccion,
  MOTIVO_SIN_CONCEPTOS_REALES,
  type RedondeoDeRemanentes,
} from './nominativaPorExtraccion'
import {
  acreditadoContra,
  acreditadoTotal,
  asegurarGlobalVigente,
  defaultCreditNoteDeps,
  fiscalDeLaOriginal,
  LIMITE_ESPERA_XML_EN_LA_NOTA_MS,
  leerEgreso,
  SELECT_DE_ORIGINAL,
  sumarTolerancias,
  totalDe,
  type AcreditadoContra,
  type EmitRefundCreditNoteDeps,
  type EntradaEgresoV2,
  type LoadedRefundForCreditNote,
  type OriginalCfdiForCreditNote,
} from './cfdiCreditNote.service'
import type { CfdiItemInput, CreateInvoiceParams } from './providers/fiscal-provider.interface'
export { llaveDeExtraccion } from './exclusionGlobal'
export { descripcionDeExtraccion } from './cfdiPayloadBuilder'

export const MOTIVO_SIN_SALDO_EN_GLOBAL = 'Esta venta ya se devolvió completa dentro de la factura global; no queda nada que facturar.'
/** B7: la espera del XML dice qué se espera (la factura de la venta), no «la nota de crédito» (el texto de C2). */
export const MOTIVO_ESPERA_XML_DE_LA_GLOBAL =
  'Falta el XML de la factura global en la que entró esta venta; lo estamos recuperando. La podrás facturar aparte en unos minutos.'
/** B7: el XML de la global se bajó y no se lee, o el PAC ya no lo entrega (o no hay con qué pedirlo): se detiene, nunca espera para siempre. */
export const MOTIVO_XML_DE_LA_GLOBAL_IRRECUPERABLE =
  'No se puede leer ni recuperar el XML de la factura global en la que entró esta venta, así que no se puede facturar aparte desde aquí. Escríbenos a soporte.'
/** B12: la global de la venta está viva pero todavía no se timbra (reservada, en el PAC o en duda). */
export const MOTIVO_GLOBAL_TIMBRANDOSE = 'La factura global de esta venta se está timbrando; intenta en unos minutos.'
export const MOTIVO_GLOBAL_EN_CANCELACION =
  'La factura global de esta venta tiene una cancelación en trámite ante el SAT; la venta se podrá facturar aparte cuando se resuelva.'
const MOTIVO_SIN_GLOBAL = 'Esta venta no está en una factura global vigente.'
const MOTIVO_GLOBAL_NO_VIGENTE = 'La factura global de esta venta ya no está vigente.'
const MOTIVO_NO_SE_PUDO_ARMAR = 'La nota que saca esta venta de la factura global no se pudo armar; requiere revisión de soporte.'
/** ¿La nota ya tiene con qué nombrarse? Se nombra con `folioDe` («E-123»), igual que el resto de los textos al usuario; reservada y sin enviar aún no tiene nada. */
const tieneIdentidad = (e: { serie: string | null; folio: string | null; uuid: string | null }) => !!(e.serie || e.folio || e.uuid)
/** C3-P9 = B (Codex C3-19): una extracción timbrada y luego cancelada no se vuelve a sacar sola (el texto de la Tarea 4). */
export const motivoExtraccionCancelada = (e: { serie: string | null; folio: string | null; uuid: string | null }) =>
  `La nota que sacaba esta venta de la factura global${tieneIdentidad(e) ? ` (${folioDe(e)})` : ''} se canceló. Volver a sacarla no se hace sola: pide a soporte que facture esta venta.`
/** C3 (Codex C3-13): la extracción de esta venta es de una global que ya no está vigente (o la venta ya no está en ninguna). */
export const motivoExtraccionSinGlobal = (e: { serie: string | null; folio: string | null; uuid: string | null; totalCents: number }) => {
  const total = (e.totalCents / 100).toFixed(2)
  // Reservada y sin enviar: aún no tiene serie, folio ni UUID, y «la nota null» no le dice nada a nadie.
  const nota = tieneIdentidad(e) ? `la nota ${folioDe(e)}` : 'una nota que todavía se está confirmando'
  return `Esta venta ya se sacó de su factura global con ${nota} por $${total}, pero esa factura global ya no está vigente. La factura del cliente no se emite sola: pide a soporte que revise esa nota (cancelarla, o facturar exactamente $${total}).`
}
/** C3-12: la factura del cliente sale con el emisor de la global de la que se saca la venta; si la venta ya factura con otro, se detiene. */
export const MOTIVO_EMISOR_DISTINTO_DE_LA_GLOBAL =
  'El emisor fiscal que factura esta venta ya no es el de la factura global en la que entró, así que no se puede facturar aparte desde aquí. Escríbenos a soporte.'
const PUBLICO_EN_GENERAL = { rfc: 'XAXX010101000', razonSocial: 'PÚBLICO EN GENERAL', regimenFiscal: '616' } as const
/** La prueba de dinero de la factura del cliente no depende de las claves SAT (las del catálogo de hoy las pone la Tarea 4). */
const CLAVES_DE_COMPROBACION = () => ({ satProductKey: '01010101', satUnitKey: 'ACT' })

export const extraccionVigente = (db: Pick<Prisma.TransactionClient, 'cfdi'>, globalCfdiId: string, orderId: string) =>
  db.cfdi.findUnique({ where: { idempotencyKey: llaveDeExtraccion(globalCfdiId, orderId) } })
/** Enviada al PAC y sin desenlace (ni timbre ni rechazo definitivo): sólo se recupera por su identidad. */
export const esEnvioIncierto = (c: any) => c?.protocoloIva === 1 && !!c.enviadoAt && !c.falloDefinitivo && c.status !== 'STAMPED'

/**
 * C3 (Codex C3-22, C3-23): el ÚNICO lugar que escribe `CFDI_EXTRACCION_EMITIDA`, IDEMPOTENTE por el índice único parcial
 * `ActivityLog_extraccion_emitida_key` (`entityId` WHERE `action` = 'CFDI_EXTRACCION_EMITIDA'): dos llamadas a la vez ⇒ una gana y la otra
 * recibe `P2002`, que es «ya estaba». Lo llama TODO lugar que ve una extracción timbrada —el envío, la recuperación, cada «ya timbrada» y el
 * barrido del reconciliador—: una caída entre el timbre y el registro no lo pierde. B15: un actor que ya no existe (dado de baja) no hace
 * fallar el pedido cada vez: se escribe sin actor, como `logAction`.
 */
export async function registrarExtraccionEmitida(cfdi: any, staffId: string | null): Promise<void> {
  const e = (cfdi.entrada ?? {}) as Partial<EntradaEgresoV2>
  const data = {
    orderId: e.orderId ?? cfdi.orderId,
    globalCfdiId: e.originalCfdiId,
    globalUuid: e.originalUuid,
    uuid: cfdi.uuid,
    generacion: e.generacion ?? 1, // C3-P9 = B: siempre 1 (sin generaciones)
    porTratamiento: e.porTratamiento,
    redondeo: e.redondeo,
    ...(e.redondeoDeRemanentes ? { redondeoDeRemanentes: e.redondeoDeRemanentes } : {}),
  } as Prisma.InputJsonObject
  const escribir = (actor: string | null, datos: Prisma.InputJsonValue) =>
    prisma.activityLog.create({
      data: { staffId: actor, venueId: cfdi.venueId, action: 'CFDI_EXTRACCION_EMITIDA', entity: 'Cfdi', entityId: cfdi.id, data: datos },
    })
  const yaEstaba = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  try {
    await escribir(staffId, data)
  } catch (err) {
    if (yaEstaba(err)) return
    if (staffId === null || !(err instanceof Error && err.message.includes('ActivityLog_staffId_fkey'))) throw err
    try {
      await escribir(null, preserveUnknownStaffId(data, staffId)) // como `logAction`: el actor desconocido queda en `data`
    } catch (otro) {
      if (!yaEstaba(otro)) throw otro
    }
  }
}

export type DepsDeExtraccion = EmitRefundCreditNoteDeps & {
  /** La global VIVA (`CFDI_VIVO`) cuyo manifiesto tiene la venta, timbrada o no (B12), con lo que lee una original (`SELECT_DE_ORIGINAL`). */
  cargarGlobalViva: (venueId: string, orderId: string) => Promise<OriginalCfdiForCreditNote | null>
  acreditadoContra: typeof acreditadoContra
  /** SÓLO PARA PRUEBAS: dentro de la reserva, entre leer la fila de la extracción y escribirla (C3-17). */
  despuesDeLeerLaExtraccion?: () => Promise<void>
  /** SÓLO PARA PRUEBAS: después de reservar, antes de adquirir el envío (C3-17). */
  antesDeEnviar?: () => Promise<void>
}
const depsPorOmision: DepsDeExtraccion = {
  ...defaultCreditNoteDeps,
  cargarGlobalViva: (venueId, orderId) =>
    prisma.cfdi.findFirst({
      where: { venueId, type: 'INGRESO', isGlobal: true, manifiestoGlobal: { some: { orderId } }, ...CFDI_VIVO },
      orderBy: { createdAt: 'desc' },
      select: SELECT_DE_ORIGINAL,
    }) as unknown as Promise<OriginalCfdiForCreditNote | null>,
  acreditadoContra,
}

/** Consulta al PAC por la identidad del intento ENVIADO (su captura y su emisor congelados); si lo tiene, lo termina y lo registra. */
async function consultarYTerminar(
  existente: any,
  p: { venueId: string; sandbox: boolean; staffId: string | null },
  deps: DepsDeExtraccion,
) {
  const emisor = await deps.loadEmisor(existente.fiscalEmisorId, p.venueId)
  if (!emisor) throw new Error('Venta no encontrada')
  const provider = deps.resolveProvider(emisor, { sandbox: p.sandbox })
  const encontrada = await consultarIntentoCapturado(existente, provider, deps.runInTransaction) // en duda y sin hallazgo ⇒ «procesando»
  if (!encontrada) return null
  const { cfdi } = await finalizarEmision(existente, encontrada, provider, await deps.loadVenueSlug(p.venueId), deps)
  await registrarExtraccionEmitida(cfdi, p.staffId)
  return cfdi
}

/**
 * C3 (Codex C3-11/C3-20/C3-22): un intento de extracción ENVIADO y en duda se recupera por su identidad ante el PAC, con su captura y su
 * emisor CONGELADOS: no pide el XML de la global ni las habilitaciones de hoy (eso es para efectos nuevos). Si el PAC no lo tiene,
 * `ConflictError` («se está procesando»; el motor escala a los 60 min).
 */
export async function recuperarExtraccionEnviada(
  existente: any,
  p: { venueId: string; sandbox: boolean; staffId: string | null },
  overrides: Partial<DepsDeExtraccion> = {},
) {
  const cfdi = await consultarYTerminar(existente, p, { ...depsPorOmision, ...overrides })
  if (!cfdi) throw new ConflictError(PROCESANDO)
  return cfdi
}

export type ExtraccionArmada = {
  /** El ticket en la global: su folio timbrado (`NoIdentificacion`) y su forma de pago congelada. */
  ticket: { folio: string; formaPago: string }
  etiquetaOriginal: string
  extraidoCents: number
  bruto: Partial<Record<TratamientoDeNota, number>>
  items: CfdiItemInput[]
  ajustes: AjusteAlCobro[]
  porTratamiento: FiscalDeNota
  redondeo: Redondeo[]
  montos: { subtotalCents: number; taxCents: number; totalCents: number }
  remanentes: ConceptoReal[]
  filasD16: string[][]
  redondeoDeRemanentes?: RedondeoDeRemanentes[]
}

/**
 * C3 (Codex C3-7): la extracción Y la prueba de la factura del cliente que saldrá de ella, con lo acreditado que se le pase. Lo extraído es
 * lo que queda del tramo del ticket en la asignación de TODA la global (C2), y cabe con la MISMA receta que la nota de C2
 * (`notaPorTratamientoSinRed`, M3): topes por el total en el ticket y en el documento, la 6b por tasa, `cabeEnElSaldo(…, 'TICKET')` y
 * `cabeEnElDocumentoGlobal` con las tolerancias que los tickets ya usaron. La comprobación previa (Tarea 4) la corre sin candados; la
 * reserva, bajo sus candados con lo acreditado releído. Pura; `acreditado` es el del TICKET.
 */
export function construirExtraccion(p: {
  viva: OriginalCfdiForCreditNote
  orderId: string
  acreditado: AcreditadoContra
  acreditadoDelDocumento: AcreditadoContra
}): { sinSaldo: true } | { motivo: string; espera?: true } | ExtraccionArmada {
  const loaded = {
    original: { ...p.viva, esGlobal: true },
    refund: { orderId: p.orderId },
    acreditado: p.acreditado,
    acreditadoDelDocumento: p.acreditadoDelDocumento,
  } as unknown as LoadedRefundForCreditNote
  // B7: la marca de XML ilegible se mira primero; sin XML, espera; luego el tramo del ticket, de la evaluación memorizada de C2 (M6).
  const f = fiscalDeLaOriginal(loaded)
  if ('eligible' in f) {
    if (f.reason === 'ESPERA_XML') return { motivo: MOTIVO_ESPERA_XML_DE_LA_GLOBAL, espera: true }
    return { motivo: f.reason === 'XML_IRRECUPERABLE' ? MOTIVO_XML_DE_LA_GLOBAL_IRRECUPERABLE : f.message! }
  }
  const ticket = f.ticket!
  const saldo = restar(f.fiscal, p.acreditado.notas, p.acreditado.desconocidoCents)
  const bruto: Partial<Record<TratamientoDeNota, number>> = {}
  for (const [t, c] of Object.entries(saldo) as Array<[TratamientoDeNota, { totalCents: number }]>)
    if (c.totalCents > 0) bruto[t] = c.totalCents
  if (!Object.keys(bruto).length) return { sinSaldo: true }
  if (bruto.IVA_8) return { motivo: MOTIVO_OCHO_SIN_REGLA } // B8: el 8 % no tiene regla de la 6b
  const extraidoCents = Object.values(bruto).reduce((s, c) => s + (c ?? 0), 0)
  // M3: los topes por el TOTAL (como la nota de C2): lo extraído no pasa «lo del ticket − TODO lo acreditado», ni «la global − TODO».
  const queda = totalDe(f.fiscal) - acreditadoTotal(p.acreditado)
  if (extraidoCents > queda) return { motivo: motivoExcedeElTotal(extraidoCents, queda, 'TICKET') }
  if (extraidoCents > totalDe(f.documentoSinRestar!) - acreditadoTotal(p.acreditadoDelDocumento))
    return { motivo: MOTIVO_SALDO_DEL_DOCUMENTO }
  const etiquetaOriginal = `${p.viva.serie ?? ''}${p.viva.folio ?? ''}` || p.viva.uuid
  const base = conceptosDeNota(bruto, etiquetaOriginal, { descripcion: descripcionDeExtraccion(f.folio!, etiquetaOriginal), sku: f.folio })
  // C1-30: por la única puerta —barrera N3 y cada tasa sola—; `SIN_FILAS_D16`: cada concepto ES lo extraído de su tasa con IVA incluido.
  const opts = { cobradoPorTasa: bruto, filasD16: SIN_FILAS_D16 }
  const cuadre = cuadrarPorTasa(base.map(conceptoDesdeElPayload), extraidoCents, opts)
  if (!cuadre.ok) return { motivo: cuadre.motivo }
  const items = aplicarAjustes(base, cuadre.ajustes, extraidoCents, opts) // C1-36: confinado por tasa
  const documento = items ? documentoDeConceptos(items) : null
  if (!items || !documento || 'invalido' in documento) return { motivo: MOTIVO_NO_SE_PUDO_ARMAR }
  const propia = asignacionFiscal(
    unidadesDeConceptos(items, () => 'extraccion'),
    documento,
    resumenDeConceptos(items),
  )
  if ('invalido' in propia) return { motivo: propia.invalido }
  const cabe = cabeEnElSaldo(propia.porTratamiento, saldo, 'TICKET')
  if (!cabe.ok) return { motivo: cabe.message }
  const tolerancia = sumarTolerancias(p.acreditadoDelDocumento.toleranciaDeTickets ?? {}, cabe.redondeo)
  const doc = cabeEnElDocumentoGlobal(propia.porTratamiento, f.documento!, tolerancia)
  if (!doc.ok) return { motivo: doc.message }
  // 🔴 C3-7: la factura del cliente que saldrá de esta extracción tiene que poder demostrarse CON ESTE acreditado (el del ticket). M5: sin los
  // reales del ticket (o sin artículos) no hay respaldo genérico.
  if (!ticket.conceptosReales?.length) return { motivo: MOTIVO_SIN_CONCEPTOS_REALES }
  const cobrado = ticket.porTratamiento as Partial<Record<TratamientoDeNota, number>>
  const rem = conceptosRemanentes(ticket.conceptosReales, p.acreditado, cobrado, ticket.filasD16)
  if ('motivo' in rem) return { motivo: rem.motivo }
  const nom = nominativaPorExtraccion({
    reales: rem.reales,
    filasD16: ticket.filasD16,
    claves: CLAVES_DE_COMPROBACION,
    extraido: { brutoPorTratamiento: bruto, porTratamiento: propia.porTratamiento },
  })
  if ('motivo' in nom) return { motivo: nom.motivo }
  return {
    ticket: { folio: f.folio!, formaPago: ticket.formaPago },
    etiquetaOriginal,
    extraidoCents,
    bruto,
    items,
    ajustes: cuadre.ajustes,
    porTratamiento: propia.porTratamiento,
    redondeo: [...cabe.redondeo, ...doc.redondeo],
    montos: montosDesdeDocumento(documento),
    remanentes: rem.reales,
    filasD16: ticket.filasD16,
    ...(rem.redondeo ? { redondeoDeRemanentes: rem.redondeo } : {}),
  }
}

export type EmitirExtraccionResult = {
  status: 'STAMPED' | 'VALIDATION_FAILED' | 'STAMP_FAILED' | 'SIN_SALDO'
  cfdi?: any
  reasons?: string[]
}

/** La global sigue timbrada y sin cancelación (en trámite o consumada); si no, se detiene con su texto. */
export function exigirGlobalVigente(g: OriginalCfdiForCreditNote | null): asserts g is OriginalCfdiForCreditNote {
  if (!g) throw new ConflictError(MOTIVO_SIN_GLOBAL)
  if (['ACCEPTED', 'CANCELLED'].includes(g.cancelStatus ?? '') || g.status === 'CANCELLED')
    throw new ConflictError(MOTIVO_GLOBAL_NO_VIGENTE)
  if (g.status !== 'STAMPED' || !g.uuid) throw new ConflictError(MOTIVO_GLOBAL_TIMBRANDOSE) // B12
  if (g.cancelStatus === 'REQUESTED') throw new ConflictError(MOTIVO_GLOBAL_EN_CANCELACION)
}

/**
 * C3: la nota de extracción de la venta `orderId`. Una por (global, ticket). Lo ENVIADO se recupera PRIMERO por su identidad (C3-20); un
 * rechazo DEFINITIVO se reintenta con identidad nueva tras consultar la anterior (M4, como la global y las notas); lo no enviado se
 * recaptura bajo los candados con un CAS que exige que siga sin enviar (C3-17). La reserva toma la orden (el candado de las devoluciones),
 * la admisión y la fila de la global, relee lo acreditado, vuelve a armar la extracción y corre ahí la preparación REAL de la factura del
 * cliente (`comprobarNominativa`, C3-12/G1). `staffId` es obligatorio (`null` sólo en autofactura, C3-16).
 */
export async function emitirExtraccion(
  params: {
    venueId: string
    orderId: string
    sandbox: boolean
    staffId: string | null
    /** B14: el flujo del pedido (la autofactura nace `AUTOFACTURA_A`). */
    flow?: 'STAFF_B' | 'AUTOFACTURA_A'
    comprobarNominativa: (tx: Prisma.TransactionClient, c: ExtraccionArmada) => Promise<string[]>
  },
  overrides: Partial<DepsDeExtraccion> = {},
): Promise<EmitirExtraccionResult> {
  const deps: DepsDeExtraccion = { ...depsPorOmision, ...overrides }
  let global = await deps.cargarGlobalViva(params.venueId, params.orderId)
  if (!global) throw new ConflictError(MOTIVO_SIN_GLOBAL)
  const key = llaveDeExtraccion(global.id, params.orderId)
  const existente = await deps.findExistingCfdi(key)
  if (existente && (existente.venueId !== params.venueId || existente.type !== 'EGRESO')) throw new Error('Venta no encontrada')
  if (existente?.status === 'STAMPED') {
    await registrarExtraccionEmitida(existente, params.staffId) // C3-23: si una caída se lo comió, aquí se escribe
    return { status: 'STAMPED', cfdi: existente }
  }
  if (existente?.status === 'CANCELLED')
    return { status: 'VALIDATION_FAILED', cfdi: existente, reasons: [motivoExtraccionCancelada(existente)] }
  // 🔴 C3-20: lo ENVIADO se consulta primero, por su identidad y con lo congelado: ni el XML de la global ni nada de hoy lo condiciona. En
  // duda y sin hallazgo ⇒ «se está procesando». M4: rechazada en definitiva y el PAC no la tiene ⇒ se recaptura abajo (identidad nueva).
  if (existente?.enviadoAt) {
    const recuperada = await consultarYTerminar(existente, params, deps)
    if (recuperada) return { status: 'STAMPED', cfdi: recuperada }
  }
  exigirGlobalVigente(global) // para un efecto NUEVO (y no antes: lo enviado se recupera aunque la global ya esté en cancelación)
  if (global.taxBreakdown == null || global.xmlConceptos == null) {
    // C2-13: el XML de la global es requisito de una extracción NUEVA; se pide al momento (fuera de candados: hace red) y, si no llega,
    // se espera sin reservar nada. Lo permanente se detiene con su texto.
    const r = await deps.repararArchivos(global.id, { sandbox: params.sandbox, limiteMs: LIMITE_ESPERA_XML_EN_LA_NOTA_MS, insistir: true })
    if (r === 'XML_ILEGIBLE' || r === 'XML_NO_DISPONIBLE' || r === 'NO_APLICA')
      return { status: 'VALIDATION_FAILED', reasons: [MOTIVO_XML_DE_LA_GLOBAL_IRRECUPERABLE] }
    global = await deps.cargarGlobalViva(params.venueId, params.orderId)
    if (!global || global.taxBreakdown == null || global.xmlConceptos == null)
      return { status: 'VALIDATION_FAILED', reasons: [MOTIVO_ESPERA_XML_DE_LA_GLOBAL] }
  }
  const gid = global.id
  // M6 (C2 ronda 2, N2): la evaluación de la global, si toca, en frío AQUÍ, fuera de los candados.
  asegurarGlobalVigente({ original: { ...global, esGlobal: true } } as unknown as LoadedRefundForCreditNote)
  const reservada = await deps
    .runInTransaction(async tx => {
      const scope = await bloquearOrdenParaFacturar(tx, params.orderId)
      if (!scope || scope.venueId !== params.venueId) throw new Error('Venta no encontrada')
      await tomarAdmisionCompartida(tx, scope.organizationId)
      await tx.$queryRaw`SELECT id FROM "Cfdi" WHERE id = ${gid} FOR UPDATE` // el documento compartido (C2-3), después de la orden y la admisión
      const viva = (await tx.cfdi.findUnique({
        where: { id: gid },
        select: SELECT_DE_ORIGINAL,
      })) as unknown as OriginalCfdiForCreditNote | null // B13
      exigirGlobalVigente(viva)
      const actual = await tx.cfdi.findUnique({ where: { idempotencyKey: key } })
      await deps.despuesDeLeerLaExtraccion?.() // gancho de prueba (C3-17)
      if (actual?.status === 'STAMPED') return { yaTimbrada: actual }
      // Lo que se consultó afuera tiene que ser lo que hay bajo el candado; si alguien la movió en medio, está trabajando: «procesando».
      if (
        actual &&
        (!existente ||
          actual.attempts !== existente.attempts ||
          actual.status !== existente.status ||
          actual.enviadoAt?.getTime() !== existente.enviadoAt?.getTime())
      )
        throw new ConflictError(PROCESANDO)
      // 🔴 C3-17 / M4: se recaptura SÓLO lo que no se envió o lo que el PAC rechazó en definitiva (ya consultado afuera). Nunca se borra un
      // `enviadoAt` en duda; nunca se recaptura una cancelada (C3-P9 = B).
      if (
        actual &&
        (actual.protocoloIva !== 1 ||
          !['STAMPING', 'STAMP_FAILED', 'VALIDATION_FAILED'].includes(actual.status) ||
          ['ACCEPTED', 'CANCELLED'].includes(actual.cancelStatus ?? '') ||
          (actual.enviadoAt !== null && !actual.falloDefinitivo))
      )
        throw new ConflictError(PROCESANDO)
      // 🔴 C3-7: lo devuelto se relee AQUÍ, bajo los candados, y la prueba de la factura del cliente se repite con él.
      const acreditado = await deps.acreditadoContra(tx, {
        venueId: params.venueId,
        orderId: params.orderId,
        originalCfdiId: gid,
        excludeCfdiId: actual?.id,
      })
      const acreditadoDelDocumento = await deps.acreditadoContra(tx, {
        venueId: params.venueId,
        orderId: null,
        originalCfdiId: gid,
        excludeCfdiId: actual?.id,
        todoElDocumento: true,
      })
      const c = construirExtraccion({ viva, orderId: params.orderId, acreditado, acreditadoDelDocumento })
      if ('sinSaldo' in c) return { sinSaldo: true as const }
      if ('motivo' in c) return { reasons: [c.motivo] }
      // 🔴 C3-12 / G1: la preparación REAL de la factura del cliente, bajo este mismo candado de la orden (el que toman las devoluciones). Si
      // ya no vale, no se extrae: nunca un egreso que deja a la factura del cliente sin poder salir.
      const motivosDeLaFactura = await params.comprobarNominativa(tx, c)
      if (motivosDeLaFactura.length) return { reasons: motivosDeLaFactura }
      // El receptor de la nota a una global (C2 · T8): el Público en General con el lugar de expedición VIGENTE del emisor (M5 de C2).
      const receptor = {
        ...PUBLICO_EN_GENERAL,
        codigoPostal: viva.fiscalEmisor.lugarExpedicion || viva.receptorCp,
        usoCfdi: CREDIT_NOTE_USO_CFDI,
      }
      const formaPago = c.ticket.formaPago
      const outbound: EntradaEgresoV2['params'] = {
        receptor,
        items: c.items,
        formaPago,
        metodoPago: 'PUE',
        ...(viva.fiscalEmisor.serie ? { serie: viva.fiscalEmisor.serie } : {}),
        relationship: CREDIT_NOTE_RELATIONSHIP,
        relatedUuids: [viva.uuid],
      }
      const reasons = validateBeforeStamp({
        csdStatus: viva.fiscalEmisor.csdStatus,
        formaPago,
        receptor,
        items: c.items,
        expectedSubtotalCents: c.montos.subtotalCents,
        expectedTaxCents: c.montos.taxCents,
        expectedTotalCents: c.montos.totalCents,
        isGlobal: false,
        relacionadaConGlobal: true,
      }).reasons
      const entrada: EntradaEgresoV2 = structuredClone({
        version: 2,
        tipo: 'EGRESO',
        causa: 'EXTRACCION',
        orderId: params.orderId,
        refundPaymentId: null,
        generacion: 1,
        originalCfdiId: viva.id,
        originalUuid: viva.uuid,
        etiquetaOriginal: c.etiquetaOriginal,
        fiscalEmisorId: viva.fiscalEmisor.id,
        originalEsGlobal: true,
        folio: c.ticket.folio,
        modalidad: 'POR_IMPORTE',
        devueltoCents: c.extraidoCents,
        brutoPorTratamiento: c.bruto,
        porTratamiento: c.porTratamiento,
        redondeo: c.redondeo,
        ajustes: c.ajustes,
        montos: c.montos,
        remanentes: c.remanentes,
        filasD16: c.filasD16,
        ...(c.redondeoDeRemanentes ? { redondeoDeRemanentes: c.redondeoDeRemanentes } : {}),
        params: outbound,
      })
      const data = {
        venueId: params.venueId,
        fiscalEmisorId: viva.fiscalEmisor.id,
        orderId: params.orderId,
        type: 'EGRESO',
        flow: params.flow ?? 'STAFF_B', // B14
        status: reasons.length ? 'VALIDATION_FAILED' : 'STAMPING',
        idempotencyKey: key,
        receptorRfc: receptor.rfc,
        receptorNombre: receptor.razonSocial,
        receptorRegimen: receptor.regimenFiscal,
        receptorCp: receptor.codigoPostal,
        usoCfdi: CREDIT_NOTE_USO_CFDI,
        formaPago,
        metodoPago: 'PUE',
        ...c.montos,
        lastError: reasons.join(' | ') || null,
        protocoloIva: 1,
        entrada: entrada as unknown as Prisma.InputJsonValue,
        entradaHuella: huellaDeEntrada(entrada),
        enviadoAt: null,
        falloDefinitivo: false,
        facturapiId: null,
        attempts: (actual?.attempts ?? 0) + (reasons.length ? 0 : 1), // M4: un rechazo definitivo se reintenta como `#n+1`
      }
      let cfdi
      if (actual) {
        // C3-17: el CAS exige el MISMO intento y su marca de envío tal como se leyó (sin enviar, o rechazado en definitiva): si alguien
        // adquirió el envío entretanto, pierde.
        const { count } = await tx.cfdi.updateMany({
          where: {
            id: actual.id,
            status: actual.status,
            attempts: actual.attempts,
            enviadoAt: actual.enviadoAt,
            falloDefinitivo: actual.falloDefinitivo,
          },
          data: data as any,
        })
        if (count !== 1) throw new ConflictError(PROCESANDO)
        cfdi = await tx.cfdi.findUniqueOrThrow({ where: { id: actual.id } })
      } else cfdi = await deps.reserveCfdi(data, tx)
      return { cfdi, reasons, emisor: viva.fiscalEmisor }
    })
    .catch(err => {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictError(PROCESANDO)
      throw err
    })

  if ('yaTimbrada' in reservada) {
    await registrarExtraccionEmitida(reservada.yaTimbrada, params.staffId)
    return { status: 'STAMPED', cfdi: reservada.yaTimbrada }
  }
  if ('sinSaldo' in reservada) return { status: 'SIN_SALDO', reasons: [MOTIVO_SIN_SALDO_EN_GLOBAL] }
  if (!('cfdi' in reservada)) return { status: 'VALIDATION_FAILED', reasons: reservada.reasons }
  if (reservada.reasons.length) return { status: 'VALIDATION_FAILED', cfdi: reservada.cfdi, reasons: reservada.reasons }
  const entrada = leerEgreso(reservada.cfdi) as EntradaEgresoV2
  await deps.antesDeEnviar?.() // gancho de prueba (C3-17)
  const provider = deps.resolveProvider(reservada.emisor as any, { sandbox: params.sandbox })
  const r = await enviarIntentoCapturado(
    reservada.cfdi,
    { tipo: 'EGRESO', params: entrada.params },
    null,
    provider,
    await deps.loadVenueSlug(params.venueId),
    deps,
  )
  if (r.status === 'STAMPED') await registrarExtraccionEmitida(r.cfdi, params.staffId) // C3-22: el mismo punto que la recuperación
  return { status: r.status, cfdi: r.cfdi }
}

// ─── C3 · Tarea 4: el antecedente de la venta y la factura del cliente ─────────────────────────────────────────────────────────────

/**
 * C3 (Codex C3-13/C3-19): el ANTECEDENTE de extracción más reciente de la venta, de cualquier global —aunque esa global ya no esté viva—:
 * viva, o cancelada y confirmada. (Las que nunca existieron ante el SAT —`VALIDATION_FAILED`, rechazo definitivo— no cuentan.)
 */
export const extraccionDeLaOrden = (db: Pick<Prisma.TransactionClient, 'cfdi'>, orderId: string) =>
  db.cfdi.findFirst({
    where: { orderId, type: 'EGRESO', idempotencyKey: { startsWith: PREFIJO_EXTRACCION }, OR: [CFDI_VIVO, EXTRACCION_CANCELADA] },
    orderBy: { createdAt: 'desc' },
  })

/**
 * C3 (C3-13/C3-19): el antecedente manda aunque su global ya no esté viva. Cancelado (sin generaciones: C3-P9 = B), o de otra global (o la
 * venta ya no está en ninguna viva) ⇒ su motivo: se detiene y se dice a quién acudir; nunca se cae a la factura ordinaria por la orden
 * completa. `null` = es la extracción de la global viva de hoy.
 */
export function motivoDelAntecedente(
  antecedente: {
    status: string
    idempotencyKey: string | null
    serie: string | null
    folio: string | null
    uuid: string | null
    totalCents: number
  },
  global: { id: string } | null,
  orderId: string,
): string | null {
  if (antecedente.status === 'CANCELLED') return motivoExtraccionCancelada(antecedente)
  if (!global || antecedente.idempotencyKey !== llaveDeExtraccion(global.id, orderId)) return motivoExtraccionSinGlobal(antecedente)
  return null
}

/**
 * C2-pulido · G2 → C3 (Ruling G2): lo que el GET público de la autofactura mira, sin candado. Un ticket en una global viva SE OFRECE (el POST
 * decide, con la extracción); sólo no se ofrece si su extracción se canceló o quedó sin su global. (A7-R10 lo mira el controlador.)
 */
export async function motivoAutofacturaEnGlobal(db: Pick<Prisma.TransactionClient, 'cfdi'>, orderId: string): Promise<string | null> {
  const antecedente = await extraccionDeLaOrden(db, orderId)
  return antecedente ? motivoDelAntecedente(antecedente, await globalVivaDeLaOrden(db, orderId), orderId) : null
}

/** C3: lo que la factura del cliente toma de su extracción: la que se arma al comprobar, o la congelada en la extracción timbrada. */
export type BaseDeLaFactura = {
  remanentes: ConceptoReal[]
  filasD16: string[][]
  bruto: Partial<Record<TratamientoDeNota, number>>
  porTratamiento: FiscalDeNota
  /** Sólo con la extracción TIMBRADA (la captura): de cuál sale la factura (`entrada.extraccion`, sin las diferencias, que se calculan). */
  extraccion?: Omit<ExtraccionDeLaFactura, 'brutoPorTratamiento' | 'diferencias'>
}

/** C3 (captura): la base de la factura del cliente es lo CONGELADO en su extracción timbrada (`leerEgreso`), no lo que diga hoy la orden. */
export function baseDeLaExtraccion(ext: any): BaseDeLaFactura {
  const e = leerEgreso(ext)
  if (e.version !== 2 || e.causa !== 'EXTRACCION' || !e.remanentes || !e.filasD16)
    throw new ConflictError('La entrada fiscal de esta factura requiere revisión de soporte.')
  return {
    remanentes: e.remanentes,
    filasD16: e.filasD16,
    bruto: e.brutoPorTratamiento,
    porTratamiento: e.porTratamiento,
    extraccion: {
      cfdiId: ext.id,
      uuid: ext.uuid,
      globalCfdiId: e.originalCfdiId,
      generacion: e.generacion ?? 1,
      folio: `${ext.serie ?? ''}${ext.folio ?? ''}` || ext.uuid,
    },
  }
}

/**
 * C3 (comprobación previa, con `prisma` y SIN efectos): la extracción que saldría HOY —lo acreditado leído sin candados, la MISMA prueba
 * que repetirá la reserva bajo los suyos—. Sin el XML de la global, se pide UNA vez (fuera de candados) y se repite (C2-13).
 */
async function extraccionDeHoy(
  db: Prisma.TransactionClient,
  p: { orderId: string; sandbox: boolean },
  globalId: string,
  venueId: string,
): Promise<BaseDeLaFactura | { motivo: string }> {
  const propia = await extraccionVigente(db, globalId, p.orderId) // un intento suyo sin timbre no cuenta como acreditado (como la reserva)
  const armar = async () => {
    const viva = (await db.cfdi.findUnique({
      where: { id: globalId },
      select: SELECT_DE_ORIGINAL,
    })) as unknown as OriginalCfdiForCreditNote | null
    exigirGlobalVigente(viva) // B13: la fila completa de la global
    const acreditado = await acreditadoContra(db, { venueId, orderId: p.orderId, originalCfdiId: globalId, excludeCfdiId: propia?.id })
    const acreditadoDelDocumento = await acreditadoContra(db, {
      venueId,
      orderId: null,
      originalCfdiId: globalId,
      excludeCfdiId: propia?.id,
      todoElDocumento: true,
    })
    return construirExtraccion({ viva, orderId: p.orderId, acreditado, acreditadoDelDocumento })
  }
  let c = await armar()
  if ('espera' in c) {
    const r = await defaultCreditNoteDeps.repararArchivos(globalId, {
      sandbox: p.sandbox,
      limiteMs: LIMITE_ESPERA_XML_EN_LA_NOTA_MS,
      insistir: true,
    })
    if (r === 'XML_ILEGIBLE' || r === 'XML_NO_DISPONIBLE' || r === 'NO_APLICA') return { motivo: MOTIVO_XML_DE_LA_GLOBAL_IRRECUPERABLE }
    c = await armar()
  }
  if ('sinSaldo' in c) return { motivo: MOTIVO_SIN_SALDO_EN_GLOBAL } // B21
  if ('motivo' in c) return { motivo: c.motivo }
  return { remanentes: c.remanentes, filasD16: c.filasD16, bruto: c.bruto, porTratamiento: c.porTratamiento }
}

/**
 * C3 (spec §4.5; Codex C3-1/C3-7/C3-12, C3-P8): la factura del cliente de un ticket que sale de la global, con los productos que quedan.
 * - **Sin `base`** (comprobación previa, con `prisma`, sin efectos): arma la extracción de hoy y, de sus remanentes, la factura.
 * - **Con `base`**: en la reserva de la extracción, lo que acaba de armar `construirExtraccion` bajo sus candados (C3-12, con `tx`); en la
 *   captura, lo congelado en la extracción timbrada (`baseDeLaExtraccion`).
 * En los tres: A7-R10 (G1), el emisor de la venta = el de la global, `nominativaPorExtraccion` con las claves SAT del catálogo de HOY (C3-P8,
 * B11: del payload de la factura individual, por el `OrderItem` de cada concepto), el receptor, la forma y el método de hoy, y
 * `validateBeforeStamp`. `paidCents` = lo extraído (B10). `entrada` es `null` si no se pudo armar (sus motivos lo dicen). No modifica `base`
 * (en la reserva son referencias de la memoria compartida de la global).
 */
export async function prepararPorExtraccion(
  db: Prisma.TransactionClient,
  params: { orderId: string; receptor: IssueReceptor; sandbox: boolean; flow?: 'STAFF_B' | 'AUTOFACTURA_A' },
  global: { id: string; fiscalEmisorId: string | null },
  bundle: LoadedOrderBundle,
  base?: BaseDeLaFactura,
): Promise<{ entrada: EntradaDocumentalV1 | null; reasons: string[] }> {
  // G1 (A7-R10, founder 10-oct): una venta con devolución completada no se AUTOFACTURA; se decide ANTES de extraer (y, en la reserva, bajo
  // el `FOR UPDATE` de la orden que también toman las devoluciones).
  if (params.flow === 'AUTOFACTURA_A' && (await ventaConDevolucion(params.orderId, db)))
    return { entrada: null, reasons: [MOTIVO_AUTOFACTURA_CON_DEVOLUCION] }
  const reasons = bundle.emisor.id === global.fiscalEmisorId ? [] : [MOTIVO_EMISOR_DISTINTO_DE_LA_GLOBAL]
  const b = base ?? (await extraccionDeHoy(db, params, global.id, bundle.venueId))
  if ('motivo' in b) return { entrada: null, reasons: [...reasons, b.motivo] }
  // B11 / C3-P8: el payload de la factura individual de HOY (el mismo que arma `capturarEntrada`) da las claves; su dinero no se usa.
  let venta: CreateInvoiceParams
  try {
    venta = buildCreateInvoiceParams(
      assembleSaleInput(bundle.order, {
        receptor: params.receptor,
        paymentMethod: bundle.paymentMethod,
        tenderSatFormaPago: bundle.tenderSatFormaPago ?? null,
        metodoPago: bundle.metodoPago,
        serie: bundle.emisor.serie ?? undefined,
        idempotencyKey: params.orderId,
      }),
    )
  } catch (err) {
    return { entrada: null, reasons: [...reasons, err instanceof Error ? err.message : String(err)] }
  }
  // Los conceptos de la venta y `venta.items` van 1 a 1; cada uno lleva el `OrderItem` del que nace (`origen`; la venta sin renglones, ninguno).
  const claves = new Map<string | null, { satProductKey: string; satUnitKey: string }>()
  ;(bundle.order.items as RenglonParaCfdi[]).forEach((c, i) => {
    const k = c.origen ?? null
    if (!claves.has(k)) claves.set(k, { satProductKey: venta.items[i].satProductKey, satUnitKey: venta.items[i].satUnitKey })
  })
  if (b.remanentes.some(r => !claves.has(r.orderItemId))) return { entrada: null, reasons: [...reasons, MOTIVO_SIN_CONCEPTOS_REALES] }
  const nom = nominativaPorExtraccion({
    reales: b.remanentes,
    filasD16: b.filasD16,
    claves: (_productId, _descripcion, orderItemId) => claves.get(orderItemId)!,
    extraido: { brutoPorTratamiento: b.bruto, porTratamiento: b.porTratamiento },
  })
  if ('motivo' in nom) return { entrada: null, reasons: [...reasons, nom.motivo] }
  const items = nom.items
  reasons.push(
    ...validateBeforeStamp({
      csdStatus: bundle.emisor.csdStatus,
      formaPago: venta.formaPago,
      receptor: params.receptor,
      items,
      expectedSubtotalCents: nom.montos.subtotalCents,
      expectedTaxCents: nom.montos.taxCents,
      expectedTotalCents: nom.montos.totalCents,
      isGlobal: false,
    }).reasons,
  )
  const entrada: EntradaDocumentalV1 = structuredClone({
    version: 1,
    orderId: params.orderId,
    fiscalEmisorId: bundle.emisor.id,
    replacesCfdiId: null,
    contratoDePrecio: bundle.order.contratoDePrecio ?? null,
    paymentStatus: bundle.order.paymentStatus ?? null,
    clasificacion: nom.clasificacion,
    paidCents: Object.values(b.bruto).reduce((s, c) => s + (c ?? 0), 0), // B10: lo extraído, no lo cobrado de la orden
    montos: nom.montos,
    renglones: nom.renglones,
    params: { ...venta, items },
    ...(nom.montosPorRenglon.length ? { montosPorRenglon: nom.montosPorRenglon } : {}),
    ...(b.extraccion ? { extraccion: { ...b.extraccion, brutoPorTratamiento: b.bruto, diferencias: nom.diferencias } } : {}),
  })
  return { entrada, reasons }
}
