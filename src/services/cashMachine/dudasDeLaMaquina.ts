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
import { withDeadlockRetry } from '../../utils/serializableRetry'
import { utcTs } from '../../utils/sqlDates'
// El cursor `createdAt|id` opaco de la merma: la misma forma (orden `createdAt DESC, id DESC`), sin copiarlo.
import { decodeWasteCursor as leerCursor, encodeWasteCursor as cursorDe } from '../../schemas/mobile/inventoryWaste.mobile.schema'
import { logAction } from '../dashboard/activity-log.service'
import { candadoDeLaLlave } from '../mobile/pagarDespuesLlave'
import type { CreateOrderInput } from '../mobile/order.mobile.service'
import { aparatoDe, exigirAparatoEmparejado } from './emparejamiento'
import {
  CASH_MACHINE_REF,
  adeudoCobrable,
  anotarIncidencia,
  huellaDelCierre,
  registrarCierreDeLaMaquina,
  respuestaDe,
  respuestaSinRegistro,
  sinRegistroDelFolio,
  type AutorDeLaMaquina,
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
  /** Al cerrarse (`marcarDudaResuelta`): quién, la huella y, si la venta ya no se pudo armar, `incident`. */
  resolucion?: { huella?: string; incident?: string } & Record<string, unknown>
}

export type EstadoDeLaDuda =
  | { status: 'ABIERTO'; referenceCC: string }
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
}

const LIMITE_POR_OMISION = 50
const LIMITE_MAXIMO = 100

const dondeLaDuda = (venueId: string, referenceCC: string) => ({
  venueId_referenceCC_kind: { venueId, referenceCC, kind: 'ESPERANDO' },
})

const leerDuda = (fila: Pick<CashMachineIncident, 'payload'>) => fila.payload as unknown as DudaGuardada

const cierreDelFolio = (venueId: string, referenceCC: string) =>
  prisma.cashMachineClose.findUnique({ where: { venueId_referenceCC: { venueId, referenceCC } } })

