/**
 * Mobile Cash Drawer Service
 *
 * Cash drawer session management for iOS/Android POS apps.
 * Tracks open/close, pay-in, pay-out, and cash sales.
 */

import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, InternalServerError, NotFoundError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import { abrirTurnoDeCaja, cerrarTurnoDeCaja, turnoAbiertoDelNegocio } from '../shared/turnoDeCaja'
import { asegurarLaLiga } from '../shared/parejaDeCierre'
import { Decimal } from '@prisma/client/runtime/library'
import { CashDrawerEventType, Prisma } from '@prisma/client'

/**
 * Largo máximo de la llave de idempotencia que un cliente puede mandar.
 *
 * 🔴 NO es un número al azar: es el techo de lo que la propia plataforma genera, con holgura.
 * Las llaves reales de hoy son un UUID del POS (36) o una derivada del `paymentId`
 * (`srv-cash-sale:` + cuid = 39, el más largo del repo — ver `shared/cashDrawerPosting.ts`).
 * 64 deja sitio para un prefijo nuevo o un id más largo sin que ninguna llave legítima quepa
 * justa, y a la vez impide que un cliente meta kilobytes en una columna INDEXADA: sin tope,
 * una llave gigante o revienta el índice btree de Postgres con un error críptico (500 por lo
 * que debería ser un 400) o infla el índice del que depende la protección contra el doble
 * cobro. El límite se aplica en TODAS las puertas que aceptan la llave del cliente
 * (`pay-in`, `pay-out`, `sync`), no sólo en las nuevas.
 */
const LOCAL_ID_MAX_LENGTH = 64

/**
 * Normaliza la llave que manda el cliente: ausente → `null` (app vieja, sigue igual);
 * presente pero inservible → 400 explícito, nunca un 500 desde el índice.
 *
 * NO se recorta el valor: la llave la elige el cliente y tiene que poder reenviar EXACTAMENTE
 * la misma cadena para que el dedupe empareje. Sólo se rechaza la que no sirve como llave.
 */
function normalizeLocalId(raw: unknown, campo = 'localId'): string | null {
  if (raw === undefined || raw === null) return null

  if (typeof raw !== 'string') {
    throw new BadRequestError(`${campo} debe ser texto`)
  }
  if (raw.trim().length === 0) {
    throw new BadRequestError(`${campo} no puede venir vacío`)
  }
  if (raw.length > LOCAL_ID_MAX_LENGTH) {
    throw new BadRequestError(`${campo} no puede exceder ${LOCAL_ID_MAX_LENGTH} caracteres`)
  }

  return raw
}

// ============================================================================
// GET CURRENT SESSION
// ============================================================================

/**
 * Get the current open cash drawer session for a venue, including all events.
 */
export async function getCurrentSession(venueId: string, incluirEsperado = false) {
  const session = await prisma.cashDrawerSession.findFirst({
    where: { venueId, status: 'OPEN' },
    include: {
      events: {
        orderBy: { createdAt: 'desc' },
      },
    },
  })

  if (!session) {
    return null
  }

  return formatSession(session, incluirEsperado)
}

// ============================================================================
// OPEN SESSION
// ============================================================================

interface OpenSessionParams {
  venueId: string
  staffId: string
  staffName: string
  startingAmount: number // dollars (e.g. 10.50 = $10.50)
  deviceName?: string
}

/**
 * Open a new cash drawer session. Only one session can be open per venue at a time.
 */
/**
 * Las apps mandan `staffName` opcional y el controlador rellenaba 'Staff' cuando faltaba — así el
 * dashboard («Caja física») decía "Abierta por Staff" (visto en /full-testing 27-ago). Si viene un
 * nombre real se respeta; si no, se resuelve del `Staff` y sólo en último caso queda 'Staff'.
 */
async function resolveMobileStaffName(staffId: string | null | undefined, provided?: string | null): Promise<string> {
  const given = (provided || '').trim()
  if (given && given !== 'Staff') return given
  if (!staffId) return given || 'Staff'
  try {
    const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { firstName: true, lastName: true } })
    const name = [staff?.firstName, staff?.lastName].filter(Boolean).join(' ').trim()
    return name || given || 'Staff'
  } catch {
    return given || 'Staff'
  }
}

/**
 * Abre la caja desde la tablet — la puerta del POS móvil (`POST /mobile/venues/:id/cash-drawer/open`).
 *
 * 🔴 **Desde la Fase 2 (3-sep-2026) esta ruta NO abre sólo el cajón: abre EL TURNO DE CAJA DEL
 * NEGOCIO**, que es un solo gesto con dos registros ligados (`abrirTurnoDeCaja` en
 * `shared/turnoDeCaja.ts`). Antes el negocio abría dos cosas cada mañana —la Caja aquí con su fondo
 * y el Turno en la PAX con otro— para UNA sola gaveta física, y los cobros de quien no había
 * abierto turno caían FUERA de todo turno (Testarudo, 1-sep-2026: 78 de 92 cobros, $10,337).
 *
 * **Quien llama sigue siendo la ruta de SIEMPRE, y ése es el punto**: Android e iOS reciben el gesto
 * único sin actualizarse, y el servidor se puede desplegar solo.
 *
 * ── Qué cambia para el POS, y qué no ───────────────────────────────────────────────────────
 *
 * · La respuesta es la sesión de siempre (`formatSession`, campo por campo) MÁS `shiftId`, aditivo
 *   y opcional: los dos clientes parsean sólo las llaves que declaran.
 * · Con una caja ya abierta ya **no** contesta 409 «Ya existe una caja abierta»: LIGA y devuelve la
 *   que hay. Los dos clientes ya trataban ese 409 cayendo a `syncCurrentSession()` para adoptar la
 *   caja del servidor; ahora la adoptan directo, en la misma respuesta.
 * · Aparece un rechazo nuevo: con un cierre de TURNO en curso contesta 409 `SHIFT_CLOSE_IN_PROGRESS`
 *   y no abre nada. Es transitorio (milisegundos) y el POS ya abrió su caja en local; su siguiente
 *   `GET /current` la adopta. Ver el reporte de la Task 4 para el análisis del código de estado.
 *
 * @param incluirEsperado ¿el llamante tiene `cash-drawer:view-expected`? Al abrir, el esperado
 * ES el fondo que la persona acaba de teclear, así que ocultarlo no protege nada — pero sin el
 * flag el mismo usuario lo veía en `current` y no aquí, y un contrato que responde distinto
 * según el endpoint es el tipo de incoherencia que después nadie sabe explicar.
 */
export async function openSession(params: OpenSessionParams, incluirEsperado = false) {
  const { venueId, staffId, startingAmount, deviceName } = params

  // 🔴 La validación se queda AQUÍ, con su mensaje de siempre. `abrirTurnoDeCaja` también rechaza un
  // fondo negativo, pero con otro texto ("El fondo inicial…"), y ese texto es lo que el cajero ve.
  if (startingAmount < 0) {
    throw new BadRequestError('El monto inicial no puede ser negativo')
  }

  const apertura = await abrirTurnoDeCaja({
    venueId,
    staffId,
    // El nombre lo resuelve el servicio con la MISMA regla que `resolveMobileStaffName` (si llega
    // el placeholder 'Staff' se saca del registro), sin repetir la consulta.
    staffName: params.staffName,
    startingCash: startingAmount,
    deviceName,
    source: 'CAJA_MOVIL',
  })

  // Se relee con los eventos porque el POS calcula su esperado EN EL APARATO a partir de ellos: sin
  // el evento OPEN, una caja recién abierta se leería con $0 de fondo. `formatSession` es la MISMA
  // función de `current` y de `close`, así que la forma no puede divergir entre endpoints.
  const session = await prisma.cashDrawerSession.findUnique({
    where: { id: apertura.cashDrawerSessionId },
    include: { events: { orderBy: { createdAt: 'desc' } } },
  })
  if (!session) {
    // Imposible salvo que alguien borre la sesión entre la transacción y esta lectura.
    throw new InternalServerError('La caja se abrió pero no se pudo releer')
  }

  // `logAction(CASH_DRAWER_OPENED)` ya lo escribe `abrirTurnoDeCaja` — aquí duplicarlo pondría dos
  // renglones por apertura en la bitácora que el dueño audita.
  return { ...formatSession(session, incluirEsperado), shiftId: apertura.shiftId }
}

// ============================================================================
// PAY IN
// ============================================================================

