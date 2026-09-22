/**
 * Integration: la declaración del cajero contra POSTGRES REAL (plan 18-sep, Task 5).
 *
 * 🔴 POR QUÉ EL UNIT NO BASTA, y es la mitad del incidente: que la terminal quede LIBRE no lo decide ninguna
 * comparación en JavaScript — lo decide el ÍNDICE ÚNICO PARCIAL de la base
 * (`UNIQUE(terminalId) WHERE status IN ('PENDING','SENT','CANCEL_REQUESTED','UNKNOWN')`). Con `prismaMock` se
 * puede afirmar que el UPDATE se llamó, pero no que la ranura se soltó: eso sólo lo prueba intentar crear otra
 * solicitud en la MISMA terminal y ver que Postgres la acepta.
 *
 * Lo mismo con el veto: `sinEvidenciaPositivaSql` y `hayEvidenciaDeConciliacionSql` son SQL que el mock nunca
 * evalúa. Aquí sí corren.
 *
 * El escenario es el de Testarudo del 18-sep: $65.00 + $9.75 de propina, fila UNKNOWN, terminal de vuelta.
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import {
  reconcileUncharged,
  reconcileBankDeclined,
  UnchargedReconciliationError,
} from '@/services/tpv/uncharged-reconciliation.service'
import { randomUUID } from 'crypto'
import { terminalPaymentService } from '@/services/terminal-payment.service'

const resolucionFija = '11111111-1111-4111-8111-111111111111'

jest.setTimeout(120000)

describe('la declaración del cajero libera la venta Y la ranura, contra Postgres real', () => {
  let venueId: string
  let staffCajeroId: string
  let staffMeseroId: string
  const sufijo = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const terminalId = `t-uncharged-${sufijo}`.toLowerCase().slice(0, 40)

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Uncharged Org ${sufijo}`, email: `unch-${sufijo}@test.com`, phone: '5550000000' },
    })
    const venue = await prisma.venue.create({
      data: {
        name: `Uncharged Venue ${sufijo}`,
        slug: `uncharged-${sufijo}`,
        organizationId: org.id,
        address: 'Test',
        city: 'Test',
        state: 'Test',
        country: 'MX',
        zipCode: '12345',
        timezone: 'America/Mexico_City',
      },
    })
    venueId = venue.id

    const cajero = await prisma.staff.create({
      data: {
        email: `unch-cajero-${sufijo}@test.com`,
        firstName: 'Viridiana',
        lastName: 'Cajera',
        phone: '5551110000',
        organizations: { create: { organizationId: org.id, role: 'MEMBER', isPrimary: true, isActive: true } },
        venues: { create: { venueId: venue.id, role: 'CASHIER', active: true } },
      },
    })
    staffCajeroId = cajero.id

    const mesero = await prisma.staff.create({
      data: {
        email: `unch-mesero-${sufijo}@test.com`,
        firstName: 'Mesero',
        lastName: 'Sin Permiso',
        phone: '5551110001',
        organizations: { create: { organizationId: org.id, role: 'MEMBER', isPrimary: true, isActive: true } },
        venues: { create: { venueId: venue.id, role: 'WAITER', active: true } },
      },
    })
    staffMeseroId = mesero.id
  })

  /** Una fila como la del incidente: UNKNOWN, la terminal ya volvió, sin pago. */
  async function sembrarFilaAtorada(over: Record<string, unknown> = {}) {
    const requestId = randomUUID()
    const ahora = new Date()
    await prisma.terminalPaymentRequest.create({
      data: {
        requestId,
        venueId,
        terminalId,
        status: 'UNKNOWN',
        amountCents: 6500,
        tipCents: 975,
        terminalReturnedAt: ahora,
        acknowledgedAt: ahora,
        expiresAt: new Date(ahora.getTime() - 30 * 60 * 1000),
        ...over,
      },
    })
    // 🔴 En el camino REAL siempre existe el vínculo S1: el webhook no llega aquí sin él (`findAttemptLink`).
    // Sembrarlo hace que las pruebas ejerciten el escenario que de verdad ocurre — sin esto probaban uno
    // imposible, y por eso no vieron que sin vínculos se liberaba (Codex, 5ª pasada).
    await prisma.terminalPaymentAttemptLink.create({
      data: { attemptId: `att-${requestId}`, requestId, venueId, terminalId: (over.terminalId as string) ?? terminalId },
    })
    return requestId
  }

  afterEach(async () => {
    // 🔴 También el rastro: sin esto los asientos de una prueba se cuentan en la siguiente y el conteo
    // acusa en falso al candado de concurrencia (pasó al escribir esta suite).
    await prisma.activityLog.deleteMany({ where: { venueId } })
    // Los eventos del procesador no cuelgan del venue (el cruce los deja con `venueId: null`): se
    // limpian por los intentos de ESTA suite, o contaminan la siguiente prueba.
    const vinculos = await prisma.terminalPaymentAttemptLink.findMany({ where: { venueId }, select: { attemptId: true } })
    if (vinculos.length > 0)
      await prisma.providerEventLog.deleteMany({ where: { attemptId: { in: vinculos.map(v => v.attemptId) } } })
    await prisma.terminalPaymentRequest.deleteMany({ where: { venueId } })
  })

  it('🔴 la declaración escribe el desenlace y LIBERA LA RANURA: otra solicitud en la MISMA terminal entra', async () => {
    const requestId = await sembrarFilaAtorada()

    // Antes: la ranura está tomada — el índice único parcial rechaza otra solicitud viva en esa terminal.
    await expect(
      prisma.terminalPaymentRequest.create({
        data: {
          requestId: randomUUID(),
          venueId,
          terminalId,
          status: 'PENDING',
          amountCents: 100,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        },
      }),
    ).rejects.toThrow()

    const r = await reconcileUncharged(
      { venueId, requestId, actorStaffId: staffCajeroId, source: 'MOBILE' },
      { requestId, resolutionId: randomUUID(), statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
    )
    expect(r.kind).toBe('UNCHARGED_VERIFIED')

    const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
    expect(fila).toMatchObject({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE', cancelDisposition: null })
    expect(fila?.operatorReconciliation).toMatchObject({ kind: 'UNCHARGED_VERIFIED', staffId: staffCajeroId })

    // 🔴 DESPUÉS: la ranura quedó libre de verdad. Esto es lo que el cajero no podía conseguir el 18-sep.
    const nueva = await prisma.terminalPaymentRequest.create({
      data: {
        requestId: randomUUID(),
        venueId,
        terminalId,
        status: 'PENDING',
        amountCents: 100,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    })
    expect(nueva.id).toBeTruthy()

    const asientos = await prisma.activityLog.findMany({
      where: { action: 'TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED', venueId, entityId: fila!.id },
    })
    expect(asientos).toHaveLength(1)
    expect(asientos[0].staffId).toBe(staffCajeroId)
  })

  it('🔴 con un Payment ligado NO declara: el SQL del veto corre de verdad', async () => {
    const requestId = await sembrarFilaAtorada()
    const orden = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `UNCH-${sufijo}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'TAKEOUT',
        source: 'TPV',
        status: 'CONFIRMED',
        paymentStatus: 'PENDING',
        subtotal: 65,
        taxAmount: 0,
        total: 65,
        createdById: staffCajeroId,
      },
    })
    await prisma.payment.create({
      data: {
        venueId,
        orderId: orden.id,
        amount: 65,
        tipAmount: 9.75,
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 65,
        terminalPaymentRequestId: requestId,
      },
    })

    await expect(
      reconcileUncharged(
        { venueId, requestId, actorStaffId: staffCajeroId, source: 'MOBILE' },
        { requestId, resolutionId: randomUUID(), statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
      ),
    ).rejects.toThrow(UnchargedReconciliationError)

    const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
    expect(fila?.failureCode).not.toBe('OPERATOR_RECONCILED_NO_CHARGE')
    expect(fila?.operatorReconciliation).toBeNull()
  })

  it('🔴 un WAITER no puede declarar, aunque la fila sea elegible', async () => {
    const requestId = await sembrarFilaAtorada()
    await expect(
      reconcileUncharged(
        { venueId, requestId, actorStaffId: staffMeseroId, source: 'MOBILE' },
        { requestId, resolutionId: randomUUID(), statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
      ),
    ).rejects.toMatchObject({ statusCode: 403 })

    const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
    expect(fila?.status).toBe('UNKNOWN')
  })

  it('🔴 dos declaraciones CONCURRENTES: una gana, la otra no corrompe nada', async () => {
    const requestId = await sembrarFilaAtorada()
    const unaDeclaracion = () =>
      reconcileUncharged(
        { venueId, requestId, actorStaffId: staffCajeroId, source: 'MOBILE' },
        { requestId, resolutionId: randomUUID(), statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
      )

    const resultados = await Promise.allSettled([unaDeclaracion(), unaDeclaracion()])
    const cumplidas = resultados.filter(r => r.status === 'fulfilled')
    expect(cumplidas.length).toBeGreaterThanOrEqual(1)

    const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
    expect(fila?.status).toBe('FAILED')
    // Una sola declaración guardada y UN solo asiento PARA ESTA SOLICITUD: el candado serializó de verdad.
    const asientos = await prisma.activityLog.findMany({
      where: { action: 'TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED', venueId, entityId: fila!.id },
    })
    expect(asientos).toHaveLength(1)
    // Y la declaración guardada es UNA: la segunda no la pisó con otro resolutionId.
    expect((fila?.operatorReconciliation as any)?.kind).toBe('UNCHARGED_VERIFIED')
  })

  it('🔴 P1 Codex: tras una aprobación TARDÍA, el replay NO dice «liberada»', async () => {
    const requestId = await sembrarFilaAtorada()
    const declararla = () =>
      reconcileUncharged(
        { venueId, requestId, actorStaffId: staffCajeroId, source: 'MOBILE' },
        { requestId, resolutionId: resolucionFija, statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
      )
    await declararla()

    // Llega el dinero tarde y el cierre común deja la fila COMPLETED con su Payment.
    const orden = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `UNCH-T-${sufijo}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'TAKEOUT',
        source: 'TPV',
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
        subtotal: 65,
        taxAmount: 0,
        total: 65,
        createdById: staffCajeroId,
      },
    })
    const pago = await prisma.payment.create({
      data: {
        venueId,
        orderId: orden.id,
        amount: 65,
        tipAmount: 9.75,
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 65,
        terminalPaymentRequestId: requestId,
      },
    })
    await prisma.terminalPaymentRequest.update({
      where: { requestId },
      data: { status: 'COMPLETED', paymentId: pago.id },
    })

    // El replay devuelve la MISMA declaración (fue aceptada de verdad)...
    const replay = await declararla()
    expect(replay.id).toBe(resolucionFija)

    // ...pero el wrapper ya NO puede decir «liberada»: el desenlace se deriva de la fila fresca.
    const r = await terminalPaymentService.releaseUnknownRequest({
      requestId,
      venueId,
      actor: { staffId: staffCajeroId, source: 'MOBILE' },
      reason: 'replay',
      declaration: { requestId, resolutionId: resolucionFija, statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
    })
    expect(r.released).toBe(false)
    expect(r.status).toBe('COMPLETED')
    expect(r.paymentId).toBe(pago.id)
  })

  it('🔴 Codex r4: el replay NO dice «liberada» con una aprobación del banco pendiente de retención', async () => {
    const requestId = await sembrarFilaAtorada()
    const declarar = () =>
      reconcileUncharged(
        { venueId, requestId, actorStaffId: staffCajeroId, source: 'MOBILE' },
        { requestId, resolutionId: resolucionFija, statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
      )
    await declarar()

    // Llega un Payment PENDING con evidencia de colisión: el banco habló, pero la fila NO cambió de estado.
    const orden = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `UNCH-R4-${sufijo}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'TAKEOUT', source: 'TPV', status: 'CONFIRMED', paymentStatus: 'PENDING',
        subtotal: 65, taxAmount: 0, total: 65, createdById: staffCajeroId,
      },
    })
    await prisma.payment.create({
      data: {
        venueId, orderId: orden.id, amount: 65, tipAmount: 0, method: 'CREDIT_CARD',
        status: 'PENDING', feePercentage: 0, feeAmount: 0, netAmount: 65,
        terminalPaymentRequestId: requestId,
        processorData: { reconciliation: { kind: 'POSSIBLE_SECOND_CAPTURE' } },
      },
    })

    // La fila sigue FAILED/OPERATOR_RECONCILED_NO_CHARGE, sin paymentId...
    const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
    expect(fila).toMatchObject({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE', paymentId: null })

    // ...y aun así el replay NO puede decir que quedó liberada.
    const r = await terminalPaymentService.releaseUnknownRequest({
      requestId, venueId,
      actor: { staffId: staffCajeroId, source: 'MOBILE' },
      reason: 'replay',
      declaration: { requestId, resolutionId: resolucionFija, statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
    })
    expect(r.released).toBe(false)
  })

  it('🔴 P1 Codex (20-sep): el replay NO dice «liberada» con un aprobado del MISMO intento recibido por OTRO venue', async () => {
    // 🔴 El hueco: la revalidación del replay buscaba aprobaciones SÓLO en este venue
    // (`aprobadoVinculadoSql` filtra por `e."venueId" = venueId`). Un webhook del mismo intento que
    // aterriza en OTRO negocio queda `LINK_VENUE_MISMATCH` y NO crea `Payment`, así que ni el estado
    // ni el puntero de la fila se mueven: el replay respondía `released:true` y le decía al cajero
    // «vuelve a cobrar» con el cargo ya hecho. Una declaración NUEVA sí lo habría vetado.
    const requestId = await sembrarFilaAtorada()
    const declaration = { requestId, resolutionId: resolucionFija, statement: 'UNCHARGED_VERIFIED' as const, statementVersion: 1 as const }
    const attemptId = `att-cruce-${sufijo}-${Math.random().toString(36).slice(2, 8)}`
    await prisma.terminalPaymentAttemptLink.create({ data: { requestId, attemptId, venueId, terminalId } })

    await reconcileUncharged({ venueId, requestId, actorStaffId: staffCajeroId, source: 'MOBILE' }, declaration)

    // El aprobado llega a OTRO venue: el vínculo es de éste, el evento no.
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR',
        venueId: null, // ningún venue lo reclamó: es el cruce que `LINK_VENUE_MISMATCH` describe
        type: 'send_transaction',
        attemptId,
        errorReason: 'LINK_VENUE_MISMATCH',
        payload: { payload: { status: 'APROBADO' } },
      },
    })

    const r = await terminalPaymentService.releaseUnknownRequest({
      requestId,
      venueId,
      actor: { staffId: staffCajeroId, source: 'MOBILE' },
      reason: 'replay',
      declaration,
    })
    expect(r.released).toBe(false)
  })

  it('🔴 P1 Codex (20-sep): tras la declaración, la entrega YA NO EMITE — y el control demuestra que sí emitiría', async () => {
    // 🔴 El hueco: grabar la procedencia y emitir eran dos pasos con una SUSPENSIÓN en medio. Si en esa
    // ventana la fila vencía a UNKNOWN y el cajero declaraba, el `emit` salía igual y la terminal pedía la
    // tarjeta sobre una venta YA liberada — el cobro doble por el otro extremo. Ahora las dos van bajo el
    // MISMO candado que toma la declaración, y el UPDATE de la procedencia (que exige un estado entregable)
    // ES la comprobación del estado vigente.
    const entregar = (requestId: string, emitir: () => void) =>
      (
        terminalPaymentService as unknown as {
          entregarBajoCandado: (
            requestId: string,
            venueId: string,
            entry: Record<string, number>,
            socketId: string,
            replay: boolean,
            emitir: () => void,
          ) => Promise<boolean>
        }
      ).entregarBajoCandado(requestId, venueId, { terminalPaymentAckVersion: 1 }, 'socket-de-prueba', false, emitir)

    // 🟢 CONTROL primero: sobre una fila viva SÍ emite. Sin esto, el caso de abajo pasaría por el motivo
    // equivocado (por ejemplo si `entregarBajoCandado` devolviera false siempre).
    // Terminal PROPIA: el índice único parcial sólo deja una fila viva por terminal, y abajo hay otra.
    const vivo = await sembrarFilaAtorada({ status: 'PENDING', terminalId: `${terminalId}-b`.slice(0, 40) })
    let emitidosVivo = 0
    expect(await entregar(vivo, () => void emitidosVivo++)).toBe(true)
    expect(emitidosVivo).toBe(1)

    // Y sobre una DECLARADA no sale un solo paquete.
    const requestId = await sembrarFilaAtorada()
    await reconcileUncharged(
      { venueId, requestId, actorStaffId: staffCajeroId, source: 'MOBILE' },
      { requestId, resolutionId: resolucionFija, statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
    )
    let emitidos = 0
    expect(await entregar(requestId, () => void emitidos++)).toBe(false)
    expect(emitidos).toBe(0)

    // Y la declaración queda intacta: no se re-abrió la solicitud ni se le añadió una entrega.
    const fresca = await prisma.terminalPaymentRequest.findFirstOrThrow({ where: { requestId, venueId } })
    expect(fresca.status).toBe('FAILED')
    expect(fresca.failureCode).toBe('OPERATOR_RECONCILED_NO_CHARGE')
  })

  it('🔴 Codex (21-sep): si algo falla DESPUÉS de emitir, la constancia de la entrega SOBREVIVE', async () => {
    // 🔴 La regresión que abrí el 20-sep al meter grabación y emisión en UNA transacción: al fallar el
    // commit, Postgres revertía la procedencia **pero el paquete ya había salido**. Quedaba un cobro
    // entregado sin rastro, y un `NOT_FOUND` de la sonda lo libera como `TPV_NEVER_RECEIVED` — o sea,
    // liberar a ciegas una terminal que sí lo recibió. Ahora la marca va ANTES y por su cuenta.
    const requestId = await sembrarFilaAtorada({ status: 'PENDING', terminalId: `${terminalId}-c`.slice(0, 40) })
    const servicio = terminalPaymentService as unknown as {
      entregarBajoCandado: (
        requestId: string,
        venueId: string,
        entry: Record<string, number>,
        socketId: string,
        replay: boolean,
        emitir: () => void,
      ) => Promise<boolean>
    }

    await expect(
      servicio.entregarBajoCandado(requestId, venueId, { terminalPaymentAckVersion: 1 }, 'socket-x', false, () => {
        throw new Error('el socket murió justo después de mandar el paquete')
      }),
    ).rejects.toThrow('el socket murió')

    const fila = await prisma.terminalPaymentRequest.findFirstOrThrow({ where: { requestId, venueId } })
    const entregas = (fila.deliveryProvenance as { deliveries?: unknown[] } | null)?.deliveries
    expect(Array.isArray(entregas)).toBe(true)
    expect(entregas).toHaveLength(1)
    // Y NO es `[]`: una procedencia vacía es exactamente lo que la sonda lee como «nunca entregada».
    expect(fila.deliveryAttempts).toBe(1)
  })

  it('🔴 Codex (21-sep): `failUndelivered` CONSERVA una afirmación de cobro ya guardada', async () => {
    // El envío original no encuentra su socket y entra aquí mientras un éxito degradado ya dejó su
    // `claimedSuccess`. Antes el sobre se reemplazaba entero: la señal positiva desaparecía y la
    // declaración podía aceptar sin verla. Ahora se fusiona.
    const requestId = await sembrarFilaAtorada({
      status: 'PENDING',
      terminalId: `${terminalId}-d`.slice(0, 40),
      resultJson: { status: 'success', claimedSuccess: { transactionId: 'tx-real-123' } },
    })
    const servicio = terminalPaymentService as unknown as {
      failUndelivered: (requestId: string, venueId: string, failureCode: string) => Promise<void>
    }

    await servicio.failUndelivered(requestId, venueId, 'SOCKET_NOT_FOUND')

    const fila = await prisma.terminalPaymentRequest.findFirstOrThrow({ where: { requestId, venueId } })
    const sobre = fila.resultJson as Record<string, unknown>
    expect(fila.status).toBe('UNKNOWN')
    expect(sobre.origin).toBe('SERVER')
    // 🔴 Lo que importa: la afirmación del cobro sigue ahí.
    expect(sobre.claimedSuccess).toEqual({ transactionId: 'tx-real-123' })

    // Y por eso la declaración NO puede aceptar sobre esta fila.
    await expect(
      reconcileUncharged(
        { venueId, requestId, actorStaffId: staffCajeroId, source: 'MOBILE' },
        { requestId, resolutionId: resolucionFija, statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/POSITIVE_EVIDENCE_EXISTS|TERMINAL_NEVER_ANSWERED/) })
  })

  it('🟢 CONTROL del veto: sin ninguna evidencia, el replay SÍ dice «liberada» (si no, el de arriba pasa por el motivo equivocado)', async () => {
    const requestId = await sembrarFilaAtorada()
    const declaracion = {
      requestId,
      resolutionId: resolucionFija,
      statement: 'UNCHARGED_VERIFIED' as const,
      statementVersion: 1,
    }
    await reconcileUncharged({ venueId, requestId, actorStaffId: staffCajeroId, source: 'MOBILE' }, declaracion)

    const r = await terminalPaymentService.releaseUnknownRequest({
      requestId,
      venueId,
      actor: { staffId: staffCajeroId, source: 'MOBILE' },
      reason: 'replay',
      declaration: declaracion,
    })
    expect(r.released).toBe(true)
  })

  it('🔴 una fila TIMED_OUT legacy SIN la marca de retorno se declara si la terminal está viva', async () => {
    const requestId = await sembrarFilaAtorada({ status: 'TIMED_OUT', terminalReturnedAt: null })
    await prisma.terminal.create({
      data: {
        venueId,
        name: `Term ${sufijo}`,
        serialNumber: terminalId,
        type: 'TPV_ANDROID',
        status: 'ACTIVE',
        lastHeartbeat: new Date(),
      },
    })
    const r = await reconcileUncharged(
      { venueId, requestId, actorStaffId: staffCajeroId, source: 'MOBILE' },
      { requestId, resolutionId: randomUUID(), statement: 'UNCHARGED_VERIFIED', statementVersion: 1 },
    )
    expect(r.kind).toBe('UNCHARGED_VERIFIED')
    await prisma.terminal.deleteMany({ where: { venueId } })
  })

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // 🔴 EL RECHAZO DEL BANCO — la misma liberación, con evidencia del procesador en vez de la
  // palabra del cajero.
  //
  // Founder, 21-sep-2026: «todo lo que hicimos fue hacer lo de webhook first. ¿Por qué seguimos
  // con lo de "si no cobró"? eso lo podemos verificar en el webhook». Tenía razón, y está medido
  // en producción ese día: **187 rechazos en 30 días** (68 de AngelPay + 119 de Blumon), el 100 %
  // con referencia, y NINGUNO liberaba nada — AngelPay los tiraba (`return null` para todo lo que
  // no fuera aprobado) y Blumon ni siquiera mira `TerminalPaymentRequest`.
  //
  // 🔑 Un rechazo NUNCA crea dinero, así que su único modo de falla es cerrar la fila EQUIVOCADA.
  // Por eso reusa los mismos vetos que la declaración del cajero, y por eso estas pruebas corren
  // contra Postgres real: el veto y la ranura son SQL, no comparaciones en JavaScript.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  describe('el rechazo del banco libera la venta Y la ranura', () => {
    it('🔴 un rechazo cierra la fila y SUELTA LA RANURA: otra solicitud en la MISMA terminal entra', async () => {
      const requestId = await sembrarFilaAtorada()

      const r = await reconcileBankDeclined({
        venueId,
        requestId,
        origen: 'ANGELPAY',
        evidencia: { eventLogId: `evt-${randomUUID()}`, attemptId: `att-${requestId}`, codigo: '05', descripcion: 'Do not honor' },
      })
      expect(r.closed).toBe(true)

      const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
      expect(fila?.status).toBe('FAILED')
      expect(fila?.failureCode).toBe('BANK_DECLINED')
      // 🔴 El POS pinta ESTE texto: el mensaje lo escribe el servidor, nunca la app.
      const sobre = fila?.resultJson as Record<string, unknown>
      expect(sobre.status).toBe('failed')
      expect(sobre.outcomeEvidence).toBe('BANK_DECLINED')
      expect(String(sobre.errorMessage)).toMatch(/rechaz/i)

      // La mitad que sólo Postgres puede probar: el índice único parcial soltó la terminal.
      await expect(
        prisma.terminalPaymentRequest.create({
          data: {
            requestId: randomUUID(),
            venueId,
            terminalId,
            status: 'PENDING',
            amountCents: 1000,
            tipCents: 0,
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ).resolves.toBeTruthy()
    })

    it('🔴 con un Payment ligado NO cierra: el veto SQL corre de verdad', async () => {
      const requestId = await sembrarFilaAtorada()
      const orden = await prisma.order.create({
        data: {
          venueId,
          orderNumber: `BANKDEC-${sufijo}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'TAKEOUT',
          source: 'TPV',
          status: 'CONFIRMED',
          paymentStatus: 'PENDING',
          subtotal: 65,
          taxAmount: 0,
          total: 65,
          createdById: staffCajeroId,
        },
      })
      await prisma.payment.create({
        data: {
          venueId,
          orderId: orden.id,
          amount: 65,
          tipAmount: 9.75,
          method: 'CREDIT_CARD',
          status: 'COMPLETED',
          feePercentage: 0,
          feeAmount: 0,
          netAmount: 65,
          terminalPaymentRequestId: requestId,
        },
      })

      const r = await reconcileBankDeclined({
        venueId,
        requestId,
        origen: 'ANGELPAY',
        evidencia: { eventLogId: `evt-${randomUUID()}`, attemptId: `att-${requestId}`, codigo: '05' },
      })
      expect(r.closed).toBe(false)
      expect(r.reason).toBe('POSITIVE_EVIDENCE_EXISTS')

      const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
      expect(fila?.failureCode).not.toBe('BANK_DECLINED')
      expect(fila?.status).toBe('UNKNOWN')
    })

    it('🔴 una fila PENDING NO se cierra: el cajero puede estar reintentando EN la terminal', async () => {
      // 🔑 Éste es el candado que hace innecesario razonar sobre relojes: mientras la terminal
      // trabaja, la fila está PENDING y el rechazo del intento anterior no puede matarla.
      const requestId = await sembrarFilaAtorada({ status: 'PENDING', terminalId: `${terminalId}-viva`.slice(0, 40) })

      const r = await reconcileBankDeclined({
        venueId,
        requestId,
        origen: 'BLUMON',
        evidencia: { eventLogId: `evt-${randomUUID()}`, attemptId: `att-${requestId}`, codigo: '55' },
      })
      expect(r.closed).toBe(false)
      expect(r.reason).toBe('NOT_ELIGIBLE')

      const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
      expect(fila?.status).toBe('PENDING')
    })

    it('🔴 un webhook REPETIDO no rompe nada ni vuelve a cerrar (los procesadores reintentan)', async () => {
      const requestId = await sembrarFilaAtorada()
      const evidencia = { eventLogId: `evt-${randomUUID()}`, attemptId: `att-${requestId}`, codigo: '51' }

      const primero = await reconcileBankDeclined({ venueId, requestId, origen: 'BLUMON', evidencia })
      const segundo = await reconcileBankDeclined({ venueId, requestId, origen: 'BLUMON', evidencia })

      expect(primero.closed).toBe(true)
      // El segundo NO vuelve a cerrar, y tampoco explota: un webhook jamás puede lanzar.
      expect(segundo.closed).toBe(false)
      expect(segundo.reason).toBe('NOT_ELIGIBLE')
      const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
      expect(fila?.failureCode).toBe('BANK_DECLINED')
    })

    it('🔴 la terminal SORDA también se libera: el banco es mejor evidencia que el ACK del aparato', async () => {
      // 🔑 Es justo lo que a la declaración del cajero se le escapa (`constaQueSalio`): si la terminal nunca
      // acusó recibo, el cajero no puede declarar — pero si el BANCO contestó, la transacción salió sin duda.
      const requestId = await sembrarFilaAtorada({ acknowledgedAt: null, resultJson: undefined, deliveryProvenance: undefined })
      const r = await reconcileBankDeclined({
        venueId,
        requestId,
        origen: 'BLUMON',
        evidencia: { eventLogId: `evt-${randomUUID()}`, attemptId: `att-${requestId}`, codigo: 'rejected', descripcion: '51 FONDOS INSUFICIENTES' },
      })
      expect(r.closed).toBe(true)
      const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
      expect(fila?.failureCode).toBe('BANK_DECLINED')
      // 🔴 El CÓDIGO sí, la prosa del banco NO: el destructive pass del 21-sep demostró que meter su texto libre
      // en la pantalla deja pasar un «APROBADA, COBRO EXITOSO» dentro de un mensaje de rechazo. La descripción
      // vive en `bankDeclined.descripcion`, para diagnóstico.
      // El motivo se dice con NUESTRAS palabras (lista blanca por código), nunca con la prosa del banco.
      expect(String((fila?.resultJson as Record<string, unknown>).errorMessage)).toContain('fondos suficientes')
      expect(String((fila?.resultJson as Record<string, unknown>).errorMessage)).not.toContain('FONDOS INSUFICIENTES')
      expect((fila?.resultJson as Record<string, any>).bankDeclined.descripcion).toBe('51 FONDOS INSUFICIENTES')
    })

    it('🔴 tras el rechazo el servidor dice «NO se cobró», no «no se sabe» — es lo que lee el POS', async () => {
      // 🔴 El defecto que este test fija, y casi se me va: liberar la ranura NO basta. El POS decide qué pintar
      // con `desenlaceCanonico`, que para una fila FAILED sólo acredita «no se cobró» si su `failureCode` está en
      // `CODIGOS_SIN_COBRO`. Con un código que no esté en ese mapa, el cajero lee «no se sabe si se cobró» —
      // justo la pantalla que este trabajo existe para eliminar — mientras el banco ya había dicho que NO.
      const requestId = await sembrarFilaAtorada()
      await reconcileBankDeclined({
        venueId,
        requestId,
        origen: 'ANGELPAY',
        evidencia: { eventLogId: `evt-${randomUUID()}`, attemptId: `att-${requestId}`, codigo: 'declined', descripcion: 'Do not honor' },
      })
      const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
      const { desenlaceCanonico } = await import('@/services/terminal-payment.service')
      const d = desenlaceCanonico(fila!)
      expect(d.outcome).toBe('NOT_CHARGED')
      expect(d.outcomeEvidence).toBe('PROCESSOR_DECLINED')
    })

    it('🔴 P1-3 de Codex: NO cierra si entre la lectura y el CAS alguien afirmó cobro, y NO borra esa afirmación', async () => {
      // El CAS escribía `resultJson` COMPLETO desde la copia leída antes: un `claimedSuccess` persistido en
      // paralelo (`escribirSuccessDegradado`, que no toma el candado de solicitud) se perdía. Borrar evidencia
      // de cobro es peor que no liberar.
      const requestId = await sembrarFilaAtorada()
      await prisma.terminalPaymentRequest.update({
        where: { requestId },
        data: { resultJson: { claimedSuccess: { authorizationCode: '123456' } } },
      })
      const r = await reconcileBankDeclined({
        venueId,
        requestId,
        origen: 'ANGELPAY',
        evidencia: { eventLogId: `evt-${randomUUID()}`, attemptId: `att-${requestId}`, codigo: 'declined' },
      })
      expect(r.closed).toBe(false)
      const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
      expect(fila?.status).toBe('UNKNOWN')
      // La afirmación SIGUE AHÍ: no se pisó.
      expect((fila?.resultJson as Record<string, any>).claimedSuccess?.authorizationCode).toBe('123456')
    })

    it('🔴 P1-3 de Codex: NO cierra con la sonda reportando ejecución ACTIVA en el aparato', async () => {
      const requestId = await sembrarFilaAtorada({ probeActiveAt: new Date() })
      const r = await reconcileBankDeclined({
        venueId,
        requestId,
        origen: 'BLUMON',
        evidencia: { eventLogId: `evt-${randomUUID()}`, attemptId: `att-${requestId}`, codigo: '05' },
      })
      expect(r.closed).toBe(false)
      expect((await prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))?.status).toBe('UNKNOWN')
    })

    it('🔴 P1-4 de Codex: una liberación por rechazo es REVERSIBLE si luego aparece el dinero', async () => {
      // Sin esto, los caminos que vuelven a retener (aprobación tardía, pago sin ligar) responden NOT_APPLICABLE
      // y la fila se queda liberada con un cobro real encima. La declaración del cajero SÍ tiene esa red.
      const requestId = await sembrarFilaAtorada()
      await reconcileBankDeclined({
        venueId,
        requestId,
        origen: 'ANGELPAY',
        evidencia: { eventLogId: `evt-${randomUUID()}`, attemptId: `att-${requestId}`, codigo: 'declined' },
      })
      const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
      const { esLiberacionReversible } = await import('@/services/terminal-payment.service')
      expect(esLiberacionReversible(fila!)).toBe(true)
    })

    it('🔴 P1 de Codex: con REINTENTO el webhook no libera solo — el cajero confirma', async () => {
      // 🔴 El defecto que este test fija, y NO es una correlación equivocada — los dos intentos pertenecen
      // correctamente a la MISMA venta. El cajero reintenta conservando la solicitud: A se rechaza, nace B, B
      // autoriza mientras la fila está SENT, la fila vence a UNKNOWN y ENTONCES llega el webhook demorado de A.
      // Si B todavía no dejó evidencia, liberar la venta y decir «puedes volver a cobrar» es el cobro doble.
      // Codex: «los candados serializan escrituras; NO detienen al procesador».
      const requestId = await sembrarFilaAtorada()
      const intentoA = randomUUID()
      const intentoB = randomUUID()
      for (const attemptId of [intentoA, intentoB]) {
        await prisma.terminalPaymentAttemptLink.create({
          data: { attemptId, requestId, venueId, terminalId },
        })
      }
      // Sólo A tiene veredicto del banco. B no dejó nada: puede seguir ejecutándose en la terminal.
      await prisma.providerEventLog.create({
        data: {
          provider: 'PAYMENT_PROCESSOR',
          eventId: `angelpay-${randomUUID()}`,
          attemptId: intentoA,
          venueId,
          payload: { event_type: 'send_transaction', payload: { status: 'rejected', integratorReference: intentoA } },
          status: 'ERROR',
        },
      })

      const r = await reconcileBankDeclined({
        venueId,
        requestId,
        origen: 'ANGELPAY',
        evidencia: { eventLogId: `evt-${randomUUID()}`, attemptId: `att-${requestId}`, attemptId: intentoA, codigo: 'rejected', descripcion: '05 DECLINADA' },
      })

      expect(r.closed).toBe(false)
      expect(r.reason).toBe('NOT_ELIGIBLE')
      expect((await prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))?.status).toBe('UNKNOWN')
    })

    it('🟢 CONTROL: con UN solo intento el webhook ES toda la verdad y libera solo (97,4 % de las ventas)', async () => {
      // Un solo intento: el que sembró el helper. Es el caso del 97,4 % de las ventas.
      const requestId = await sembrarFilaAtorada()

      const r = await reconcileBankDeclined({
        venueId,
        requestId,
        origen: 'ANGELPAY',
        evidencia: { eventLogId: `evt-${randomUUID()}`, attemptId: `att-${requestId}`, codigo: 'rejected', descripcion: '05 DECLINADA' },
      })

      expect(r.closed).toBe(true)
      expect((await prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))?.failureCode).toBe('BANK_DECLINED')
    })

    it('🔴 Codex (5ª pasada): SIN ningún vínculo tampoco libera — una precondición externa no es una guarda', async () => {
      // Codex: «el array vacío sí pasa `some()`». Llamar sin vínculos liberaba, y la seguridad dependía de que
      // el llamador exigiera uno antes. Eso funciona hoy y se rompe el día que entre otro llamador.
      const requestId = randomUUID()
      const ahora = new Date()
      await prisma.terminalPaymentRequest.create({
        data: {
          requestId,
          venueId,
          terminalId: `${terminalId}-sinvinc`.slice(0, 40),
          status: 'UNKNOWN',
          amountCents: 6500,
          tipCents: 0,
          terminalReturnedAt: ahora,
          acknowledgedAt: ahora,
          expiresAt: new Date(ahora.getTime() - 60000),
        },
      })

      const r = await reconcileBankDeclined({
        venueId,
        requestId,
        origen: 'ANGELPAY',
        evidencia: { eventLogId: `evt-${randomUUID()}`, codigo: 'rejected', descripcion: '05 DECLINADA' },
      })

      expect(r.closed).toBe(false)
      expect((await prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))?.status).toBe('UNKNOWN')
    })

    it('🔴 SEGURIDAD: un cliente NO puede colar statement BANK_DECLINED para saltarse el permiso', async () => {
      // Agujero que abrí yo al parametrizar (21-sep) y que el guard nuevo cierra: si la procedencia se leyera
      // del CUERPO, cualquiera con acceso al endpoint del POS —un WAITER, sin `payments:reconcile-uncharged`—
      // podría declarar «el banco lo rechazó» y liberar la venta sin permiso.
      const requestId = await sembrarFilaAtorada()
      await expect(
        reconcileUncharged(
          { venueId, requestId, actorStaffId: staffMeseroId, source: 'MOBILE' },
          { requestId, resolutionId: randomUUID(), statement: 'BANK_DECLINED', statementVersion: 1 },
        ),
      ).rejects.toThrow(UnchargedReconciliationError)
      expect((await prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))?.status).toBe('UNKNOWN')
    })

    it('🔴 una solicitud de OTRO venue no se toca (el webhook llega por el secreto del comercio)', async () => {
      const requestId = await sembrarFilaAtorada()
      const r = await reconcileBankDeclined({
        venueId: 'venue-de-otro-negocio',
        requestId,
        origen: 'ANGELPAY',
        evidencia: { eventLogId: `evt-${randomUUID()}`, attemptId: `att-${requestId}`, codigo: '05' },
      })
      expect(r.closed).toBe(false)
      expect(r.reason).toBe('NOT_FOUND')
      const fila = await prisma.terminalPaymentRequest.findUnique({ where: { requestId } })
      expect(fila?.status).toBe('UNKNOWN')
    })
  })
})
