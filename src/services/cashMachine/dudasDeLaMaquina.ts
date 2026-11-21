/**
 * Máquina de efectivo QuickPay Mini · fase 1a · «Cobros en duda» (plan `2026-11-20-maquina-de-efectivo-fase-1a.md`, R4-4, R5#5, R5#6,
 * R5#8 y el rediseño tras la ronda 3 de Codex). La PC perdió el mensaje de cierre y NO sabe cómo terminó una operación: sube la duda
 * (`CashMachineIncident` `ESPERANDO`), que congela el folio si es su primer mensaje (`CashMachineFolio`: carrito, turno, reparto,
 * dueño). Una duda NUNCA se vuelve desenlace (r6-2): sólo un cierre de la PC o lo que declara un GERENTE con SU sesión. La resolución
 * entra por la MISMA escritura que el cierre de la PC (`recibirCierreDeLaMaquina`), con la `version` que vio el gerente (r6-4).
 *
 * Recorte R2 (founder «a», 21-nov): las dudas se resuelven SÓLO desde el panel (`/dashboard/...`, también en el celular). La PC sube su
 * duda y la consulta; las rutas móviles de listar, resolver y revisar ya no existen.
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
  RECIBIDO_ATASCADO_MS,
  anotar,
  centavosGuardables,
  anotarEnBitacora,
  conElFolio,
  congelarElFolio,
  huellaDelCarritoCompleto,
  instante,
  numeroQueLlego,
  observar,
  recibirCierreDeLaMaquina,
  respuestaDelCierre,
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

/**
 * Lo que la PC sabe de la operación en duda, en CENTAVOS (como la venta). H3/H4 (Codex servidor r5): la ruta sólo exige el folio, la
 * credencial y el adeudo como número legible; lo demás se lee aquí DESPUÉS de guardar la evidencia y lo que no sirve cuenta como
 * desconocido (nunca un 400 que pierda la duda).
 */
export interface DudaDeLaMaquina {
  referenceCC: string
  /** Lo físico: el adeudo. Si la máquina lo puede cobrar lo decide el servicio (422 con incidencia). */
  dueCents: number
  /** El reparto venta/propina (administrativo): lo que no llegó como número queda en null. */
  saleCents?: unknown
  tipCents?: unknown
  /** El carrito congelado, el MISMO JSON de la venta (`POST /orders`). Ilegible o ausente no es 400 (r6-2). */
  pedido?: unknown
  /** Cuándo empezó el cobro (ISO). Nunca se usa como la hora de la venta (R5#8). La que no es hora queda en null. */
  startedAt?: unknown
  /** Lo último que vio la PC de la máquina (texto libre para el gerente). Lo que pase de 16 KB se corta, no se rechaza. */
  lastSeen?: unknown
  /** H1 (Codex servidor r5, opcional): lo que la PC vio entrar, en centavos enteros. La bandeja enseña el MAYOR visto del folio. */
  creditCents?: unknown
  saleShiftId?: unknown
}

/** Lo que se guarda en la duda (lo demás vive congelado en el folio, también lo MÁS que vio entrar: `maxCreditCents`). */
interface DudaGuardada {
  startedAt: string | null
  /** Lo último que vio la PC dueña (un reenvío tardío con menos crédito que el ya visto no lo tapa), cortado a 16 KB para la bandeja. */
  lastSeen: unknown
  /** El vendedor por omisión del carrito congelado. */
  subidoPor: string
}

/**
 * ponytail: 16 KB de «lo último que vio la PC» bastan para que el gerente lo lea en la bandeja; lo que sobra se corta (H4: nunca un
 * 400). La observación guarda el mensaje COMPLETO y su huella se calcula sobre él (r6 #9).
 */
const LAST_SEEN_MAX = 16_384
function loUltimoQueVio(v: unknown): unknown {
  if (v === undefined || v === null) return null
  const texto = JSON.stringify(v)
  return texto.length <= LAST_SEEN_MAX ? v : texto.slice(0, LAST_SEEN_MAX)
}

export type EstadoDeLaDuda =
  /** `incidentId`: la duda (ESPERANDO). `version`: la que manda el gerente al resolverla (r6-4). */
  | { status: 'ABIERTO'; ack: 'RECIBIDO'; referenceCC: string; deviceId: string | null; incidentId: string | null; version: number }
  | ({ status: 'RESUELTO' } & RespuestaDeLaMaquina)
  | ({ status: 'RESUELTO' } & RespuestaSinRegistro)