interface PayInOutParams {
  venueId: string
  staffId: string
  staffName: string
  amount: number // dollars (e.g. 20.00 = $20.00)
  note?: string
  /**
   * Caja a la que pertenece el movimiento (cola offline, Codex 3ª auditoría). Sin él se usa la abierta.
   * Si ESA caja ya cerró, el movimiento se acepta igual sobre ella —el dinero sí salió del cajón— con
   * recálculo del overShort y bitácora `CASH_DRAWER_ADJUSTED_AFTER_CLOSE`; nunca se carga a otra caja.
   */
  sessionId?: string | null
  /**
   * 🔴 LLAVE DE IDEMPOTENCIA DEL POS. OPCIONAL y ADITIVA (contrato /mobile: una app ya
   * distribuida que no la mande se comporta EXACTAMENTE como hoy).
   *
   * Es el id con el que la app guarda el movimiento en su base local — Android
   * `CashDrawerEventEntity.id`, un UUID estable; iOS el suyo — la MISMA llave que ya viaja
   * por `/cash-drawer/sync`. El push de un ingreso/retiro es fire-and-forget: si la respuesta
   * se pierde, el POS reintenta el MISMO movimiento y sin llave el servidor crea una SEGUNDA
   * fila que el arqueo da por buena (efectivo inventado, +$100 medido en Android).
   */
  localId?: string | null
}

/**
 * Lo que devuelven `payIn` / `payOut`.
 *
 * `created` es la señal con la que el controlador elige el código HTTP: **201 cuando la fila
 * se creó, 200 cuando la llave ya existía** y se devuelve la que ya estaba. El CUERPO es
 * idéntico en los dos casos, así que un cliente que ignore el código sigue funcionando.
 */
export interface DrawerEventResult {
  event: ReturnType<typeof formatEvent>
  /** `false` = reintento: no se creó nada, se devolvió el movimiento que ya existía. */
  created: boolean
}

/**
 * Registra un movimiento manual del cajero (ingreso o retiro), idempotente por `localId`.
 *
 * 🔴 EL PUNTO ENTERO ES EL REINTENTO. El caso real no es un cliente hostil: es la respuesta
 * que se pierde (WiFi del local, 502 del proxy, la app que se reinicia a media petición) y el
 * POS que reenvía el MISMO retiro. Sin llave eso era un SEGUNDO retiro; con ella el índice
 * `@@unique([venueId, localId])` lo bloquea y se devuelve el movimiento original.
 *
 * `createMany` + `skipDuplicates` en vez de `create`: con `create`, el choque lanza P2002 y el
 * cajero vería un error 500 por una operación que SÍ había funcionado — y volvería a teclearla.
 * Es el mismo patrón que ya usa `services/shared/cashDrawerPosting.ts` para lo que escribe el
 * servidor, para que haya UNA sola forma de escribir en esta tabla.
 *
 * GANA LA PRIMERA ESCRITURA: un reenvío con la misma llave y otro monto NO reescribe la fila.
 * Si pudiera, la idempotencia se convertiría en una puerta para mover dinero sin dejar rastro.
 */
async function recordManualDrawerEvent(type: 'PAY_IN' | 'PAY_OUT', params: PayInOutParams): Promise<DrawerEventResult> {
  const { venueId, staffId, amount, note } = params
  const staffName = await resolveMobileStaffName(staffId, params.staffName)

  if (amount <= 0) {
    throw new BadRequestError('El monto debe ser mayor a 0')
  }

  // Se valida ANTES de tocar la base: una llave basura no puede llegar al índice único.
  const localId = normalizeLocalId(params.localId)
  const session = params.sessionId
    ? await prisma.cashDrawerSession.findFirst({ where: { id: params.sessionId, venueId }, select: { id: true, status: true } })
    : await getOpenSession(venueId)
  if (!session) throw new NotFoundError('Esa caja no existe en este negocio')
  const amountDecimal = dollarsToDecimal(amount)

  const row = {
    sessionId: session.id,
    venueId,
    type,
    amount: amountDecimal,
    staffId,
    staffName,
    note: note || null,
    localId,
  }

  const action = type === 'PAY_IN' ? 'CASH_DRAWER_PAY_IN' : 'CASH_DRAWER_PAY_OUT'

  const auditar = (entityId: string) =>
    logAction({
      staffId,
      venueId,
      action,
      entity: 'CashDrawerEvent',
      entityId,
      data: { sessionId: session.id, amount: Number(amountDecimal), note, source: 'MOBILE' },
    })

  // Sin llave: EXACTAMENTE el `create` de siempre. Las apps ya distribuidas no cambian de
  // camino ni de comportamiento — simplemente no ganan la protección (Postgres permite
  // varios NULL en un índice único, así que aquí no hay nada que deduplicar).

  // 🔴 Caja YA CERRADA (llega tarde desde la cola de un aparato): el dinero sí salió/entró del cajón,
  // así que el movimiento se acepta SOBRE ESA caja, bajo candado, con recálculo del overShort firmado y
  // bitácora con los valores anterior/nuevo. Cargarlo a la caja abierta de hoy sería atribuirlo mal;
  // rechazarlo, perderlo.
  if ((session as { status?: string }).status === 'CLOSED') {
    const result = await prisma.$transaction(async tx => {
      await tx.cashDrawerSession.updateMany({ where: { id: session.id }, data: { updatedAt: new Date() } })
      const inserted = localId
        ? await tx.cashDrawerEvent.createMany({ data: [row], skipDuplicates: true })
        : { count: (await tx.cashDrawerEvent.create({ data: row })) ? 1 : 0 }
      const stored = localId
        ? await tx.cashDrawerEvent.findFirst({ where: { venueId, localId } })
        : await tx.cashDrawerEvent.findFirst({ where: { sessionId: session.id, type }, orderBy: { createdAt: 'desc' } })
      if (!stored) throw new InternalServerError('No se pudo confirmar el movimiento de caja')
      if (inserted.count > 0) {
        const full = await tx.cashDrawerSession.findUnique({
          where: { id: session.id },
          select: { actualAmount: true, overShort: true, startingAmount: true, events: { select: { type: true, amount: true } } },
        })
        if (full && full.actualAmount !== null) {
          const expected = calculateExpectedAmount({ startingAmount: full.startingAmount, events: full.events })
          const overShort = Number(full.actualAmount) - expected
          await tx.cashDrawerSession.update({ where: { id: session.id }, data: { overShort: new Decimal(overShort.toFixed(2)) } })
          logAction({
            staffId,
            venueId,
            action: 'CASH_DRAWER_ADJUSTED_AFTER_CLOSE',
            entity: 'CashDrawerSession',
            entityId: session.id,
            data: {
              cause: type,
              eventId: stored.id,
              amount: Number(amountDecimal),
              overShortBefore: full.overShort != null ? Number(full.overShort) : null,
              overShortAfter: overShort,
              expectedAfter: expected,
              source: 'MOBILE_OFFLINE_REPLAY',
            },
          })
        }
      }
      return { stored, created: inserted.count > 0 }
    })
    if (result.created) auditar(result.stored.id)
    return { event: formatEvent(result.stored), created: result.created }
  }
  // 🔴 P1 (Codex, 2ª auditoría): el movimiento MANUAL se colaba en una caja que el cierre acababa de
  // firmar. Mismo candado que la venta: dentro de la transacción se TOCA la fila con status='OPEN'
  // (UPDATE = candado de fila); si el cierre ya la marcó CLOSED, al re-evaluar no hay fila y el
  // movimiento se rechaza con el mismo "no hay caja abierta" que las apps ya conocen.
  const lockOrThrow = async (tx: Prisma.TransactionClient) => {
    const lock = await tx.cashDrawerSession.updateMany({ where: { id: session.id, status: 'OPEN' }, data: { updatedAt: new Date() } })
    if (!lock || lock.count === 0) throw new NotFoundError('No hay una caja abierta')
  }
  if (!localId) {
    const event = await prisma.$transaction(async tx => {
      await lockOrThrow(tx)
      return tx.cashDrawerEvent.create({ data: row })
    })
    auditar(event.id)
    return { event: formatEvent(event), created: true }
  }
  const result = await prisma.$transaction(async tx => {
    await lockOrThrow(tx)
    return tx.cashDrawerEvent.createMany({ data: [row], skipDuplicates: true })
  })
  const stored = await prisma.cashDrawerEvent.findFirst({ where: { venueId, localId } })

  if (!stored) {
    // No debería ocurrir: o lo acabamos de insertar, o ya estaba. Si la relectura falla no
    // podemos devolverle al POS la fila que tiene que adoptar, y mentir con una fila
    // inventada sería peor: se responde error y el reintento vuelve a deduplicar.
    logger.error('❌ [CASH-DRAWER] Movimiento guardado pero imposible de releer por su llave', { venueId, localId, type })
    throw new InternalServerError('No se pudo confirmar el movimiento de caja')
  }

  const created = result.count > 0

  if (created) {
    auditar(stored.id)
  } else {
    // Ni auditoría nueva ni fila nueva: el movimiento es el mismo de antes.
    logger.info('💵 [CASH-DRAWER] Movimiento manual ya registrado (reintento) — se devuelve el original, no se duplica', {
      venueId,
      sessionId: session.id,
      type,
      localId,
      eventId: stored.id,
    })
  }

  return { event: formatEvent(stored), created }
}

