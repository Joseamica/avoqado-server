import type { PrismaClient } from '@prisma/client'
import { Prisma, ShiftStatus } from '@prisma/client'

import logger from '../../config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { publishCommand } from '../../communication/rabbitmq/publisher'
import { logAction } from '../dashboard/activity-log.service'
import { AUTO_CLOSED_BY_NAME, businessDayStart } from './cashDrawerAutoClose'

/** Acepta el cliente de Prisma o un `tx`: los sitios que atan dinero llaman desde ambos. */
export type ShiftReader = Pick<PrismaClient, 'shift'> | Pick<Prisma.TransactionClient, 'shift'>

/**
 * El turno de caja es del NEGOCIO, no de la persona (decisión del founder, 2-sep-2026).
 *
 * Antes cada cobro buscaba «el turno abierto de QUIEN cobra» (`{ venueId, staffId, OPEN }`),
 * y el selector «Vendedor» de Cobrar cambia ese `staffId` en cada cobro: quien no había
 * abierto turno cobraba FUERA de todo turno, sin aviso. Testarudo, 1-sep-2026: 78 de 92
 * cobros ($10,337 de $12,002) sin turno; el dashboard decía $1,772.
 *
 * `openShiftForVenue` ya obliga a UN turno abierto por venue, así que «el abierto del
 * negocio» es único. Quién vendió sigue viviendo en `Payment.processedById`.
 *
 * 🔴 Es el ÚNICO sitio que resuelve el turno abierto para atar dinero, y
 * `tests/unit/services/shared/turnoDeCaja.guard.test.ts` es la prueba estática que falla si
 * alguien vuelve a filtrar por `staffId` en los 8 sitios que antes lo hacían (7 archivos):
 *
 *   1. `tpv/payment.tpv.service.ts`      → `recordOrderPayment` y `recordFastPayment` (2)
 *   2. `tpv/refund.tpv.service.ts`       → `recordRefund`
 *   3. `tpv/order.tpv.service.ts`        → `createOrderWithItems` (dentro de `tx`)
 *   4. `dashboard/manualPayment.service.ts`   → `createManualPayment` (dentro de `tx`)
 *   5. `dashboard/refund.dashboard.service.ts` → `issueRefund`
 *   6. `mobile/order.mobile.service.ts`  → `payCashOrder`
 *   7. `mobile/refund.mobile.service.ts` → `createRefund` (dentro de `tx`)
 *
 * ⚠️ No confundir con `getCurrentShift` (`tpv/shift.tpv.service.ts`), que consulta
 * `{ venueId, endTime: null }` SIN `status` porque es para la PANTALLA. Aquí se exige
 * `status: 'OPEN'` a propósito: mientras un turno está en `CLOSING` (cierre en curso) este
 * helper devuelve `null` y un cobro en esa ventana de milisegundos cae sin turno — límite
 * conocido y aceptado (decisión del controlador, 2-sep-2026); lo rediseña la Fase 2.
 */
export async function turnoAbiertoDelNegocio(db: ShiftReader, venueId: string): Promise<{ id: string } | null> {
  const shift = await db.shift.findFirst({
    where: { venueId, status: 'OPEN', endTime: null },
    orderBy: { startTime: 'desc' },
    select: { id: true },
  })
  return shift ? { id: shift.id } : null
}

// ============================================================================
// ABRIR EL TURNO DE CAJA DEL NEGOCIO — UN SOLO GESTO
// ============================================================================

