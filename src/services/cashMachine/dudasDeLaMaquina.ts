/**
 * Máquina de efectivo QuickPay Mini · fase 1a · «Cobros en duda» (plan `2026-11-20-maquina-de-efectivo-fase-1a.md`, R4-4, R5#5, R5#6,
 * R5#8). La PC perdió el mensaje de cierre y NO sabe cómo terminó una operación: sube la duda (`CashMachineIncident` `ESPERANDO`) con
 * su carrito congelado y pregunta cada 60 s. Un GERENTE la resuelve con SU sesión (POS del mostrador o DASHBOARD, `cash-machine:resolve`),
 * tecleando lo que ve en la máquina. La resolución usa el MISMO núcleo que la venta de la PC (`registrarCierreDeLaMaquina`), con
 * `resolvedBy GERENTE` y el gerente del token; sin la hora del comprobante, la hora y el turno quedan por conciliar.
 */
import type { CashMachineIncident, Prisma } from '@prisma/client'

import AppError, { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { utcTs } from '../../utils/sqlDates'
// El cursor `createdAt|id` opaco de la merma: la misma forma (orden `createdAt DESC, id DESC`), sin copiarlo.
import { decodeWasteCursor as leerCursor, encodeWasteCursor as cursorDe } from '../../schemas/mobile/inventoryWaste.mobile.schema'
import { logAction } from '../dashboard/activity-log.service'
import type { CreateOrderInput } from '../mobile/order.mobile.service'
import { decidirEscrituraDelFolio, versionDeLaIncidencia } from './decisionDelFolio'
import { aparatoDe, exigirAparatoEmparejado } from './emparejamiento'
import {
  CASH_MACHINE_REF,
  adeudoCobrable,
  anotarEnBitacora,
  anotarEnTx,
  anotarIncidencia,
  conElFolio,
  huellaDelCarrito,
  registrarCierreDeLaMaquina,
  respuestaDe,
  respuestaSinRegistro,
  type AutorDeLaMaquina,
  type IncidenciaAnotada,
  type LecturaDelFolio,
  type CierreDeLaMaquina,
  type DesenlaceDeLaMaquina,
  type RespuestaDeLaMaquina,
  type RespuestaSinRegistro,
  type ResultadoDeLaMaquina,
} from './ventaDeLaMaquina'

/** Lo que la PC sabe de la operación en duda, en CENTAVOS (como la venta). */
export interface DudaDeLaMaquina {
  referenceCC: string
  dueCents: number
  saleCents: number
  tipCents: number
  /** El carrito congelado, el MISMO JSON de la venta (`POST /orders`). */
  pedido: Record<string, unknown>
  /** Cuándo empezó el cobro (ISO). Nunca se usa como la hora de la venta (R5#8). */
  startedAt: string
  /** Lo último que vio la PC de la máquina (texto libre para el gerente). */
  lastSeen?: unknown
  saleShiftId?: string | null
}

/** Lo que se guarda en la duda: lo de la PC más quién la subió (el vendedor por omisión del carrito). */
interface DudaGuardada extends Omit<DudaDeLaMaquina, 'referenceCC'> {
  subidoPor: string
  /** Codex r2 #5: la huella de los artículos del carrito congelado: el cierre de la PC debe traer el MISMO. */
  huellaDelCarrito?: string | null
  /** Al cerrarse (`marcarDudaResuelta`): quién, la huella y, si la venta ya no se pudo armar, `incident`. */
  resolucion?: { huella?: string; incident?: string } & Record<string, unknown>
}

export type EstadoDeLaDuda =
  /** `incidentId`: la duda guardada (ESPERANDO), la que el gerente resuelve. */
  | { status: 'ABIERTO'; referenceCC: string; incidentId: string | null }
  | ({ status: 'RESUELTO' } & RespuestaDeLaMaquina)
  | ({ status: 'RESUELTO' } & RespuestaSinRegistro)

/** Lo que el gerente teclea al ver la máquina. El gerente sale del token; los importes de la venta, de la duda. */
export interface ResolucionDelGerente {
  outcome: DesenlaceDeLaMaquina
  creditCents: number
  changeDispensedCents: number
  /** La hora impresa en el comprobante de la máquina (ISO). Sin ella → hora y turno por conciliar (R5#8). */
  occurredAt?: string | null
  /** Lo que leyó en la máquina. */
  evidence: string
  /**
   * Codex r2 #10: lo que el gerente VIO que hizo la máquina con los billetes de un CANCELADO o GUARDADO — `'1'` los devolvió, `'2'` los
   * guardó —. Pasa por el MISMO validador que el cierre de la PC: sin él, o incompatible con el desenlace, 422 y la duda sigue abierta.
   */
  cancelMode?: '1' | '2' | null
}

const LIMITE_POR_OMISION = 50
const LIMITE_MAXIMO = 100

const dondeLaDuda = (venueId: string, referenceCC: string) => ({
  venueId_referenceCC_kind: { venueId, referenceCC, kind: 'ESPERANDO' },
})

const leerDuda = (fila: Pick<CashMachineIncident, 'payload'>) => fila.payload as unknown as DudaGuardada

/** `POST /mobile/venues/:venueId/cash-machine/doubts` — idempotente por folio. */
export async function subirDudaDeLaMaquina(venueId: string, autor: AutorDeLaMaquina, entrada: DudaDeLaMaquina): Promise<EstadoDeLaDuda> {
  const { referenceCC } = entrada
  if (!CASH_MACHINE_REF.test(referenceCC)) {
    throw new BadRequestError('El folio de la máquina debe ser AQ seguido de 12 letras mayúsculas o números.')
  }
  const importes = [entrada.dueCents, entrada.saleCents, entrada.tipCents]
  if (!importes.every(n => Number.isInteger(n) && n >= 0) || entrada.dueCents !== entrada.saleCents + entrada.tipCents) {
    throw new BadRequestError('El adeudo de la duda debe ser la venta más la propina, en centavos enteros.')
  }
  const deviceId = await aparatoDe(venueId, autor.deviceUid)
  // La MISMA puerta que la venta: sólo una credencial de esta PC. Lo que una PC revocada puede escribir lo decide el folio (abajo).
  const { revocadaEn } = await exigirAparatoEmparejado(venueId, deviceId, autor.credencial)
  const quien = { userId: autor.userId, deviceId }
  const evento = { duda: { ...entrada, pedido: undefined }, deviceId, recibidoEn: new Date().toISOString() }
  // Codex r1 #12 (decisión h): un adeudo de $0 o que no es múltiplo de $0.50 no lo cobra la máquina: 422 con incidencia.
  if (!adeudoCobrable(entrada.dueCents)) {
    const incidentId = await anotarIncidencia(venueId, referenceCC, 'IMPOSIBLE', quien, evento)
    throw new AppError(
      'El adeudo de esta duda no lo puede cobrar la máquina (debe ser mayor que $0 y múltiplo de $0.50). Quedó registrado para el gerente.',
      422,
      true,
      'CASH_MACHINE_CLOSE_IMPOSSIBLE',
      { incidentId },
    )
  }

  const carrito = huellaDelCarrito(entrada.pedido)
  const payload: DudaGuardada = {
    dueCents: entrada.dueCents,
    saleCents: entrada.saleCents,
    tipCents: entrada.tipCents,
    pedido: entrada.pedido,
    huellaDelCarrito: carrito,
    startedAt: entrada.startedAt,
    lastSeen: entrada.lastSeen ?? null,
    saleShiftId: entrada.saleShiftId ?? null,
    subidoPor: autor.userId,
  }
  // Bajo el candado del folio (el de la venta y su cierre), lo decide `decidirEscrituraDelFolio`: la duda nunca nace después de que el
  // folio ya se cerró o quedó sin registro (r1 #3), ni encima de la de otra PC (r1 #4); otra versión de la evidencia es 409 con ella
  // guardada (r1 #7); la PC revocada todavía la entrega, y queda TRAS_REVOCAR (r1 #5).
  const r = await conElFolio(venueId, referenceCC, async (tx, lectura) => {
    const d = decidirEscrituraDelFolio(lectura.estado, {
      que: 'DUDA',
      quien: { tipo: 'PC', deviceId, revocadaEn },
      importes: { dueCents: entrada.dueCents, saleCents: entrada.saleCents, tipCents: entrada.tipCents },
      huellaDelCarrito: carrito,
    })
    const anotadas: IncidenciaAnotada[] = []
    const registrada = d.accion === 'CONFLICTO' && d.motivo === 'OTRA_PC' ? { motivo: 'OTRA_PC' } : importesGuardados(lectura)
    if (d.accion === 'CONFLICTO') {
      await anotarEnTx(tx, venueId, referenceCC, deviceId, anotadas, 'CONFLICTO', { ...evento, motivo: d.motivo, registrada })
    }
    let nueva: { id: string } | null = null
    if (d.accion === 'ABRIR_DUDA') {
      if (d.trasRevocar) {
        await anotarEnTx(tx, venueId, referenceCC, deviceId, anotadas, 'TRAS_REVOCAR', {
          ...evento,
          revocadaEn: revocadaEn?.toISOString() ?? null,
        })
      }
      nueva = await tx.cashMachineIncident.create({
        data: {
          venueId,
          referenceCC,
          kind: 'ESPERANDO',
          status: 'ABIERTO',
          payload: payload as unknown as Prisma.InputJsonValue,
          deviceId,
        },
        select: { id: true },
      })
    }
    return { d, lectura, anotadas, nueva, registrada }
  })
  await anotarEnBitacora(venueId, referenceCC, autor.userId, r.anotadas)
  if (r.nueva) {
    await logAction({
      action: 'CASH_MACHINE_DOUBT_OPENED',
      entity: 'CashMachineIncident',
      entityId: r.nueva.id,
      venueId,
      staffId: autor.userId,
      data: { referenceCC, deviceId, duePesos: entrada.dueCents / 100, startedAt: entrada.startedAt },
    })
  }
  const desenlace = desenlaceDe(referenceCC, r.d, r.lectura)
  if (desenlace) return desenlace
  if (r.d.accion === 'DUDA_ABIERTA' || r.d.accion === 'ABRIR_DUDA') {
    return { status: 'ABIERTO', referenceCC, incidentId: r.nueva?.id ?? r.lectura.duda?.id ?? null }
  }
  throw new ConflictError(
    'Esta duda de la máquina ya se subió con otros importes o desde otra PC. Quedó registrado para que el gerente lo revise.',
    'CASH_MACHINE_DOUBT_CONFLICT',
    { registrada: r.registrada, incidentId: r.anotadas.find(a => a.kind === 'CONFLICTO')?.id ?? null },
  )
}

/** Los importes que el folio ya tiene (la duda, o lo definitivo): lo que el 409 le enseña a la PC dueña. */
function importesGuardados(lectura: LecturaDelFolio): Record<string, unknown> | null {
  const g = lectura.estado.duda ?? lectura.estado.cierre ?? lectura.estado.sinRegistro
  return g ? { dueCents: g.dueCents, saleCents: g.saleCents, tipCents: g.tipCents } : null
}

/** El desenlace guardado del folio, si la decisión dice REPETIR (el cierre o el comprobante estable del «no se pudo registrar»). */
function desenlaceDe(referenceCC: string, d: ReturnType<typeof decidirEscrituraDelFolio>, lectura: LecturaDelFolio): EstadoDeLaDuda | null {
  if (d.accion !== 'REPETIR') return null
  if (d.de === 'CIERRE' && lectura.cierre) return { status: 'RESUELTO', ...respuestaDe(lectura.cierre) }
  const cuerpo =
    d.de === 'SIN_REGISTRO' && lectura.sinRegistro
      ? respuestaSinRegistro(referenceCC, lectura.sinRegistro.payload, lectura.sinRegistro.id)
      : null
  return cuerpo ? { status: 'RESUELTO', ...cuerpo } : null
}

/**
 * `GET /mobile/venues/:venueId/cash-machine/doubts/:referenceCC` — lo que la PC consulta cada 60 s (R5#6).
 * Codex r1 #6: primero la duda y DESPUÉS el desenlace, bajo el candado del folio; lo que se contesta lo dice `decidirEscrituraDelFolio`
 * (CONSULTA). Una duda sin desenlace guardado sigue «ABIERTO»: nunca se fabrica uno.
 */
export async function consultarDudaDeLaMaquina(venueId: string, referenceCC: string): Promise<EstadoDeLaDuda> {
  const lectura = await conElFolio(venueId, referenceCC, async (_tx, l) => l)
  const d = decidirEscrituraDelFolio(lectura.estado, { que: 'CONSULTA' })
  const desenlace = desenlaceDe(referenceCC, d, lectura)
  if (desenlace) return desenlace
  if (d.accion !== 'DUDA_ABIERTA') {
    throw new NotFoundError('Ese folio de la máquina no tiene una duda ni un cierre.', 'CASH_MACHINE_DOUBT_NOT_FOUND')
  }
  return { status: 'ABIERTO', referenceCC, incidentId: lectura.duda?.id ?? null }
}

/** Lo que el gerente revisa de las incidencias que NO son duda (Codex r1 #7): cuántas veces llegó y la primera y última evidencia. */
type EventosGuardados = {
  eventos?: unknown[]
  veces?: number
  version?: number
  repetidas?: number
  revision?: unknown
  revisiones?: unknown[]
}

/**
 * `GET …/cash-machine/doubts` (POS del mostrador y DASHBOARD): acotada, más nuevas primero, con el total y el cursor.
 * Codex r1 #7: trae TODAS las incidencias abiertas de la máquina (la duda, el imposible, el conflicto, el «no se pudo registrar» y el
 * folio de una PC revocada), cada una con su `kind`, para que un 409 o un 422 nunca mande al gerente a revisar algo que no ve.
 * `kind` y `folio` (parte del folio) filtran en la base, antes de paginar.
 */
export async function listarDudasDeLaMaquina(
  venueId: string,
  q: { status?: 'ABIERTO' | 'RESUELTO'; kind?: string; folio?: string; cursor?: string; limit?: number },
): Promise<{ data: Array<Record<string, unknown>>; total: number; nextCursor: string | null }> {
  const limite = Math.min(Math.max(Math.trunc(q.limit ?? LIMITE_POR_OMISION), 1), LIMITE_MAXIMO)
  const despues = q.cursor === undefined ? null : leerCursor(q.cursor)
  if (q.cursor !== undefined && !despues) throw new BadRequestError('El cursor no es válido.')
  const folio = q.folio?.trim().toUpperCase()
  const where: Prisma.CashMachineIncidentWhereInput = {
    venueId,
    status: q.status ?? 'ABIERTO',
    ...(q.kind ? { kind: q.kind } : {}),
    ...(folio ? { referenceCC: { contains: folio } } : {}),
  }
  const [total, filas] = await Promise.all([
    prisma.cashMachineIncident.count({ where }),
    prisma.cashMachineIncident.findMany({
      where: despues
        ? { AND: [where, { OR: [{ createdAt: { lt: despues.createdAt } }, { createdAt: despues.createdAt, id: { lt: despues.id } }] }] }
        : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limite + 1,
      select: {
        id: true,
        referenceCC: true,
        kind: true,
        status: true,
        deviceId: true,
        createdAt: true,
        resolvedByStaffId: true,
        resolvedAt: true,
        payload: true,
      },
    }),
  ])
  const pagina = filas.slice(0, limite)
  const ultima = pagina[pagina.length - 1]
  return {
    data: pagina.map(({ payload, ...fila }) => {
      if (fila.kind !== 'ESPERANDO') {
        const p = (payload ?? {}) as EventosGuardados
        const eventos = Array.isArray(p.eventos) ? p.eventos : []
        return {
          ...fila,
          veces: p.veces ?? eventos.length,
          // Codex r2 #8: la versión de la evidencia (la que el gerente confirma al revisar) y cuántas entregas fueron idénticas.
          version: versionDeLaIncidencia(p),
          repetidas: p.repetidas ?? 0,
          primerEvento: eventos[0] ?? null,
          ultimoEvento: eventos.length > 1 ? eventos[eventos.length - 1] : null,
          revision: p.revision ?? null,
          revisiones: Array.isArray(p.revisiones) ? p.revisiones : [],
        }
      }
      const d = leerDuda({ payload })
      return {
        ...fila,
        dueCents: d.dueCents,
        saleCents: d.saleCents,
        tipCents: d.tipCents,
        startedAt: d.startedAt,
        lastSeen: d.lastSeen ?? null,
        pedido: d.pedido,
        saleShiftId: d.saleShiftId ?? null,
      }
    }),
    total,
    nextCursor: filas.length > limite && ultima ? cursorDe(ultima.createdAt, ultima.id) : null,
  }
}

/**
 * `POST …/cash-machine/incidents/:incidentId/review` (`cash-machine:resolve`, Codex r1 #7): el gerente da por revisada una incidencia
 * que NO es duda (el imposible, el conflicto, el «no se pudo registrar», el folio de la PC revocada) con una nota. No mueve dinero ni
 * cambia el desenlace del folio. 🔴 Codex r2 #8: confirma la `version` de la evidencia que el gerente VIO (la de la lista): si llegó
 * evidencia nueva mientras la leía, 409 `CASH_MACHINE_INCIDENT_CHANGED` y no se da por revisada. Bajo el candado del folio, decide
 * `decidirEscrituraDelFolio` (REVISION). La revisión se guarda en `revision` y se agrega a `revisiones`: evidencia nueva reabre la
 * incidencia sin borrar la revisión anterior. Repetirla con la misma versión no hace nada.
 */
export async function revisarIncidenciaDeLaMaquina(
  venueId: string,
  gerenteId: string,
  incidentId: string,
  nota: string,
  versionVista: number,
): Promise<{ id: string; referenceCC: string; kind: string; status: 'RESUELTO'; version: number }> {
  const fila = await prisma.cashMachineIncident.findFirst({
    where: { id: incidentId, venueId },
    select: { id: true, referenceCC: true },
  })
  if (!fila) throw new NotFoundError('Esa incidencia de la máquina no existe en este negocio.', 'CASH_MACHINE_INCIDENT_NOT_FOUND')
  const r = await conElFolio(venueId, fila.referenceCC, async tx => {
    const actual = await tx.cashMachineIncident.findFirst({
      where: { id: fila.id, venueId },
      select: { id: true, referenceCC: true, kind: true, status: true, payload: true },
    })
    if (!actual) throw new NotFoundError('Esa incidencia de la máquina no existe en este negocio.', 'CASH_MACHINE_INCIDENT_NOT_FOUND')
    const versionActual = versionDeLaIncidencia(actual.payload)
    const d = decidirEscrituraDelFolio(
      { cierre: null, sinRegistro: null, duda: null },
      { que: 'REVISION', kind: actual.kind, status: actual.status, versionVista, versionActual },
    )
    if (d.accion !== 'REVISAR') return { d, actual, versionActual, revisada: false }
    const ahora = new Date()
    const revision = { nota, staffId: gerenteId, en: ahora.toISOString(), version: versionActual }
    await tx.$executeRaw`
      UPDATE "CashMachineIncident"
      SET "status" = 'RESUELTO', "resolvedByStaffId" = ${gerenteId}, "resolvedAt" = ${utcTs(ahora)}, "updatedAt" = ${utcTs(ahora)},
          "payload" = "payload" || jsonb_build_object(
            'revision', ${JSON.stringify(revision)}::jsonb,
            'revisiones', COALESCE("payload" -> 'revisiones', '[]'::jsonb) || jsonb_build_array(${JSON.stringify(revision)}::jsonb))
      WHERE "id" = ${actual.id} AND "venueId" = ${venueId} AND "status" = 'ABIERTO'`
    return { d, actual, versionActual, revisada: true }
  })
  if (r.d.accion === 'NO_REVISABLE') {
    throw new ConflictError(
      'Un cobro en duda se resuelve tecleando lo que dice la máquina, no se da por revisado.',
      'CASH_MACHINE_DOUBT_NEEDS_RESOLUTION',
    )
  }
  if (r.d.accion === 'CONFLICTO') {
    throw new ConflictError(
      'Llegó evidencia nueva de esta incidencia mientras la revisabas. Vuelve a leerla antes de darla por revisada.',
      'CASH_MACHINE_INCIDENT_CHANGED',
      { version: r.versionActual },
    )
  }
  if (r.revisada) {
    await logAction({
      action: 'CASH_MACHINE_INCIDENT_REVIEWED',
      entity: 'CashMachineIncident',
      entityId: r.actual.id,
      venueId,
      staffId: gerenteId,
      data: { referenceCC: r.actual.referenceCC, kind: r.actual.kind, nota, version: r.versionActual },
    })
  }
  return { id: r.actual.id, referenceCC: r.actual.referenceCC, kind: r.actual.kind, status: 'RESUELTO', version: r.versionActual }
}

/**
 * `POST …/cash-machine/doubts/:referenceCC/resolve` (`cash-machine:resolve`). El gerente es `gerenteId` (del token). Con `PAGADO`,
 * `armarPedido` lee el carrito congelado como `POST /orders` (el controlador: lectura y autoridad de la sesión del gerente).
 * Misma resolución otra vez → la misma evidencia; otra → 409 con lo registrado.
 */
export async function resolverDudaDeLaMaquina(
  venueId: string,
  gerenteId: string,
  referenceCC: string,
  r: ResolucionDelGerente,
  armarPedido: (pedido: Record<string, unknown>, subidoPor: string) => Promise<CreateOrderInput>,
): Promise<ResultadoDeLaMaquina> {
  const fila = await prisma.cashMachineIncident.findUnique({ where: dondeLaDuda(venueId, referenceCC) })
  if (!fila) throw new NotFoundError('Ese folio de la máquina no tiene una duda.', 'CASH_MACHINE_DOUBT_NOT_FOUND')
  const duda = leerDuda(fila)
  const estabaAbierta = fila.status === 'ABIERTO'
  const cierre: CierreDeLaMaquina = {
    outcome: r.outcome,
    dueCents: duda.dueCents,
    saleCents: duda.saleCents,
    tipCents: duda.tipCents,
    creditCents: r.creditCents,
    changeDispensedCents: r.changeDispensedCents,
    // R5#8: sólo la hora del comprobante; nunca `startedAt` ni la hora de la resolución.
    occurredAt: r.occurredAt ?? null,
    occurredAtKnown: Boolean(r.occurredAt),
    saleShiftId: duda.saleShiftId ?? null,
    // Codex r2 #10: el modo que el gerente VIO, nunca inferido del desenlace. El núcleo lo valida igual que el cierre de la PC.
    cancelMode: r.cancelMode ?? null,
  }

  // Todo pasa por el núcleo y su decisión bajo el candado (Codex r2 #9): una declaración que contradice lo ya decidido —también después
  // de un 202— queda como CONFLICTO antes del 409. El carrito sólo se arma si la duda sigue abierta; la evidencia del carrito es SIEMPRE
  // la huella congelada de la duda.
  const resultado = await registrarCierreDeLaMaquina(venueId, {
    referenceCC,
    cierre,
    ...(r.outcome === 'PAGADO' && estabaAbierta ? { pedido: await armarPedido(duda.pedido, duda.subidoPor) } : {}),
    resolvedBy: 'GERENTE',
    userId: gerenteId,
    deviceId: fila.deviceId,
    evidence: r.evidence,
    huellaDelCarrito: duda.huellaDelCarrito ?? huellaDelCarrito(duda.pedido),
  })
  if (estabaAbierta) {
    await logAction({
      action: 'CASH_MACHINE_DOUBT_RESOLVED',
      entity: 'CashMachineIncident',
      entityId: fila.id,
      venueId,
      staffId: gerenteId,
      data: {
        referenceCC,
        outcome: r.outcome,
        cancelMode: r.cancelMode ?? null,
        creditPesos: r.creditCents / 100,
        changeDispensedPesos: r.changeDispensedCents / 100,
        occurredAt: r.occurredAt ?? null,
        evidence: r.evidence,
        ...(resultado.status === 202 ? { incident: resultado.body.incident } : { paymentId: resultado.body.paymentId }),
      },
    })
  }
  return resultado
}