/**
 * Add a pay-in event (cash added to drawer). Idempotente por `localId` — ver
 * `recordManualDrawerEvent`.
 */
export async function payIn(params: PayInOutParams): Promise<DrawerEventResult> {
  return recordManualDrawerEvent('PAY_IN', params)
}

// ============================================================================
// PAY OUT
// ============================================================================

/**
 * Add a pay-out event (cash removed from drawer). Idempotente por `localId` — ver
 * `recordManualDrawerEvent`.
 */
export async function payOut(params: PayInOutParams): Promise<DrawerEventResult> {
  return recordManualDrawerEvent('PAY_OUT', params)
}

// ============================================================================
// CLOSE SESSION
// ============================================================================

interface CloseSessionParams {
  /** Id de la caja que el aparato cerró (cola offline). Si ya no es la abierta, 404 en vez de cerrar otra. */
  sessionId?: string | null
  venueId: string
  staffId: string
  staffName: string
  actualAmount: number // dollars
  note?: string
}

/**
 * Cierra la caja desde la tablet — la puerta del POS móvil (`POST /mobile/…/cash-drawer/close`).
 *
 * 🔴 **Desde la Task 5 (3-sep-2026) esta ruta NO cierra sólo el cajón: cierra EL TURNO DE CAJA DEL
 * NEGOCIO**, que es un solo gesto con dos registros ligados (`cerrarTurnoDeCaja` en
 * `shared/turnoDeCaja.ts`). Antes `closeSession` no tocaba el `Shift` —cero referencias—, así que
 * el turno seguía abierto hasta el relevo de la mañana siguiente, sus totales seguían creciendo con
 * las ventas del cajero siguiente, y la PAX no se enteraba de nada porque el aviso `shift closed`
 * sólo lo emite el cierre del turno.
 *
 * **Quien llama sigue siendo la ruta de SIEMPRE**: Android e iOS reciben el gesto único sin
 * actualizarse. La respuesta conserva EXACTAMENTE los campos de hoy MÁS `shiftId` (aditivo y
 * opcional; una app instalada no puede notar un campo que no lee).
 *
 * 🔴 El ORDEN es la garantía: la gaveta se cierra y se commitea PRIMERO —el cajero ya contó y ese
 * dinero ya está firmado—, y sólo después se cierra el turno. Un fallo en la segunda mitad jamás
 * convierte un cierre bueno en un error en el mostrador.
 *
 * 🔴 **Lo que ese fallo deja NO es «lo de hoy», y este comentario lo afirmaba hasta el 3-sep-2026**
 * (auditoría de Codex). Con la apertura ya unificada, el turno que sobrevive a su gaveta lo REUSA
 * la cajera de la tarde —`abrirTurnoDeCaja` sólo releva turnos de un día de negocio ANTERIOR— y
 * acaba firmando dos arqueos con los totales del día entero. Por eso el fallo no se tolera: se
 * deja REPARABLE (`asegurarLaLiga`, abajo) y lo completa `cash-close-pair-reconciler`.
 */