/** Lo que el gerente teclea al ver la máquina. El gerente sale del token; los importes, del folio congelado. */
export interface ResolucionDelGerente {
  /**
   * Lo que el gerente leyó en la máquina, obligatorio para una duda SIN desenlace. H5 (Codex servidor r5): un folio «pendiente de
   * terminar» (su desenlace ya está guardado) se termina SÓLO con la `version`, desde lo congelado.
   */
  outcome?: DesenlaceDeLaMaquina
  creditCents?: number
  changeDispensedCents?: number
  /** La hora impresa en el comprobante de la máquina (ISO). Sin ella → hora y turno por conciliar (R5#8). */
  occurredAt?: string | null
  /** Lo que leyó en la máquina. */
  evidence?: string
  /** Codex r2 #10: lo que VIO hacer a la máquina con los billetes de un CANCELADO/GUARDADO. Pasa por el MISMO validador. */
  cancelMode?: '1' | '2' | null
  /** r6-4: la versión de la evidencia que vio (la de la lista). Si llegó otra, 409 y no se escribe nada. */
  version: number
}

const LIMITE_POR_OMISION = 50
const LIMITE_MAXIMO = 100
/** Lo que mueve dinero no se «da por revisado»: la duda se resuelve y el pendiente de terminar se termina. */
const SE_TERMINAN = new Set(['ESPERANDO', 'POR_TERMINAR'])

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
  // H3/H4: el reparto, la hora de inicio, el turno y lo que vio la PC se leen aquí; lo que no sirve cuenta como desconocido.
  const importes = { dueCents: entrada.dueCents, saleCents: numeroQueLlego(entrada.saleCents), tipCents: numeroQueLlego(entrada.tipCents) }
  const startedAt =
    typeof entrada.startedAt === 'string' && !Number.isNaN(Date.parse(entrada.startedAt)) ? instante(entrada.startedAt) : null
  const saleShiftId = typeof entrada.saleShiftId === 'string' && entrada.saleShiftId.length <= 64 ? entrada.saleShiftId : null
  const lastSeen = loUltimoQueVio(entrada.lastSeen)
  const credito = typeof entrada.creditCents === 'number' && centavosGuardables(entrada.creditCents) ? entrada.creditCents : null
  const deviceId = await aparatoDe(venueId, autor.deviceUid)
  // La MISMA puerta que la venta: sólo una credencial de esta PC. Recorte R1: si ya la revocaron, la duda queda TRAS_REVOCAR.
  const { bindingId, revocada } = await exigirAparatoEmparejado(venueId, deviceId, autor.credencial)
  const carritoRecibido = huellaDelCarritoCompleto(entrada.pedido)
  // Codex r1 #12 (decisión h): un adeudo de $0 o que no es múltiplo de $0.50 no lo cobra la máquina: 422 con incidencia. F4 y H4: el
  // reparto venta/propina descuadrado, con fracción de centavo o sin número NO es imposible (la máquina sólo conoce el adeudo): la duda se
  // guarda ABIERTA con su evidencia y el gerente la resuelve (sin venta: `REPARTO_DESCUADRADO`).
  const imposible = !adeudoCobrable(entrada.dueCents)
  const observacion: Record<string, unknown> = {
    que: 'DUDA',
    origen: 'PC',
    deviceId,
    bindingId,
    ...importes,
    // F13: la misma hora en otra zona es la MISMA evidencia.
    startedAt,
    // r6 #9: el mensaje y lo que vio entrar TAL CUAL llegaron (sin cortar ni descartar), para la huella y el historial.
    lastSeen: entrada.lastSeen ?? null,
    saleShiftId,
    creditCents: entrada.creditCents ?? null,
    cartHash: carritoRecibido,
    ...(imposible ? { imposible: true } : {}),
    userId: autor.userId,
    recibidoEn: new Date().toISOString(),
  }

  const r = await conElFolio(venueId, referenceCC, async (tx, l) => {
    const huella = huellaDeLaObservacion({ ...observacion, congelado: l.folio?.cartHash ?? carritoRecibido })
    const repetida = await yaObservada(tx, venueId, referenceCC, huella)
    const d = decidirSobreElFolio(l.estado, {
      que: 'DUDA',
      deviceId,
      importes,
      carritoRecibido,
      turnoRecibido: saleShiftId,
      revocada,
      imposible,
    })
    // r6 #4: lo de OTRA PC se guarda (y va a su conflicto), pero no toca el folio ni la duda de la dueña.
    const otraPc = d.accion === 'CONFLICTO' && d.motivo === 'OTRA_PC'
    const observada = await observar(tx, venueId, referenceCC, huella, repetida, observacion, l.folio, { subeVersion: !otraPc, credito })
    const nueva = observada.nueva
    // H1 y r6 #1: lo MÁS que entró vive en el folio (`observar`); aquí sólo lo último que vio la PC dueña, salvo que diga MENOS de lo ya
    // visto (un reenvío tardío). En la misma transacción que sube la versión.
    const menos = credito !== null && credito < (l.folio?.maxCreditCents ?? -1)
    if (nueva && !otraPc && !menos && entrada.lastSeen != null && l.duda?.status === 'ABIERTO') {
      await tx.cashMachineIncident.update({
        where: { id: l.duda.id },
        data: { payload: { ...((l.duda.payload ?? {}) as object), lastSeen } as Prisma.InputJsonValue },
      })
    }
    const anotadas: IncidenciaAnotada[] = []
    let folio = observada.folio
    let dudaId = l.duda?.id ?? null
    let abrio = false
    const loQueSeCongela = {
      deviceId,
      bindingId,
      pedido: entrada.pedido,
      cartHash: carritoRecibido,
      saleShiftId,
      ...importes,
      maxCreditCents: credito,
    }
    if (d.accion === 'IMPOSIBLE') {
      // F12: aunque sea imposible, el primer mensaje congela el folio; lo que llegue después no lo sustituye.
      if (!folio) folio = await congelarElFolio(tx, venueId, referenceCC, loQueSeCongela)
      await anotar(tx, venueId, referenceCC, deviceId, anotadas, 'IMPOSIBLE', { duda: importes, ...observacion }, nueva)
      return { d, l, anotadas, folio, dudaId, abrio }
    }
    if (d.accion === 'ABRIR_DUDA') {
      // H2: sobre un folio que ya congeló un cierre imposible, la duda se abre sin volver a congelar (lo primero manda).
      if (!folio) folio = await congelarElFolio(tx, venueId, referenceCC, loQueSeCongela)
      const guardada: DudaGuardada = { startedAt, lastSeen, subidoPor: autor.userId }
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
    }
    // F6: evidencia física NUEVA de un folio que ya tiene desenlace (los $50 que llegan después de un CANCELADO en $0) vuelve a
    // revisión, sin tocar lo ya asentado.
    const motivo =
      d.accion === 'CONFLICTO'
        ? d.motivo
        : (d.accion === 'SEGUIR' || d.accion === 'ABRIR_DUDA') && d.discrepancia
          ? 'DISCREPANCIA'
          : d.accion === 'SEGUIR' && nueva && l.estado.folio?.decision
            ? 'TRAS_RESOLVER'
            : null
    if (motivo) await anotar(tx, venueId, referenceCC, deviceId, anotadas, 'CONFLICTO', { ...observacion, motivo }, nueva)
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
      data: { referenceCC, deviceId, duePesos: entrada.dueCents / 100, startedAt },
    })
  }
  if (r.d.accion === 'IMPOSIBLE') {
    throw new AppError(
      'El adeudo de esta duda no lo puede cobrar la máquina (debe ser mayor que $0 y múltiplo de $0.50). Quedó registrado para el gerente.',
      422,
      true,
      'CASH_MACHINE_CLOSE_IMPOSSIBLE',
      { incidentId: r.anotadas.find(a => a.kind === 'IMPOSIBLE')?.id ?? null },
    )
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
  // r6 #6: un ABIERTO siempre trae la incidencia que el GET encuentra: la duda o, sin duda, el «pendiente de terminar» del desenlace.
  if (r.l.cierre || r.l.estado.folio?.decision) {
    const t = await terminarElFolio(venueId, referenceCC, r.folio, r.l.cierre, leerPedido)
    return comoDuda(referenceCC, t, r.folio, r.dudaId ?? r.l.porTerminar?.id ?? null)
  }
  return abierta(referenceCC, r.folio, r.dudaId)
}

