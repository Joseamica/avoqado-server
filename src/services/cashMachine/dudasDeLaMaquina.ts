/**
 * Máquina de efectivo QuickPay Mini · fase 1a · «Cobros en duda» (plan `2026-11-20-maquina-de-efectivo-fase-1a.md`, R4-4, R5#5, R5#6,
 * R5#8). La PC perdió el mensaje de cierre y NO sabe cómo terminó una operación: sube la duda (`CashMachineIncident` `ESPERANDO`) con
 * su carrito congelado y pregunta cada 60 s. Un GERENTE la resuelve con SU sesión (POS del mostrador o DASHBOARD, `cash-machine:resolve`),
 * tecleando lo que ve en la máquina. La resolución usa el MISMO núcleo que la venta de la PC (`registrarCierreDeLaMaquina`), con
 * `resolvedBy GERENTE` y el gerente del token; sin la hora del comprobante, la hora y el turno quedan por conciliar.
 */
import type { CashMachineIncident, Prisma } from '@prisma/client'

import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { withDeadlockRetry } from '../../utils/serializableRetry'
// El cursor `createdAt|id` opaco de la merma: la misma forma (orden `createdAt DESC, id DESC`), sin copiarlo.
import { decodeWasteCursor as leerCursor, encodeWasteCursor as cursorDe } from '../../schemas/mobile/inventoryWaste.mobile.schema'
import { logAction } from '../dashboard/activity-log.service'
import { candadoDeLaLlave } from '../mobile/pagarDespuesLlave'
import type { CreateOrderInput } from '../mobile/order.mobile.service'
import { aparatoDe, exigirAparatoEmparejado } from './emparejamiento'
import {
  CASH_MACHINE_REF,
  huellaDelCierre,
  registrarCierreDeLaMaquina,
  respuestaDe,
  type AutorDeLaMaquina,
  type CierreDeLaMaquina,
  type DesenlaceDeLaMaquina,
  type RespuestaDeLaMaquina,
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
  | { status: 'RESUELTO'; referenceCC: string; incident: 'NO_SE_PUDO_REGISTRAR' }

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

/** El estado que ve la PC: el cierre manda; sin cierre, la duda (abierta, o cerrada porque la venta ya no se pudo armar). */
function estadoDe(referenceCC: string, duda: Pick<CashMachineIncident, 'status'>): EstadoDeLaDuda {
  if (duda.status === 'ABIERTO') return { status: 'ABIERTO', referenceCC }
  return { status: 'RESUELTO', referenceCC, incident: 'NO_SE_PUDO_REGISTRAR' }
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
  // La MISMA puerta que la venta: sólo la PC emparejada abre una duda; la revocada sólo repite la suya.
  await exigirAparatoEmparejado(venueId, referenceCC, deviceId, autor.credencial)

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
  // Bajo el candado del folio (el de la venta y su cierre): la duda nunca nace después de que el folio ya se cerró.
  const r = await withDeadlockRetry(
    async tx => {
      await tx.$queryRaw(candadoDeLaLlave(venueId, `maquina-${referenceCC}`))
      const cierre = await tx.cashMachineClose.findUnique({ where: { venueId_referenceCC: { venueId, referenceCC } } })
      if (cierre) return { cierre }
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
  if (r.cierre) return { status: 'RESUELTO', ...respuestaDe(r.cierre) }

  const guardada = leerDuda(r.duda)
  if (guardada.dueCents !== entrada.dueCents || guardada.saleCents !== entrada.saleCents || guardada.tipCents !== entrada.tipCents) {
    throw new ConflictError('Esta duda de la máquina ya se subió con otros importes.', 'CASH_MACHINE_DOUBT_CONFLICT', {
      registrada: { dueCents: guardada.dueCents, saleCents: guardada.saleCents, tipCents: guardada.tipCents },
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
  return estadoDe(referenceCC, r.duda)
}

/** `GET /mobile/venues/:venueId/cash-machine/doubts/:referenceCC` — lo que la PC consulta cada 60 s (R5#6). */
export async function consultarDudaDeLaMaquina(venueId: string, referenceCC: string): Promise<EstadoDeLaDuda> {
  const cierre = await cierreDelFolio(venueId, referenceCC)
  if (cierre) return { status: 'RESUELTO', ...respuestaDe(cierre) }
  const duda = await prisma.cashMachineIncident.findUnique({
    where: dondeLaDuda(venueId, referenceCC),
    select: { status: true },
  })
  if (!duda) throw new NotFoundError('Ese folio de la máquina no tiene una duda ni un cierre.', 'CASH_MACHINE_DOUBT_NOT_FOUND')
  return estadoDe(referenceCC, duda)
}

/** `GET …/cash-machine/doubts` (POS del mostrador y DASHBOARD): acotada, más nuevas primero, con el total y el cursor. */
export async function listarDudasDeLaMaquina(
  venueId: string,
  q: { status?: 'ABIERTO' | 'RESUELTO'; cursor?: string; limit?: number },
): Promise<{ data: Array<Record<string, unknown>>; total: number; nextCursor: string | null }> {
  const limite = Math.min(Math.max(Math.trunc(q.limit ?? LIMITE_POR_OMISION), 1), LIMITE_MAXIMO)
  const despues = q.cursor === undefined ? null : leerCursor(q.cursor)
  if (q.cursor !== undefined && !despues) throw new BadRequestError('El cursor no es válido.')
  const where = { venueId, kind: 'ESPERANDO', status: q.status ?? 'ABIERTO' }
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
  }

  // Ya se cerró sin cierre (la venta no se pudo armar): se compara con lo que se resolvió, sin volver a armarla.
  if (!estabaAbierta && !(await cierreDelFolio(venueId, referenceCC))) {
    if (duda.resolucion?.huella === huellaDelCierre(venueId, referenceCC, cierre, 'GERENTE')) {
      return { status: 202, body: { referenceCC, incident: 'NO_SE_PUDO_REGISTRAR' } }
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
