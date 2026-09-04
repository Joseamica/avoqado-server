import type { PrismaClient } from '@prisma/client'
import { Prisma, ShiftStatus } from '@prisma/client'
import { randomUUID } from 'node:crypto'

import logger from '../../config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { deliverPosCommand } from '../../communication/rabbitmq/commandListener'
import { logAction } from '../dashboard/activity-log.service'
import { AUTO_CLOSED_BY_NAME, businessDayStart } from './cashDrawerAutoClose'
import { lockShiftLifecycleForVenue } from './shiftLifecycleLock'

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
  /**
   * El nombre que quedó en el historial del cajón, ya resuelto (nunca el placeholder 'Staff').
   * Lo devuelve para que las rutas que ya avisaban por Socket.IO conserven su payload EXACTO sin
   * repetir la consulta de `StaffVenue` que este servicio acaba de hacer.
   */
  staffName: string
  /**
   * El fondo con el que de verdad se escribieron los registros, en pesos como cadena. Puede NO ser
   * el `startingCash` que se pidió: una gaveta ya abierta —o un turno sin gaveta con fondo propio—
   * manda sobre lo que se teclea después. Existe para que la bitácora registre lo ESCRITO y no lo
   * pedido: un dueño auditando no puede leer $500 en el log y $2,000 en la fila sin explicación.
   */
  fondoAplicado: string
  /** Presente sólo si esta llamada subió el `startingCash` del turno (era cero y sin gaveta). */
  turnoAlineadoDesde?: string
}

/** Marca legible del relevo. Va en `Shift.notes`: quien lo lea tiene que saber que NADIE contó. */
export const NOTA_DEL_RELEVO = 'Cerrado por relevo al abrir el turno del día siguiente. Sin conteo.'

/** Su gemela para el cajón. Va en `closingNote`, con la misma promesa: nadie contó. */
export const NOTA_DEL_RELEVO_DE_CAJA = '[Sistema] Cerrada por relevo al abrir la caja del día siguiente. Sin conteo.'

/**
 * Un único PARCIAL creado en SQL crudo, que Prisma no conoce por el schema. Lleva las dos formas
 * con las que puede llegar identificado, porque Prisma no garantiza cuál da.
 */
export interface UnicoParcial {
  /** El nombre del índice en Postgres. */
  indice: string
  /** Sus columnas EXACTAS, en orden. 🔴 Es la forma que Prisma reporta DE VERDAD (ver abajo). */
  columnas: string[]
}

/** Los dos índices únicos PARCIALES que garantizan «uno abierto por negocio». Se crean en SQL. */
export const UNICO_TURNO_ABIERTO: UnicoParcial = { indice: 'Shift_venueId_open_key', columnas: ['venueId'] }
export const UNICO_CAJA_ABIERTA: UnicoParcial = { indice: 'CashDrawerSession_venueId_open_key', columnas: ['venueId'] }

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
 * 🔴 **LA FORMA SE MIDIÓ CONTRA POSTGRES EL 3-SEP-2026, no se asumió**, provocando el choque real
 * dentro de una transacción revertida:
 *
 *     code: 'P2002'   meta: { modelName: 'Shift', target: ['venueId'] }   meta.constraint: undefined
 *
 * O sea: **`meta.target` trae la lista de COLUMNAS, no el nombre del índice, y `meta.constraint` ni
 * siquiera viene.** La primera versión de esta función comparaba contra `'Shift_venueId_open_key'` y
 * por tanto **no disparaba nunca** — con todas sus pruebas en verde, porque construían la forma
 * asumida. Consecuencias que eso habría tenido vivas: un 500 en la ruta de la PAX ante un doble
 * intento legítimo, y el rescate de `getOrCreatePosShift` sin correr, con la orden del POS dropeada
 * porque el consumidor hace `nack(msg, false, false)` ante cualquier throw.
 *
 * Por eso se aceptan las TRES formas, igual que `isCatalogOverrideUniqueConstraint` en
 * `master-catalog/catalogOverrideRecovery.service.ts` —el otro sitio del repo con un índice parcial
 * crudo—: `meta.constraint`, el nombre del índice en `target`, y la lista EXACTA de columnas.
 *
 * La lista discrimina bien para nuestros dos índices: son sobre `(venueId)` a secas, mientras el
 * otro único de `Shift` llega como `['venueId','externalId']` y el de la caja como `['shiftId']`.
 *
 * 🔴 Y si no viene NINGUNO de los dos descriptores, no se adivina: el error sube tal cual. Un 500
 * honesto es mejor que un 409 que miente — el 409 además lo tratan las apps como rechazo PERMANENTE
 * y descartan lo encolado para siempre.
 */
export function esChoqueDelUnico(error: unknown, unico: UnicoParcial): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false
  const meta = error.meta as { target?: unknown; constraint?: unknown } | undefined
  const descriptor = meta?.constraint ?? meta?.target
  if (descriptor === undefined || descriptor === null) return false

  // (1) el nombre del índice, suelto o dentro de un arreglo de uno
  if (descriptor === unico.indice) return true
  if (Array.isArray(descriptor) && descriptor.length === 1 && descriptor[0] === unico.indice) return true

  // (2) la lista EXACTA de columnas, en orden — la forma medida
  return (
    Array.isArray(descriptor) && descriptor.length === unico.columnas.length && descriptor.every((campo, i) => campo === unico.columnas[i])
  )
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

