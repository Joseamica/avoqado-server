import fs from 'fs'
import os from 'os'
import path from 'path'
import type OpenAI from 'openai'
import {
  CALIFICADOR_INSTRUCCIONES,
  CALIFICADOR_MAX_ENTRADA_BYTES,
  CALIFICADOR_MAX_SALIDA,
  CALIFICADOR_MODELO,
  CALIFICADOR_PRECIO,
  CALIFICADOR_RESERVA_USD,
  META_AJUSTE,
  META_CIEGO,
  avisosDePalabras,
  calificarCondicion,
  huellaCalificador,
  leerVeredicto,
  preguntaDe,
  type GastoCalificador,
  type Veredicto,
} from '../../../../scripts/support-eval/calificador'
import {
  calificar,
  certificadoVigente,
  completitud,
  correrMeta,
  examen,
  resultadoMeta,
  type Calificador,
  type FilaMeta,
  type Salida,
} from '../../../../scripts/support-eval/run'

const EVAL_DIR = path.join(__dirname, '../../../../scripts/support-eval')
const USAGE = { input_tokens: 1000, output_tokens: 100 }
type Entrada = { tipo: 'debe' | 'no-debe'; pregunta: string; condicion: string; respuesta: string }

/** The grader model is always fake: it answers with whatever `responder` returns for the input it was sent. */
function fakeClient(
  responder: (input: Entrada) => { veredicto: string; cita: string } | string,
  opts: { usage?: unknown; status?: string; error?: Error } = {},
) {
  const create = jest.fn(async (request: Record<string, unknown>, _options?: unknown) => {
    if (opts.error) throw opts.error
    const r = responder(JSON.parse(String(request.input)))
    return {
      status: opts.status ?? 'completed',
      usage: 'usage' in opts ? opts.usage : USAGE,
      output: [{ type: 'message', content: [{ type: 'output_text', text: typeof r === 'string' ? r : JSON.stringify(r) }] }],
    }
  })
  return { client: { responses: { create } } as unknown as OpenAI, create }
}
const gastoNuevo = (topeUsd = 1): GastoCalificador => ({ reservadoUsd: 0, topeUsd })
const salida = (texto: string, accion: Salida['accion'] = 'contestar', guias = ['general/overview']): Salida => ({
  accion,
  guias,
  opciones: [],
  texto,
  sourceIds: [],
  costoUsd: 0,
  costoEstimado: false,
  tiempos: [],
  llamadas: 1,
  ms: 1,
})
const tmpDirs: string[] = []
/** A throwaway exam folder with a copy of calificador.ts, so a certificate can be computed and broken. */
function carpeta(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-calificador-'))
  tmpDirs.push(dir)
  fs.copyFileSync(path.join(EVAL_DIR, 'calificador.ts'), path.join(dir, 'calificador.ts'))
  return dir
}
afterAll(() => tmpDirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })))
const escribir = (dir: string, f: string, data: unknown) => fs.writeFileSync(path.join(dir, f), JSON.stringify(data, null, 2))
const leerJson = (dir: string, f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))

/** A meta-exam row whose fake verdict is `esperado`, quoted from its answer. */
const filaMeta = (id: string, familia: boolean, esperado: Veredicto): FilaMeta => ({
  id,
  familia,
  fuente: 'prueba',
  tipo: ['afirma', 'no-afirma'].includes(esperado) ? 'no-debe' : 'debe',
  pregunta: `pregunta de ${id}`,
  condicion: `cond-${id}-texto`,
  respuesta: `respuesta secreta de ${id}: cond-${id}-texto.`,
  esperado,
})
/** Answers each meta row as its `esperado` says, quoting the condition from the answer. */
function graderDeMeta(filas: FilaMeta[]) {
  const porCondicion = new Map(filas.map(f => [String(f.condicion), f]))
  return fakeClient(input => {
    const v = porCondicion.get(input.condicion)!.esperado
    return { veredicto: v, cita: ['omite', 'no-afirma'].includes(v) ? '' : input.condicion }
  })
}