/**
 * `GET /mobile/venues/:venueId/cash-machine/doubts/:referenceCC` — lo que la PC consulta cada 60 s (R5#6). Bajo el candado, nunca
 * escribe: RESUELTO con el acuse TERMINADO, o ABIERTO con su duda o (r6 #6) con el desenlace RECIBIDO y su «pendiente de terminar»:
 * lo que el POST contestó ABIERTO, el GET lo encuentra.
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
  const incidentId = l.duda?.id ?? (d.accion === 'RECIBIDO' ? (l.porTerminar?.id ?? null) : null)
  if (!incidentId) throw new NotFoundError('Ese folio de la máquina no tiene una duda ni un cierre.', 'CASH_MACHINE_DOUBT_NOT_FOUND')
  return abierta(referenceCC, l.folio, incidentId)
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
 * `GET /dashboard/…/cash-machine/doubts` (el panel, recorte R2): acotada, más nuevas primero, con el total y el cursor. Trae TODAS las
 * incidencias de la máquina, cada una con su `kind`. Una duda trae lo congelado de su folio (importes, carrito, turno), su `version`,
 * `creditCents` = lo MÁS que la PC dueña vio entrar en cualquier mensaje del folio (r6 #1) y `lastSeen`. Un `POR_TERMINAR` trae lo
 * congelado, el desenlace ya guardado (`outcome`, `creditCents`, `changeDispensedCents`, `occurredAt`) y la `version` con la que el
 * gerente lo termina; entre las ABIERTAS sale cuando lleva `RECIBIDO_ATASCADO_MS` sin terminar (recorte R1), aunque su PC siga activa.
 */