/**
 * El nombre que queda en el historial del cajón al CERRAR.
 *
 * 🔴 El único llamador real (`tpv/shift.tpv.service.ts`) manda `staffName: null` porque no lo tiene
 * a la mano, así que resolverlo aquí no es un lujo: sin esto el **100 %** de los cierres desde la
 * PAX quedaban «Cerrada por Staff» mientras el turno, a dos centímetros en la misma pantalla, decía
 * el nombre real. Es la desunión que `Shift.closedById` existía para matar, y el mismo hallazgo del
 * /full-testing del 27-ago («Abierta por Staff») reintroducido por la otra puerta.
 *
 * La regla de qué nombre gana es la de `nombreDelCajero` —una sola, no una copia—; lo que añade es
 * la consulta, y sólo cuando hace falta: con un nombre real ya dado no toca la base.
 */
async function nombreDeQuienCierra(staffId: string | null, dado?: string | null): Promise<string> {
  const limpio = (dado || '').trim()
  if (limpio && limpio !== 'Staff') return limpio
  // Sin persona no se inventa una: es un script, y decirlo es más honesto que un 'Staff' anónimo.
  if (!staffId) return NOMBRE_DEL_SISTEMA
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { firstName: true, lastName: true } }).catch(() => null)
  return nombreDelCajero(dado, staff ?? {})
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

  const posIntegrado = venue.posType === 'SOFTRESTAURANT' && venue.posStatus === 'CONNECTED'

  const resultadoConOutbox = await prisma.$transaction(async tx => {
    // Orden global: advisory del venue → fila Shift → gaveta. Quien cierra o recupera un Shift
    // usa la misma autoridad; nadie puede observar ausencia y crear mientras otro queda CLOSING.
    await lockShiftLifecycleForVenue(tx, venueId)

    // ── El turno ──────────────────────────────────────────────────────────────────────────
    //
    // `endTime: null` y no `status: 'OPEN'`: un turno en CLOSING sigue con `endTime` nulo y su
    // cierre puede REVERTIRSE a OPEN (`releaseShiftCloseClaim`). Abrir otro encima dejaría al
    // venue con dos abiertos en cuanto ese cierre falle —y el índice único haría fallar la
    // reversión, dejando el turno atorado en CLOSING—. Mientras hay un cierre en curso, se espera.
    const turno = await tx.shift.findFirst({
      where: { venueId, endTime: null },
      orderBy: { startTime: 'desc' },
      // `startingCash` se lee porque es EL FONDO cuando este gesto sólo crea la caja: ver
      // `fondoEfectivo` más abajo.
      select: { id: true, status: true, startTime: true, notes: true, startingCash: true },
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
      select: { id: true, shiftId: true, openedAt: true, startingAmount: true },
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

    // ── EL FONDO: uno solo por caja física ────────────────────────────────────────────────
    //
    // 🔴 El caso REAL de Testarudo (1-sep-2026): la tablet abrió la gaveta a las 07:38 con **$2,000**
    // contados y la PAX pidió turno a las 08:12 tecleando **$0**. Dejar cada registro con su número
    // da dos fondos para UNA sola gaveta, y uno de los dos cierres firma un descuadre de $2,000
    // contra alguien que no hizo nada mal.
    //
    // 🔴 «Gana el que CONTÓ» NO es «gana el que abrió primero», y confundirlos cuesta dinero en las
    // dos direcciones (las dos verificadas contra el código, ronda de arreglo 1):
    //
    //   (a) **Relevo de mostrador**, un martes normal: turno + gaveta a las 08:00 con $2,000; a las
    //       15:00 la tablet CIERRA la gaveta y cuenta, pero el `Shift` sigue OPEN —`closeSession`
    //       de `mobile/cash-drawer.mobile.service.ts` no toca el turno, cero referencias—; a las
    //       15:05 la cajera de la tarde abre con **$500** suyos. Heredar del turno le firmaría un
    //       **faltante de $1,500**, y encima la tablet adopta la sesión del server y borra su OPEN
    //       provisional de $500 (`CashDrawerRepository.kt`, promoción de provisionales).
    //   (b) **La dirección que de verdad ocurrió**: la PAX primero, tecleando $0. Un `??` no salta
    //       el cero, así que la gaveta nacía en $0 y los $2,000 contados se descartaban.
    //
    // Las tres ramas, y por qué:
    //   · gaveta ABIERTA                    → manda su fondo, sin condiciones: es la caja que está
    //                                          abierta ahora mismo, y su arqueo ya se calcula contra él
    //   · turno SIN gaveta y con fondo > 0  → manda el del turno: nadie ha abierto la caja todavía,
    //                                          así que ese número es lo único que la describe
    //   · todo lo demás                     → manda lo que se teclea AHORA, que lo escribe quien está
    //                                          viendo la gaveta
    //
    // 🔑 Un `startingCash` de CERO en un turno que nunca tuvo gaveta **no es un conteo**: es el
    // default del campo — Testarudo tecleó $0 en la PAX— y por eso no gana. Un cero en una gaveta
    // ABIERTA sí gana: ahí alguien miró la caja y dijo que estaba vacía.
    //
    // ⚠️ Por eso el cajón se resuelve ANTES de crear el turno: al revés, el turno nacería sin poder
    // saber que la gaveta ya tenía fondo.
    const cajonDelTurnoReusado = turnoAReusar
      ? await tx.cashDrawerSession.findUnique({ where: { shiftId: turnoAReusar.id }, select: { id: true } })
      : null

    // ⚠️ `!= null` sobre `turnoAReusar` y no truthiness: un `Decimal(0)` es un OBJETO y por tanto
    // truthy, así que un `&&` sobre el fondo no distinguiría «cero» de «ausente». Quien decide es
    // `greaterThan(0)`, explícito.
    //
    // 🔴 `startingCash` NO se comprueba contra null: `schema.prisma` la declara **no-nulable con
    // `@default(0)`**, así que una guarda `!= null` sería código muerto — y encima haría creer que
    // un `de: 0` en la bitácora puede significar «era null», que es una cosa distinta.
    const fondoDelTurnoSinGaveta =
      turnoAReusar != null && cajonDelTurnoReusado == null && new Prisma.Decimal(turnoAReusar.startingCash).greaterThan(0)
        ? new Prisma.Decimal(turnoAReusar.startingCash)
        : null

    const fondoDeLaGavetaAbierta = caja != null ? new Prisma.Decimal(caja.startingAmount) : null
    const fondoEfectivo = fondoDeLaGavetaAbierta ?? fondoDelTurnoSinGaveta ?? fondo

    // Un fondo tecleado que se descarta es la ÚNICA huella de que dos personas dijeron cosas
    // distintas del mismo dinero. Sin esto, la divergencia entre lo que se ve en pantalla y lo que
    // queda en la fila parece un bug del sistema.
    if (!fondoEfectivo.equals(fondo)) {
      logger.warn('[TURNO DE CAJA] Se descartó el fondo tecleado: manda el de la caja que ya existía', {
        venueId,
        source,
        fondoTecleado: fondo.toString(),
        fondoAplicado: fondoEfectivo.toString(),
        origen: caja ? 'gaveta abierta' : 'turno sin gaveta',
      })
    }

    let shiftId: string
    let shiftCreado = false
    let shiftExternalId: string | null = null
    if (turnoAReusar) {
      shiftId = turnoAReusar.id
    } else {
      // La identidad externa nace dentro de la transacción del turno ganador.
      // Si otro dispositivo gana el único parcial, este valor nunca sale ni deja outbox.
      shiftExternalId = posIntegrado ? `SHIFT_${ahora.getTime()}_${randomUUID().replace(/-/g, '').slice(0, 9)}` : null
      const nuevo = await tx.shift
        .create({
          data: {
            venueId,
            staffId,
            startTime: ahora,
            endTime: null,
            status: ShiftStatus.OPEN,
            startingCash: fondoEfectivo,
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
          if (esChoqueDelUnico(error, UNICO_TURNO_ABIERTO)) throw conflictoDeApertura()
          throw error
        })
      shiftId = nuevo.id
      shiftCreado = true
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
            startingAmount: fondoEfectivo,
            deviceName: deviceName || null,
            status: 'OPEN',
            events: {
              create: {
                venueId,
                type: 'OPEN',
                amount: fondoEfectivo,
                staffId,
                staffName,
                note: `Caja abierta con $${fondoEfectivo}`,
              },
            },
          },
          select: { id: true },
        })
        .catch((error: unknown) => {
          // SÓLO el índice de cajas abiertas. Un choque de `CashDrawerSession_shiftId_key` o del
          // `localId` del evento no significa «ya hay una caja abierta» y sube tal cual.
          if (esChoqueDelUnico(error, UNICO_CAJA_ABIERTA)) throw conflictoDeApertura()
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
    // 🔴 `true` sólo si la gaveta con la que salimos ES la de ESTE turno. Es lo que decide si el
    // fondo se puede alinear: la gaveta de otro turno —o la de la mañana que ya cerró— describe SU
    // sesión de caja, no ésta.
    let gavetaDeEsteTurno = false
    if (cajaYaLigadaA == null) {
      // Se reusa la lectura de arriba: un turno recién CREADO no puede estar reclamado por nadie.
      const reclamadoPorOtra = shiftCreado ? null : cajonDelTurnoReusado
      if (reclamadoPorOtra && reclamadoPorOtra.id !== cashDrawerSessionId) {
        logger.warn('[TURNO DE CAJA] El turno ya está ligado a otro cajón; no se reescribe la liga', {
          venueId,
          shiftId,
          cajaDelTurno: reclamadoPorOtra.id,
          cajaAbierta: cashDrawerSessionId,
        })
      } else if (!reclamadoPorOtra) {
        gavetaDeEsteTurno = true
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
    } else {
      // Ya estaban ligados de antes: la pareja que existe en producción desde ayer.
      gavetaDeEsteTurno = true
    }

    // ── QUE LOS DOS CIERRES DIGAN EL MISMO NÚMERO ─────────────────────────────────────────
    //
    // 🔴 Los dos cierres leen COLUMNAS DISTINTAS: el del cajón calcula su esperado desde
    // `CashDrawerSession.startingAmount` (`calculateExpectedAmount`) y el del turno desde
    // `Shift.startingCash`. Si divergen, uno de los dos le firma al cajero un descuadre que nadie
    // causó. (Desde la Task 5 el cierre del turno prefiere el esperado de la gaveta, así que la
    // divergencia ya no firma dinero — pero `Shift.startingCash` se sigue LEYENDO en el dashboard
    // y en el editor de superadmin, y un turno que dice $0 sobre una gaveta de $2,000 miente igual.)
    //
    // 🔴 Dos condiciones, y las dos importan:
    //
    //   · **la gaveta tiene que ser la de ESTE turno** (`gavetaDeEsteTurno`). Nunca la de otro, ni
    //     la segunda del día sobre un turno que ya tuvo la suya: ahí su `startingCash` es suyo.
    //   · **sólo SUBE un cero.** Un turno con fondo propio no se baja jamás — el fondo de una
    //     gaveta abierta manda para lo que se ESCRIBE ahora, no para reescribir hacia abajo un
    //     número que alguien contó antes.
    //
    // ⚠️ Alcanza tanto a la gaveta recién creada como a la pareja que YA existía y sólo se ligó:
    // la segunda era el hueco que quedó vivo tras la Task 4 (auditoría de Codex, 3-sep-2026), y en
    // producción es el estado normal de cualquier venue que ya abrió las dos cosas por separado.
    let turnoAlineadoDesde: string | undefined
    const fondoDelTurno = turnoAReusar ? new Prisma.Decimal(turnoAReusar.startingCash) : null
    if (gavetaDeEsteTurno && fondoDelTurno && fondoDelTurno.equals(0) && fondoEfectivo.greaterThan(0)) {
      // CAS por estado: si el turno cambió debajo (cierre en curso), no se le toca el dinero.
      const alineado = await tx.shift.updateMany({
        where: { id: shiftId, venueId, status: ShiftStatus.OPEN },
        data: { startingCash: fondoEfectivo, updatedAt: ahora },
      })
      if (alineado.count === 1) {
        turnoAlineadoDesde = fondoDelTurno.toString()
      } else {
        // 🔴 Perder ESTE CAS no es benigno como los del relevo: la gaveta tiene el fondo bueno y el
        // turno se queda con el suyo, que es JUSTO la divergencia que este bloque existe para matar.
        // No se reintenta (el turno está cerrándose y tocarle el dinero sería peor), pero tampoco se
        // calla: sin este aviso la divergencia sólo se descubre al cuadrar la caja.
        logger.warn('[TURNO DE CAJA] no se pudo alinear el fondo del turno: cambió de estado a media apertura', {
          venueId,
          shiftId,
          source,
          fondoDelTurno: fondoDelTurno.toString(),
          fondoDeLaGaveta: fondoEfectivo.toString(),
          cashDrawerSessionId,
        })
      }
    }

    const relevo =
      shiftCerradoId || cajaCerradaId
        ? { ...(shiftCerradoId ? { shiftCerradoId } : {}), ...(cajaCerradaId ? { cajaCerradaId } : {}) }
        : undefined

    let posCommandId: string | undefined
    if (shiftCreado && posIntegrado && shiftExternalId) {
      // Outbox transaccional: el Shift, la gaveta y la intención OPEN viven o
      // revierten juntos. La clave apunta a la apertura ganadora, no al request.
      const command = await tx.posCommand.create({
        data: {
          venueId,
          entityType: 'Shift',
          entityId: shiftId,
          commandType: 'CREATE',
          action: 'OPEN',
          dedupeKey: `shift-open:${shiftId}`,
          payload: {
            tempShiftId: shiftExternalId,
            posStaffId: staffVenue.posStaffId || staffId,
            startingCash: Number(fondoEfectivo.toFixed(2)),
            stationId: stationId || 'AVOQADO',
          },
        },
        select: { id: true },
      })
      posCommandId = command.id
    }

    return {
      shiftId,
      cashDrawerSessionId,
      shiftCreado,
      cajaCreada,
      staffName,
      fondoAplicado: fondoEfectivo.toString(),
      ...(turnoAlineadoDesde !== undefined ? { turnoAlineadoDesde } : {}),
      ...(relevo ? { relevo } : {}),
      ...(posCommandId ? { posCommandId } : {}),
    } as AbrirTurnoDeCajaResult & { posCommandId?: string }
  })

  const { posCommandId, ...resultado } = resultadoConOutbox

  // Best effort DESPUÉS del commit. LISTEN/NOTIFY puede ganar esta carrera; el
  // claim CAS de deliverPosCommand hace que sólo uno publique. Un fallo deja la
  // fila PENDING con backoff persistido para el barrido recurrente y jamás
  // deshace la apertura local ya confirmada.
  if (posCommandId) {
    try {
      const delivery = await deliverPosCommand(posCommandId)
      if (delivery === 'FAILED') logger.warn('[TURNO DE CAJA] OPEN de POS pendiente de reintento', { venueId, posCommandId })
    } catch (error) {
      logger.error('[TURNO DE CAJA] No se pudo intentar la entrega del OPEN durable', { venueId, posCommandId, error })
    }
  }

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
  if (resultado.turnoAlineadoDesde !== undefined) {
    // 🔴 Mover el fondo de un turno YA ABIERTO es tocar dinero: va con su renglón en la bitácora,
    // con el antes y el después, para que un dueño pueda ver quién y por qué.
    void logAction({
      staffId,
      venueId,
      action: 'SHIFT_STARTING_CASH_ALIGNED',
      entity: 'Shift',
      entityId: resultado.shiftId,
      data: {
        motivo: 'el turno se abrió sin fondo y sin gaveta; se alinea al fondo con el que se abrió la caja',
        de: Number(resultado.turnoAlineadoDesde),
        a: Number(resultado.fondoAplicado),
        cashDrawerSessionId: resultado.cashDrawerSessionId,
        source,
      },
    })
  }
  if (resultado.shiftCreado) {
    void logAction({
      staffId,
      venueId,
      action: 'SHIFT_OPENED',
      entity: 'Shift',
      entityId: resultado.shiftId,
      data: { startingCash: Number(resultado.fondoAplicado), stationId: stationId ?? undefined, isIntegratedPOS: posIntegrado, source },
    })
  }
  if (resultado.cajaCreada) {
    void logAction({
      staffId,
      venueId,
      action: 'CASH_DRAWER_OPENED',
      entity: 'CashDrawerSession',
      entityId: resultado.cashDrawerSessionId,
      data: { startingAmount: Number(resultado.fondoAplicado), deviceName, source },
    })
  }

  logger.info('[TURNO DE CAJA] Apertura resuelta', {
    venueId,
    source,
    shiftId: resultado.shiftId,
    cashDrawerSessionId: resultado.cashDrawerSessionId,
    shiftCreado: resultado.shiftCreado,
    cajaCreada: resultado.cajaCreada,
    fondoAplicado: resultado.fondoAplicado,
    turnoAlineadoDesde: resultado.turnoAlineadoDesde ?? null,
    turnoRelevado: resultado.relevo?.shiftCerradoId ?? null,
    cajaRelevada: resultado.relevo?.cajaCerradaId ?? null,
  })

  return resultado
}

// ============================================================================
// CERRAR EL TURNO DE CAJA DEL NEGOCIO — EL MISMO GESTO ÚNICO, AL REVÉS
// ============================================================================

/**
 * 🔴 UN GESTO, DOS REGISTROS. Es la otra mitad de `abrirTurnoDeCaja` (Fase 2, Task 5, 3-sep-2026).
 *
 * La apertura ya está unificada: la caja física y el turno son dos registros de UNA sola caja, y
 * quien llega primero crea mientras el segundo liga. El CIERRE seguía partido, y eso se veía: una
 * caja creada por la apertura del turno desde la PAX **no la cerraba el cierre del turno**, sino el
 * auto-cierre de las 04:00 o el relevo de la mañana siguiente. Consecuencia: los venues sólo-PAX
 * habrían empezado a ver un bloque «Caja física · sin conteo» todos los días.
 *
 * ── Las dos direcciones ───────────────────────────────────────────────────────
 *   · `TURNO_TPV`  — la PAX cerró el turno   → se cierra la GAVETA ligada
 *   · `CAJA_MOVIL` — la tablet cerró la caja → se cierra el TURNO del negocio
 *
 * ── Reglas duras ──────────────────────────────────────────────────────────────
 *
 * 1. 🔴 **Un cierre NUNCA inventa un conteo.** Sin `conteo`, la gaveta se cierra con
 *    `actualAmount` y `overShort` en NULL y **sin evento `CLOSE`** — un evento lleva `amount` y una
 *    fila en cero se lee como un arqueo. Es la regla 1 de `cashDrawerAutoClose` y la misma que ya
 *    cumple el relevo al abrir. Escribir un 0 le firmaría al cajero un faltante del tamaño de las
 *    ventas del día.
 * 2. 🔴 **Nunca se cierra el registro de otro.** La gaveta que se cierra tiene que haber estado
 *    abierta ANTES del cierre del turno y no pertenecer a otro turno. Sin ese filtro, un relevo que
 *    caiga en los milisegundos siguientes al cierre —la caja de la tarde abriéndose— se cerraría
 *    sola, dejando a su turno nuevo sin gaveta.
 * 3. 🔴 **La segunda mitad NUNCA tumba a la primera.** Cuando esto corre, el gesto que llamó ya
 *    commiteó su parte y el dinero ya está firmado, así que un fallo aquí se reporta y nunca se
 *    convierte en un error para quien está en el mostrador.
 *
 *    🔴 **Lo que ese fallo deja NO es «lo de hoy», y esta regla lo afirmaba hasta el 3-sep-2026**
 *    (auditoría de Codex). Con la apertura ya unificada el estado partido hace daño de dinero en
 *    las dos direcciones —mezcla jornadas, o deja una gaveta tragando efectivo sin turno—, y por
 *    eso NO se tolera: se deja reparable (`asegurarLaLiga` en `shared/parejaDeCierre.ts`) y lo
 *    completa el barrido `cash-close-pair-reconciler`. Tolerar el fallo aquí es lo correcto; darlo
 *    por inocuo, no.
 */
export type OrigenDelCierre = 'CAJA_MOVIL' | 'TURNO_TPV'

export interface CerrarTurnoDeCajaParams {
  venueId: string
  /**
   * Quién cerró. Va al historial del cajón (`closedByStaffId`) y a la bitácora.
   *
   * 🔴 `null` cuando no se sabe (un script, o un llamador sin contexto de sesión). NO se cae a
   * «quien abrió»: eso afirmaría que el que abrió también cerró, que es justo lo que estas
   * columnas existen para dejar de suponer.
   */
  staffId: string | null
  staffName?: string | null
  source: OrigenDelCierre
  /** El registro que el gesto que llama YA cerró. El OTRO es el que se cierra aquí. */
  yaCerrado: { shiftId: string } | { cashDrawerSessionId: string }
  /**
   * El conteo físico, si alguien contó. 🔴 `null` = nadie contó, y entonces NADA se inventa.
   * ⚠️ `Decimal(0)` es un objeto y por tanto truthy: quien decide siempre es `!= null`, nunca un
   * `&&` — contar cero es un conteo REAL (una gaveta vacía con $2,000 esperados es un faltante de
   * $2,000, el caso más importante que este cierre tiene que acertar).
   */
  conteo: Prisma.Decimal | null
  /**
   * El esperado de la gaveta, ya resuelto. Es lo que hace que los DOS cierres firmen el MISMO
   * número, y viaja en las DOS direcciones:
   *
   *   · desde `CAJA_MOVIL` lo calculó la gaveta al cerrarse; sin él, el turno recalcularía su
   *     esperado contra un `Shift.startingCash` congelado en la apertura, ciego a los retiros y al
   *     refondeo;
   *   · desde `TURNO_TPV` lo calculó el turno al reclamar. 🔴 Entre ese instante y esta escritura
   *     pasan SEGUNDOS (consulta de pagos, armado del reporte, transacción, publicación al POS,
   *     broadcast), y una venta en efectivo en esa ventana postea su `CASH_SALE` a la gaveta
   *     abierta: releer los eventos aquí haría que la gaveta firmara `overShort = −venta` mientras
   *     el turno firma `0`. La foto es una sola; las firmas, dos.
   *
   * Ausente ⇒ se calcula de los eventos de la gaveta (el camino de siempre).
   */
  esperadoDelCajon?: Prisma.Decimal | null
  /**
   * A qué turno pertenece la gaveta que se acaba de cerrar (sólo desde `CAJA_MOVIL`).
   *
   * 🔴 Es el espejo del `OR` de `gavetaCerrable`, y protege del mismo escenario al revés: si la
   * gaveta pertenecía al turno A y el abierto ahora es B, cerrar B con el conteo y el esperado de A
   * le firmaría una diferencia sobre dinero que nunca tuvo. `null` (gaveta sin turno ligado, o
   * anterior a la liga) sí puede cerrar el que esté abierto, por la misma razón que el `OR`.
   */
  shiftIdDeLaGaveta?: string | null
  note?: string | null
  now?: () => Date
}

export interface CerrarTurnoDeCajaResult {
  /** Lo que ESTA llamada cerró. Ausente = no había nada que cerrar, o alguien se adelantó. */
  shiftCerradoId?: string
  cajaCerradaId?: string
  /** `true` sólo si el registro cerrado aquí llevó un conteo físico. */
  conConteo: boolean
  /** Por qué no se cerró nada. Va al log; nunca es un error para el mostrador. */
  motivo?: 'SIN_PAREJA' | 'YA_CERRADO' | 'CIERRE_EN_CURSO'
}

/**
 * Autor de un `CashDrawerEvent` que no tiene una persona detrás (un script, un cierre sin sesión).
 *
 * 🔴 NO es una convención nueva: `shared/cashDrawerPosting.ts` ya escribe exactamente
 * `posting.staffId || 'SYSTEM'` en ESTA MISMA TABLA y la vuelve a leer para no atribuirle la
 * bitácora a nadie. Hace falta porque `CashDrawerEvent.staffId` y `staffName` son **columnas NO
 * NULABLES**: un `null` ahí tumba la transacción entera y deja al cajero sin poder cerrar la caja.
 * Por eso no se resuelve volviendo la columna nulable —cambiaría el TIPO de dos campos que las
 * apps de la calle ya reciben— ni cayendo a «quien abrió», que sería afirmar algo falso.
 */
export const STAFF_ID_DEL_SISTEMA = 'SYSTEM'

/** Su gemelo legible, el mismo que usa `resolveStaffName` de `cashDrawerPosting`. */
export const NOMBRE_DEL_SISTEMA = 'Sistema'

/** Va en `closingNote` cuando la PAX cierra el turno sin mandar un conteo. Nadie contó, y se dice. */
export const NOTA_DEL_CIERRE_SIN_CONTEO =
  '[Sistema] Cerrada al cerrar el turno de caja desde la terminal. SIN CONTEO FÍSICO: no hay monto real ni diferencia.'

export async function cerrarTurnoDeCaja(parametros: CerrarTurnoDeCajaParams): Promise<CerrarTurnoDeCajaResult> {
  return 'shiftId' in parametros.yaCerrado
    ? cerrarLaGavetaDelTurno(parametros, parametros.yaCerrado.shiftId)
    : cerrarElTurnoDeLaGaveta(parametros, parametros.yaCerrado.cashDrawerSessionId)
}

/**
 * La gaveta que se puede cerrar cuando se cierra un turno: abierta, de ESTE negocio, abierta ANTES
 * del instante del cierre, y de este turno o de ninguno.
 *
 * 🔴 Los tres filtros de más son la regla 2: sin `openedAt <= momento` una caja abierta un
 * milisegundo después del cierre (el relevo de la tarde) se cerraría sola; sin el `OR` sobre
 * `shiftId` se le arrancaría la gaveta a un turno ajeno.
 */
function gavetaCerrable(venueId: string, shiftId: string, momento: Date) {
  return { venueId, status: 'OPEN' as const, openedAt: { lte: momento }, OR: [{ shiftId }, { shiftId: null }] }
}

/**
 * El efectivo que DEBE haber en la gaveta que el cajero tiene enfrente, o `null` si no hay ninguna
 * abierta que pertenezca a este turno.
 *
 * 🔴 Es el número con el que el cierre del turno tiene que comparar el conteo, y no
 * `Shift.startingCash + ventas en efectivo`. Esa fórmula es ciega a dos cosas que sí mueven el
 * dinero físico:
 *
 *   · **los retiros.** Un `PAY_OUT` de $50 baja el esperado de la gaveta y no toca el del turno, así
 *     que el cierre de la PAX firma un faltante de $50 que nadie causó.
 *   · **el refondeo a media jornada.** `Shift.startingCash` es un ESCALAR: si la gaveta se cierra a
 *     las 15:00 y se abre otra con $500, el turno sigue creyendo que su fondo son los $2,000 de la
 *     mañana y que las ventas del día entero están en la caja. En ese escenario las dos fórmulas
 *     difieren en el fondo viejo MÁS las ventas ya retiradas.
 *
 * Devolver `null` no es un fallo: es el venue que no usa el módulo de caja, y ahí el cierre se
 * queda con la fórmula de siempre, byte a byte.
 */
export async function esperadoDelCajonAbierto(
  venueId: string,
  shiftId: string,
  momento: Date,
): Promise<{ sessionId: string; esperado: Prisma.Decimal } | null> {
  const gaveta = await prisma.cashDrawerSession.findFirst({
    where: gavetaCerrable(venueId, shiftId, momento),
    select: { id: true, startingAmount: true, events: { select: { type: true, amount: true } } },
    orderBy: { openedAt: 'desc' },
  })
  if (!gaveta) return null

  const { calculateExpectedAmount } = await import('../mobile/cash-drawer.mobile.service')
  const esperado = calculateExpectedAmount({ startingAmount: gaveta.startingAmount, events: gaveta.events })
  return { sessionId: gaveta.id, esperado: new Prisma.Decimal(esperado.toFixed(2)) }
}

async function cerrarLaGavetaDelTurno(p: CerrarTurnoDeCajaParams, shiftId: string): Promise<CerrarTurnoDeCajaResult> {
  const { venueId, staffId, source, conteo } = p
  const ahora = (p.now ?? (() => new Date()))()
  const staffName = await nombreDeQuienCierra(staffId, p.staffName)

  const gaveta = await prisma.cashDrawerSession.findFirst({
    where: gavetaCerrable(venueId, shiftId, ahora),
    select: { id: true, startingAmount: true },
    orderBy: { openedAt: 'desc' },
  })
  if (!gaveta) {
    logger.info('[TURNO DE CAJA] El turno se cerró sin gaveta abierta que cerrar', { venueId, shiftId, source })
    return { conConteo: false, motivo: 'SIN_PAREJA' }
  }

  // La MISMA fórmula del arqueo de la tablet (`calculateExpectedAmount`), no una copia: dos
  // fórmulas serían dos verdades para el mismo dinero. Import dinámico para no cerrar el ciclo
  // `mobile → shared → mobile`, igual que hace `shared/cashDrawerPosting.ts`.
  const { calculateExpectedAmount } = await import('../mobile/cash-drawer.mobile.service')

  const resultado = await prisma.$transaction(async tx => {
    // 🔴 El CAS va PRIMERO y toma el candado de la fila: un cobro que quiera sumar al cajón espera
    // y al re-evaluar ya no encuentra la caja abierta. Lo que se lee bajo el candado es lo que se
    // firma. Es exactamente el orden de `closeSession`.
    const gano = await tx.cashDrawerSession.updateMany({
      where: { id: gaveta.id, venueId, status: 'OPEN' },
      data: {
        status: 'CLOSED',
        closedAt: ahora,
        // Sí hubo una persona: fue quien cerró el turno. `actualAmount` en NULL sigue siendo la
        // señal de «nadie contó» que ya leen el dashboard (`counted`) y las apps.
        closedByStaffId: staffId,
        closedByName: staffName,
        closingNote: conteo != null ? p.note || null : NOTA_DEL_CIERRE_SIN_CONTEO,
        ...(conteo != null ? { actualAmount: conteo } : {}),
      },
    })
    if (gano.count !== 1) return null

    if (conteo == null) return { esperado: null as number | null, overShort: null as number | null }

    // 🔴 El esperado que firmó el turno MANDA cuando viene dado. Recalcularlo aquí sería una
    // SEGUNDA foto, tomada segundos después: una venta en efectivo en esa ventana la cambia y las
    // dos mitades firmarían números distintos del mismo billete. Cuando no viene, se calcula de los
    // eventos con la MISMA fórmula que ve el cajero en la tablet (`calculateExpectedAmount`).
    //
    // La garantía también se conserva DESPUÉS del cierre: una reposición tardía recalcula el
    // `overShort` y, si esta gaveta trae su `shiftId` explícito hacia el mismo conteo cerrado,
    // `cashDrawerPosting` actualiza el `cashDifference` con la misma Decimal dentro de la misma
    // transacción. Una liga ausente, ambigua o que cambió concurrentemente queda visible como
    // reconciliación pendiente en la bitácora; nunca se adivina un turno por reloj.
    const esperado =
      p.esperadoDelCajon != null
        ? Number(p.esperadoDelCajon)
        : calculateExpectedAmount({
            startingAmount: gaveta.startingAmount,
            events: await tx.cashDrawerEvent.findMany({ where: { sessionId: gaveta.id }, orderBy: { createdAt: 'asc' } }),
          })
    // ⚠️ EXCEPCIÓN CONSCIENTE a «dinero nunca en float»: `calculateExpectedAmount` devuelve `number`
    // y `closeSession` calcula su `overShort` así desde siempre. Hacerlo aquí con `Decimal` podría
    // dar un centavo distinto del que la tablet acaba de enseñarle al cajero para LA MISMA gaveta,
    // que es peor que el redondeo: la paridad entre los dos cierres vale más aquí. Se redondea a
    // centavos antes de persistir, y la columna sigue siendo `Decimal`.
    const overShort = Number((Number(Number(conteo).toFixed(2)) - esperado).toFixed(2))
    await tx.cashDrawerSession.update({ where: { id: gaveta.id }, data: { overShort: new Prisma.Decimal(overShort.toFixed(2)) } })
    await tx.cashDrawerEvent.create({
      data: {
        sessionId: gaveta.id,
        venueId,
        type: 'CLOSE',
        amount: conteo,
        // Columnas NO NULABLES: sin persona va la centinela que esta misma tabla ya usa.
        staffId: staffId ?? STAFF_ID_DEL_SISTEMA,
        staffName,
        note: p.note || null,
      },
    })
    return { esperado, overShort }
  })

  if (!resultado) {
    // Benigno: alguien la cerró primero, que es el estado que queríamos.
    logger.info('[TURNO DE CAJA] Otro aparato ya había cerrado la gaveta del turno', { venueId, shiftId, cajaId: gaveta.id })
    return { conConteo: false, motivo: 'YA_CERRADO' }
  }

  void logAction({
    staffId,
    venueId,
    action: 'CASH_DRAWER_CLOSED',
    entity: 'CashDrawerSession',
    entityId: gaveta.id,
    data: {
      expectedAmount: resultado.esperado,
      actualAmount: conteo != null ? Number(conteo) : null,
      overShort: resultado.overShort,
      sinConteo: conteo == null,
      shiftId,
      source,
    },
  })

  logger.info('[TURNO DE CAJA] Cierre resuelto: la gaveta se cerró con el turno', {
    venueId,
    shiftId,
    cajaCerradaId: gaveta.id,
    conConteo: conteo != null,
    source,
  })

  return { cajaCerradaId: gaveta.id, conConteo: conteo != null }
}

async function cerrarElTurnoDeLaGaveta(p: CerrarTurnoDeCajaParams, cashDrawerSessionId: string): Promise<CerrarTurnoDeCajaResult> {
  const { venueId, staffId, source, conteo } = p

  const turno = await turnoAbiertoDelNegocio(prisma, venueId)
  if (!turno) {
    logger.info('[TURNO DE CAJA] La gaveta se cerró sin turno abierto que cerrar', { venueId, cashDrawerSessionId, source })
    return { conConteo: false, motivo: 'SIN_PAREJA' }
  }

  // 🔴 PERTENENCIA — el espejo del `OR` de `gavetaCerrable`, y protege del mismo daño al revés.
  //
  // Escenario alcanzable, degradado sobre degradado: la PAX cierra el turno A a las 20:05 y la
  // mitad de la gaveta falla (se queda en el `try/catch`), así que la gaveta sigue OPEN ligada a A;
  // 20:20 se abre el turno B; 20:30 se reproduce el cierre encolado de la tablet. Su `sessionId`
  // sigue siendo el de la única gaveta abierta, así que pasa la guarda del 404 — y sin esto
  // cerraría **B** con el conteo y el esperado de **A**, firmándole una diferencia sobre dinero que
  // ese turno nunca tuvo.
  //
  // Una gaveta SIN turno ligado (anterior a la liga, o abierta sin turno) sí puede cerrar el que
  // esté abierto: es la misma razón por la que el `OR` de la otra dirección acepta `shiftId: null`.
  if (p.shiftIdDeLaGaveta != null && p.shiftIdDeLaGaveta !== turno.id) {
    logger.warn('[TURNO DE CAJA] La gaveta pertenece a OTRO turno; no se cierra el que está abierto', {
      venueId,
      cashDrawerSessionId,
      turnoDeLaGaveta: p.shiftIdDeLaGaveta,
      turnoAbierto: turno.id,
      source,
    })
    return { conConteo: false, motivo: 'SIN_PAREJA' }
  }

  // Import dinámico: `tpv/shift.tpv.service` ya importa este módulo (`abrirTurnoDeCaja`), así que
  // uno estático cerraría el ciclo. Es el mismo recurso que usa `shared/cashDrawerPosting.ts`.
  const { cerrarTurnoPorCierreDeCaja } = await import('../tpv/shift.tpv.service')

  try {
    const cerrado = await cerrarTurnoPorCierreDeCaja(venueId, turno.id, {
      conteo,
      esperadoDelCajon: p.esperadoDelCajon ?? null,
      actorStaffId: staffId,
      cashDrawerSessionId,
    })
    logger.info('[TURNO DE CAJA] Cierre resuelto: el turno se cerró con la gaveta', {
      venueId,
      cashDrawerSessionId,
      shiftCerradoId: cerrado.id,
      conConteo: conteo != null,
      source,
    })
    return { shiftCerradoId: cerrado.id, conConteo: conteo != null }
  } catch (error) {
    // 🔴 Regla 3: el conteo de la gaveta YA está commiteado y el cajero ya lo vio, así que un turno
    // que no se pudo cerrar NO se convierte en un error en el mostrador.
    //
    // 🔴 **No «se queda abierto y lo recoge el relevo de mañana», que es lo que decía este
    // comentario hasta el 3-sep-2026** (auditoría de Codex): antes del relevo puede recogerlo la
    // apertura de ESTA tarde, que lo REUSA por ser del mismo día de negocio, y entonces un solo
    // turno firma dos arqueos. Lo recoge `cash-close-pair-reconciler` en el siguiente minuto.
    logger.error('[TURNO DE CAJA] La gaveta se cerró pero el turno no; queda abierto', {
      venueId,
      cashDrawerSessionId,
      shiftId: turno.id,
      source,
      error: error instanceof Error ? error.message : String(error),
    })
    return { conConteo: false, motivo: 'CIERRE_EN_CURSO' }
  }
}