describe('grader: leerVeredicto', () => {
  it('parses a valid verdict for each tipo', () => {
    const respuesta = 'El POS funciona sin internet y sincroniza al reconectar.'
    expect(leerVeredicto('{"veredicto":"cumple","cita":"funciona sin internet"}', 'debe', respuesta)).toEqual({
      veredicto: 'cumple',
      cita: 'funciona sin internet',
    })
    for (const v of ['omite', 'contradice', 'otra-accion'] as const)
      expect(leerVeredicto({ veredicto: v, cita: v === 'omite' ? '' : 'sincroniza al reconectar' }, 'debe', respuesta).veredicto).toBe(v)
    expect(leerVeredicto({ veredicto: 'afirma', cita: 'El POS funciona' }, 'no-debe', respuesta).veredicto).toBe('afirma')
    expect(leerVeredicto({ veredicto: 'no-afirma', cita: '' }, 'no-debe', respuesta)).toEqual({ veredicto: 'no-afirma', cita: '' })
    // The quote is normalized: case, accents, markdown marks and spaces don't matter.
    expect(leerVeredicto({ veredicto: 'cumple', cita: 'el  *POS* FUNCIONÁ' }, 'debe', respuesta).veredicto).toBe('cumple')
  })

  it('invalid JSON, unknown or wrong-tipo verdict, or a quote not in the answer → tecnico, never omite or contradice', () => {
    const respuesta = 'Usa la misma tarjeta del cobro.'
    const malos: [unknown, 'debe' | 'no-debe'][] = [
      ['{"veredicto":"cumple"', 'debe'],
      ['no es json', 'debe'],
      [null, 'debe'],
      [{ veredicto: 'cumple' }, 'debe'],
      [{ veredicto: 'cumple', cita: 'misma tarjeta', extra: 1 }, 'debe'],
      [{ veredicto: 'quizas', cita: '' }, 'debe'],
      [{ veredicto: 'tecnico', cita: '' }, 'debe'],
      [{ veredicto: 'afirma', cita: 'misma tarjeta' }, 'debe'],
      [{ veredicto: 'cumple', cita: 'misma tarjeta' }, 'no-debe'],
      [{ veredicto: 'cumple', cita: 'otra tarjeta' }, 'debe'],
      [{ veredicto: 'contradice', cita: 'no uses la misma' }, 'debe'],
      // A verdict that says the answer DOES say something needs its quote.
      [{ veredicto: 'cumple', cita: '' }, 'debe'],
      [{ veredicto: 'afirma', cita: '   ' }, 'no-debe'],
    ]
    for (const [raw, tipo] of malos) expect(leerVeredicto(raw, tipo, respuesta)).toEqual({ veredicto: 'tecnico', cita: '' })
  })
})

describe('grader: quotes', () => {
  it('a quote needs at least 8 normalized characters, or the whole explanation when it is shorter', () => {
    const respuesta = 'Usa la misma tarjeta del cobro.'
    // «tarjeta» (7) is too short to prove anything; «la misma» (8) is enough.
    expect(leerVeredicto({ veredicto: 'cumple', cita: 'tarjeta' }, 'debe', respuesta).veredicto).toBe('tecnico')
    expect(leerVeredicto({ veredicto: 'cumple', cita: '  *Tarjeta*  ' }, 'debe', respuesta).veredicto).toBe('tecnico')
    expect(leerVeredicto({ veredicto: 'cumple', cita: 'la misma' }, 'debe', respuesta).veredicto).toBe('cumple')
    expect(leerVeredicto({ veredicto: 'afirma', cita: 'cobro' }, 'no-debe', respuesta).veredicto).toBe('tecnico')
    // A short answer can only be quoted whole.
    expect(leerVeredicto({ veredicto: 'contradice', cita: 'No.' }, 'debe', 'No.').veredicto).toBe('contradice')
    expect(leerVeredicto({ veredicto: 'contradice', cita: 'no' }, 'debe', 'No, nunca.').veredicto).toBe('tecnico')
    // Through the real call: the explanation is what has to be quoted.
    return calificarCondicion(
      fakeClient(() => ({ veredicto: 'cumple', cita: 'misma' })).client,
      { tipo: 'debe', pregunta: 'p', condicion: { texto: 'Usa la misma tarjeta' }, respuesta },
      gastoNuevo(),
    ).then(r => expect(r).toEqual({ veredicto: 'tecnico', cita: '' }))
  })
})

