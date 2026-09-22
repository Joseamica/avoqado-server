import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import { reconcileBankDeclined } from '@/services/tpv/uncharged-reconciliation.service'
import { randomUUID } from 'crypto'

jest.setTimeout(120000)

describe('FULL-TESTING destructive - lo que un procesador puede meter en la pantalla del cajero', () => {
  let venueId: string
  const sufijo = `${Date.now()}`
  const base = `ft-dest-${sufijo}`.slice(0, 28)

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `FULLTEST Dest ${sufijo}`, email: `ftd-${sufijo}@test.com`, phone: '5550000001' },
    })
    const v = await prisma.venue.create({
      data: { name: `FULLTEST Dest ${sufijo}`, slug: `fulltest-dest-${sufijo}`, organizationId: org.id,
              address: 'T', city: 'T', state: 'T', country: 'MX', zipCode: '12345', timezone: 'America/Mexico_City' },
    })
    venueId = v.id
  })

  async function fila() {
    const requestId = randomUUID()
    const ahora = new Date()
    await prisma.terminalPaymentRequest.create({
      data: { requestId, venueId, terminalId: `${base}-${Math.random().toString(36).slice(2, 7)}`,
              status: 'UNKNOWN', amountCents: 6500, tipCents: 975, terminalReturnedAt: ahora, acknowledgedAt: ahora,
              expiresAt: new Date(ahora.getTime() - 60000) },
    })
    // En el camino real el webhook sólo llega con su vínculo S1: sembrarlo hace la prueba fiel.
    await prisma.terminalPaymentAttemptLink.create({
      data: { attemptId: `att-${requestId}`, requestId, venueId, terminalId: `${base}-x` },
    })
    return requestId
  }
  const msg = async (requestId: string) =>
    String(((await prisma.terminalPaymentRequest.findUnique({ where: { requestId } }))?.resultJson as any)?.errorMessage ?? '')

  it('A1 - descripcion de 10000 caracteres del procesador', async () => {
    const r = await fila()
    await reconcileBankDeclined({ venueId, requestId: r, origen: 'ANGELPAY',
      evidencia: { eventLogId: 'e', attemptId: `att-${r}`, codigo: '05', descripcion: 'X'.repeat(10000) } })
    const m = await msg(r)
    console.log(`[A1] longitud del mensaje que pinta el POS: ${m.length}`)
    expect(m.length).toBeLessThan(400)
  })

  it('A2 - el procesador manda un texto que CONTRADICE el rechazo', async () => {
    const r = await fila()
    await reconcileBankDeclined({ venueId, requestId: r, origen: 'ANGELPAY',
      evidencia: { eventLogId: 'e', attemptId: `att-${r}`, codigo: 'declined', descripcion: 'APROBADA, COBRO EXITOSO' } })
    const m = await msg(r)
    console.log(`[A2] el cajero lee: "${m}"`)
    expect(m).not.toMatch(/APROBADA|EXITOSO/i)
  })

  it('A3 - saltos de linea y control chars rompen el renglon', async () => {
    const r = await fila()
    const res = await reconcileBankDeclined({ venueId, requestId: r, origen: 'BLUMON',
      evidencia: { eventLogId: 'e', attemptId: `att-${r}`, codigo: '05' + String.fromCharCode(10, 10),
                   descripcion: 'A' + String.fromCharCode(0) + 'B' + String.fromCharCode(13, 10) + 'C' } })
    const m = await msg(r)
    const fila2 = await prisma.terminalPaymentRequest.findUnique({ where: { requestId: r } })
    console.log(`[A3] closed=${JSON.stringify(res)} status=${fila2?.status} failureCode=${fila2?.failureCode} msg=${JSON.stringify(m)}`)
    // Control positivo: si el mensaje viene vacío es porque NO se liberó, no porque esté saneado.
    expect(fila2?.status).toBe('FAILED')
    expect(m).not.toMatch(new RegExp('[' + String.fromCharCode(10) + String.fromCharCode(13) + String.fromCharCode(0) + ']'))
  })

  it('A4 - requestId vacio, gigante o con SQL no explotan ni liberan nada', async () => {
    for (const bad of ['', 'x'.repeat(5000), String.fromCharCode(39) + ' OR 1=1--']) {
      const r = await reconcileBankDeclined({ venueId, requestId: bad, origen: 'ANGELPAY', evidencia: { eventLogId: 'e' } })
      expect(r.closed).toBe(false)
    }
  })

  // ══════════════════════════════════════════════════════════════════════════════════════
  // 🔴 CON LOS VALORES REALES DE PRODUCCIÓN (medidos el 21-sep-2026, 68 rechazos en 30 días).
  // Mis pruebas anteriores usaban `status: 'declined'`, un valor INVENTADO. AngelPay manda
  // `status: 'rejected'` y el motivo útil va en `description`, con formato `<CÓDIGO> <TEXTO ES>`:
  //   51 FONDOS INSUFICIENTES (18) · 1A SE REQUIERE AUTENTICACION… (8) · 05 DECLINADA (7)
  //   U0 LLAMAR AL EMISOR (6) · 87 DATOS DE PISTA INCORRECTOS (5) · 91 INCAPAZ DE AUTORIZAR (4)
  // ══════════════════════════════════════════════════════════════════════════════════════
  it('R1 - con el payload REAL, el cajero NO lee "rejected" en ingles', async () => {
    const r = await fila()
    await reconcileBankDeclined({ venueId, requestId: r, origen: 'ANGELPAY',
      evidencia: { eventLogId: 'e', attemptId: `att-${r}`, codigo: 'rejected', descripcion: '87 DATOS DE PISTA INCORRECTOS' } })
    const m = await msg(r)
    console.log(`[R1] el cajero lee: "${m}"`)
    expect(m).not.toContain('rejected')
  })

  it('R2 - un motivo accionable se dice con NUESTRAS palabras, no con las del banco', async () => {
    const casos: Array<[string, RegExp]> = [
      ['51 FONDOS INSUFICIENTES', /fondos/i],
      ['87 DATOS DE PISTA INCORRECTOS', /pasarla|leer/i],
      ['U0 LLAMAR AL EMISOR', /banco|emisor/i],
    ]
    for (const [desc, esperado] of casos) {
      const r = await fila()
      await reconcileBankDeclined({ venueId, requestId: r, origen: 'ANGELPAY',
        evidencia: { eventLogId: 'e', attemptId: `att-${r}`, codigo: 'rejected', descripcion: desc } })
      const m = await msg(r)
      console.log(`[R2] "${desc}" -> "${m}"`)
      expect(m).toMatch(esperado)
      // Y nunca la prosa cruda del procesador: ese es el vector de A2.
      expect(m).not.toContain(desc)
    }
  })

  it('R3 - un codigo DESCONOCIDO no inventa motivo: mensaje limpio y accionable', async () => {
    const r = await fila()
    await reconcileBankDeclined({ venueId, requestId: r, origen: 'ANGELPAY',
      evidencia: { eventLogId: 'e', attemptId: `att-${r}`, codigo: 'rejected', descripcion: 'ZZ MOTIVO QUE NO CONOCEMOS' } })
    const m = await msg(r)
    console.log(`[R3] el cajero lee: "${m}"`)
    expect(m).not.toContain('ZZ')
    expect(m).toMatch(/volver a cobrar/)
  })

  it('U1 - un emoji al filo del tope no rompe el jsonb ni tumba la liberacion', async () => {
    // P2 de Codex (2a pasada): `.slice()` corta UNIDADES UTF-16. Con 199 caracteres + un emoji, el corte deja
    // un sustituto alto suelto (\ud83d); Postgres exige pares validos en jsonb, la transaccion revienta y la
    // liberacion muere con reason ERROR — o sea, el procesador podia dejar la terminal trabada con un emoji.
    const r = await fila()
    const res = await reconcileBankDeclined({
      venueId, requestId: r, origen: 'ANGELPAY',
      // 299 caracteres + emoji: el corte a 300 cae EXACTAMENTE en medio del par sustituto.
      evidencia: { eventLogId: 'e', attemptId: `att-${r}`, codigo: 'rejected', descripcion: '51 ' + 'x'.repeat(296) + String.fromCodePoint(0x1f600) },
    })
    const f2 = await prisma.terminalPaymentRequest.findUnique({ where: { requestId: r } })
    console.log(`[U1] closed=${JSON.stringify(res)} status=${f2?.status}`)
    expect(res.closed).toBe(true)
    expect(f2?.status).toBe('FAILED')
  })

  afterAll(async () => {
    await prisma.terminalPaymentRequest.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  })
})
