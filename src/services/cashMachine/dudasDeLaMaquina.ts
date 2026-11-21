/**
 * Máquina de efectivo QuickPay Mini · fase 1a · «Cobros en duda» (plan `2026-11-20-maquina-de-efectivo-fase-1a.md`, R4-4, R5#5, R5#6,
 * R5#8 y el rediseño tras la ronda 3 de Codex). La PC perdió el mensaje de cierre y NO sabe cómo terminó una operación: sube la duda
 * (`CashMachineIncident` `ESPERANDO`), que congela el folio si es su primer mensaje (`CashMachineFolio`: carrito, turno, reparto,
 * dueño). Una duda NUNCA se vuelve desenlace (r6-2): sólo un cierre de la PC o lo que declara un GERENTE con SU sesión. La resolución
 * entra por la MISMA escritura que el cierre de la PC (`recibirCierreDeLaMaquina`), con la `version` que vio el gerente (r6-4).
 */
import { Prisma } from '@prisma/client'

import AppError, { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
// El cursor `createdAt|id` opaco de la merma: la misma forma (orden `createdAt DESC, id DESC`), sin copiarlo.
import { decodeWasteCursor as leerCursor, encodeWasteCursor as cursorDe } from '../../schemas/mobile/inventoryWaste.mobile.schema'
import { logAction } from '../dashboard/activity-log.service'
import { decidirSobreElFolio, huellaDeLaObservacion, versionDeLaIncidencia } from './decisionDelFolio'
import { aparatoDe, exigirAparatoEmparejado } from './emparejamiento'
import {
  CASH_MACHINE_REF,
  adeudoCobrable,
  anotar,
  anotarEnBitacora,
  anotarImposible,
  conElFolio,
  huellaDelCarritoCompleto,
  observar,
  recibirCierreDeLaMaquina,
  respuestaDelCierre,
  revocacionDelVinculo,
  terminarElFolio,
  yaObservada,
  type AutorDeLaMaquina,
  type DesenlaceDeLaMaquina,
  type IncidenciaAnotada,
  type LectorDelPedido,
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
  /** El carrito congelado, el MISMO JSON de la venta (`POST /orders`). Ilegible o ausente no es 400 (r6-2). */
  pedido?: unknown
  /** Cuándo empezó el cobro (ISO). Nunca se usa como la hora de la venta (R5#8). */
  startedAt: string
  /** Lo último que vio la PC de la máquina (texto libre para el gerente). */
  lastSeen?: unknown
  saleShiftId?: string | null
  /** r6-6: el emparejamiento con el que la PC empezó este cobro. */
  bindingId?: string | null
}

/** Lo que se guarda en la duda (lo demás vive congelado en el folio). */
interface DudaGuardada {
  startedAt: string
  lastSeen: unknown
  /** El vendedor por omisión del carrito congelado. */
  subidoPor: string
}

export type EstadoDeLaDuda =
  /** `incidentId`: la duda (ESPERANDO). `version`: la que manda el gerente al resolverla (r6-4). */
  | { status: 'ABIERTO'; ack: 'RECIBIDO'; referenceCC: string; deviceId: string | null; incidentId: string | null; version: number }
  | ({ status: 'RESUELTO' } & RespuestaDeLaMaquina)
  | ({ status: 'RESUELTO' } & RespuestaSinRegistro)

/** Lo que el gerente teclea al ver la máquina. El gerente sale del token; los importes, del folio congelado. */
export interface ResolucionDelGerente {
  outcome: DesenlaceDeLaMaquina
  creditCents: number
  changeDispensedCents: number
  /** La hora impresa en el comprobante de la máquina (ISO). Sin ella → hora y turno por conciliar (R5#8). */
  occurredAt?: string | null
  /** Lo que leyó en la máquina. */
  evidence: string
  /** Codex r2 #10: lo que VIO hacer a la máquina con los billetes de un CANCELADO/GUARDADO. Pasa por el MISMO validador. */
  cancelMode?: '1' | '2' | null
  /** r6-4: la versión de la evidencia que vio (la de la lista). Si llegó otra, 409 y no se escribe nada. */
  version: number
}

const LIMITE_POR_OMISION = 50
const LIMITE_MAXIMO = 100

const abierta = (
  referenceCC: string,
  folio: { deviceId: string | null; version: number } | null,
  dudaId: string | null,
): EstadoDeLaDuda => ({
  status: 'ABIERTO',
  ack: 'RECIBIDO',
  referenceCC,
  deviceId: folio?.deviceId ?? null,
  incidentId: dudaId,
  version: folio?.version ?? 1,
})

/** El acuse del folio, dicho como el estado de la duda: TERMINADO → RESUELTO; RECIBIDO → sigue ABIERTO. */
const comoDuda = (
  referenceCC: string,
  r: ResultadoDeLaMaquina,
  folio: { deviceId: string | null; version: number } | null,
  dudaId: string | null,
) => (r.body.ack === 'TERMINADO' ? ({ status: 'RESUELTO', ...r.body } as EstadoDeLaDuda) : abierta(referenceCC, folio, dudaId))

/** `POST /mobile/venues/:venueId/cash-machine/doubts` — idempotente por folio. */
export async function subirDudaDeLaMaquina(
  venueId: string,
  autor: AutorDeLaMaquina,
  entrada: DudaDeLaMaquina,
  leerPedido: LectorDelPedido,
): Promise<EstadoDeLaDuda> {
  const { referenceCC } = entrada
  if (!CASH_MACHINE_REF.test(referenceCC)) {
    throw new BadRequestError('El folio de la máquina debe ser AQ seguido de 12 letras mayúsculas o números.')
  }
  const importes = { dueCents: entrada.dueCents, saleCents: entrada.saleCents, tipCents: entrada.tipCents }
  if (!Object.values(importes).every(n => Number.isInteger(n) && n >= 0) || importes.dueCents !== importes.saleCents + importes.tipCents) {
    throw new BadRequestError('El adeudo de la duda debe ser la venta más la propina, en centavos enteros.')
  }
  const deviceId = await aparatoDe(venueId, autor.deviceUid)
  // La MISMA puerta que la venta: sólo una credencial de esta PC; el emparejamiento del intento (r6-6).
  const { bindingId } = await exigirAparatoEmparejado(venueId, deviceId, autor.credencial, entrada.bindingId ?? null)
  const carritoRecibido = huellaDelCarritoCompleto(entrada.pedido)
  const observacion: Record<string, unknown> = {
    que: 'DUDA',
    origen: 'PC',
    deviceId,
    bindingId,
    ...importes,
    startedAt: entrada.startedAt,
    lastSeen: entrada.lastSeen ?? null,
    saleShiftId: entrada.saleShiftId ?? null,
    cartHash: carritoRecibido,
    userId: autor.userId,
    recibidoEn: new Date().toISOString(),
  }
  // Codex r1 #12 (decisión h): un adeudo de $0 o que no es múltiplo de $0.50 no lo cobra la máquina: 422 con incidencia.
  if (!adeudoCobrable(entrada.dueCents)) {
    const incidentId = await anotarImposible(venueId, referenceCC, { userId: autor.userId, deviceId }, observacion)
    throw new AppError(
      'El adeudo de esta duda no lo puede cobrar la máquina (debe ser mayor que $0 y múltiplo de $0.50). Quedó registrado para el gerente.',
      422,
      true,
      'CASH_MACHINE_CLOSE_IMPOSSIBLE',
      { incidentId },
    )
  }

  const r = await conElFolio(venueId, referenceCC, async (tx, l) => {
    const huella = huellaDeLaObservacion({ ...observacion, congelado: l.folio?.cartHash ?? carritoRecibido })
    const repetida = await yaObservada(tx, venueId, referenceCC, huella)
    const d = decidirSobreElFolio(l.estado, {
      que: 'DUDA',
      deviceId,
      importes,
      carritoRecibido,
      turnoRecibido: entrada.saleShiftId ?? null,
      revocadaEn: await revocacionDelVinculo(tx, venueId, l.folio ? l.folio.bindingId : bindingId),
    })
    const observada = await observar(tx, venueId, referenceCC, huella, repetida, observacion, l.folio)
    const nueva = observada.nueva
    const anotadas: IncidenciaAnotada[] = []
    let folio = observada.folio
    let dudaId = l.duda?.id ?? null
    let abrio = false
    if (d.accion === 'ABRIR_DUDA') {
      folio = await tx.cashMachineFolio.create({
        data: {
          venueId,
          referenceCC,
          deviceId,
          bindingId,
          pedido: entrada.pedido != null ? (entrada.pedido as Prisma.InputJsonValue) : Prisma.JsonNull,
          cartHash: carritoRecibido,
          saleShiftId: entrada.saleShiftId ?? null,
          ...importes,
        },
      })
      const guardada: DudaGuardada = { startedAt: entrada.startedAt, lastSeen: entrada.lastSeen ?? null, subidoPor: autor.userId }
      dudaId = (
        await tx.cashMachineIncident.create({
          data: {
            venueId,
            referenceCC,
            kind: 'ESPERANDO',
            status: 'ABIERTO',
            payload: guardada as unknown as Prisma.InputJsonValue,
            deviceId,
          },
          select: { id: true },
        })
      ).id
      abrio = true
      if (d.trasRevocar) await anotar(tx, venueId, referenceCC, deviceId, anotadas, 'TRAS_REVOCAR', observacion, nueva)
    } else if (nueva && l.duda && d.accion !== 'CONFLICTO') {
      // r3 #10: lo nuevo que vio la PC (el crédito que subió de $0 a $50) queda, sube la versión y la bandeja enseña lo último.
      const previa = (l.duda.payload ?? {}) as Record<string, unknown>
      await tx.cashMachineIncident.update({
        where: { id: l.duda.id },
        data: { payload: { ...previa, lastSeen: entrada.lastSeen ?? null } as Prisma.InputJsonValue },
      })
    }
    if (d.accion === 'CONFLICTO' || (d.accion === 'SEGUIR' && d.discrepancia)) {
      const motivo = d.accion === 'CONFLICTO' ? d.motivo : 'DISCREPANCIA'
      await anotar(tx, venueId, referenceCC, deviceId, anotadas, 'CONFLICTO', { ...observacion, motivo }, nueva)
    }
    return { d, l, anotadas, folio, dudaId, abrio }
  })
  await anotarEnBitacora(venueId, referenceCC, autor.userId, r.anotadas)
  if (r.abrio) {
    await logAction({
      action: 'CASH_MACHINE_DOUBT_OPENED',
      entity: 'CashMachineIncident',
      entityId: r.dudaId ?? undefined,
      venueId,
      staffId: autor.userId,
      data: { referenceCC, deviceId, duePesos: entrada.dueCents / 100, startedAt: entrada.startedAt },
    })
  }
  if (r.d.accion === 'CONFLICTO') {
    throw new ConflictError(
      'Esta duda de la máquina ya se subió con otros importes o desde otra PC. Quedó registrado para que el gerente lo revise.',
      'CASH_MACHINE_DOUBT_CONFLICT',
      {
        motivo: r.d.motivo,
        deviceId: r.l.folio?.deviceId ?? null,
        registrada:
          r.d.motivo === 'OTRA_PC' || !r.l.folio
            ? null
            : { dueCents: r.l.folio.dueCents, saleCents: r.l.folio.saleCents, tipCents: r.l.folio.tipCents },
        incidentId: r.anotadas.find(a => a.kind === 'CONFLICTO')?.id ?? null,
      },
    )
  }
  // El folio ya tiene su cierre: contesta ése. Tiene desenlace sin terminar: el reenvío lo reanuda. Si no, sigue abierta.
  if (r.l.cierre || r.l.estado.folio?.decision) {
    const t = await terminarElFolio(venueId, referenceCC, r.folio, r.l.cierre, leerPedido)
    return comoDuda(referenceCC, t, r.folio, r.dudaId)
  }
  return abierta(referenceCC, r.folio, r.dudaId)
}

/**
 * `GET /mobile/venues/:venueId/cash-machine/doubts/:referenceCC` — lo que la PC consulta cada 60 s (R5#6). Bajo el candado, nunca
 * escribe: RESUELTO con el acuse TERMINADO, o ABIERTO (con desenlace pendiente también: la PC reenvía su duda y eso lo reanuda).
 */
export async function consultarDudaDeLaMaquina(venueId: string, referenceCC: string): Promise<EstadoDeLaDuda> {
  const l = await conElFolio(venueId, referenceCC, async (_tx, lectura) => lectura)
  const d = decidirSobreElFolio(l.estado, { que: 'CONSULTA' })
  if (d.accion === 'TERMINADO' && l.cierre) {
    return comoDuda(
      referenceCC,
      await respuestaDelCierre(prisma, l.cierre, l.folio?.deviceId ?? l.cierre.deviceId),
      l.folio,
      l.duda?.id ?? null,
    )
  }
  if (!l.duda) throw new NotFoundError('Ese folio de la máquina no tiene una duda ni un cierre.', 'CASH_MACHINE_DOUBT_NOT_FOUND')
  return abierta(referenceCC, l.folio, l.duda.id)
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
 * `GET …/cash-machine/doubts` (POS del mostrador y DASHBOARD): acotada, más nuevas primero, con el total y el cursor. Trae TODAS las
 * incidencias de la máquina, cada una con su `kind`. Una duda trae lo congelado de su folio (importes, carrito, turno) y su `version`.
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
  // Lo congelado de las dudas de ESTA página (a lo más `limite` folios): una consulta acotada.
  const refsDeDudas = pagina.filter(f => f.kind === 'ESPERANDO').map(f => f.referenceCC)
  const folios = refsDeDudas.length
    ? await prisma.cashMachineFolio.findMany({
        where: { venueId, referenceCC: { in: refsDeDudas } },
        select: { referenceCC: true, dueCents: true, saleCents: true, tipCents: true, pedido: true, saleShiftId: true, version: true },
        take: refsDeDudas.length,
      })
    : []
  const folioDe = new Map(folios.map(f => [f.referenceCC, f]))
  return {
    data: pagina.map(({ payload, ...fila }) => {
      if (fila.kind !== 'ESPERANDO') {
        const p = (payload ?? {}) as EventosGuardados
        const eventos = Array.isArray(p.eventos) ? p.eventos : []
        return {
          ...fila,
          veces: p.veces ?? eventos.length,
          version: versionDeLaIncidencia(p),
          repetidas: p.repetidas ?? 0,
          primerEvento: eventos[0] ?? null,
          ultimoEvento: eventos.length > 1 ? eventos[eventos.length - 1] : null,
          revision: p.revision ?? null,
          revisiones: Array.isArray(p.revisiones) ? p.revisiones : [],
        }
      }
      const d = (payload ?? {}) as Partial<DudaGuardada>
      const f = folioDe.get(fila.referenceCC)
      return {
        ...fila,
        dueCents: f?.dueCents ?? null,
        saleCents: f?.saleCents ?? null,
        tipCents: f?.tipCents ?? null,
        startedAt: d.startedAt ?? null,
        lastSeen: d.lastSeen ?? null,
        pedido: f?.pedido ?? null,
        saleShiftId: f?.saleShiftId ?? null,
        version: f?.version ?? 1,
      }
    }),
    total,
    nextCursor: filas.length > limite && ultima ? cursorDe(ultima.createdAt, ultima.id) : null,
  }
}

/**
 * `POST …/cash-machine/incidents/:incidentId/review` (`cash-machine:resolve`, Codex r1 #7): el gerente da por revisada una incidencia
 * que NO es duda con una nota. No mueve dinero. Confirma la `version` de la evidencia que VIO (Codex r2 #8): si llegó evidencia nueva,
 * 409 `CASH_MACHINE_INCIDENT_CHANGED`. Bajo el candado del folio; repetirla con la misma versión no hace nada.
 */
export async function revisarIncidenciaDeLaMaquina(
  venueId: string,
  gerenteId: string,
  incidentId: string,
  nota: string,
  versionVista: number,
): Promise<{ id: string; referenceCC: string; kind: string; status: 'RESUELTO'; version: number }> {
  const fila = await prisma.cashMachineIncident.findFirst({ where: { id: incidentId, venueId }, select: { id: true, referenceCC: true } })
  if (!fila) throw new NotFoundError('Esa incidencia de la máquina no existe en este negocio.', 'CASH_MACHINE_INCIDENT_NOT_FOUND')
  const r = await conElFolio(venueId, fila.referenceCC, async tx => {
    const actual = await tx.cashMachineIncident.findFirst({
      where: { id: fila.id, venueId },
      select: { id: true, referenceCC: true, kind: true, status: true, payload: true },
    })
    if (!actual) throw new NotFoundError('Esa incidencia de la máquina no existe en este negocio.', 'CASH_MACHINE_INCIDENT_NOT_FOUND')
    const versionActual = versionDeLaIncidencia(actual.payload)
    if (actual.kind === 'ESPERANDO' || versionVista !== versionActual || actual.status !== 'ABIERTO') {
      return { actual, versionActual, revisada: false }
    }
    const ahora = new Date()
    const revision = { nota, staffId: gerenteId, en: ahora.toISOString(), version: versionActual }
    const previo = (actual.payload ?? {}) as Record<string, unknown>
    const { count } = await tx.cashMachineIncident.updateMany({
      where: { id: actual.id, venueId, status: 'ABIERTO' },
      data: {
        status: 'RESUELTO',
        resolvedByStaffId: gerenteId,
        resolvedAt: ahora,
        payload: {
          ...previo,
          revision,
          revisiones: [...(Array.isArray(previo.revisiones) ? previo.revisiones : []), revision],
        } as Prisma.InputJsonValue,
      },
    })
    return { actual, versionActual, revisada: count === 1 }
  })
  if (r.actual.kind === 'ESPERANDO') {
    throw new ConflictError(
      'Un cobro en duda se resuelve tecleando lo que dice la máquina, no se da por revisado.',
      'CASH_MACHINE_DOUBT_NEEDS_RESOLUTION',
    )
  }
  if (versionVista !== r.versionActual) {
    throw new ConflictError(
      'Llegó evidencia nueva de esta incidencia mientras la revisabas. Vuelve a leerla antes de darla por revisada.',
      'CASH_MACHINE_INCIDENT_CHANGED',
      { version: r.versionActual },
    )
  }
  // D4: la bitácora sólo de quien la cambió de ABIERTO a RESUELTO.
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
 * `POST …/cash-machine/doubts/:referenceCC/resolve` (`cash-machine:resolve`). El gerente es `gerenteId` (del token). Su declaración entra
 * por la MISMA escritura que el cierre de la PC (r6-2), con los importes congelados del folio y la `version` que vio (r6-4): primero se
 * guarda, después se lee el carrito congelado (con la autoridad de su sesión) y se termina.
 */
export async function resolverDudaDeLaMaquina(
  venueId: string,
  gerenteId: string,
  referenceCC: string,
  r: ResolucionDelGerente,
  leerPedido: LectorDelPedido,
): Promise<ResultadoDeLaMaquina> {
  const [duda, folio] = await Promise.all([
    prisma.cashMachineIncident.findUnique({
      where: { venueId_referenceCC_kind: { venueId, referenceCC, kind: 'ESPERANDO' } },
      select: { id: true },
    }),
    // Lo congelado no cambia una vez escrito: sus importes pueden leerse fuera del candado (la decisión se toma dentro).
    prisma.cashMachineFolio.findUnique({
      where: { venueId_referenceCC: { venueId, referenceCC } },
      select: { dueCents: true, saleCents: true, tipCents: true, saleShiftId: true },
    }),
  ])
  if (!duda || !folio) throw new NotFoundError('Ese folio de la máquina no tiene una duda.', 'CASH_MACHINE_DOUBT_NOT_FOUND')
  return recibirCierreDeLaMaquina(
    venueId,
    {
      origen: 'GERENTE',
      referenceCC,
      cierre: {
        outcome: r.outcome,
        dueCents: folio.dueCents,
        saleCents: folio.saleCents,
        tipCents: folio.tipCents,
        creditCents: r.creditCents,
        changeDispensedCents: r.changeDispensedCents,
        // R5#8: sólo la hora del comprobante; nunca `startedAt` ni la hora de la resolución.
        occurredAt: r.occurredAt ?? null,
        occurredAtKnown: Boolean(r.occurredAt),
        saleShiftId: folio.saleShiftId,
        // Codex r2 #10: el modo que el gerente VIO, nunca inferido del desenlace.
        cancelMode: r.cancelMode ?? null,
      },
      userId: gerenteId,
      evidence: r.evidence,
      versionVista: r.version,
    },
    leerPedido,
  )
}