/** Codex r1 #4: una duda de OTRA PC (o el desenlace que otra PC dejó) no se toca: 409 con la evidencia nueva guardada. */
async function conflictoDeLaDuda(
  venueId: string,
  referenceCC: string,
  quien: { userId: string; deviceId: string | null },
  evento: Record<string, unknown>,
  registrada: unknown,
): Promise<never> {
  await anotarIncidencia(venueId, referenceCC, 'CONFLICTO', quien, { ...evento, registrada })
  throw new ConflictError(
    'Esta duda de la máquina ya se subió con otros importes o desde otra PC. Quedó registrado para que el gerente lo revise.',
    'CASH_MACHINE_DOUBT_CONFLICT',
    { registrada },
  )
}

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
  // La MISMA puerta que la venta: sólo la PC emparejada abre una duda; la revocada repite la suya o entrega una nueva para revisión.
  const { revocadaEn } = await exigirAparatoEmparejado(venueId, referenceCC, deviceId, autor.credencial)
  const quien = { userId: autor.userId, deviceId }
  const evento = { duda: { ...entrada, pedido: undefined }, deviceId, recibidoEn: new Date().toISOString() }
  // Codex r1 #12 (decisión h): un adeudo de $0 o que no es múltiplo de $0.50 no lo cobra la máquina: 422 con incidencia.
  if (!adeudoCobrable(entrada.dueCents)) {
    await anotarIncidencia(venueId, referenceCC, 'IMPOSIBLE', quien, evento)
    throw new AppError(
      'El adeudo de esta duda no lo puede cobrar la máquina (debe ser mayor que $0 y múltiplo de $0.50). Quedó registrado para el gerente.',
      422,
      true,
      'CASH_MACHINE_CLOSE_IMPOSSIBLE',
    )
  }
  // Codex r1 #5 (decisión d): la PC revocada todavía entrega su duda (evidencia, nunca autoridad): queda también a revisión.
  if (revocadaEn) {
    await anotarIncidencia(venueId, referenceCC, 'TRAS_REVOCAR', quien, { ...evento, revocadaEn: revocadaEn.toISOString() })
  }

  const payload: DudaGuardada = {
    dueCents: entrada.dueCents,
    saleCents: entrada.saleCents,
    tipCents: entrada.tipCents,
    pedido: entrada.pedido,
    startedAt: entrada.startedAt,
    lastSeen: entrada.lastSeen ?? null,
    saleShiftId: entrada.saleShiftId ?? null,
    subidoPor: autor.userId,
  }
  // Bajo el candado del folio (el de la venta y su cierre): la duda nunca nace después de que el folio ya se cerró o ya quedó sin
  // registro (Codex r1 #3): manda ESE desenlace.
  const r = await withDeadlockRetry(
    async tx => {
      await tx.$queryRaw(candadoDeLaLlave(venueId, `maquina-${referenceCC}`))
      const cierre = await tx.cashMachineClose.findUnique({ where: { venueId_referenceCC: { venueId, referenceCC } } })
      if (cierre) return { cierre }
      const sinRegistro = await tx.cashMachineIncident.findUnique({
        where: { venueId_referenceCC_kind: { venueId, referenceCC, kind: 'NO_SE_PUDO_REGISTRAR' } },
        select: { payload: true, deviceId: true },
      })
      if (sinRegistro) return { sinRegistro }
      const previa = await tx.cashMachineIncident.findUnique({ where: dondeLaDuda(venueId, referenceCC) })
      if (previa) return { duda: previa, nueva: false }
      const duda = await tx.cashMachineIncident.create({
        data: {
          venueId,
          referenceCC,
          kind: 'ESPERANDO',
          status: 'ABIERTO',
          payload: payload as unknown as Prisma.InputJsonValue,
          deviceId,
        },
      })
      return { duda, nueva: true }
    },
    { etiqueta: 'subirDudaDeLaMaquina' },
  )
  // Codex r1 #4: el folio es de la PC que lo subió primero; a otra PC no se le contesta con su desenlace ni se le deja tocarlo.
  if (r.cierre) {
    if (r.cierre.deviceId !== deviceId) return conflictoDeLaDuda(venueId, referenceCC, quien, evento, { motivo: 'OTRA_PC' })
    return { status: 'RESUELTO', ...respuestaDe(r.cierre) }
  }
  if (r.sinRegistro) {
    const cuerpo = respuestaSinRegistro(referenceCC, r.sinRegistro.payload)
    if (r.sinRegistro.deviceId !== deviceId || !cuerpo) {
      return conflictoDeLaDuda(venueId, referenceCC, quien, evento, { motivo: 'OTRA_PC' })
    }
    return { status: 'RESUELTO', ...cuerpo }
  }

  const guardada = leerDuda(r.duda)
  if (r.duda.deviceId !== deviceId) return conflictoDeLaDuda(venueId, referenceCC, quien, evento, { motivo: 'OTRA_PC' })
  if (guardada.dueCents !== entrada.dueCents || guardada.saleCents !== entrada.saleCents || guardada.tipCents !== entrada.tipCents) {
    // Codex r1 #7: la versión nueva de la evidencia se guarda (CONFLICTO) antes del 409; la duda original no cambia.
    return conflictoDeLaDuda(venueId, referenceCC, quien, evento, {
      dueCents: guardada.dueCents,
      saleCents: guardada.saleCents,
      tipCents: guardada.tipCents,
    })
  }
  if (r.nueva) {
    await logAction({
      action: 'CASH_MACHINE_DOUBT_OPENED',
      entity: 'CashMachineIncident',
      entityId: r.duda.id,
      venueId,
      staffId: autor.userId,
      data: { referenceCC, deviceId, duePesos: entrada.dueCents / 100, startedAt: entrada.startedAt },
    })
  }
  // Una duda que ya se cerró sin cierre tiene su «no se pudo registrar» (se habría devuelto arriba): aquí sólo queda abierta.
  return { status: 'ABIERTO', referenceCC }
}

/**
 * `GET /mobile/venues/:venueId/cash-machine/doubts/:referenceCC` — lo que la PC consulta cada 60 s (R5#6).
 * Codex r1 #6: primero la duda y DESPUÉS el desenlace. Una duda RESUELTO ya tiene su cierre o su «no se pudo registrar» guardados (se
 * escriben en la misma transacción que la cierra), así que leerlos después siempre los encuentra; nunca se fabrica un desenlace.
 */
export async function consultarDudaDeLaMaquina(venueId: string, referenceCC: string): Promise<EstadoDeLaDuda> {
  const duda = await prisma.cashMachineIncident.findUnique({
    where: dondeLaDuda(venueId, referenceCC),
    select: { status: true },
  })
  const cierre = await cierreDelFolio(venueId, referenceCC)
  if (cierre) return { status: 'RESUELTO', ...respuestaDe(cierre) }
  const sinRegistro = await sinRegistroDelFolio(venueId, referenceCC)
  const cuerpo = sinRegistro ? respuestaSinRegistro(referenceCC, sinRegistro.payload) : null
  if (cuerpo) return { status: 'RESUELTO', ...cuerpo }
  if (!duda) throw new NotFoundError('Ese folio de la máquina no tiene una duda ni un cierre.', 'CASH_MACHINE_DOUBT_NOT_FOUND')
  return { status: 'ABIERTO', referenceCC }
}

