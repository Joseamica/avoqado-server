/**
 * «Mis reservas de clase» (`GET /public/venues/:venueSlug/customer/class-reservations`): las clases que la clienta del token ya
 * reservó en ese negocio, en la MISMA ventana de fechas que el horario público (`leerRangoDelHorario`, con las `dateFrom`/`dateTo`
 * que el widget ya manda al horario). El widget la usa para marcar «Reservada» en el horario y, tras un error de red al confirmar,
 * para revisar si la reserva sí quedó (compara los `confirmationCode` de una `classSessionId` antes y después del intento).
 *
 * Es una LECTURA de la propia clienta: no escribe `ActivityLog` y no es una capacidad del operador (no lleva herramienta del MCP).
 * Acotada: páginas de 100 que impone el servidor, orden `(inicio de la clase, id)`, `total` real y ventana de 60 días a lo más.
 */
import type { Prisma, ReservationStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { BadRequestError } from '@/errors/AppError'
import type { CustomerAuthContext } from '@/middlewares/customerAuth.middleware'
import { LUGAR_DEL_PASE } from '@/services/credits/ilimitado'
import { fromActiveCursor, toActiveCursor } from '@/services/online-ordering/inbox.service'
import { filtroDeReservasDeLaClienta } from '@/services/public/customerPortal.public.service'
import { DIAS_TOPE, leerRangoDelHorario, type MotivoDeRangoInvalido } from '@/services/reservation/rangoDelHorario'

/** El servidor impone el tamaño de la página; la petición no lo elige. */
export const PAGINA_DE_RESERVAS_DE_CLASE = 100
/** Lo que el horario marca como «Reservada»: la reserva viva. Terminadas, «No asistió» y canceladas no. */
const ESTADOS_RESERVADA: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'CHECKED_IN']
/**
 * Tope de clases con su Ilimitado en la ventana. El pase cubre UN lugar por clase (`CREDIT_UNLIMITED_SAME_CLASS`) y la ventana es de
 * 61 días a lo más: 1,000 son ~16 clases diarias de una sola clienta. Llegar ahí es un dato anómalo y queda en el log.
 */
const TOPE_DE_CLASES_CON_ILIMITADO = 1000

const MENSAJE_DE_RANGO: Record<MotivoDeRangoInvalido, string> = {
  FORMATO_DESDE: 'La fecha de inicio debe tener el formato AAAA-MM-DD.',
  FECHA_DESDE: 'La fecha de inicio no es una fecha válida.',
  FORMATO_HASTA: 'La fecha final debe tener el formato AAAA-MM-DD.',
  FECHA_HASTA: 'La fecha final no es una fecha válida.',
  HASTA_ANTES_DE_DESDE: 'La fecha final no puede ser anterior a la fecha de inicio.',
}

export interface MiReservaDeClase {
  classSessionId: string
  spotIds: string[]
  confirmationCode: string
  cancelSecret: string
  /** El inicio de la CLASE (el mismo que muestra el horario), no la copia guardada en la reserva. */
  startsAt: string
  status: 'PENDING' | 'CONFIRMED' | 'CHECKED_IN'
  depositStatus: string | null
  /** La reserva se pagó con un saldo Ilimitado. */
  usedUnlimited: boolean
}

export interface MisReservasDeClase {
  reservations: MiReservaDeClase[]
  total: number
  nextCursor: string | null
  /** Las clases del rango donde ya usó su Ilimitado (también terminadas o «No asistió»): no se marcan como reservadas. */
  unlimitedUsedSessionIds: string[]
}

export interface PedirMisReservasDeClase {
  dateFrom: string
  dateTo?: string
  cursor?: string
}

const VACIO: MisReservasDeClase = { reservations: [], total: 0, nextCursor: null, unlimitedUsedSessionIds: [] }