describe('grader: a case passes on content only with every debeDecir cumple', () => {
  const esperado = { accion: 'contestar' as const, guias: ['general/overview'], debeDecir: ['efectivo', { texto: 'transferencia' }] }
  const con =
    (porCondicion: Record<string, Veredicto>): Calificador =>
    async i => ({ veredicto: porCondicion[i.condicion.texto], cita: 'x' })

  it('only cumple passes a debeDecir; a case passes only if every one is cumple', async () => {
    const s = salida('Sí: también registra efectivo y transferencia.')
    expect((await calificar(esperado, s, 'p', con({ efectivo: 'cumple', transferencia: 'cumple' }))).pasa).toBe(true)
    for (const v of ['omite', 'contradice', 'otra-accion', 'tecnico'] as Veredicto[]) {
      const nota = await calificar(esperado, s, 'p', con({ efectivo: 'cumple', transferencia: v }))
      expect(nota.pasa).toBe(false)
      expect(nota.faltaDecir).toEqual(['transferencia'])
    }
  })

  it('claves and prohibidas only add report warnings', async () => {
    const c = { texto: 'usa la misma tarjeta', claves: ['misma tarjeta', 'cobro'], prohibidas: ['otra tarjeta'] }
    const texto = 'Pásala con la *misma tarjeta*; no aceptes otra tarjeta.\n\nGuía: https://avoqado.io/help/tpv/cobro/x'
    expect(avisosDePalabras(texto, c)).toEqual(['falta la clave «cobro»', 'trae la prohibida «otra tarjeta»'])
    expect(avisosDePalabras('Usa la misma tarjeta del cobro.', c)).toEqual([])
    // The verdict decides; the warnings never do.
    const e = { accion: 'contestar' as const, guias: ['general/overview'], debeDecir: [c] }
    const ok = await calificar(e, salida(texto), 'p', async () => ({ veredicto: 'cumple', cita: 'misma tarjeta' }))
    expect(ok.pasa).toBe(true)
    expect(ok.avisos).toHaveLength(2)
    const no = await calificar(e, salida('Usa la misma tarjeta del cobro.'), 'p', async () => ({ veredicto: 'omite', cita: '' }))
    expect(no.pasa).toBe(false)
    expect(no.avisos).toEqual([])
  })
})