/** Lo que el gerente revisa de las incidencias que NO son duda (Codex r1 #7): cuántas veces llegó y la primera y última evidencia. */
type EventosGuardados = { eventos?: unknown[]; veces?: number; revision?: unknown }

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
          primerEvento: eventos[0] ?? null,
          ultimoEvento: eventos.length > 1 ? eventos[eventos.length - 1] : null,
          revision: p.revision ?? null,
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
 * cambia el desenlace del folio: la evidencia (el cierre comprobado y la declaración contradictoria) se conserva entera. Si después
 * llega evidencia nueva del mismo folio, la incidencia se vuelve a abrir. Repetirla no hace nada.
 */
export async function revisarIncidenciaDeLaMaquina(
  venueId: string,
  gerenteId: string,
  incidentId: string,
  nota: string,
): Promise<{ id: string; referenceCC: string; kind: string; status: 'RESUELTO' }> {
  const fila = await prisma.cashMachineIncident.findFirst({
    where: { id: incidentId, venueId },
    select: { id: true, referenceCC: true, kind: true, status: true },
  })
  if (!fila) throw new NotFoundError('Esa incidencia de la máquina no existe en este negocio.', 'CASH_MACHINE_INCIDENT_NOT_FOUND')
  if (fila.kind === 'ESPERANDO') {
    throw new ConflictError(
      'Un cobro en duda se resuelve tecleando lo que dice la máquina, no se da por revisado.',
      'CASH_MACHINE_DOUBT_NEEDS_RESOLUTION',
    )
  }
  const respuesta = { id: fila.id, referenceCC: fila.referenceCC, kind: fila.kind, status: 'RESUELTO' as const }
  if (fila.status === 'RESUELTO') return respuesta
  const ahora = new Date()
  const revision = { nota, staffId: gerenteId, en: ahora.toISOString() }
  const cambiadas = await prisma.$executeRaw`
    UPDATE "CashMachineIncident"
    SET "status" = 'RESUELTO', "resolvedByStaffId" = ${gerenteId}, "resolvedAt" = ${utcTs(ahora)}, "updatedAt" = ${utcTs(ahora)},
        "payload" = "payload" || jsonb_build_object('revision', ${JSON.stringify(revision)}::jsonb)
    WHERE "id" = ${fila.id} AND "venueId" = ${venueId} AND "status" = 'ABIERTO'`
  if (cambiadas === 1) {
    await logAction({
      action: 'CASH_MACHINE_INCIDENT_REVIEWED',
      entity: 'CashMachineIncident',
      entityId: fila.id,
      venueId,
      staffId: gerenteId,
      data: { referenceCC: fila.referenceCC, kind: fila.kind, nota },
    })
  }
  return respuesta
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
    // El gerente declara lo que pasó con los billetes: su desenlace ES el modo (devolvió = `'1'`, guardó = `'2'`).
    cancelMode: r.outcome === 'CANCELADO' ? '1' : r.outcome === 'GUARDADO' ? '2' : null,
  }

  // Ya se cerró sin cierre (la venta no se pudo armar): se compara con lo que se resolvió, sin volver a armarla.
  if (!estabaAbierta && !(await cierreDelFolio(venueId, referenceCC))) {
    // El comprobante estable del folio (Codex r1 #3): el mismo que vio la PC.
    const sinRegistro = await sinRegistroDelFolio(venueId, referenceCC)
    const cuerpo = sinRegistro ? respuestaSinRegistro(referenceCC, sinRegistro.payload) : null
    if (cuerpo && duda.resolucion?.huella === huellaDelCierre(venueId, referenceCC, cierre, 'GERENTE')) {
      return { status: 202, body: cuerpo }
    }
    throw new ConflictError('Esta duda de la máquina ya se resolvió de otra forma.', 'CASH_MACHINE_DOUBT_CONFLICT', {
      registrada: duda.resolucion ?? null,
    })
  }

  const resultado = await registrarCierreDeLaMaquina(venueId, {
    referenceCC,
    cierre,
    ...(r.outcome === 'PAGADO' ? { pedido: await armarPedido(duda.pedido, duda.subidoPor) } : {}),
    resolvedBy: 'GERENTE',
    userId: gerenteId,
    deviceId: fila.deviceId,
    evidence: r.evidence,
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