export async function listarDudasDeLaMaquina(
  venueId: string,
  q: { status?: 'ABIERTO' | 'RESUELTO'; kind?: string; folio?: string; cursor?: string; limit?: number },
): Promise<{ data: Array<Record<string, unknown>>; total: number; nextCursor: string | null }> {
  const limite = Math.min(Math.max(Math.trunc(q.limit ?? LIMITE_POR_OMISION), 1), LIMITE_MAXIMO)
  const despues = q.cursor === undefined ? null : leerCursor(q.cursor)
  if (q.cursor !== undefined && !despues) throw new BadRequestError('El cursor no es válido.')
  const folio = q.folio?.trim().toUpperCase()
  const status = q.status ?? 'ABIERTO'
  const where: Prisma.CashMachineIncidentWhereInput = {
    venueId,
    status,
    ...(q.kind ? { kind: q.kind } : {}),
    ...(folio ? { referenceCC: { contains: folio } } : {}),
    // Recorte R1: un RECIBIDO recién nacido lo termina su PC sola; a los 10 min ya es del gerente.
    ...(status === 'ABIERTO' ? { NOT: { kind: 'POR_TERMINAR', createdAt: { gt: new Date(Date.now() - RECIBIDO_ATASCADO_MS) } } } : {}),
  }
  // F5 (Codex servidor r4): la evidencia (la duda y su `lastSeen`) y la `version` del folio salen de la MISMA foto de Postgres
  // (`RepeatableRead`, el mismo cliente de transacción). Con dos lecturas sueltas, los $50 que entraban entre ellas se entregaban como
  // «$0, versión 2» y el gerente firmaba una versión que nunca vio.
  const { total, filas, folios } = await prisma.$transaction(
    async tx => {
      const total = await tx.cashMachineIncident.count({ where })
      const filas = await tx.cashMachineIncident.findMany({
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
      })
      // Lo congelado de las dudas y de los pendientes de terminar de ESTA página (a lo más `limite` folios): una consulta acotada.
      const refsDeDudas = [
        ...new Set(
          filas
            .slice(0, limite)
            .filter(f => f.kind === 'ESPERANDO' || f.kind === 'POR_TERMINAR')
            .map(f => f.referenceCC),
        ),
      ]
      const folios = refsDeDudas.length
        ? await tx.cashMachineFolio.findMany({
            where: { venueId, referenceCC: { in: refsDeDudas } },
            select: {
              referenceCC: true,
              dueCents: true,
              saleCents: true,
              tipCents: true,
              pedido: true,
              saleShiftId: true,
              version: true,
              decision: true,
              maxCreditCents: true,
            },
            take: refsDeDudas.length,
          })
        : []
      return { total, filas, folios }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  )
  const pagina = filas.slice(0, limite)
  const ultima = pagina[pagina.length - 1]
  const folioDe = new Map(folios.map(f => [f.referenceCC, f]))
  return {
    data: pagina.map(({ payload, ...fila }) => {
      if (fila.kind === 'POR_TERMINAR') {
        const f = folioDe.get(fila.referenceCC)
        const c = (f?.decision as { cierre?: Record<string, unknown> } | null)?.cierre ?? {}
        return {
          ...fila,
          dueCents: f?.dueCents ?? null,
          saleCents: f?.saleCents ?? null,
          tipCents: f?.tipCents ?? null,
          pedido: f?.pedido ?? null,
          saleShiftId: f?.saleShiftId ?? null,
          outcome: c.outcome ?? null,
          creditCents: c.creditCents ?? null,
          changeDispensedCents: c.changeDispensedCents ?? null,
          occurredAt: c.occurredAt ?? null,
          version: f?.version ?? 1,
        }
      }
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
        creditCents: f?.maxCreditCents ?? null,
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
    if (SE_TERMINAN.has(actual.kind) || versionVista !== versionActual || actual.status !== 'ABIERTO') {
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
  if (SE_TERMINAN.has(r.actual.kind)) {
    throw new ConflictError(
      r.actual.kind === 'ESPERANDO'
        ? 'Un cobro en duda se resuelve tecleando lo que dice la máquina, no se da por revisado.'
        : 'Un folio pendiente de terminar se termina con «Resolver», no se da por revisado.',
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
 *
 * H5 y recorte R1: un folio que YA tiene su desenlace guardado y no se terminó (RECIBIDO; en la bandeja como `POR_TERMINAR` a
 * los 10 min) se termina sólo con la `version`, sin teclear importes: desde lo congelado, con
 * exactamente un pago. La PC nueva sigue recibiendo 409 `OTRA_PC` por ese folio.
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
      select: { dueCents: true, saleCents: true, tipCents: true, saleShiftId: true, decision: true },
    }),
  ])
  const sinImportes = r.outcome == null && r.creditCents == null && r.changeDispensedCents == null
  if (folio?.decision && sinImportes) return terminarDesdeLoCongelado(venueId, gerenteId, referenceCC, r.version, leerPedido)
  if (!folio || (!duda && !folio.decision)) {
    throw new NotFoundError('Ese folio de la máquina no tiene una duda.', 'CASH_MACHINE_DOUBT_NOT_FOUND')
  }
  if (r.outcome == null || r.creditCents == null || r.changeDispensedCents == null || !r.evidence) {
    throw new BadRequestError(
      'Para resolver un cobro en duda escribe el desenlace, lo que entró, el cambio entregado y lo que viste en la máquina.',
      'CASH_MACHINE_DOUBT_RESOLUTION_INCOMPLETE',
    )
  }
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

/**
 * H5: el gerente TERMINA un folio con desenlace guardado desde lo congelado, con la versión que vio. Si otra petición ya lo terminó,
 * contesta ese cierre (y cierra el «pendiente de terminar» que hubiera quedado). Exactamente un pago: el mismo escritor de siempre, con
 * sus llaves únicas, bajo el candado del folio.
 */
async function terminarDesdeLoCongelado(
  venueId: string,
  gerenteId: string,
  referenceCC: string,
  versionVista: number,
  leerPedido: LectorDelPedido,
): Promise<ResultadoDeLaMaquina> {
  const l = await conElFolio(venueId, referenceCC, async (tx, lectura) => {
    if (lectura.cierre) {
      await tx.cashMachineIncident.updateMany({
        where: { venueId, referenceCC, kind: 'POR_TERMINAR', status: 'ABIERTO' },
        data: { status: 'RESUELTO', resolvedByStaffId: gerenteId, resolvedAt: new Date() },
      })
    }
    return lectura
  })
  if (!l.folio?.decision) throw new NotFoundError('Ese folio de la máquina no tiene una duda.', 'CASH_MACHINE_DOUBT_NOT_FOUND')
  if (l.cierre) return respuestaDelCierre(prisma, l.cierre, l.folio.deviceId)
  // r6 #2: la `version` se vuelve a comparar bajo el candado, en la MISMA transacción que escribe el cierre (`terminarElFolio`): lo que
  // entre entre esta lectura y la escritura deja 409 sin nada escrito.
  return terminarElFolio(venueId, referenceCC, l.folio, null, leerPedido, { id: gerenteId, versionVista })
}