/**
 * 🔴 UN GESTO, DOS REGISTROS LIGADOS. Es la Fase 2 del turno de caja del negocio (3-sep-2026).
 *
 * Hoy el negocio abre DOS cosas cada mañana: la **Caja** en la tablet (con su fondo) y el **Turno**
 * en la PAX (con otro fondo). Testarudo, 1-sep-2026: la caja abrió a las 07:38 con $2,000 en un
 * Sunmi D3 y el turno a las 08:12 con $0 en la PAX — dos aperturas, dos fondos y dos cierres para
 * UNA sola caja física. El founder, que es quien lo pidió: «la persona va a pensar "abro mi turno
 * desde el POS con saldo inicial en abrir caja" — los confundirá».
 *
 * La respuesta NO es fusionar las tablas (decisión del 27-ago-2026: el `Shift` es la jornada de
 * venta y la `CashDrawerSession` el cajón físico; migrar todo a una perdería lo que cada una tiene).
 * Es que **cualquiera de los dos gestos deje los dos registros abiertos y LIGADOS**, y que ligar
 * gane siempre a duplicar. Como quien llama es la ruta que ya existe, las apps en la calle reciben
 * el gesto único **sin actualizarse**.
 *
 * ── Las cuatro ramas ──────────────────────────────────────────────────────────
 *   · no hay nada        → crea las dos con el MISMO fondo y las liga
 *   · ya hay caja        → crea el turno y lo liga a esa caja (el caso de Testarudo)
 *   · ya hay turno       → crea la caja y la liga a ese turno
 *   · ya hay las dos     → no crea nada; devuelve las que hay (una apertura encolada sin red no
 *                          rebota, sólo confirma lo que ya estaba)
 *
 * 🔴 **El fondo de lo que ya estaba NUNCA se pisa.** Si la caja se abrió con $2,000 contados, esos
 * $2,000 siguen siendo el fondo aunque el segundo gesto teclee otra cosa: el dinero que alguien
 * contó gana sobre el que alguien tecleó después.
 *
 * ── El relevo NO es un cierre por reloj ───────────────────────────────────────
 *
 * El founder vetó el cierre automático de turnos (2-sep-2026). Lo que esto hace es distinto: si al
 * abrir encuentra un turno que quedó abierto de un **día de negocio anterior**, lo cierra **sin
 * conteo** y abre el nuevo. El corte de las 04:00 en la zona del venue —el mismo de
 * `cashDrawerAutoClose`, que es el default de Toast— se usa **sólo para decidir «es de otro día»**,
 * nunca para cerrar por la hora: a las 02:00 todavía corre el día de negocio de ayer, y un turno
 * del MISMO día se reusa tal cual por muchas horas que lleve abierto.
 *
 * 🔴 Y el cierre del relevo **no inventa un conteo**: `endingCash`, `cashDeclared` y
 * `cashDifference` se quedan como estén (normalmente NULL). Escribir un 0 diría «alguien contó y
 * había cero» y le firmaría al cajero un faltante del tamaño de las ventas del día. Es la misma
 * regla dura del auto-cierre de caja.
 *
 * ── Concurrencia ──────────────────────────────────────────────────────────────
 *
 * Dos terminales que abren a la vez no pueden dejar dos turnos ni dos cajas: lo impiden los índices
 * únicos PARCIALES de la base — `Shift(venueId) WHERE status='OPEN'` (migración
 * `20260903030000_shift_one_open_per_venue`) y `CashDrawerSession(venueId) WHERE status='OPEN'`
 * (`20260827151634`) —, y los DOS choques se traducen aquí al MISMO `ConflictError` que las apps ya
 * entienden, nunca a un 500. El check previo es la respuesta amable del caso normal; el índice es
 * lo que de verdad evita la carrera.
 */
export type OrigenDeLaApertura = 'CAJA_MOVIL' | 'TURNO_TPV' | 'DASHBOARD'

export interface AbrirTurnoDeCajaParams {
  venueId: string
  staffId: string
  /** Nombre para el historial del cajón. Si falta (o llega el placeholder 'Staff'), se resuelve del `Staff`. */
  staffName?: string | null
  /** Fondo con el que se abre, en pesos. Sólo se usa si hay algo que CREAR: nunca pisa un fondo ya contado. */
  startingCash: number
  deviceName?: string | null
  /** Por dónde entró el gesto. Va a la bitácora; no cambia el comportamiento. */
  source: OrigenDeLaApertura
  /** Estación del POS integrado (se conserva de `openShiftForVenue`). */
  stationId?: string
  /** Reloj inyectable: el relevo depende de la fecha y las pruebas no pueden depender de «hoy». */
  now?: () => Date
}