describe('grader: the call and its spending', () => {
  const input = {
    tipo: 'debe' as const,
    pregunta: 'el pos jala sin internet?',
    condicion: { texto: 'funciona sin internet', claves: ['CLAVE-PRIVADA'] },
    respuesta: 'Funciona sin internet.\n\nGuía: https://avoqado.io/help/general/overview\nFuente: manual de Avoqado · Caja',
  }
  const cumple = () => ({ veredicto: 'cumple', cita: 'funciona sin internet' })

  it('sends one condition, the question and only the explanation, never the expected label', async () => {
    const { client, create } = fakeClient(cumple)
    expect(await calificarCondicion(client, input, gastoNuevo())).toEqual({ veredicto: 'cumple', cita: 'funciona sin internet' })
    const [request, options] = create.mock.calls[0] as [Record<string, any>, unknown]
    expect(request).toMatchObject({
      model: CALIFICADOR_MODELO,
      store: false,
      max_output_tokens: CALIFICADOR_MAX_SALIDA,
      instructions: CALIFICADOR_INSTRUCCIONES,
    })
    expect(request.text.format).toMatchObject({ type: 'json_schema', strict: true })
    expect(options).toEqual({ timeout: 20_000, maxRetries: 0 })
    const sent = JSON.parse(request.input)
    expect(Object.keys(sent).sort()).toEqual(['condicion', 'pregunta', 'respuesta', 'tipo'])
    expect(sent.condicion).toBe('funciona sin internet')
    expect(request.input).not.toContain('CLAVE-PRIVADA')
    expect(request.input).not.toContain('Guía:')
    expect(request.input).not.toContain('Fuente:')
    expect(request.input).not.toContain('https://')
  })

  it('reserves the maximum before calling and does not call when it no longer fits (SIN_TOPE)', async () => {
    expect(CALIFICADOR_RESERVA_USD).toBeCloseTo(
      (CALIFICADOR_MAX_ENTRADA_BYTES * CALIFICADOR_PRECIO.entradaUsd + CALIFICADOR_MAX_SALIDA * CALIFICADOR_PRECIO.salidaUsd) / 1e6,
      12,
    )
    let reservadoAlLlamar = -1
    const gasto = gastoNuevo(2 * CALIFICADOR_RESERVA_USD)
    const { client, create } = fakeClient(
      () => {
        reservadoAlLlamar = gasto.reservadoUsd
        return cumple()
      },
      { usage: null },
    )
    expect(await calificarCondicion(client, input, gasto)).not.toBe('SIN_TOPE')
    expect(reservadoAlLlamar).toBe(CALIFICADOR_RESERVA_USD)
    expect(await calificarCondicion(client, input, gasto)).not.toBe('SIN_TOPE')
    expect(await calificarCondicion(client, input, gasto)).toBe('SIN_TOPE')
    expect(create).toHaveBeenCalledTimes(2)
    expect(gasto.reservadoUsd).toBe(2 * CALIFICADOR_RESERVA_USD)
  })

  it('a call without usage keeps the maximum reserved; with usage it settles the real cost', async () => {
    const sin = gastoNuevo()
    await calificarCondicion(fakeClient(cumple, { usage: null }).client, input, sin)
    expect(sin.reservadoUsd).toBe(CALIFICADOR_RESERVA_USD)
    const raro = gastoNuevo()
    await calificarCondicion(fakeClient(cumple, { usage: { input_tokens: 'mil', output_tokens: 3 } }).client, input, raro)
    expect(raro.reservadoUsd).toBe(CALIFICADOR_RESERVA_USD)
    const con = gastoNuevo()
    await calificarCondicion(fakeClient(cumple).client, input, con)
    expect(con.reservadoUsd).toBeCloseTo((1000 * CALIFICADOR_PRECIO.entradaUsd + 100 * CALIFICADOR_PRECIO.salidaUsd) / 1e6, 12)
  })

  it('a provider error is tecnico', async () => {
    const gasto = gastoNuevo()
    const caido = fakeClient(cumple, { error: new Error('timeout') })
    expect(await calificarCondicion(caido.client, input, gasto)).toEqual({ veredicto: 'tecnico', cita: '' })
    expect(gasto.reservadoUsd).toBe(CALIFICADOR_RESERVA_USD)
    const incompleta = fakeClient(cumple, { status: 'incomplete' })
    expect(await calificarCondicion(incompleta.client, input, gastoNuevo())).toEqual({ veredicto: 'tecnico', cita: '' })
  })

  it('an input over CALIFICADOR_MAX_ENTRADA_BYTES, multibyte and with the contradiction after where a cut would fall, is not sent and is tecnico; the run and the meta-exam are INCOMPLETO', async () => {
    const respuesta = `${'ñ'.repeat(3000)} El cobro con tarjeta no funciona sin internet.`
    // In characters it would fit: only the UTF-8 bytes go over, and the contradiction sits past any cut.
    expect((CALIFICADOR_INSTRUCCIONES + respuesta).length).toBeLessThan(CALIFICADOR_MAX_ENTRADA_BYTES)
    expect(Buffer.byteLength(CALIFICADOR_INSTRUCCIONES + respuesta, 'utf8')).toBeGreaterThan(CALIFICADOR_MAX_ENTRADA_BYTES)
    const { client, create } = fakeClient(cumple)
    const gasto = gastoNuevo()
    const big = { ...input, respuesta }
    expect(await calificarCondicion(client, big, gasto)).toEqual({ veredicto: 'tecnico', cita: '' })
    expect(create).not.toHaveBeenCalled()
    expect(gasto.reservadoUsd).toBe(0)
    // The run: one tecnico → INCOMPLETO.
    const nota = await calificar(
      { accion: 'contestar', guias: ['general/overview'], debeDecir: ['funciona sin internet'] },
      salida(respuesta),
      'p',
      i => calificarCondicion(client, i, gasto),
    )
    expect(nota.tecnicos).toBe(1)
    expect(completitud(['c15'], ['c15'], false, nota.tecnicos).completo).toBe(false)
    // The meta-exam: the same row is tecnico, INCOMPLETO and not approved.
    const dir = carpeta()
    escribir(dir, META_AJUSTE, [{ ...filaMeta('grande', true, 'contradice'), condicion: 'funciona sin internet', respuesta }])
    const { resultado } = await correrMeta('ajuste', { client, dir, log: () => undefined })
    expect(resultado).toMatchObject({ completo: false, tecnicos: 1, aprobado: false })
    expect(create).not.toHaveBeenCalled()
  })
})