export async function closeSession(params: CloseSessionParams) {
  const { venueId, staffId, actualAmount, note } = params
  const staffName = await resolveMobileStaffName(staffId, params.staffName)

  if (actualAmount < 0) {
    throw new BadRequestError('El monto no puede ser negativo')
  }

  const session = await prisma.cashDrawerSession.findFirst({
    where: { venueId, status: 'OPEN' },
    // 🔴 `startingAmount` viene de SU COLUMNA. Derivarlo del primer evento `OPEN` hacía que
    // el fondo de caja dependiera de una fila que el propio cliente podía insertar por
    // `/sync`, y que además ordenaba por una fecha suya: un `OPEN` de $0 antedatado borraba
    // el fondo real del esperado y le inventaba al cajero un sobrante del tamaño del fondo.
    // Es la misma columna que leen el dashboard, el turno de la PAX y `cashDrawerPosting`,
    // así que los cuatro dicen por fin el mismo número.
    //
    // `shiftId`: a qué turno pertenece ESTA gaveta. Sin él, el cierre unificado sólo sabría que
    // había una gaveta abierta, no que su turno siga siendo el abierto — y un cierre encolado que
    // se reproduce tarde cerraría el turno equivocado con este conteo.
    select: { id: true, startingAmount: true, shiftId: true },
  })
  if (!session) {
    throw new NotFoundError('No hay una caja abierta')
  }
  // 🔴 P1 (Codex, 2ª auditoría): un cierre ENCOLADO en el aparato (sin red) llega tarde. Si trae el
  // id de SU caja y la caja abierta ahora es OTRA, no se cierra la ajena con el conteo de la vieja:
  // se contesta el mismo 404, que el aparato entiende como "esa ya no está abierta".
  if (params.sessionId && params.sessionId !== session.id) {
    throw new NotFoundError('No hay una caja abierta')
  }
  const actualDecimal = dollarsToDecimal(actualAmount)

  // ── El registro durable del gesto, ANTES del primer commit ────────────────────────────────
  //
  // 🔴 Este cierre son DOS commits, y si el proceso muere en medio lo que queda NO «degrada a lo de
  // hoy»: con la apertura ya unificada, el turno que sobrevive a su gaveta lo REUSA la cajera de la
  // tarde y acaba firmando dos arqueos con los totales del día entero (mezcla jornadas). El barrido
  // `cash-close-pair-reconciler` repara eso, pero sólo puede si la gaveta dice de QUÉ turno era:
  // emparejarlas por reloj es justo lo que mezclaría las jornadas (la forma real de producción es
  // una caja abierta a las 07:38 y un turno a las 08:12).
  //
  // Casi siempre no hace nada —desde la Task 4 la apertura ya deja los dos registros ligados—, así
  // que sólo cuesta consultas cuando la liga de verdad falta. Y nunca lanza: si no se puede ligar,
  // la pareja queda como hoy y el barrido la reporta en vez de repararla.
  if (!session.shiftId) {
    // 🔴 El `catch` no puede ser mudo: lo que se pierde aquí no es una consulta, es la
    // REPARABILIDAD de este cierre — sin la liga, la pareja partida ni siquiera se puede ver
    // (`buscarParejasAMedias` filtra `shiftId: { not: null }`). Se traga el error para no tumbar un
    // cierre bueno, pero se dice.
    const turno = await turnoAbiertoDelNegocio(prisma, venueId).catch(error => {
      logger.warn('💵 [CASH-DRAWER] no se pudo resolver el turno abierto; este cierre queda sin liga y sin reparación', {
        venueId,
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    })
    if (turno) await asegurarLaLiga(prisma, venueId, turno.id, session.id)
  }

  // Fase 4: el cierre es UNA transacción con CAS. Antes era leer → calcular → actualizar en
  // tres pasos sueltos: una venta que entrara entre "leer" y "escribir" dejaba el `overShort`
  // obsoleto, y dos cierres simultáneos se pisaban y creaban dos eventos CLOSE. Ahora:
  //   · los eventos se leen DENTRO de la tx (lo que ella ve es lo que se firma);
  //   · el `updateMany where status='OPEN'` es el candado: quien pierde la carrera no
  //     actualiza nada y recibe el mismo "no hay caja abierta" que ya conocen las apps;
  //   · el CLOSE se crea sólo si el CAS ganó.
  const { closedSession, expectedAmount, overShort } = await prisma.$transaction(async tx => {
    // 🔴 P1 (Codex 27-ago): el CAS va PRIMERO. El UPDATE toma el candado de la fila; un cobro que
    // quiera sumar al cajón (createEventUnderSessionLock, con `status='OPEN'`) se queda esperando
    // y al re-evaluar ya no encuentra la caja abierta. Sólo entonces se leen los eventos: lo que
    // se lee bajo el candado es exactamente lo que se firma.
    const closedAt = new Date()
    const won = await tx.cashDrawerSession.updateMany({
      where: { id: session.id, venueId, status: 'OPEN' },
      data: {
        status: 'CLOSED',
        closedByStaffId: staffId,
        closedByName: staffName,
        closedAt,
        actualAmount: actualDecimal,
        closingNote: note || null,
      },
    })
    if (won.count !== 1) {
      throw new NotFoundError('No hay una caja abierta')
    }
    const events = await tx.cashDrawerEvent.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: 'asc' } })
    const startingAmount = session.startingAmount
    const expected = calculateExpectedAmount({ startingAmount, events })
    const diff = Number(actualDecimal) - expected
    await tx.cashDrawerSession.update({ where: { id: session.id }, data: { overShort: new Decimal(diff.toFixed(2)) } })
    await tx.cashDrawerEvent.create({
      data: { sessionId: session.id, venueId, type: 'CLOSE', amount: actualDecimal, staffId, staffName, note: note || null },
    })
    const closed = await tx.cashDrawerSession.findUnique({
      where: { id: session.id },
      include: { events: { orderBy: { createdAt: 'desc' } } },
    })
    if (!closed) throw new NotFoundError('No hay una caja abierta')
    return { closedSession: closed, expectedAmount: expected, overShort: diff }
  })

  logAction({
    staffId,
    venueId,
    action: 'CASH_DRAWER_CLOSED',
    entity: 'CashDrawerSession',
    entityId: session.id,
    data: {
      expectedAmount,
      actualAmount: Number(actualDecimal),
      overShort,
      source: 'MOBILE',
    },
  })

  // ── La otra mitad del gesto: el turno de caja del negocio ──────────────────────────────────
  //
  // 🔴 Va con el conteo Y con el ESPERADO que se acaba de calcular sobre los eventos de ESTA
  // gaveta. Sin el esperado, el turno lo recalcularía con su propia fórmula
  // (`startingCash + ventas en efectivo`), que es ciega a los retiros: un `PAY_OUT` de $50 le
  // firmaría al cajero un faltante de $50 que la gaveta acaba de decir que no existe.
  //
  // Fuera de la transacción y en try/catch: el cierre de la gaveta YA está commiteado.
  let shiftId: string | null = null
  try {
    const cierre = await cerrarTurnoDeCaja({
      venueId,
      staffId,
      staffName,
      source: 'CAJA_MOVIL',
      yaCerrado: { cashDrawerSessionId: session.id },
      // ⚠️ Siempre hay conteo por esta puerta: el controlador devuelve 400 si falta `actualAmount`.
      // Y contar CERO es un conteo REAL — una gaveta vacía con $2,950 esperados es un faltante de
      // $2,950—, por eso viaja el `Decimal` tal cual y nunca detrás de un `&&`.
      conteo: new Prisma.Decimal(actualDecimal.toFixed(2)),
      esperadoDelCajon: new Prisma.Decimal(expectedAmount.toFixed(2)),
      shiftIdDeLaGaveta: session.shiftId,
      note: note || null,
    })
    shiftId = cierre.shiftCerradoId ?? null
  } catch (error) {
    logger.error('💵 [CASH-DRAWER] La caja se cerró pero el turno del negocio no; queda abierto', {
      venueId,
      sessionId: session.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // `shiftId` es ADITIVO: el turno que este cierre cerró, o `null` si no había ninguno abierto.
  return { ...formatSession(closedSession), shiftId }
}

// ============================================================================
// HISTORY
// ============================================================================

/**
 * Get closed cash drawer sessions (history).
 */
export async function getHistory(venueId: string, page: number = 1, pageSize: number = 20) {
  const skip = (page - 1) * pageSize

  const [sessions, total] = await Promise.all([
    prisma.cashDrawerSession.findMany({
      where: { venueId, status: 'CLOSED' },
      include: {
        events: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { closedAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.cashDrawerSession.count({
      where: { venueId, status: 'CLOSED' },
    }),
  ])

  return {
    sessions: sessions.map(s => formatSession(s)),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}

// ============================================================================
// TENDER BREAKDOWN (payments by method for the corte / Z-report)
// ============================================================================

/**
 * Payments grouped by tender for a time window — the authoritative source for
 * the corte de caja's "Desglose por método de pago" (the drawer only tracks
 * CASH physically, so card/other totals must come from the payment records).
 * Sums amount + tip per COMPLETED payment (refunds ride as negative COMPLETED
 * payments, so the signed sum auto-nets them). Window = the drawer session's
 * [openedAt, closedAt || now].
 */
export async function getTenderBreakdown(venueId: string, from: Date, to: Date) {
  const payments = await prisma.payment.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      createdAt: { gte: from, lte: to },
    },
    select: { method: true, amount: true, tipAmount: true },
  })

  // `total` sigue incluyendo la propina —es lo que entró por ese método y lo que
  // el cajón tiene físicamente— pero ahora viaja aparte cuánto de eso fue propina.
  // Mezclarlas sin distinguirlas escondía dinero que NO es del negocio: la propina
  // se le entrega al mesero, así que un corte que la suma al efectivo hace que el
  // cajón "cuadre" con dinero que se va a repartir.
  const byMethod = new Map<string, { total: number; tips: number }>()
  for (const p of payments) {
    const method = p.method || 'OTHER'
    const tip = Number(p.tipAmount ?? 0)
    const acc = byMethod.get(method) || { total: 0, tips: 0 }
    acc.total += Number(p.amount) + tip
    acc.tips += tip
    byMethod.set(method, acc)
  }

  // Emit every method with activity, dollars major units (matches this API).
  // `tips` es ADITIVO: los clientes viejos siguen leyendo `total` igual que antes.
  const tenderBreakdown = Array.from(byMethod.entries())
    .map(([method, v]) => ({
      method,
      total: Number(v.total.toFixed(2)),
      tips: Number(v.tips.toFixed(2)),
    }))
    .filter(t => t.total !== 0 || t.tips !== 0)
    .sort((a, b) => b.total - a.total)

  const totalTips = Number(tenderBreakdown.reduce((sum, t) => sum + t.tips, 0).toFixed(2))

  return { tenderBreakdown, totalTips, from: from.toISOString(), to: to.toISOString() }
}

// ============================================================================
// SYNC (Offline-first bulk event sync)
// ============================================================================

interface SyncEvent {
  /**
   * `CASH_SALE` sigue en la unión porque las apps ya desplegadas lo mandan y el contrato
   * `/mobile` no rompe versiones viejas — pero el servidor lo DESCARTA (ver `syncEvents`):
   * la venta en efectivo ya crea su propio movimiento al cobrar.
   */
  type: 'PAY_IN' | 'PAY_OUT' | 'CASH_SALE'
  amount: number // dollars
  note?: string
  staffId: string
  staffName: string
  orderId?: string
  createdAt?: string // ISO date
  /**
   * Llave de idempotencia del POS: el id con el que la app guarda el evento en su base
   * local (Android `CashDrawerEventEntity.id`, un UUID estable). Opcional para no romper
   * apps viejas — sin ella el reintento no se puede deduplicar. Misma llave y mismas
   * reglas de validación que en `pay-in` / `pay-out` (ver `normalizeLocalId`).
   */
  localId?: string | null
  /**
   * Identidad durable de la caja local donde ocurrió el movimiento. Aditivo: las apps
   * viejas pueden omitirla, pero entonces la fecha debe resolver UNA sola ventana histórica.
   */
  sessionId?: string | null
}

/** Un día offline completo cabe holgadamente; más se rechaza en vez de cargar la DB sin techo. */
const CASH_DRAWER_SYNC_EVENT_LIMIT = 500
/** A full offline day should touch few drawers; cap fan-out before holding transaction locks. */
const CASH_DRAWER_SYNC_SESSION_LIMIT = 100
/** El barrido legacy trae uno extra para detectar truncamiento; jamás adivina al tocar el techo. */
const CASH_DRAWER_SYNC_LEGACY_SESSION_LIMIT = 100
/** `Shift.cashDifference` is Decimal(10,2), narrower than the drawer's Decimal(12,2). */
const CASH_DRAWER_SYNC_SHIFT_DIFFERENCE_MAX = new Decimal('99999999.99')
const CASH_DRAWER_EXPECTED_EVENT_TYPES = [CashDrawerEventType.PAY_IN, CashDrawerEventType.PAY_OUT, CashDrawerEventType.CASH_SALE]

type SyncShiftPendingReason =
  | 'MISSING_SHIFT_RELATION'
  | 'SHIFT_NOT_FOUND_OR_CROSS_VENUE'
  | 'SHIFT_NOT_CLOSED'
  | 'SHIFT_MISSING_CASH_DECLARED'
  | 'SHIFT_COUNT_MISMATCH'
  | 'SHIFT_DIFFERENCE_OVERFLOW'
  | 'SHIFT_CONCURRENT_WRITE_LOST'

interface SyncClosedDrawerAudit {
  sessionId: string
  linkedShiftId: string | null
  insertedCount: number
  localIds: string[]
  expectedBeforePesos: string | null
  expectedAfterPesos: string
  overShortBeforePesos: string | null
  overShortAfterPesos: string
  shiftStatus: 'APPLIED' | 'PENDING'
  shiftDifferenceBeforePesos?: string | null
  pendingReason?: SyncShiftPendingReason
}

function rejectCashDrawerSync(venueId: string, reason: string, details: Record<string, unknown> = {}): never {
  logger.warn('💵 [CASH-DRAWER] CASH_DRAWER_SYNC_REJECTED', { venueId, reason, ...details })
  throw new BadRequestError(
    'No se pudo identificar con seguridad la caja histórica de todos los movimientos. Nada fue sincronizado.',
    'CASH_DRAWER_SYNC_UNSAFE_IDENTITY',
    { reason, ...details },
  )
}

/**
 * Bulk sync events from mobile (for offline-first support).
 * Creates multiple events in a single transaction.
 */
/**
 * `appVersion` (header `x-app-version`) sólo alimenta la MÉTRICA de compatibilidad: cuántos
 * `CASH_SALE` empujan todavía las apps viejas y desde qué versión. Es lo que permite retirar el
 * descarte de abajo por DATO (N días con `droppedCashSales = 0`) y no por "ya están todos
 * actualizados" — decisión del founder (27-ago): nada de gates manuales, nada de código muerto.
 */
export async function syncEvents(venueId: string, events: SyncEvent[], appVersion?: string | null, actorStaffId?: string | null) {
  if (!events || events.length === 0) {
    throw new BadRequestError('No hay eventos para sincronizar')
  }
  // 🔴 EL SERVIDOR ES DUEÑO DEL `CASH_SALE` — el cliente ya no lo puede empujar.
  //
  // Desde que el cobro en efectivo crea su propio movimiento de caja en el servidor
  // (`services/shared/cashDrawerPosting.ts`, enganchado en `payCashOrder`,
  // `recordOrderPayment` y `recordFastPayment`), aceptar además el `CASH_SALE` que las
  // apps YA DESPLEGADAS empujan a este endpoint contaría la MISMA venta dos veces: un
  // SOBRANTE inventado, el mismo defecto que veníamos a arreglar pero al revés.
  //
  // No se puede deduplicar contra el evento del servidor: la app manda un UUID local
  // propio, no el `paymentId`, y un cheque partido en dos cobros iguales haría
  // indistinguibles el duplicado y el legítimo. Se descartan y punto.
  //
  // No se pierde nada: TODA venta en efectivo de un POS pasa por uno de esos tres
  // servicios, así que el movimiento nace igual —y ahora también cuando la app estaba
  // sin red, porque el intent `PAY_CASH` del outbox llega por `payCashOrder`. El push
  // del cliente era fire-and-forget SIN cola de reintento: si la respuesta se perdía,
  // el movimiento no existía nunca.
  //
  // PAY_IN y PAY_OUT siguen siendo del cliente: no nacen de un cobro.
  const droppedCashSales = events.filter(event => event.type === 'CASH_SALE').length
  // 🔴 La llave se valida aquí también: `/sync` es la OTRA puerta por la que un cliente
  // escribe en la columna indexada. Validar sólo `pay-in`/`pay-out` dejaría el hueco
  // abierto por donde entra el lote. Se valida lo que de verdad vamos a insertar (los
  // `CASH_SALE` se descartan más abajo, así que su llave nunca toca el índice).
  // 🔴 LISTA BLANCA de tipos, no lista negra. Un POS sin internet sólo puede haber hecho
  // ingresos y retiros: abrir y cerrar la caja son operaciones del servidor, con su propia
  // ruta y su propio candado. Descartar sólo `CASH_SALE` dejaba pasar `OPEN` y `CLOSE`, que
  // son valores válidos del enum de Prisma — y un `OPEN` inyectado se convertía en el fondo
  // de caja del cierre, así que uno de $0 antedatado borraba el fondo real del arqueo firmado.
  const TIPOS_DEL_CLIENTE = new Set(['PAY_IN', 'PAY_OUT'])
  const droppedInvalidTypes = events.filter(e => e.type !== 'CASH_SALE' && !TIPOS_DEL_CLIENTE.has(e.type)).length
  if (droppedInvalidTypes > 0) {
    logger.warn('💵 [CASH-DRAWER] /sync descartó eventos de un tipo que el cliente no puede empujar', {
      venueId,
      droppedInvalidTypes,
      tipos: [...new Set(events.filter(e => !TIPOS_DEL_CLIENTE.has(e.type) && e.type !== 'CASH_SALE').map(e => e.type))],
    })
  }

  const acceptedEvents = events
    .filter(event => TIPOS_DEL_CLIENTE.has(event.type))
    .map(event => ({ ...event, localId: normalizeLocalId(event.localId, 'events[].localId') }))

  if (droppedCashSales > 0) {
    logger.info('💵 [CASH-DRAWER] CASH_SALE del cliente ignorado — el servidor ya lo registra al cobrar', {
      venueId,
      droppedCashSales,
    })
  }

  if (acceptedEvents.length === 0) {
    // 200 con lote vacío, no error: el push del cliente es fire-and-forget y un 4xx
    // aquí lo haría reintentar para siempre algo que nunca vamos a aceptar.
    return { syncedCount: 0, events: [] }
  }
  if (events.length > CASH_DRAWER_SYNC_EVENT_LIMIT) {
    rejectCashDrawerSync(venueId, 'REQUEST_LIMIT_EXCEEDED', {
      receivedCount: events.length,
      limit: CASH_DRAWER_SYNC_EVENT_LIMIT,
    })
  }

  const requestNow = new Date()
  const parseDate = (raw?: string | Date | null): Date | null => {
    if (!raw) return null
    const parsed = new Date(raw)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  type SessionWindow = {
    id: string
    venueId: string
    status: string
    openedAt: Date
    closedAt: Date | null
  }
  type Accepted = SyncEvent & { localId: string | null }
  type Resolved = { event: Accepted; session: SessionWindow; createdAt: Date }

  const explicitIds: string[] = []
  const legacyDates: Date[] = []
  for (const event of acceptedEvents as Accepted[]) {
    if (event.sessionId !== undefined && event.sessionId !== null) {
      if (typeof event.sessionId !== 'string' || event.sessionId.trim().length === 0 || event.sessionId.length > 128) {
        rejectCashDrawerSync(venueId, 'INVALID_EXPLICIT_SESSION_ID', { localId: event.localId })
      }
      explicitIds.push(event.sessionId)
    } else {
      const createdAt = parseDate(event.createdAt)
      if (!createdAt) rejectCashDrawerSync(venueId, 'LEGACY_TIMESTAMP_REQUIRED', { localId: event.localId })
      legacyDates.push(createdAt)
    }
  }

  // Explicit identities are fetched in one tenant-scoped, request-bounded query.
  const uniqueExplicitIds = [...new Set(explicitIds)].sort()
  const explicitSessions = uniqueExplicitIds.length
    ? await prisma.cashDrawerSession.findMany({
        where: { venueId, id: { in: uniqueExplicitIds } },
        select: { id: true, venueId: true, status: true, openedAt: true, closedAt: true },
        take: uniqueExplicitIds.length,
      })
    : []
  const explicitById = new Map(explicitSessions.map(session => [session.id, session as SessionWindow]))
  const missingExplicit = uniqueExplicitIds.filter(id => !explicitById.has(id))
  if (missingExplicit.length > 0) {
    rejectCashDrawerSync(venueId, 'EXPLICIT_SESSION_NOT_FOUND', { sessionIds: missingExplicit })
  }

  // Old clients have no durable id. One bounded interval scan covers the whole batch; each
  // timestamp must belong to exactly one candidate or the complete request is rejected.
  let legacySessions: SessionWindow[] = []
  if (legacyDates.length > 0) {
    const minLegacy = new Date(Math.min(...legacyDates.map(date => date.getTime())))
    const maxLegacy = new Date(Math.max(...legacyDates.map(date => date.getTime())))
    const candidates = await prisma.cashDrawerSession.findMany({
      where: {
        venueId,
        openedAt: { lte: maxLegacy },
        OR: [{ closedAt: { gte: minLegacy } }, { status: 'OPEN', closedAt: null }],
      },
      select: { id: true, venueId: true, status: true, openedAt: true, closedAt: true },
      orderBy: { id: 'asc' },
      take: CASH_DRAWER_SYNC_LEGACY_SESSION_LIMIT + 1,
    })
    if (candidates.length > CASH_DRAWER_SYNC_LEGACY_SESSION_LIMIT) {
      rejectCashDrawerSync(venueId, 'LEGACY_CANDIDATE_LIMIT_REACHED', {
        limit: CASH_DRAWER_SYNC_LEGACY_SESSION_LIMIT,
        from: minLegacy.toISOString(),
        to: maxLegacy.toISOString(),
      })
    }
    legacySessions = candidates as SessionWindow[]
  }

  const resolved: Resolved[] = (acceptedEvents as Accepted[]).map(event => {
    let session: SessionWindow
    const explicit = event.sessionId !== undefined && event.sessionId !== null
    if (explicit) {
      session = explicitById.get(event.sessionId as string) as SessionWindow
    } else {
      const createdAt = parseDate(event.createdAt) as Date
      const matches = legacySessions.filter(candidate => {
        const opened = new Date(candidate.openedAt).getTime()
        const end = candidate.closedAt
          ? new Date(candidate.closedAt).getTime()
          : candidate.status === 'OPEN'
            ? requestNow.getTime()
            : Number.NEGATIVE_INFINITY
        return opened <= createdAt.getTime() && createdAt.getTime() <= end
      })
      if (matches.length !== 1) {
        rejectCashDrawerSync(venueId, matches.length === 0 ? 'LEGACY_SESSION_NOT_FOUND' : 'LEGACY_SESSION_AMBIGUOUS', {
          localId: event.localId,
          createdAt: createdAt.toISOString(),
          candidateCount: matches.length,
        })
      }
      session = matches[0]
    }

    // Explicit identity remains authoritative even with a bad device clock. Its date is clamped
    // only to that exact drawer's own lifetime, never to a newer open drawer.
    const rawCreatedAt = parseDate(event.createdAt) ?? requestNow
    const opened = new Date(session.openedAt).getTime()
    const end = session.closedAt ? new Date(session.closedAt).getTime() : requestNow.getTime()
    const createdAt = new Date(Math.min(Math.max(rawCreatedAt.getTime(), opened), end))
    return { event, session, createdAt }
  })

  // 🔴 El AUTOR se comprueba contra el venue. El POS es compartido y el movimiento pudo
  // hacerlo alguien distinto de quien sincroniza, así que el `staffId` del cuerpo se
  // respeta —pero sólo si esa persona de verdad trabaja aquí—. Un id ajeno o inventado cae
  // al del token: antes, cualquiera con `payments:create` podía colgarle un retiro a un
  // compañero, o a alguien de otro negocio.
  const idsDelCuerpo = [...new Set(acceptedEvents.map(e => e.staffId).filter(Boolean))] as string[]
  const memberships = idsDelCuerpo.length
    ? await prisma.staffVenue.findMany({
        where: { venueId, staffId: { in: idsDelCuerpo } },
        select: { staffId: true },
        take: idsDelCuerpo.length,
      })
    : []
  const validos = new Set<string>(memberships.map(row => row.staffId))
  const autorDe = (event: SyncEvent) =>
    event.staffId && validos.has(event.staffId)
      ? { staffId: event.staffId, staffName: event.staffName }
      : { staffId: (actorStaffId ?? event.staffId) as string, staffName: event.staffName }

  // 🔴 `createMany` + `skipDuplicates` en vez de un `create` por evento — SOLO
  // para los eventos que traen `localId`.
  //
  // Las apps mandan el lote fire-and-forget y sin cola de reintento: si la respuesta se
  // pierde, el MISMO lote vuelve. El `create` ciego insertaba las filas otra vez y el cajón
  // terminaba con efectivo inventado — que el arqueo daba por bueno. Con la llave
  // `localId` del POS y el índice `@@unique([venueId, localId])`, el reintento choca y
  // Postgres lo salta en vez de duplicar.
  const keyed = resolved.filter(({ event }) => Boolean(event.localId))
  const localIds = [...new Set(keyed.map(({ event }) => event.localId as string))]
  const incomingTargetByLocalId = new Map<string, string>()
  for (const item of keyed) {
    const localId = item.event.localId as string
    const previous = incomingTargetByLocalId.get(localId)
    if (previous && previous !== item.session.id) {
      rejectCashDrawerSync(venueId, 'LOCAL_ID_SESSION_CONFLICT', { localId, sessionIds: [previous, item.session.id].sort() })
    }
    incomingTargetByLocalId.set(localId, item.session.id)
  }
  const existingKeyed = localIds.length
    ? await prisma.cashDrawerEvent.findMany({
        where: { venueId, localId: { in: localIds } },
        select: { id: true, localId: true, sessionId: true },
        take: localIds.length,
      })
    : []
  for (const existing of existingKeyed) {
    if (existing.localId && incomingTargetByLocalId.get(existing.localId) !== existing.sessionId) {
      rejectCashDrawerSync(venueId, 'LOCAL_ID_SESSION_CONFLICT', {
        localId: existing.localId,
        existingSessionId: existing.sessionId,
        requestedSessionId: incomingTargetByLocalId.get(existing.localId),
      })
    }
  }

  const bySession = new Map<string, Resolved[]>()
  for (const item of resolved) {
    const group = bySession.get(item.session.id) ?? []
    group.push(item)
    bySession.set(item.session.id, group)
  }
  const orderedGroups = [...bySession.entries()].sort(([left], [right]) => left.localeCompare(right))
  if (orderedGroups.length > CASH_DRAWER_SYNC_SESSION_LIMIT) {
    rejectCashDrawerSync(venueId, 'TARGET_SESSION_LIMIT_EXCEEDED', {
      targetSessionCount: orderedGroups.length,
      limit: CASH_DRAWER_SYNC_SESSION_LIMIT,
    })
  }

  const toRow = (item: Resolved) => {
    const autor = autorDe(item.event)
    return {
      sessionId: item.session.id,
      venueId,
      type: item.event.type,
      amount: dollarsToDecimal(item.event.amount),
      note: item.event.note || null,
      staffId: autor.staffId,
      staffName: autor.staffName,
      orderId: item.event.orderId || null,
      localId: item.event.localId || null,
      createdAt: item.createdAt,
    }
  }

  // 🔴 Apps viejas sin `localId` (contrato /mobile: las versiones ya
  // distribuidas siguen funcionando): tras un `createMany` no hay llave para
  // RELEER sus filas, y responder `events: []` rompía a los clientes que
  // marcan su outbox local con el eco de la respuesta — re-mandaban el lote
  // completo en cada sync, y sin llave el índice único no puede deduplicarlo:
  // efectivo inventado causado por el propio cambio de forma. Se insertan una
  // a una (el comportamiento que esas apps siempre tuvieron) para poder
  // devolverlas.
  //
  // 🔴 TODO el lote va en UNA transacción (audit 2026-08-13): con inserts
  // sueltos, un fallo a media lista dejaba los primeros commiteados aunque el
  // request regresara error — el reintento del cliente los reinsertaba (los
  // sin llave no tienen dedupe) y el cajón inventaba efectivo. Todo-o-nada:
  // o entra el lote completo, o el reintento parte de cero.
  const { insertedCount, keyedRows, unkeyedRows, closedAudits } = await prisma.$transaction(
    async tx => {
      // Take every target row lock before the first insert. Stable id order prevents two devices
      // syncing overlapping historical drawers from deadlocking each other.
      for (const [sessionId] of orderedGroups) {
        const lock = await tx.cashDrawerSession.updateMany({
          where: { id: sessionId, venueId },
          data: { updatedAt: requestNow },
        })
        if (!lock || lock.count !== 1) {
          throw new BadRequestError(
            'Una caja cambió mientras se sincronizaba el lote. Nada fue sincronizado.',
            'CASH_DRAWER_SYNC_SESSION_CHANGED',
          )
        }
      }

      let durableKeyedRows = [] as Awaited<ReturnType<typeof prisma.cashDrawerEvent.findMany>>
      const createdUnkeyed = [] as Awaited<ReturnType<typeof prisma.cashDrawerEvent.create>>[]
      const audits: SyncClosedDrawerAudit[] = []
      const insertedKeyed =
        keyed.length > 0
          ? await tx.cashDrawerEvent.createManyAndReturn({
              data: keyed.map(toRow),
              skipDuplicates: true,
              select: { id: true, localId: true, sessionId: true },
            })
          : []
      for (const item of resolved.filter(({ event }) => !event.localId)) {
        createdUnkeyed.push(await tx.cashDrawerEvent.create({ data: toRow(item) }))
      }

      // createManyAndReturn identifies the exact keyed winners of the unique-key race. This
      // map therefore drives both reconciliation and audits; requested duplicates never appear.
      const insertedBySession = new Map<string, { count: number; localIds: string[] }>()
      for (const row of [...insertedKeyed, ...createdUnkeyed]) {
        const inserted = insertedBySession.get(row.sessionId) ?? { count: 0, localIds: [] }
        inserted.count += 1
        if (row.localId) inserted.localIds.push(row.localId)
        insertedBySession.set(row.sessionId, inserted)
      }
      const changedSessionIds = [...insertedBySession.keys()].sort()

      // One bounded metadata read and one bounded aggregate replace a full, unbounded events
      // relation per drawer. At most three aggregate rows can exist for each changed drawer.
      const closedSessions = changedSessionIds.length
        ? await tx.cashDrawerSession.findMany({
            where: {
              venueId,
              id: { in: changedSessionIds },
              status: 'CLOSED',
              actualAmount: { not: null },
            },
            select: {
              id: true,
              venueId: true,
              shiftId: true,
              actualAmount: true,
              overShort: true,
              startingAmount: true,
            },
            orderBy: { id: 'asc' },
            take: changedSessionIds.length,
          })
        : []
      const closedSessionIds = closedSessions.map(session => session.id)
      const eventTotals = closedSessionIds.length
        ? await tx.cashDrawerEvent.groupBy({
            by: ['sessionId', 'type'],
            where: {
              venueId,
              sessionId: { in: closedSessionIds },
              type: { in: CASH_DRAWER_EXPECTED_EVENT_TYPES },
            },
            _sum: { amount: true },
            orderBy: [{ sessionId: 'asc' }, { type: 'asc' }],
            take: closedSessionIds.length * CASH_DRAWER_EXPECTED_EVENT_TYPES.length,
          })
        : []
      const totalsBySession = new Map<string, Array<{ type: CashDrawerEventType; amount: Decimal }>>()
      for (const total of eventTotals) {
        if (total._sum.amount === null) continue
        const sessionTotals = totalsBySession.get(total.sessionId) ?? []
        sessionTotals.push({ type: total.type, amount: total._sum.amount })
        totalsBySession.set(total.sessionId, sessionTotals)
      }

      const linkedShiftIds = [...new Set(closedSessions.map(session => session.shiftId).filter((id): id is string => Boolean(id)))].sort()
      const linkedShifts = linkedShiftIds.length
        ? await tx.shift.findMany({
            where: { venueId, id: { in: linkedShiftIds } },
            select: { id: true, venueId: true, status: true, cashDeclared: true, cashDifference: true },
            orderBy: { id: 'asc' },
            take: linkedShiftIds.length,
          })
        : []
      const shiftById = new Map(linkedShifts.map(shift => [shift.id, shift]))

      for (const session of closedSessions) {
        if (session.actualAmount === null) continue
        const insertedForSession = insertedBySession.get(session.id)
        if (!insertedForSession) continue

        const expected = calculateExpectedAmount({
          startingAmount: session.startingAmount,
          events: totalsBySession.get(session.id) ?? [],
        })
        const expectedDecimal = new Decimal(expected.toString())
        const difference = new Decimal(session.actualAmount.toString()).minus(expectedDecimal).toDecimalPlaces(2)
        await tx.cashDrawerSession.updateMany({ where: { id: session.id, venueId }, data: { overShort: difference } })

        let pendingReason: SyncShiftPendingReason | undefined
        let shiftDifferenceBeforePesos: string | null | undefined
        if (!session.shiftId) {
          pendingReason = 'MISSING_SHIFT_RELATION'
        } else {
          const shift = shiftById.get(session.shiftId)
          if (!shift) pendingReason = 'SHIFT_NOT_FOUND_OR_CROSS_VENUE'
          else if (shift.status !== 'CLOSED') pendingReason = 'SHIFT_NOT_CLOSED'
          else if (shift.cashDeclared === null) pendingReason = 'SHIFT_MISSING_CASH_DECLARED'
          else if (!new Decimal(shift.cashDeclared.toString()).equals(new Decimal(session.actualAmount.toString()))) {
            pendingReason = 'SHIFT_COUNT_MISMATCH'
          } else if (difference.absoluteValue().greaterThan(CASH_DRAWER_SYNC_SHIFT_DIFFERENCE_MAX)) {
            pendingReason = 'SHIFT_DIFFERENCE_OVERFLOW'
          } else {
            shiftDifferenceBeforePesos = shift.cashDifference?.toFixed(2) ?? null
            const shifted = await tx.shift.updateMany({
              where: {
                id: shift.id,
                venueId,
                status: 'CLOSED',
                cashDeclared: shift.cashDeclared,
                cashDifference: shift.cashDifference,
              },
              data: { cashDifference: difference },
            })
            if (shifted.count !== 1) pendingReason = 'SHIFT_CONCURRENT_WRITE_LOST'
          }
        }

        audits.push({
          sessionId: session.id,
          linkedShiftId: session.shiftId,
          insertedCount: insertedForSession.count,
          localIds: [...new Set(insertedForSession.localIds)].sort(),
          expectedBeforePesos:
            session.overShort === null
              ? null
              : new Decimal(session.actualAmount.toString()).minus(new Decimal(session.overShort.toString())).toFixed(2),
          expectedAfterPesos: expectedDecimal.toFixed(2),
          overShortBeforePesos: session.overShort?.toFixed(2) ?? null,
          overShortAfterPesos: difference.toFixed(2),
          shiftStatus: pendingReason ? 'PENDING' : 'APPLIED',
          ...(pendingReason ? { pendingReason } : {}),
          ...(shiftDifferenceBeforePesos !== undefined ? { shiftDifferenceBeforePesos } : {}),
        })
      }

      // The preflight read cannot close the race by itself: two requests can both see no row,
      // target different drawers, and let the unique key choose one winner. Re-read under this
      // transaction after createMany while every requested drawer is still locked. The loser
      // aborts instead of echoing/acknowledging a row attached to a different drawer.
      if (localIds.length > 0) {
        durableKeyedRows = await tx.cashDrawerEvent.findMany({
          where: { venueId, localId: { in: localIds } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: localIds.length,
        })
        for (const durable of durableKeyedRows) {
          if (durable.localId && incomingTargetByLocalId.get(durable.localId) !== durable.sessionId) {
            rejectCashDrawerSync(venueId, 'LOCAL_ID_SESSION_CONFLICT_AFTER_INSERT', {
              localId: durable.localId,
              existingSessionId: durable.sessionId,
              requestedSessionId: incomingTargetByLocalId.get(durable.localId),
            })
          }
        }
      }

      return {
        insertedCount: insertedKeyed.length + createdUnkeyed.length,
        keyedRows: durableKeyedRows,
        unkeyedRows: createdUnkeyed,
        closedAudits: audits,
      }
    },
    // Timeout explícito (audit max): el default de 5s de la tx interactiva no
    // aguanta el lote de una app vieja que reconecta tras un día offline
    // (~cientos de creates secuenciales sin llave). Un P2028 aquí revertía el
    // lote completo y el cliente lo reintentaba idéntico por siempre.
    { timeout: 30_000 },
  )

  // Audit attempts happen only after the transaction has committed. Duplicates (`inserted=0`)
  // intentionally do not create another mutation audit.
  if (insertedCount > 0) {
    await logAction({
      staffId: actorStaffId ?? acceptedEvents[0]?.staffId,
      venueId,
      action: 'CASH_DRAWER_SYNC',
      entity: 'CashDrawerSession',
      entityId: orderedGroups[0][0],
      data: {
        eventCount: insertedCount,
        receivedCount: events.length,
        droppedCashSales,
        appVersion: appVersion ?? null,
        source: 'MOBILE',
        sessionIds: orderedGroups.map(([sessionId]) => sessionId),
      },
    })
  }

  for (const audit of closedAudits) {
    if (audit.pendingReason) {
      logger.error('❌ [CASH-DRAWER] LATE_SHIFT_RECONCILIATION_PENDING', {
        venueId,
        sessionId: audit.sessionId,
        linkedShiftId: audit.linkedShiftId,
        reason: audit.pendingReason,
        source: 'MOBILE_SYNC',
      })
    }
    await logAction({
      staffId: actorStaffId ?? acceptedEvents[0]?.staffId,
      venueId,
      action: 'CASH_DRAWER_ADJUSTED_AFTER_CLOSE',
      entity: 'CashDrawerSession',
      entityId: audit.sessionId,
      data: {
        cause: 'OFFLINE_BATCH',
        source: 'MOBILE_SYNC',
        insertedCount: audit.insertedCount,
        localIds: audit.localIds,
        expectedBeforePesos: audit.expectedBeforePesos,
        expectedAfterPesos: audit.expectedAfterPesos,
        overShortBeforePesos: audit.overShortBeforePesos,
        overShortAfterPesos: audit.overShortAfterPesos,
        linkedShiftId: audit.linkedShiftId,
        shiftReconciliationStatus: audit.shiftStatus,
        ...(audit.pendingReason ? { shiftReconciliationPendingReason: audit.pendingReason } : {}),
      },
    })
    if (audit.shiftStatus === 'APPLIED' && audit.linkedShiftId) {
      await logAction({
        staffId: actorStaffId ?? acceptedEvents[0]?.staffId,
        venueId,
        action: 'SHIFT_UPDATED',
        entity: 'Shift',
        entityId: audit.linkedShiftId,
        data: {
          cause: 'OFFLINE_BATCH',
          source: 'MOBILE_SYNC',
          cashDrawerSessionId: audit.sessionId,
          insertedCount: audit.insertedCount,
          localIds: audit.localIds,
          cashDifferenceBeforePesos: audit.shiftDifferenceBeforePesos ?? null,
          cashDifferenceAfterPesos: audit.overShortAfterPesos,
        },
      })
    }
  }

  // `createMany` no devuelve filas: la transacción ya releyó por `localId` mientras
  // conservaba los candados de todas las cajas objetivo. Ese mismo resultado durable
  // es el eco que permite al cliente marcar todo su outbox sin una segunda lectura.
  const allRows = [...keyedRows, ...unkeyedRows].sort((a, b) => {
    const byDate = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    return byDate || a.id.localeCompare(b.id)
  })

  return {
    syncedCount: insertedCount,
    events: allRows.map(formatEvent),
  }
}

// ============================================================================
// HELPERS
// ============================================================================

async function getOpenSession(venueId: string) {
  const session = await prisma.cashDrawerSession.findFirst({
    where: { venueId, status: 'OPEN' },
  })

  if (!session) {
    throw new NotFoundError('No hay una caja abierta. Abre una caja primero.')
  }

  return session
}

/**
 * Efectivo que DEBERÍA haber en el cajón: inicial + PAY_IN + CASH_SALE − PAY_OUT.
 *
 * Los tres tipos que suman/restan tienen dueño y ninguno se cuenta dos veces:
 *   · `CASH_SALE` — lo crea el SERVIDOR al cobrar (`services/shared/cashDrawerPosting.ts`,
 *     enganchado en `payCashOrder`, `recordOrderPayment` y `recordFastPayment`), con una
 *     llave derivada del `paymentId`. Reproducir el mismo pago del outbox no duplica nada,
 *     y `syncEvents` descarta los `CASH_SALE` que empujan las apps para no sumar dos veces.
 *     Incluye la propina en efectivo, igual que `cashCloseout.dashboard.service.ts`.
 *   · `PAY_OUT` — retiros a mano Y el reembolso en efectivo (`refund.mobile.service.ts`),
 *     que es el ÚNICO que mueve el cajón por un reembolso: el Payment negativo del refund
 *     no vuelve a entrar por el enganche de ventas.
 *   · `PAY_IN` — entradas a mano; siguen siendo del cliente.
 */
/**
 * Exportada para que el dashboard (`cashDrawer.dashboard.service`) muestre EXACTAMENTE el
 * mismo esperado que vio el cajero al cerrar. Dos fórmulas = dos verdades para el mismo
 * dinero, que es justo lo que la unificación de caja está quitando.
 */
export function calculateExpectedAmount(session: any): number {
  let expected = Number(session.startingAmount)

  for (const event of session.events) {
    const amount = Number(event.amount)
    switch (event.type) {
      case 'PAY_IN':
      case 'CASH_SALE':
        expected += amount
        break
      case 'PAY_OUT':
        expected -= amount
        break
    }
  }

  return Math.round(expected * 100) / 100
}

function dollarsToDecimal(dollars: number): Decimal {
  return new Decimal(Number(dollars).toFixed(2))
}

/**
 * @param incluirEsperado ¿el llamante tiene `cash-drawer:view-expected`? Con `false` (el
 * default) NO se sirve `expectedAmount` mientras la caja está ABIERTA — el conteo ciego
 * dejaría de serlo si el número viaja en la respuesta que el propio cajero puede pedir.
 *
 * 🔴 `startingAmount` y `events` SÍ se siguen mandando siempre: el POS los necesita para
 * calcular su esperado EN EL APARATO, que es lo que le permite cerrar sin internet. Por eso
 * aquí el conteo ciego lo aplica el cliente (ya lo hace, tras `cash-drawer:view-expected`) y
 * el servidor sólo deja de servirlo hecho. Ningún cliente lee este campo hoy —Android e iOS
 * lo calculan— así que omitirlo no cambia nada en los aparatos ya instalados.
 *
 * Una sesión CERRADA lo revela siempre: ese es el resultado que el cajero debe ver al
 * confirmar su conteo, y por eso el cierre no necesita tratarse aparte.
 */
function formatSession(session: any, incluirEsperado = false) {
  const expectedAmount = calculateExpectedAmount(session)
  const revelar = incluirEsperado || session.status !== 'OPEN'

  return {
    id: session.id,
    venueId: session.venueId,
    deviceName: session.deviceName,
    status: session.status,
    openedByStaffId: session.openedByStaffId,
    openedByName: session.openedByName,
    openedAt: session.openedAt.toISOString(),
    startingAmount: toDollars(session.startingAmount),
    closedByStaffId: session.closedByStaffId,
    closedByName: session.closedByName,
    closedAt: session.closedAt ? session.closedAt.toISOString() : null,
    actualAmount: session.actualAmount ? toDollars(session.actualAmount) : null,
    ...(revelar ? { expectedAmount: Number(expectedAmount.toFixed(2)) } : {}),
    overShort: session.overShort ? toDollars(session.overShort) : null,
    closingNote: session.closingNote,
    events: session.events ? session.events.map(formatEvent) : [],
  }
}

/**
 * 🔴 `localId` SALE EN LA RESPUESTA: sin él los clientes fusionan por INFERENCIA.
 *
 * La llave ya se guardaba —la manda el POS al sincronizar y el servidor la deriva del
 * `paymentId` para lo que escribe él (`srv-cash-sale:` / `srv-refund:`, ver
 * `services/shared/cashDrawerPosting.ts`)— pero NUNCA se devolvía. El cliente recibía el
 * evento del servidor sin forma de reconocer que ERA EL SUYO, así que lo insertaba al lado
 * del que ya tenía en su base local: el MISMO movimiento, dos filas, dos veces en el arqueo.
 *
 * Medido en Android: un PAY_IN de $100 que ya estaba en Room antes de actualizar la app deja
 * el esperado del cajero en **$5,330.00 en vez de $5,230.00 — +$100**, el tamaño exacto del
 * movimiento heredado (con un PAY_OUT el error va al otro lado: faltante inventado). No se
 * cura solo: la limpieza por tipo del cliente excluye PAY_IN/PAY_OUT a propósito (un retiro
 * sin red debe sobrevivir) y su promoción sólo corre al ESCRIBIR el evento, así que jamás
 * alcanza filas que ya estaban en la base. Es PERMANENTE.
 *
 * Con la llave la fusión es exacta: `localId` que el cliente reconoce → es suyo, la fila local
 * adopta el id del servidor (UNA fila); `localId` desconocido o null → es de otro aparato o lo
 * escribió el servidor, entra por su id.
 *
 * ADITIVO y OPCIONAL (contrato /mobile — nunca se quita ni se renombra un campo): `null`
 * cuando la fila no tiene llave, y una app vieja que no lo lee se comporta idéntico a hoy.
 */
function formatEvent(event: any) {
  return {
    id: event.id,
    sessionId: event.sessionId,
    type: event.type,
    amount: toDollars(event.amount),
    note: event.note,
    staffId: event.staffId,
    staffName: event.staffName,
    orderId: event.orderId,
    localId: event.localId ?? null,
    createdAt: event.createdAt.toISOString(),
  }
}

function toDollars(val: any): number {
  return Number(Number(val).toFixed(2))
}