export interface AbrirTurnoDeCajaResult {
  shiftId: string
  cashDrawerSessionId: string
  /** `false` = ya estaba abierto y se LIGÓ. Es lo que la UI necesita para no decir «abriste» cuando reusó. */
  shiftCreado: boolean
  cajaCreada: boolean
  /**
   * Lo que ESTA llamada cerró SIN CONTEO por ser de un día de negocio anterior. Van por separado
   * porque se relevan por separado: el turno puede estar abierto de ayer con la caja de hoy, o al
   * revés. Si otro aparato se adelantó y cerró primero, el campo NO aparece — no lo hicimos nosotros.
   */
  relevo?: { shiftCerradoId?: string; cajaCerradaId?: string }
}

/** Marca legible del relevo. Va en `Shift.notes`: quien lo lea tiene que saber que NADIE contó. */
export const NOTA_DEL_RELEVO = 'Cerrado por relevo al abrir el turno del día siguiente. Sin conteo.'

/** Su gemela para el cajón. Va en `closingNote`, con la misma promesa: nadie contó. */
export const NOTA_DEL_RELEVO_DE_CAJA = '[Sistema] Cerrada por relevo al abrir la caja del día siguiente. Sin conteo.'

/** Los dos índices únicos PARCIALES que garantizan «uno abierto por negocio». Se crean en SQL. */
export const INDICE_TURNO_ABIERTO = 'Shift_venueId_open_key'
export const INDICE_CAJA_ABIERTA = 'CashDrawerSession_venueId_open_key'

function conflictoDeApertura(): ConflictError {
  return new ConflictError('Ya hay un turno de caja abierto en este negocio. Ciérralo antes de abrir otro.', 'CASH_SHIFT_ALREADY_OPEN')
}

function cierreEnProceso(): ConflictError {
  return new ConflictError('El cierre de turno ya está en proceso. Intenta de nuevo en unos momentos.', 'SHIFT_CLOSE_IN_PROGRESS')
}

/**
 * 🔴 NO TODO P2002 ES «YA HAY UNO ABIERTO», y confundirlos manda al cajero a buscar algo que no
 * existe. `Shift` tiene un segundo único —`@@unique([venueId, externalId])`, que SÍ se puebla en los
 * venues integrados con SoftRestaurant— y `CashDrawerSession` tiene el suyo por `shiftId`. Mirar
 * sólo `error.code` traduciría cualquiera de esos choques a «ya hay un turno abierto» sobre un
 * negocio que no tiene ninguno.
 *
 * Se discrimina por `meta.target`, que en Postgres trae el nombre del índice (o la lista de campos).
 * 🔴 Y si NO viene, no se adivina: se deja subir el error tal cual. Un 500 honesto es mejor que un
 * 409 que miente — el 409 además lo tratan las apps como rechazo PERMANENTE y descartan lo encolado.
 */
export function esChoqueDelUnico(error: unknown, nombreDelIndice: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false
  const target = (error.meta as { target?: unknown } | undefined)?.target
  if (target === undefined || target === null) return false
  const comoTexto = Array.isArray(target) ? target.join(',') : String(target)
  return comoTexto.includes(nombreDelIndice)
}

/**
 * El nombre que se guarda en el historial del cajón. Espeja `resolveMobileStaffName` de
 * `mobile/cash-drawer.mobile.service.ts` — «Abierta por Staff» fue un hallazgo real del
 * /full-testing del 27-ago— pero SIN una consulta extra: el `Staff` ya viene con el `StaffVenue`.
 */
function nombreDelCajero(dado: string | null | undefined, staff: { firstName?: string | null; lastName?: string | null }): string {
  const limpio = (dado || '').trim()
  if (limpio && limpio !== 'Staff') return limpio
  const delRegistro = [staff.firstName, staff.lastName].filter(Boolean).join(' ').trim()
  return delRegistro || limpio || 'Staff'
}