describe('grader: the certificate', () => {
  const aprobado = {
    completo: true,
    aprobado: true,
    total: 20,
    aciertos: 20,
    familiaTotal: 10,
    familiaAciertos: 10,
    tecnicos: 0,
    faltan: 0,
  }
  function certificada(): string {
    const dir = carpeta()
    escribir(dir, META_AJUSTE, [filaMeta('a1', true, 'cumple')])
    escribir(dir, META_CIEGO, [filaMeta('ciego-x1', true, 'omite')])
    escribir(dir, 'calificador-congelado.json', {
      huella: huellaCalificador(dir),
      ajuste: aprobado,
      ciego: { ...aprobado, sha256: 'x' },
      fecha: '2026-11-11',
    })
    expect(certificadoVigente(dir)).toBeNull()
    return dir
  }

  it('adding a case to the meta-exam, or changing calificador.ts, invalidates the certificate', () => {
    const a = certificada()
    escribir(a, META_AJUSTE, [filaMeta('a1', true, 'cumple'), filaMeta('a2', false, 'omite')])
    expect(certificadoVigente(a)).toMatch(/cambió/)
    const b = certificada()
    escribir(b, META_CIEGO, [filaMeta('ciego-x1', true, 'omite'), filaMeta('ciego-x2', true, 'cumple')])
    expect(certificadoVigente(b)).toMatch(/cambió/)
    const c = certificada()
    const src = fs.readFileSync(path.join(c, 'calificador.ts'), 'utf8')
    fs.writeFileSync(path.join(c, 'calificador.ts'), src.replace('Responde sólo con el JSON del esquema.', 'Responde con el JSON.'))
    expect(certificadoVigente(c)).toMatch(/cambió/)
  })

  it('the question with its history is built in calificador.ts, and changing only preguntaDe invalidates the certificate', () => {
    expect(preguntaDe([], 'hola?')).toBe('hola?')
    expect(preguntaDe(['como entro al panel', 'desde la compu'], 'y si se me olvido?')).toBe(
      'como entro al panel\ndesde la compu\ny si se me olvido?',
    )
    const dir = certificada()
    const src = fs.readFileSync(path.join(dir, 'calificador.ts'), 'utf8')
    const antes = "[...anteriores, mensaje].join('\\n')"
    expect(src).toContain(antes)
    fs.writeFileSync(path.join(dir, 'calificador.ts'), src.replace(antes, "[...anteriores, mensaje].join(' / ')"))
    expect(certificadoVigente(dir)).toMatch(/cambió/)
  })

  it('changing only explicacion invalidates the certificate', () => {
    const dir = certificada()
    const src = fs.readFileSync(path.join(dir, 'calificador.ts'), 'utf8')
    expect(src).toContain('(?:Guía|Fuente):')
    fs.writeFileSync(path.join(dir, 'calificador.ts'), src.replace('(?:Guía|Fuente):', '(?:Guía):'))
    expect(certificadoVigente(dir)).toMatch(/cambió/)
  })

  it('the main exam refuses to run without a certificate with ajuste and ciego passed', async () => {
    const dir = carpeta()
    escribir(dir, 'casos.json', [
      { id: 'c1', tipo: 'directa', app: 'dashboard', mensaje: 'hola?', esperado: { accion: 'contestar', debeDecir: ['algo'] } },
    ])
    escribir(dir, 'secuencias.json', [])
    escribir(dir, META_AJUSTE, [filaMeta('a1', true, 'cumple')])
    const { client, create } = fakeClient(() => 'nunca')
    const corre = () => examen('hibrido', undefined, client, dir)
    await expect(corre()).rejects.toThrow(/certificado/)
    for (const cert of [
      { huella: huellaCalificador(dir), ajuste: aprobado, ciego: null },
      { huella: huellaCalificador(dir), ajuste: aprobado, ciego: { ...aprobado, aprobado: false } },
      { huella: huellaCalificador(dir), ajuste: { ...aprobado, aprobado: false }, ciego: aprobado },
      { huella: 'f'.repeat(64), ajuste: aprobado, ciego: aprobado },
    ]) {
      escribir(dir, 'calificador-congelado.json', { ...cert, fecha: '2026-11-11' })
      await expect(corre()).rejects.toThrow(/certificado|cambió/)
    }
    // The other exams that grade content also need it.
    for (const etiqueta of ['hoy', 'secuencias'])
      await expect(examen(etiqueta, undefined, client, dir)).rejects.toThrow(/certificado|cambió/)
    expect(create).not.toHaveBeenCalled()
  })
})