export async function listarMisReservasDeClase(
  venueId: string,
  auth: Pick<CustomerAuthContext, 'customerId' | 'contactos'>,
  pedir: PedirMisReservasDeClase,
): Promise<MisReservasDeClase> {
  const rango = leerRangoDelHorario(pedir.dateFrom, pedir.dateTo)
  if (!rango.ok) throw new BadRequestError(MENSAJE_DE_RANGO[rango.motivo], 'INVALID_DATE_RANGE')
  if (rango.pasaDelTope) {
    throw new BadRequestError(`El rango de fechas no puede pasar de ${DIAS_TOPE} días.`, 'DATE_RANGE_TOO_LONG')
  }
  // Mal formado ⇒ 400 «Cursor inválido» (`INVALID_CURSOR`). Mismo formato que las listas de «Mi cuenta»: «<fecha ISO>_<id>».
  const despues = pedir.cursor ? fromActiveCursor(pedir.cursor) : null

  const customer = await prisma.customer.findFirst({ where: { id: auth.customerId, venueId }, select: { id: true, phone: true } })
  if (!customer) return { ...VACIO }

  // La ventana es la del horario y se mide sobre la CLASE: si el negocio la movió de hora, su reserva conserva la hora vieja.
  const clasesDelRango: Prisma.ClassSessionWhereInput = { venueId, startsAt: { gte: rango.desde, lte: rango.hasta } }
  const suyas: Prisma.ReservationWhereInput = {
    venueId,
    status: { in: ESTADOS_RESERVADA },
    classSession: { is: clasesDelRango },
    AND: [filtroDeReservasDeLaClienta(customer, auth.contactos)],
  }
  // Orden (inicio de la clase, id): la página sigue DESPUÉS de la última fila de la anterior.
  const pagina: Prisma.ReservationWhereInput = despues
    ? {
        AND: [
          suyas,
          {
            OR: [
              { classSession: { is: { startsAt: { gt: despues.createdAt } } } },
              { classSession: { is: { startsAt: despues.createdAt } }, id: { gt: despues.id } },
            ],
          },
        ],
      }
    : suyas

  const [filas, total] = await Promise.all([
    prisma.reservation.findMany({
      where: pagina,
      orderBy: [{ classSession: { startsAt: 'asc' } }, { id: 'asc' }],
      take: PAGINA_DE_RESERVAS_DE_CLASE + 1,
      select: {
        id: true,
        classSessionId: true,
        spotIds: true,
        confirmationCode: true,
        cancelSecret: true,
        status: true,
        depositStatus: true,
        classSession: { select: { startsAt: true } },
        // Igual que `pasesDeLaReserva`: un canje de un saldo Ilimitado sobre esta reserva.
        creditTransactions: { where: { venueId, type: 'REDEEM', creditItemBalance: { unlimited: true } }, select: { id: true }, take: 1 },
      },
    }),
    prisma.reservation.count({ where: suyas }),
  ])

  // Igual que `revisarPase` (CREDIT_UNLIMITED_SAME_CLASS): su canje de un Ilimitado sobre una reserva que ocupa el lugar del pase.
  const conIlimitado = await prisma.creditTransaction.findMany({
    where: {
      venueId,
      type: 'REDEEM',
      customerId: customer.id,
      creditItemBalance: { unlimited: true },
      reservation: { is: { venueId, status: { in: LUGAR_DEL_PASE }, classSession: { is: clasesDelRango } } },
    },
    select: { reservation: { select: { classSessionId: true } } },
    take: TOPE_DE_CLASES_CON_ILIMITADO,
  })
  if (conIlimitado.length >= TOPE_DE_CLASES_CON_ILIMITADO) {
    logger.warn('[MisReservasDeClase] se llegó al tope de clases con Ilimitado en la ventana', {
      venueId,
      customerId: customer.id,
      tope: TOPE_DE_CLASES_CON_ILIMITADO,
    })
  }
  const unlimitedUsedSessionIds = [
    ...new Set(conIlimitado.flatMap(c => (c.reservation?.classSessionId ? [c.reservation.classSessionId] : []))),
  ]

  const enPagina = filas.slice(0, PAGINA_DE_RESERVAS_DE_CLASE)
  const ultima = enPagina[enPagina.length - 1]
  return {
    reservations: enPagina.map(r => ({
      classSessionId: r.classSessionId!,
      spotIds: r.spotIds,
      confirmationCode: r.confirmationCode,
      cancelSecret: r.cancelSecret,
      startsAt: r.classSession!.startsAt.toISOString(),
      status: r.status as MiReservaDeClase['status'],
      depositStatus: r.depositStatus ?? null,
      usedUnlimited: r.creditTransactions.length > 0,
    })),
    total,
    nextCursor:
      filas.length > PAGINA_DE_RESERVAS_DE_CLASE && ultima
        ? toActiveCursor({ createdAt: ultima.classSession!.startsAt, id: ultima.id })
        : null,
    unlimitedUsedSessionIds,
  }
}