export async function abrirTurnoDeCaja(parametros: AbrirTurnoDeCajaParams): Promise<AbrirTurnoDeCajaResult> {
  const { venueId, staffId, startingCash, deviceName, source, stationId } = parametros
  const ahora = (parametros.now ?? (() => new Date()))()

  if (!Number.isFinite(startingCash) || startingCash < 0) {
    throw new BadRequestError('El fondo inicial no puede ser negativo')
  }

  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { id: true, name: true, timezone: true, posType: true, posStatus: true },
  })
  if (!venue) throw new NotFoundError('Venue not found')

  const staffVenue = await prisma.staffVenue.findFirst({
    where: { staffId, venueId },
    select: { posStaffId: true, staff: { select: { id: true, firstName: true, lastName: true } } },
  })
  if (!staffVenue) throw new NotFoundError('Staff member not found or not associated with this venue')

  const staffName = nombreDelCajero(parametros.staffName, staffVenue.staff ?? {})
  const fondo = new Prisma.Decimal(Number(startingCash).toFixed(2))
  const corteDelDiaDeNegocio = businessDayStart(ahora, venue.timezone)

  // ── El puente a SoftRestaurant, conservado de `openShiftForVenue` ──────────────────────────
  //
  // 🔴 Va FUERA de la transacción a propósito: publicar en RabbitMQ es una llamada de red y
  // sostenerla con una transacción abierta ata una conexión del pool a la latencia del bróker.
  // Por eso hace falta una PRE-lectura que conteste «¿va a hacer falta crear turno?». La lectura
  // que MANDA es la de dentro de la transacción; ésta sólo decide si se avisa al POS.
  //
  // ⚠️ Límite declarado: si entre la pre-lectura y la transacción otro aparato abre el turno,
  // se habrá publicado un comando para un turno que acabó ligándose en vez de crearse. Se
  // registra en el log. El caso contrario —crear sin avisarle al POS— sería peor, y el corte
  // duro de abajo (si el POS no acepta, no se abre nada) es el mismo de `openShiftForVenue`.
  const posIntegrado = venue.posType === 'SOFTRESTAURANT' && venue.posStatus === 'CONNECTED'
  const turnoPrevio = await prisma.shift.findFirst({
    where: { venueId, endTime: null },
    orderBy: { startTime: 'desc' },
    select: { id: true, status: true, startTime: true },
  })
  // 🔴 El rechazo por CLOSING va ANTES de publicar, igual que en `openShiftForVenue`: si no, el POS
  // externo se queda con un `Shift OPEN` que Avoqado nunca va a crear. La comprobación se repite
  // dentro de la transacción porque ésta no es autoritativa — aquí sólo evita el efecto externo.
  if (turnoPrevio && turnoPrevio.status === ShiftStatus.CLOSING) throw cierreEnProceso()

  const hariaFaltaCrearTurno = !turnoPrevio || turnoPrevio.startTime < corteDelDiaDeNegocio

  let shiftExternalId: string | null = null
  if (posIntegrado && hariaFaltaCrearTurno) {
    const tempShiftId = `SHIFT_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
    try {
      await publishCommand(`command.softrestaurant.${venueId}`, {
        entity: 'Shift',
        action: 'OPEN',
        payload: {
          tempShiftId,
          posStaffId: staffVenue.posStaffId || staffId,
          startingCash: startingCash || 0,
          stationId: stationId || 'AVOQADO',
        },
      })
      shiftExternalId = tempShiftId
    } catch (error) {
      logger.error('Failed to send shift open command to POS', error)
      throw new BadRequestError('Failed to open shift in POS system. Please try again.')
    }
  }

  const resultado = await prisma.$transaction(async tx => {
    // ── El turno ──────────────────────────────────────────────────────────────────────────
    //
    // `endTime: null` y no `status: 'OPEN'`: un turno en CLOSING sigue con `endTime` nulo y su
    // cierre puede REVERTIRSE a OPEN (`releaseShiftCloseClaim`). Abrir otro encima dejaría al
    // venue con dos abiertos en cuanto ese cierre falle —y el índice único haría fallar la
    // reversión, dejando el turno atorado en CLOSING—. Mientras hay un cierre en curso, se espera.
    const turno = await tx.shift.findFirst({
      where: { venueId, endTime: null },
      orderBy: { startTime: 'desc' },
      select: { id: true, status: true, startTime: true, notes: true },
    })

    if (turno && turno.status === ShiftStatus.CLOSING) throw cierreEnProceso()

    let shiftCerradoId: string | undefined
    let turnoAReusar = turno

    if (turno && turno.startTime < corteDelDiaDeNegocio) {
      // CAS: sólo cierra si sigue OPEN y sin `endTime`.
      const cerrado = await tx.shift.updateMany({
        where: { id: turno.id, venueId, status: ShiftStatus.OPEN, endTime: null },
        data: {
          status: ShiftStatus.CLOSED,
          endTime: ahora,
          notes: [turno.notes, NOTA_DEL_RELEVO].filter(Boolean).join(' · '),
          updatedAt: ahora,
        },
      })

      if (cerrado.count === 1) {
        shiftCerradoId = turno.id
        turnoAReusar = null
      } else {
        // 🔴 PERDER EL CAS AQUÍ ES UNA CARRERA BENIGNA, NO UN CONFLICTO: significa que otro aparato
        // ya cerró el turno de ayer, que es EXACTAMENTE el estado que queríamos. Lanzar «ya hay un
        // turno abierto, ciérralo» diría lo contrario de la verdad — y las apps tratan el 409 como
        // rechazo PERMANENTE, así que una apertura encolada que cayera aquí se descartaría para
        // siempre. Se relee y se sigue.
        const estadoReal = await tx.shift.findUnique({ where: { id: turno.id }, select: { status: true, endTime: true } })

        if (!estadoReal || estadoReal.endTime !== null || estadoReal.status === ShiftStatus.CLOSED) {
          logger.info('[TURNO DE CAJA] Otro aparato ya había relevado el turno del día anterior', { venueId, shiftId: turno.id })
          turnoAReusar = null
        } else if (estadoReal.status === ShiftStatus.CLOSING) {
          throw cierreEnProceso()
        } else {
          // Prácticamente inalcanzable (el `where` del CAS sólo fija id, venue, estado y endTime),
          // pero si pasa el mensaje dice la verdad: no se pudo cerrar, vuelve a intentar.
          throw new ConflictError(
            'No se pudo cerrar el turno del día anterior; vuelve a intentar en unos segundos.',
            'SHIFT_HANDOVER_RETRY',
          )
        }
      }
    }

    let shiftId: string
    let shiftCreado = false
    if (turnoAReusar) {
      shiftId = turnoAReusar.id
      if (posIntegrado && hariaFaltaCrearTurno) {
        logger.warn('[TURNO DE CAJA] Se avisó al POS de una apertura que acabó ligándose a un turno ya abierto', {
          venueId,
          shiftId,
          shiftExternalId,
        })
      }
    } else {
      const nuevo = await tx.shift
        .create({
          data: {
            venueId,
            staffId,
            startTime: ahora,
            endTime: null,
            status: ShiftStatus.OPEN,
            startingCash: fondo,
            endingCash: null,
            cashDeclared: null,
            cardDeclared: null,
            vouchersDeclared: null,
            otherDeclared: null,
            totalSales: 0,
            totalTips: 0,
            notes: null,
            externalId: shiftExternalId,
            posRawData: stationId ? { stationId } : undefined,
          },
          select: { id: true },
        })
        .catch((error: unknown) => {
          // SÓLO el índice único parcial `Shift(venueId) WHERE status='OPEN'`: otra terminal ganó.
          // Un choque de `venueId_externalId` (venues integrados) sube tal cual, no se disfraza.
          if (esChoqueDelUnico(error, INDICE_TURNO_ABIERTO)) throw conflictoDeApertura()
          throw error
        })
      shiftId = nuevo.id
      shiftCreado = true
    }

    // ── El cajón físico ───────────────────────────────────────────────────────────────────
    //
    // 🔴 SE RELEVA IGUAL QUE EL TURNO, y la simetría no es estética. Buscar aquí un
    // `{ venueId, status: 'OPEN' }` pelado —sin comparar contra el corte— hace que el turno de HOY
    // herede la caja de AYER con su fondo y sus eventos de dos días, y quien cierre hoy cuenta el
    // efectivo contra un esperado que no es el suyo. No es un caso raro: abren a las 05:30, el turno
    // de ayer se releva bien, pero la caja de ayer sigue abierta porque `cashDrawerAutoClose` la
    // respeta si tuvo un movimiento hace menos de 2 h — y una venta de las 03:30 la protege.
    //
    // 🔴 Y aquí NO se aplica esa gracia de inactividad, a propósito: el barrido corre solo con un
    // temporizador y la necesita para no arrancarle la caja a un local que sigue vendiendo a las
    // 04:05. Aquí hay una PERSONA en el mostrador pidiendo abrir, que es la señal más fuerte que
    // existe de que la sesión anterior terminó.
    const cajaAbierta = await tx.cashDrawerSession.findFirst({
      where: { venueId, status: 'OPEN' },
      select: { id: true, shiftId: true, openedAt: true },
    })

    let cajaCerradaId: string | undefined
    let caja = cajaAbierta

    if (cajaAbierta && cajaAbierta.openedAt < corteDelDiaDeNegocio) {
      // Misma forma exacta que `cashDrawerAutoClose`: sin `actualAmount`, sin `overShort`, sin
      // `closedByStaffId` y SIN evento `CLOSE` — un evento lleva `amount`, y una fila en cero se
      // lee como un conteo. Es la firma que `isAutoClosedSession` reconoce como «nadie contó».
      const cerrada = await tx.cashDrawerSession.updateMany({
        where: { id: cajaAbierta.id, status: 'OPEN' },
        data: {
          status: 'CLOSED',
          closedAt: ahora,
          closedByStaffId: null,
          closedByName: AUTO_CLOSED_BY_NAME,
          closingNote: NOTA_DEL_RELEVO_DE_CAJA,
        },
      })
      // Perder el CAS otra vez es benigno: alguien la cerró primero, que es lo que queríamos.
      if (cerrada.count === 1) cajaCerradaId = cajaAbierta.id
      else logger.info('[TURNO DE CAJA] Otro aparato ya había cerrado la caja del día anterior', { venueId, cajaId: cajaAbierta.id })
      caja = null
    }

    let cashDrawerSessionId: string
    let cajaCreada = false
    let cajaYaLigadaA: string | null | undefined
    if (caja) {
      cashDrawerSessionId = caja.id
      cajaYaLigadaA = caja.shiftId
    } else {
      const nueva = await tx.cashDrawerSession
        .create({
          data: {
            venueId,
            openedByStaffId: staffId,
            openedByName: staffName,
            openedAt: ahora,
            startingAmount: fondo,
            deviceName: deviceName || null,
            status: 'OPEN',
            events: {
              create: {
                venueId,
                type: 'OPEN',
                amount: fondo,
                staffId,
                staffName,
                note: `Caja abierta con $${fondo}`,
              },
            },
          },
          select: { id: true },
        })
        .catch((error: unknown) => {
          // SÓLO el índice de cajas abiertas. Un choque de `CashDrawerSession_shiftId_key` o del
          // `localId` del evento no significa «ya hay una caja abierta» y sube tal cual.
          if (esChoqueDelUnico(error, INDICE_CAJA_ABIERTA)) throw conflictoDeApertura()
          throw error
        })
      cashDrawerSessionId = nueva.id
      cajaCreada = true
      cajaYaLigadaA = null
    }

    // ── La liga ───────────────────────────────────────────────────────────────────────────
    //
    // 🔴 NUNCA SE ROBA UNA LIGA. Si el cajón ya apunta a otro turno, se deja como está: ese
    // `shiftId` es la única constancia de bajo qué turno se abrió ese arqueo, y sobrescribirlo
    // le borraría el cajón al turno que sí lo tuvo. Y si OTRO cajón ya reclama este turno
    // (`shiftId` es `@unique`), tampoco se intenta: un P2002 aquí abortaría la transacción
    // entera y tumbaría una apertura que por lo demás está bien. La liga mejora el reporte;
    // no es dinero, y `resolveShiftCashDrawer` sigue resolviendo por ventana de tiempo sin ella.
    if (cajaYaLigadaA == null) {
      const reclamadoPorOtra = await tx.cashDrawerSession.findUnique({ where: { shiftId }, select: { id: true } })
      if (reclamadoPorOtra && reclamadoPorOtra.id !== cashDrawerSessionId) {
        logger.warn('[TURNO DE CAJA] El turno ya está ligado a otro cajón; no se reescribe la liga', {
          venueId,
          shiftId,
          cajaDelTurno: reclamadoPorOtra.id,
          cajaAbierta: cashDrawerSessionId,
        })
      } else if (!reclamadoPorOtra) {
        // Condicional (`shiftId: null`) para que dos aperturas simultáneas no choquen contra el
        // único: la segunda encuentra 0 filas y sigue, en vez de reventar.
        await tx.cashDrawerSession.updateMany({ where: { id: cashDrawerSessionId, shiftId: null }, data: { shiftId } })
      }
    } else if (cajaYaLigadaA !== shiftId) {
      logger.warn('[TURNO DE CAJA] El cajón abierto ya pertenece a otro turno; se conserva su liga', {
        venueId,
        shiftId,
        cajaAbierta: cashDrawerSessionId,
        ligadaA: cajaYaLigadaA,
      })
    }

    const relevo =
      shiftCerradoId || cajaCerradaId
        ? { ...(shiftCerradoId ? { shiftCerradoId } : {}), ...(cajaCerradaId ? { cajaCerradaId } : {}) }
        : undefined

    return { shiftId, cashDrawerSessionId, shiftCreado, cajaCreada, ...(relevo ? { relevo } : {}) } as AbrirTurnoDeCajaResult
  })

  // ── Bitácora: fuera de la transacción y fire-and-forget ───────────────────────────────────
  // Si la bitácora truena, la apertura NO se deshace (mismo patrón que el resto del repo).
  if (resultado.relevo?.shiftCerradoId) {
    void logAction({
      staffId,
      venueId,
      action: 'SHIFT_CLOSED_ON_NEXT_OPEN',
      entity: 'Shift',
      entityId: resultado.relevo.shiftCerradoId,
      data: { motivo: 'relevo al abrir el turno del día siguiente', sinConteo: true, source },
    })
  }
  if (resultado.relevo?.cajaCerradaId) {
    void logAction({
      staffId,
      venueId,
      action: 'CASH_DRAWER_CLOSED_ON_NEXT_OPEN',
      entity: 'CashDrawerSession',
      entityId: resultado.relevo.cajaCerradaId,
      data: { motivo: 'relevo al abrir la caja del día siguiente', sinConteo: true, source },
    })
  }
  if (resultado.shiftCreado) {
    void logAction({
      staffId,
      venueId,
      action: 'SHIFT_OPENED',
      entity: 'Shift',
      entityId: resultado.shiftId,
      data: { startingCash, stationId: stationId ?? undefined, isIntegratedPOS: posIntegrado, source },
    })
  }
  if (resultado.cajaCreada) {
    void logAction({
      staffId,
      venueId,
      action: 'CASH_DRAWER_OPENED',
      entity: 'CashDrawerSession',
      entityId: resultado.cashDrawerSessionId,
      data: { startingAmount: Number(fondo), deviceName, source },
    })
  }

  logger.info('[TURNO DE CAJA] Apertura resuelta', {
    venueId,
    source,
    shiftId: resultado.shiftId,
    cashDrawerSessionId: resultado.cashDrawerSessionId,
    shiftCreado: resultado.shiftCreado,
    cajaCreada: resultado.cajaCreada,
    turnoRelevado: resultado.relevo?.shiftCerradoId ?? null,
    cajaRelevada: resultado.relevo?.cajaCerradaId ?? null,
  })

  return resultado
}