describe('grader: the meta-exam', () => {
  const filas = (n: number, familia: number) =>
    Array.from({ length: n }, (_, i) =>
      filaMeta(`m${i + 1}`, i < familia, (['cumple', 'omite', 'contradice', 'otra-accion', 'afirma', 'no-afirma'] as Veredicto[])[i % 6]),
    )
  const veredictos = (fs_: FilaMeta[], cambiar: Record<string, Veredicto> = {}) =>
    new Map(fs_.map(f => [f.id, cambiar[f.id] ?? f.esperado]))

  it('meta bars: ajuste 100 % familia and ≥ 95 %; ciego ≥ 95 % and 100 % of its familia; one tecnico makes the meta-exam INCOMPLETO', () => {
    const f = filas(20, 10)
    expect(resultadoMeta(f, veredictos(f), false)).toMatchObject({ completo: true, aciertos: 20, familiaAciertos: 10, aprobado: true })
    // One miss outside the family: 19/20 = 95 % passes.
    expect(resultadoMeta(f, veredictos(f, { m15: 'omite' }), false).aprobado).toBe(true)
    // Two misses: 90 % fails.
    expect(resultadoMeta(f, veredictos(f, { m15: 'omite', m16: 'cumple' }), false).aprobado).toBe(false)
    // One miss inside the family fails even at 95 %.
    expect(resultadoMeta(f, veredictos(f, { m2: 'cumple' }), false)).toMatchObject({ aciertos: 19, familiaAciertos: 9, aprobado: false })
    // One tecnico (even outside the family, even at 95 %), a missing row or a cut: INCOMPLETO, never approved.
    expect(resultadoMeta(f, veredictos(f, { m15: 'tecnico' }), false)).toMatchObject({ completo: false, tecnicos: 1, aprobado: false })
    const sinUna = veredictos(f)
    sinUna.delete('m20')
    expect(resultadoMeta(f, sinUna, false)).toMatchObject({ completo: false, faltan: 1, aprobado: false })
    expect(resultadoMeta(f, veredictos(f), true)).toMatchObject({ completo: false, aprobado: false })
    // An empty file, or one without its family, proves nothing.
    expect(resultadoMeta([], new Map(), false).aprobado).toBe(false)
    const sinFamilia = filas(20, 0)
    expect(resultadoMeta(sinFamilia, veredictos(sinFamilia), false).aprobado).toBe(false)
  })

  it('meta-ciego refuses a second run with the same file', async () => {
    const dir = carpeta()
    const ajuste = filas(20, 10)
    const ciego = Array.from({ length: 6 }, (_, i) =>
      filaMeta(`ciego-x${i + 1}`, i < 3, (['cumple', 'omite', 'afirma', 'no-afirma', 'contradice', 'otra-accion'] as Veredicto[])[i]),
    )
    escribir(dir, META_AJUSTE, ajuste)
    escribir(dir, META_CIEGO, ciego)
    const noop = () => undefined
    // The ciego only runs after an approved ajuste with the same fingerprint.
    await expect(correrMeta('ciego', { client: graderDeMeta(ciego).client, dir, log: noop })).rejects.toThrow(/ajuste/)
    const a = await correrMeta('ajuste', { client: graderDeMeta(ajuste).client, dir, log: noop })
    expect(a.resultado.aprobado).toBe(true)
    expect(leerJson(dir, 'calificador-congelado.json')).toMatchObject({
      huella: huellaCalificador(dir),
      ajuste: { aprobado: true },
      ciego: null,
    })

    const log = jest.fn()
    const grader = graderDeMeta(ciego)
    const primera = await correrMeta('ciego', { client: grader.client, dir, log })
    expect(primera.resultado).toMatchObject({ completo: true, aprobado: true, total: 6, familiaTotal: 3 })
    expect(grader.create).toHaveBeenCalledTimes(6)
    expect(leerJson(dir, 'calificador-congelado.json').ciego).toMatchObject({ aprobado: true })
    expect(certificadoVigente(dir)).toBeNull()
    // Only totals and bars: never an id, a condition, a question or an answer.
    const visto = [...primera.lineas, ...log.mock.calls.flat().map(String)].join('\n')
    expect(visto).toMatch(/6/)
    for (const secreto of ['ciego-x', 'cond-', 'respuesta secreta', 'pregunta de']) expect(visto).not.toContain(secreto)
    // A broken ciego file says so without quoting any of it (JSON.parse's own message would).
    const roto = carpeta()
    fs.writeFileSync(path.join(roto, META_CIEGO), '[{"id": "ciego-x9", "respuesta": "respuesta secreta" oops')
    const error = await correrMeta('ciego', { client: grader.client, dir: roto, log: noop }).catch((e: Error) => e.message)
    expect(error).toMatch(/error de archivo/)
    for (const secreto of ['ciego-x', 'respuesta secreta', 'oops']) expect(error).not.toContain(secreto)
    escribir(roto, META_CIEGO, [{ ...filaMeta('ciego-x9', true, 'cumple'), esperado: 'quizas' }])
    const invalido = await correrMeta('ciego', { client: grader.client, dir: roto, log: noop }).catch((e: Error) => e.message)
    expect(invalido).toMatch(/error de archivo.*1 errores/)
    for (const secreto of ['ciego-x', 'quizas', 'respuesta secreta']) expect(invalido).not.toContain(secreto)

    // Second run with the same file: refused before any call, also after an explicit re-certification.
    await expect(correrMeta('ciego', { client: grader.client, dir, log: noop })).rejects.toThrow(/ya corrió/)
    await correrMeta('ajuste', { client: graderDeMeta(ajuste).client, dir, log: noop, recertificar: true })
    await expect(correrMeta('ciego', { client: grader.client, dir, log: noop })).rejects.toThrow(/ya corrió/)
    expect(grader.create).toHaveBeenCalledTimes(6)
  })

  it('meta-ajuste never silently drops a ciego of the current fingerprint: it refuses, or needs --recertificar', async () => {
    const dir = carpeta()
    const ajuste = filas(20, 10)
    const ciego = [filaMeta('ciego-x1', true, 'cumple'), filaMeta('ciego-x2', false, 'omite')]
    escribir(dir, META_AJUSTE, ajuste)
    escribir(dir, META_CIEGO, ciego)
    const noop = () => undefined
    await correrMeta('ajuste', { client: graderDeMeta(ajuste).client, dir, log: noop })
    await correrMeta('ciego', { client: graderDeMeta(ciego).client, dir, log: noop })
    expect(certificadoVigente(dir)).toBeNull()
    const otra = graderDeMeta(ajuste)
    await expect(correrMeta('ajuste', { client: otra.client, dir, log: noop })).rejects.toThrow(/--recertificar/)
    await expect(examen('meta-ajuste', undefined, otra.client, dir)).rejects.toThrow(/--recertificar/)
    expect(otra.create).not.toHaveBeenCalled()
    expect(certificadoVigente(dir)).toBeNull()
    // Only meta-ajuste takes the flag, and only that one.
    await expect(examen('meta-ciego', '--recertificar', otra.client, dir)).rejects.toThrow(/--recertificar/)
    await expect(examen('meta-ajuste', 'otra-cosa', otra.client, dir)).rejects.toThrow(/--recertificar/)
    expect(otra.create).not.toHaveBeenCalled()
    // Asked for explicitly, it re-certifies: the ciego is dropped and a NEW one is needed.
    await examen('meta-ajuste', '--recertificar', otra.client, dir)
    expect(otra.create).toHaveBeenCalledTimes(20)
    expect(leerJson(dir, 'calificador-congelado.json')).toMatchObject({ ajuste: { aprobado: true }, ciego: null })
    expect(certificadoVigente(dir)).toMatch(/certificado/)
    await expect(correrMeta('ciego', { client: graderDeMeta(ciego).client, dir, log: noop })).rejects.toThrow(/ya corrió/)
  })

  it('a whitespace or key-order edit of the ciego is not a new ciego', async () => {
    const dir = carpeta()
    const ajuste = filas(20, 10)
    const ciego = [filaMeta('ciego-x1', true, 'cumple'), filaMeta('ciego-x2', false, 'omite')]
    escribir(dir, META_AJUSTE, ajuste)
    escribir(dir, META_CIEGO, ciego)
    const noop = () => undefined
    await correrMeta('ajuste', { client: graderDeMeta(ajuste).client, dir, log: noop })
    await correrMeta('ciego', { client: graderDeMeta(ciego).client, dir, log: noop })
    // Same rows, other whitespace and other key order: a new fingerprint, so the ajuste can run again…
    const reordenado = ciego.map(f => Object.fromEntries(Object.entries(f).reverse()))
    fs.writeFileSync(path.join(dir, META_CIEGO), JSON.stringify(reordenado, null, 4) + '\n\n')
    await correrMeta('ajuste', { client: graderDeMeta(ajuste).client, dir, log: noop })
    // …but the ciego is the same one: refused before any call.
    const grader = graderDeMeta(ciego)
    await expect(correrMeta('ciego', { client: grader.client, dir, log: noop })).rejects.toThrow(/ya corrió/)
    expect(grader.create).not.toHaveBeenCalled()
    // A real change to a row is a new ciego.
    escribir(dir, META_CIEGO, [...ciego, filaMeta('ciego-x3', false, 'cumple')])
    await correrMeta('ajuste', { client: graderDeMeta(ajuste).client, dir, log: noop })
    const nuevo = await correrMeta('ciego', {
      client: graderDeMeta([...ciego, filaMeta('ciego-x3', false, 'cumple')]).client,
      dir,
      log: noop,
    })
    expect(nuevo.resultado.aprobado).toBe(true)
  })
})
