import fs from 'fs'
import { aiInput } from '@tests/__helpers__/supportAiInput'
import os from 'os'
import path from 'path'
import type OpenAI from 'openai'
import { CALIFICADOR_MODELO, explicacion, huellaCalificador, preguntaDe } from '../../../../scripts/support-eval/calificador'
import {
  accionDe,
  archivoDeCasos,
  archivoDeDatos,
  archivoMeta,
  archivosDelExamen,
  barras,
  calificar,
  completitud,
  condiciones,
  correrMeta,
  erroresDeMeta,
  esfuerzoJuezDe,
  examen,
  gradeDataCase,
  recalificar,
  reporte,
  validarCaso,
  validarDato,
  type Accion,
  type Calificador,
  type Caso,
  type DataCase,
  type FilaCaso,
  type FilaMeta,
  type Salida,
  type Secuencia,
} from '../../../../scripts/support-eval/run'
import {
  SUPPORT_ASK_DEVICE,
  SUPPORT_ASK_VERSION,
  SUPPORT_GUIDE_TOO_LONG,
  SUPPORT_HYBRID_UNKNOWN,
  SUPPORT_OTHER_QUESTION,
  supportOldVersion,
} from '@/services/support/texts'
import {
  UNDERSTAND_DATA_INSTRUCTIONS,
  literalSupportAnswer,
  numberedGuide,
  wholeGuide,
  type Understanding,
} from '@/services/support/hybrid.service'
import { loadSupportLibrary } from '@/services/support/knowledge.service'
import { DATA_CAPABILITIES, dataCatalogForAi, type DataRequest } from '@/services/support/data/catalog'

const EVAL_DIR = path.join(__dirname, '../../../../scripts/support-eval')
const salida = (accion: Accion, guias: string[] = [], texto = ''): Salida => ({
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
/** The grader model is always fake here: every condition gets `veredicto`. */
const siempre =
  (debe: 'cumple' | 'omite', noDebe: 'afirma' | 'no-afirma' = 'no-afirma'): Calificador =>
  async i => ({ veredicto: i.tipo === 'debe' ? debe : noDebe, cita: 'x' })
const fakeClient = () => {
  const create = jest.fn()
  return { client: { responses: { create } } as unknown as OpenAI, create }
}
const tmpDirs: string[] = []
const carpeta = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-grader-'))
  tmpDirs.push(dir)
  fs.copyFileSync(path.join(EVAL_DIR, 'calificador.ts'), path.join(dir, 'calificador.ts'))
  return dir
}
afterAll(() => tmpDirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })))
const escribir = (dir: string, f: string, data: unknown) => fs.writeFileSync(path.join(dir, f), JSON.stringify(data))
const leer = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(EVAL_DIR, f), 'utf8'))
const caso = (id: string, esperado: Caso['esperado'], tipo = 'directa'): Caso => ({
  id,
  tipo,
  app: 'dashboard',
  mensaje: `mensaje ${id}`,
  esperado,
})

describe('exam grader: explicacion', () => {
  it('explicacion drops Guía: and Fuente: lines', () => {
    const texto = [
      'Abre *Equipo > Miembros* y elige el rol inicial.',
      'Guía: https://avoqado.io/help/dashboard/equipo/gestionar-miembros',
      'Fuente: manual de Avoqado · Caja',
      'Ayuda pública: tus permisos y funciones pueden variar.',
      'Para adaptar las instrucciones a tus permisos, vincula un WhatsApp personal desde https://dashboard.avoqado.io/support/whatsapp.',
      'Más en https://avoqado.io/help.',
    ].join('\n')
    const e = explicacion(texto)
    expect(e).toContain('Abre *Equipo > Miembros* y elige el rol inicial.')
    for (const fuera of ['Guía:', 'Fuente:', 'manual de Avoqado', 'Ayuda pública', 'vincula', 'https://']) expect(e).not.toContain(fuera)
  })
})

describe('exam labels: archivoDeCasos', () => {
  it('ocultos-N reads casos-ocultos-N.json, like ocultos and ocultos-2', () => {
    expect(archivoDeCasos('ocultos')).toBe('casos-ocultos.json')
    expect(archivoDeCasos('ocultos-2')).toBe('casos-ocultos-2.json')
    expect(archivoDeCasos('ocultos-3')).toBe('casos-ocultos-3.json')
    expect(archivoDeCasos('hibrido')).toBe('casos.json')
    expect(archivoDeCasos('hoy')).toBe('casos.json')
    expect(archivoDeCasos('secuencias')).toBe('')
    for (const bad of ['juez', 'ocultos-x', 'ocultos-3/../casos', '../casos']) expect(archivoDeCasos(bad)).toBeNull()
  })

  it('fase1, meta-ajuste and meta-ciego read their own files', () => {
    expect(archivoDeCasos('fase1')).toBe('casos-fase1.json')
    expect(archivosDelExamen('fase1')).toEqual(['casos-fase1.json'])
    expect(archivoMeta('meta-ajuste')).toBe('meta-calificador-ajuste.json')
    expect(archivoMeta('meta-ciego')).toBe('meta-calificador-ciego.json')
    expect(archivosDelExamen('meta-ajuste')).toEqual(['meta-calificador-ajuste.json'])
    expect(archivosDelExamen('meta-ciego')).toEqual(['meta-calificador-ciego.json'])
    expect(archivosDelExamen('hibrido')).toEqual(['casos.json', 'secuencias.json'])
    expect(archivosDelExamen('hoy')).toEqual(['casos.json', 'secuencias.json'])
    expect(archivosDelExamen('secuencias')).toEqual(['secuencias.json'])
    expect(archivosDelExamen('ocultos-3')).toEqual(['casos-ocultos-3.json'])
    for (const bad of ['juez', 'meta', 'meta-otro', 'fase2']) expect(archivosDelExamen(bad)).toBeNull()
    expect(archivoMeta('hibrido')).toBeNull()
    expect(archivoDeCasos('meta-ajuste')).toBeNull()
  })
})

describe('exam actions: preguntar and version-vieja', () => {
  const tip = 'tpv/propina/agregar-propina'
  const nota = (e: Caso['esperado'], s: Salida) => calificar(e, s, 'p', siempre('cumple'))
  it('eval grader: preguntar and version-vieja are graded as actions', async () => {
    // What the worker sent: the device or version question, or the old-version text with the literal guide.
    expect(accionDe(SUPPORT_ASK_DEVICE, [], 'question', 'ask-device')).toBe('preguntar')
    expect(accionDe(SUPPORT_ASK_VERSION, [], 'question', 'ask-version')).toBe('preguntar')
    expect(accionDe(`${supportOldVersion('2.19.0')}\n\nAgregar propina`, [`${tip}@abcdef12`], 'question', 'old-version')).toBe(
      'version-vieja',
    )
    expect((await nota({ accion: 'preguntar' }, salida('preguntar'))).pasa).toBe(true)
    expect((await nota({ accion: 'preguntar' }, salida('contestar', [tip]))).accionOk).toBe(false)
    expect((await nota({ accion: 'contestar', guias: [tip] }, salida('preguntar'))).accionOk).toBe(false)
    expect((await nota({ accion: 'version-vieja', guias: [tip] }, salida('version-vieja', [tip]))).pasa).toBe(true)
    // The old-version text cites a guide: it has to be the expected one.
    expect((await nota({ accion: 'version-vieja', guias: [tip] }, salida('version-vieja', ['tpv/cobro/otra']))).pasa).toBe(false)
    expect((await nota({ accion: 'version-vieja', guias: [tip] }, salida('contestar', [tip]))).accionOk).toBe(false)
  })
})

describe('exam grader: semantic conditions', () => {
  const casos = new Map(leer<Caso[]>('casos.json').map(c => [c.id, c]))
  const respuestas: Record<string, string> = {
    c15: 'El POS funciona sin internet y sincroniza al reconectar. El cobro con tarjeta no funciona sin internet',
    c13: 'No es solo tarjeta: también registra efectivo y transferencia',
  }

  it('noDebeDecir never vetoes by words: the c15 answer «El POS funciona sin internet y sincroniza al reconectar. El cobro con tarjeta no funciona sin internet» and the c13 answer «No es solo tarjeta: también registra efectivo y transferencia» keep bar 1 when the grader says no-afirma, and fail it when it says afirma', async () => {
    const filas = async (noDebe: 'afirma' | 'no-afirma'): Promise<FilaCaso[]> =>
      Promise.all(
        ['c15', 'c13'].map(async id => {
          const c = casos.get(id)!
          const s = salida('contestar', ['general/overview'], respuestas[id])
          return { caso: c, salida: s, nota: await calificar(c.esperado, s, c.mensaje, siempre('cumple', noDebe)) }
        }),
      )
    // The words of noDebeDecir («no funciona sin internet», «solo tarjeta») are literally in both answers.
    expect(respuestas.c15).toContain('no funciona sin internet')
    expect(respuestas.c13.toLowerCase()).toContain('solo tarjeta')
    const limpias = await filas('no-afirma')
    expect(limpias.every(f => f.nota.pasa && !f.nota.dijoDeMas.length)).toBe(true)
    expect(barras(limpias, [], false, true).find(b => b.n === '1')!.pasa).toBe(true)
    const inventadas = await filas('afirma')
    expect(inventadas.map(f => f.nota.dijoDeMas)).toEqual([['no funciona sin internet'], ['solo tarjeta']])
    expect(barras(inventadas, [], false, true).find(b => b.n === '1')!.pasa).toBe(false)
  })

  it('validarCaso: a contestar case or sequence turn without conditions, or with an empty list, is a file error, not a pass', () => {
    expect(validarCaso(caso('a', { accion: 'contestar', guias: ['x'] }))).toEqual(['a: «contestar» sin condiciones en debeDecir'])
    expect(validarCaso(caso('b', { accion: 'contestar', debeDecir: [] }))).toEqual(['b: «contestar» sin condiciones en debeDecir'])
    expect(validarCaso(caso('c', { accion: 'no-se', accionesValidas: ['no-se', 'contestar'] }))).toEqual([
      'c: «contestar» sin condiciones en debeDecir',
    ])
    expect(validarCaso(caso('d', { accion: 'contestar', debeDecir: [{ texto: '  ' }], noDebeDecir: [''] }))).toEqual([
      'd: condición con texto vacío en debeDecir',
      'd: condición con texto vacío en noDebeDecir',
    ])
    expect(validarCaso(caso('e', { accion: 'contestar', debeDecir: [{ claves: ['x'] } as never, 7 as never] }))).toEqual([
      'e: condición mal formada en debeDecir',
      'e: condición mal formada en debeDecir',
    ])
    expect(validarCaso(caso('f', { accion: 'contestar', debeDecir: [{ texto: 'x', claves: 'y' } as never] }))).toEqual([
      'f: condición mal formada en debeDecir',
    ])
    // The old plain string and the new condition both load.
    expect(
      validarCaso(caso('g', { accion: 'contestar', debeDecir: ['Equipo > Miembros', { texto: 'rol inicial', claves: ['rol'] }] })),
    ).toEqual([])
    expect(validarCaso(caso('h', { accion: 'saludo' }))).toEqual([])
    const sec: Secuencia = {
      id: 's9',
      app: 'dashboard',
      turnos: [
        { mensaje: 'a', esperado: { accion: 'aclarar' } },
        { mensaje: 'b', esperado: { accion: 'contestar' } },
      ],
    }
    expect(validarCaso(sec)).toEqual(['s9 turno 2: «contestar» sin condiciones en debeDecir'])
  })

  it('bar 2 counts only a «contestar» output with every debeDecir in cumple: a contestar case answered with a valid aclaración does not pass it', async () => {
    const guias = ['dashboard/a/una', 'dashboard/a/otra']
    const e: Caso['esperado'] = {
      accion: 'contestar',
      accionesValidas: ['contestar', 'aclarar'],
      guias,
      debeDecir: ['primera', { texto: 'segunda' }],
    }
    const c = caso('c1', e)
    const llamadas: string[] = []
    const grader: Calificador = async i => {
      llamadas.push(`${i.tipo}:${i.condicion.texto}`)
      return { veredicto: 'cumple', cita: 'x' }
    }
    const aclaro: Salida = { ...salida('aclarar', [], '¿Cuál de estas?'), opciones: guias }
    const nota = await calificar(e, aclaro, 'p', grader)
    // A valid action, and its debeDecir are graded because the expected action includes contestar…
    expect(nota.pasa).toBe(true)
    expect(llamadas).toEqual(['debe:primera', 'debe:segunda'])
    // …but bar 2 only counts an answer, even when the grader said cumple.
    const b2 = (f: FilaCaso) => barras([f], [], false, true).find(b => b.n === '2')
    expect(b2({ caso: c, salida: aclaro, nota })).toMatchObject({ valor: '0/1 (0 %)', pasa: false })
    const contesto = salida('contestar', ['dashboard/a/una'], 'La primera y la segunda.')
    expect(b2({ caso: c, salida: contesto, nota: await calificar(e, contesto, 'p', grader) })).toMatchObject({
      valor: '1/1 (100 %)',
      pasa: true,
    })
    // An answer with a debeDecir that was never graded does not count either.
    const sinVeredictos = { ...(await calificar(e, contesto, 'p', grader)), veredictos: [] }
    expect(b2({ caso: c, salida: contesto, nota: sinVeredictos })!.pasa).toBe(false)
  })

  it('validarCaso flags a case or turn without esperado or accion', () => {
    expect(validarCaso({ id: 'x', tipo: 'directa', app: 'dashboard', mensaje: 'm' } as never)).toEqual(['x: sin esperado.accion'])
    expect(validarCaso(caso('y', {} as never))).toEqual(['y: sin esperado.accion'])
    expect(
      validarCaso({ id: 's', app: 'dashboard', turnos: [{ mensaje: 'a' }, { mensaje: 'b', esperado: { accion: 'saludo' } }] } as never),
    ).toEqual(['s turno 1: sin esperado.accion'])
    expect(validarCaso({ id: 's2', app: 'dashboard', turnos: 'no' } as never)).toEqual(['s2: sin turnos'])
  })

  it('the tuning set examines history-style questions exactly as the exam builds them', () => {
    const ajuste = leer<FilaMeta[]>('meta-calificador-ajuste.json')
    const conHistorial = ajuste.filter(f => f.pregunta.includes('\n'))
    expect(conHistorial.filter(f => !f.familia).length).toBeGreaterThanOrEqual(2)
    // Also one with two earlier messages, where only the last line is the question.
    expect(conHistorial.some(f => !f.familia && f.pregunta.split('\n').length >= 3)).toBe(true)
    // The rows taken from real cases and turns carry the exact pregunta the exam sends.
    const c63 = leer<Caso[]>('casos.json').find(c => c.id === 'c63')!
    const sec = new Map(leer<Secuencia[]>('secuencias.json').map(x => [x.id, x]))
    const turno = (id: string) => preguntaDe([sec.get(id)!.turnos[0].mensaje], sec.get(id)!.turnos[1].mensaje)
    const reales = [
      preguntaDe(
        c63.historial!.filter(t => t.role === 'user').map(t => t.text),
        c63.mensaje,
      ),
      turno('s04'),
      turno('s06'),
    ]
    for (const p of reales) expect(conHistorial.filter(f => !f.familia).map(f => f.pregunta)).toContain(p)
  })

  it('the tuning set labels «funciona sin internet» without ambiguity and passes the pre-check', () => {
    const ajuste = leer<FilaMeta[]>('meta-calificador-ajuste.json')
    expect(erroresDeMeta(ajuste)).toEqual([])
    expect(ajuste.find(f => f.id === 'cr2-c15-con-internet')).toBeUndefined()
    const sinInternet = ajuste.filter(f => f.familia && condiciones([f.condicion])[0].texto === 'funciona sin internet')
    expect(sinInternet.map(f => f.esperado).sort()).toEqual(['contradice', 'omite'])
    expect(sinInternet.find(f => f.esperado === 'contradice')!.respuesta).toBe('El punto de venta necesita internet para funcionar')
    const omite = sinInternet.find(f => f.esperado === 'omite')!
    expect(omite.respuesta).toMatch(/punto de venta/i)
    expect(omite.respuesta).not.toMatch(/internet|conexi|wifi|en línea|offline|\bred\b|datos/i)
    expect(ajuste.find(f => f.id === 'r3-06-otra-accion-y-niega')?.esperado).toBe('contradice')
  })

  it('validarCaso on the real files: every case and sequence turn has valid conditions', () => {
    const archivos = ['casos.json', 'casos-ocultos.json', 'casos-ocultos-2.json', 'casos-ocultos-3.json']
    const errores = [
      ...archivos.flatMap(f => leer<Caso[]>(f).flatMap(validarCaso)),
      ...leer<Secuencia[]>('secuencias.json').flatMap(validarCaso),
    ]
    expect(errores).toEqual([])
  })

  it('an exam run whose case or sequence file fails validarCaso stops with a file error before any external or model call', async () => {
    const bueno = caso('c1', { accion: 'contestar', debeDecir: ['algo'] })
    const malo = caso('c2', { accion: 'contestar' })
    const turnoMalo: Secuencia = { id: 's1', app: 'dashboard', turnos: [{ mensaje: 'x', esperado: { accion: 'contestar' } }] }
    const { client, create } = fakeClient()
    const corridas: [string, Record<string, unknown>][] = [
      ['hibrido', { 'casos.json': [bueno, malo], 'secuencias.json': [] }],
      ['hibrido', { 'casos.json': [bueno], 'secuencias.json': [turnoMalo] }],
      ['secuencias', { 'secuencias.json': [turnoMalo] }],
      ['ocultos', { 'casos-ocultos.json': [malo] }],
      ['fase1', { 'casos-fase1.json': [malo] }],
    ]
    for (const [etiqueta, archivos] of corridas) {
      const dir = carpeta()
      for (const [f, data] of Object.entries(archivos)) escribir(dir, f, data)
      await expect(examen(etiqueta, undefined, client, dir)).rejects.toThrow(/error de archivo/)
    }
    // A JSON syntax error or a missing file is a file error too, never a raw SyntaxError.
    const roto = carpeta()
    fs.writeFileSync(path.join(roto, 'casos.json'), '[{"id": "c1",')
    escribir(roto, 'secuencias.json', [])
    const err = await examen('hibrido', undefined, client, roto).catch((e: Error) => e)
    expect(err).not.toBeInstanceOf(SyntaxError)
    expect((err as Error).message).toMatch(/error de archivo.*casos\.json/)
    await expect(examen('fase1', undefined, client, carpeta())).rejects.toThrow(/error de archivo.*casos-fase1\.json/)
    // The meta-exam too.
    const dir = carpeta()
    escribir(dir, 'meta-calificador-ajuste.json', [
      { id: 'm1', familia: true, fuente: 'x', tipo: 'debe', pregunta: 'p', condicion: '', respuesta: 'r', esperado: 'cumple' },
      { id: 'm2', familia: 'si', fuente: 'x', tipo: 'debe', pregunta: 'p', condicion: 'c', respuesta: 'r', esperado: 'afirma' },
    ])
    await expect(correrMeta('ajuste', { client, dir, log: () => undefined })).rejects.toThrow(/error de archivo/)
    expect(create).not.toHaveBeenCalled()
  })
})

describe('exam completeness', () => {
  const saludo = (i: number): FilaCaso => {
    const c = caso(`c${String(i).padStart(2, '0')}`, { accion: 'saludo' }, 'saludo')
    const s = salida('saludo', [], 'Hola')
    return {
      caso: c,
      salida: s,
      nota: {
        accionOk: true,
        guiaOk: true,
        guiaDeMas: false,
        faltaDecir: [],
        dijoDeMas: [],
        veredictos: [],
        avisos: [],
        tecnicos: 0,
        semantico: true,
        pasa: true,
      },
    }
  }
  const filas50 = Array.from({ length: 50 }, (_, i) => saludo(i + 1))
  const ids68 = Array.from({ length: 68 }, (_, i) => `c${String(i + 1).padStart(2, '0')}`)
  const filasDeBarras = (lineas: string[]) => lineas.filter(l => /^\| [1-7] \|/.test(l))

  it('a run cut after 50 of 68 cases with zero sequences reports INCOMPLETO and every bar as not passed, even with costs under the average cap', () => {
    const turnos = ['s01#1', 's01#2']
    const lineas = reporte('corte', filas50, [], { cortado: true, oculto: false, esperados: [...ids68, ...turnos] })
    expect(lineas.join('\n')).toContain('INCOMPLETO')
    expect(lineas.join('\n')).toContain('faltan 20')
    const bs = filasDeBarras(lineas)
    expect(bs).toHaveLength(7)
    expect(bs.every(l => l.endsWith('❌ |'))).toBe(true)
    // The same 50, complete: every bar passes (so INCOMPLETO is what fails them).
    const completas = filasDeBarras(reporte('ok', filas50, [], { cortado: false, oculto: false, esperados: filas50.map(f => f.caso.id) }))
    expect(completas.every(l => l.endsWith('✅ |'))).toBe(true)
  })

  it('a noDebeDecir tecnico goes through calificar and reporte: the case fails, the run is INCOMPLETO and every bar ❌', async () => {
    const c = caso('c99', { accion: 'saludo', noDebeDecir: ['ya te cambié'] }, 'saludo')
    const s = salida('saludo', [], 'Hola')
    const nota = await calificar(c.esperado, s, c.mensaje, async () => ({ veredicto: 'tecnico', cita: '' }))
    expect(nota).toMatchObject({ pasa: false, tecnicos: 1, dijoDeMas: [] })
    // 49 cases that pass + this one: without the tecnico every bar would pass (bar 5 at 49/50).
    const filas = [...filas50.slice(0, 49), { caso: c, salida: s, nota }]
    const lineas = reporte('tecnico', filas, [], { cortado: false, oculto: false, esperados: filas.map(f => f.caso.id) })
    expect(lineas.join('\n')).toMatch(/INCOMPLETO.*1 veredictos técnicos/)
    const bs = filasDeBarras(lineas)
    expect(bs).toHaveLength(7)
    expect(bs.every(l => l.endsWith('❌ |'))).toBe(true)
  })

  it('a missing sequence turn or a single tecnico is INCOMPLETO', () => {
    expect(completitud(['c1', 's1#1', 's1#2'], ['c1', 's1#1', 's1#2'], false, 0)).toEqual({ completo: true, faltan: [] })
    expect(completitud(['c1', 's1#1', 's1#2'], ['c1', 's1#1'], false, 0)).toEqual({ completo: false, faltan: ['s1#2'] })
    expect(completitud(['c1'], ['c1'], false, 1).completo).toBe(false)
    expect(completitud(['c1'], ['c1'], true, 0).completo).toBe(false)
  })

  it('recalificar marks old results as without the semantic grader', () => {
    // A stored run from before: plain-string debeDecir and the old nota.
    const viejo = {
      casos: filas50.slice(0, 3).map(f => ({
        ...f,
        caso: { ...f.caso, esperado: { accion: 'contestar' as const, guias: ['g'], debeDecir: ['algo'] } },
        salida: salida('contestar', ['g'], 'algo'),
        nota: { accionOk: true, guiaOk: true, guiaDeMas: false, faltaDecir: [], dijoDeMas: [], pasa: true } as never,
      })),
      secuencias: [],
    }
    const lineas = recalificar(viejo, 'hibrido-final')
    expect(lineas.join('\n')).toMatch(/sin calificador semántico/)
    const bs = filasDeBarras(lineas)
    expect(bs).toHaveLength(7)
    expect(bs.every(l => l.endsWith('❌ |'))).toBe(true)
  })

  it('answer length median is reported', () => {
    const contestar = (id: string, texto: string): FilaCaso => ({
      ...saludo(1),
      caso: caso(id, { accion: 'contestar', debeDecir: ['x'] }),
      salida: salida('contestar', ['g'], texto),
    })
    const filas = [contestar('a', 'x'.repeat(10)), contestar('b', 'x'.repeat(20)), contestar('c', 'x'.repeat(300)), saludo(2)]
    const lineas = reporte('largo', filas, [], { cortado: false, oculto: false, esperados: filas.map(f => f.caso.id) })
    expect(lineas).toContain('- Largo mediano de «contestar»: 20 caracteres (3 respuestas)')
  })
})

describe('data exam (Task 14 of the B): classification graded by code', () => {
  const data = (capability: string, extra: Partial<DataRequest> = {}): Understanding => ({
    kind: 'data',
    request: { capability, day: 'today', amount: null, time: null, otherVenue: false, ...extra },
  })
  const dato = (id: string, mensaje: string, esperado: DataCase['esperado'], trampa?: true): DataCase => ({
    id,
    giro: 'restaurante',
    mensaje,
    esperado,
    ...(trampa ? { trampa } : {}),
  })
  /** What the provider returns for «Entender» with the catalog: the data object always comes, with capability none outside kind data. */
  const entendio = (kind: string, fields: Record<string, unknown> = {}) => ({
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({
              kind,
              standalone: '',
              guideIds: [],
              data: { capability: 'none', day: 'none', amount: '', time: '', otherVenue: false, ...fields },
            }),
          },
        ],
      },
    ],
    usage: null,
  })
  const ventasHoy = dato('d01', '¿cuánto llevamos de venta hoy?', { kind: 'data', capability: 'sales_today', day: 'today' })

  it('the right capability passes and another one fails', () => {
    expect(gradeDataCase(ventasHoy, data('sales_today'), true)).toMatchObject({ ok: true, inventedParam: false })
    // «no dijo día» and «hoy» are the same day for every capability
    expect(gradeDataCase(ventasHoy, data('sales_today', { day: null }), true).ok).toBe(true)
    expect(gradeDataCase(ventasHoy, data('open_orders'), true).ok).toBe(false)
    expect(gradeDataCase(ventasHoy, data('sales_today', { day: 'yesterday' }), false).ok).toBe(false)
    expect(gradeDataCase(ventasHoy, data('other'), null).ok).toBe(false)
    expect(gradeDataCase(ventasHoy, { kind: 'unknown' }, null)).toMatchObject({ ok: false, inventedParam: false })
    expect(gradeDataCase(ventasHoy, data('open_orders'), true).why).toMatch(/open_orders/)
    // A non-data expectation compares the kind.
    const otroNegocio = dato('d02', '¿cuánto vendió hoy la taquería de enfrente?', { kind: 'off_topic' }, true)
    expect(gradeDataCase(otroNegocio, { kind: 'off_topic' }, null).ok).toBe(true)
    expect(gradeDataCase(otroNegocio, data('sales_today'), true).ok).toBe(false)
  })

  it('a trap about another venue passes only with otherVenue true', () => {
    const polanco = dato(
      'd03',
      '¿y en la de Polanco cuánto llevamos hoy?',
      { kind: 'data', capability: 'sales_today', otherVenue: true },
      true,
    )
    expect(gradeDataCase(polanco, data('sales_today', { otherVenue: true }), true).ok).toBe(true)
    expect(gradeDataCase(polanco, data('sales_today'), true).ok).toBe(false)
    // and an ordinary question fails if the model says another venue (the person would get «Sólo veo la sucursal…»)
    expect(gradeDataCase(ventasHoy, data('sales_today', { otherVenue: true }), true).ok).toBe(false)
  })

  it('an amount the model made up counts as invented only if the validation accepted it', () => {
    const sinMonto = dato('d04', '¿ya entró el cobro de la señora del corte?', { kind: 'data', capability: 'find_payment' }, true)
    const inventado = data('find_payment', { amount: '850' })
    // params said «No te entendí el monto»: a made-up amount that never reaches a read is not an invented parameter
    expect(gradeDataCase(sinMonto, inventado, false)).toMatchObject({ ok: true, inventedParam: false })
    expect(gradeDataCase(sinMonto, inventado, true)).toMatchObject({ ok: false, inventedParam: true })
    // an amount that IS in the message, however it was written, is not invented
    const escrito = dato('d05', '¿entró un cobro de $1,250 y otro de 850.50?', { kind: 'data', capability: 'find_payment' })
    for (const amount of ['1250', '$1,250', '850.5', '850.50'])
      expect(gradeDataCase(escrito, data('find_payment', { amount }), true)).toMatchObject({ ok: true, inventedParam: false })
    expect(gradeDataCase(escrito, data('find_payment', { amount: '2100.50' }), true).inventedParam).toBe(true)
  })

  it('a number that is not an amount («mesa 5») passes only if the model leaves the amount empty', () => {
    const mesa = dato(
      'd06',
      '¿Ya está facturada la venta de la mesa 5?',
      { kind: 'data', capability: 'payment_invoice', amount: null },
      true,
    )
    expect(gradeDataCase(mesa, data('payment_invoice'), false)).toMatchObject({ ok: true, inventedParam: false })
    expect(gradeDataCase(mesa, data('payment_invoice', { amount: '5' }), false)).toMatchObject({ ok: false, inventedParam: false })
    expect(gradeDataCase(mesa, data('payment_invoice', { amount: '5' }), true)).toMatchObject({ ok: false, inventedParam: true })
  })

  it('a message the router layer stops is graded as sensible and never reaches the model', async () => {
    const tarjeta = dato('d07', '¿ya entró el pago de la tarjeta 4111 1111 1111 1111?', { kind: 'sensible' }, true)
    expect(gradeDataCase(tarjeta, 'sensible', null)).toMatchObject({ ok: true, inventedParam: false })
    expect(gradeDataCase(tarjeta, data('find_payment'), false).ok).toBe(false)
    expect(gradeDataCase(ventasHoy, 'sensible', null).ok).toBe(false)
    const dir = carpeta()
    escribir(dir, 'casos-datos.json', [tarjeta])
    const { client, create } = fakeClient()
    await examen('datos', undefined, client, dir)
    expect(create).not.toHaveBeenCalled()
    const { casos } = JSON.parse(fs.readFileSync(path.join(dir, 'resultado-datos.json'), 'utf8'))
    expect(casos[0]).toMatchObject({ entendido: 'sensible', params: null, nota: { ok: true } })
  })

  it('the label datos reads casos-datos.json and never needs the semantic grader', async () => {
    expect(archivoDeDatos('datos')).toBe('casos-datos.json')
    expect(archivoDeDatos('datos-ocultos')).toBe('casos-datos-ocultos.json')
    for (const bad of ['hibrido', 'datos-2', 'ocultos', '../datos']) expect(archivoDeDatos(bad)).toBeNull()
    // Not a case exam: archivoDeCasos and the semantic pre-check never see it.
    expect(archivoDeCasos('datos')).toBeNull()
    expect(archivosDelExamen('datos-ocultos')).toBeNull()
    // The real files validate (the hidden one is only checked, never printed).
    const capacidades = [...Object.keys(DATA_CAPABILITIES), 'other']
    for (const f of ['casos-datos.json', 'casos-datos-ocultos.json'])
      expect(leer<DataCase[]>(f).flatMap(c => validarDato(c, capacidades))).toEqual([])
    // A folder with no grader certificate: the data exam still runs, with one «Entender» call per case and no grader call.
    const dir = carpeta()
    const factura = dato('d08', '¿la venta de $899 de esta mañana ya tiene factura?', {
      kind: 'data',
      capability: 'payment_invoice',
      day: 'today',
    })
    escribir(dir, 'casos-datos.json', [ventasHoy, factura])
    const { client, create } = fakeClient()
    create
      .mockResolvedValueOnce(entendio('data', { capability: 'sales_today', day: 'today' }))
      .mockResolvedValueOnce(entendio('data', { capability: 'payment_invoice', day: 'today', amount: '899' }))
    const lineas = await examen('datos', 'r1', client, dir)
    expect(create).toHaveBeenCalledTimes(2)
    for (const [body] of create.mock.calls) {
      expect(body.model).not.toBe(CALIFICADOR_MODELO)
      expect(body.instructions).toContain(UNDERSTAND_DATA_INSTRUCTIONS)
      expect(aiInput(body.input).catalog).toEqual(dataCatalogForAi())
    }
    const { casos } = JSON.parse(fs.readFileSync(path.join(dir, 'resultado-datos-r1.json'), 'utf8'))
    // def.params ran on the message: the $899 is accepted, so the invoice case reaches a read.
    expect(casos.map((f: { params: string | null; nota: { ok: boolean } }) => [f.params, f.nota.ok])).toEqual([
      ['ok', true],
      ['ok', true],
    ])
    expect(fs.readFileSync(path.join(dir, 'resultado-datos-r1.md'), 'utf8')).toBe(lineas.join('\n') + '\n')
    expect(lineas.join('\n')).toMatch(/Capacidad correcta/)
    // A file that does not validate stops before any call.
    const malo = carpeta()
    escribir(malo, 'casos-datos.json', [{ ...ventasHoy, esperado: { kind: 'data', capability: 'ventas_de_ayer' } }])
    const otra = fakeClient()
    await expect(examen('datos', undefined, otra.client, malo)).rejects.toThrow(/error de archivo/)
    expect(otra.create).not.toHaveBeenCalled()
  })

  it('--con-datos raises the per-run cap to US$0.25 only for the hybrid run; datos and plain hibrido keep US$0.095', async () => {
    // Each «Entender» costs US$0.026 (260,000 input tokens at US$0.10 per million): the check before each case decides how many go.
    const caro = (kind: string) => ({
      ...entendio(kind),
      usage: { input_tokens: 260_000, output_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
    })
    const llamadas = async (etiqueta: string, archivos: Record<string, unknown>, opts: { conDatos?: boolean }, certificado: boolean) => {
      const dir = carpeta()
      if (certificado) {
        const aprobado = { aprobado: true }
        escribir(dir, 'calificador-congelado.json', { huella: huellaCalificador(dir), ajuste: aprobado, ciego: aprobado, fecha: 'x' })
      }
      for (const [f, data] of Object.entries(archivos)) escribir(dir, f, data)
      const { client, create } = fakeClient()
      create.mockResolvedValue(caro('unknown'))
      await examen(etiqueta, 'tope', client, dir, opts)
      return create.mock.calls.length
    }
    const fase1 = Array.from({ length: 12 }, (_, i) => ({
      ...caso(`c${i + 1}`, { accion: 'no-se' }),
      mensaje: `¿cómo cambio la cosa ${i + 1}?`,
    }))
    const datos = Array.from({ length: 12 }, (_, i) =>
      dato(`d${i + 1}`, `¿cuánto vendí hoy? (${i + 1})`, { kind: 'data', capability: 'sales_today' }),
    )
    const hibrido = { 'casos.json': fase1, 'secuencias.json': [] }
    // 0, .026, .052, .078 → 4 calls under 0.095; up to .234 → 10 calls under 0.25
    expect(await llamadas('hibrido', hibrido, { conDatos: true }, true)).toBe(10)
    expect(await llamadas('hibrido', hibrido, {}, true)).toBe(4)
    expect(await llamadas('datos', { 'casos-datos.json': datos }, {}, false)).toBe(4)
    expect(await llamadas('datos', { 'casos-datos.json': datos }, { conDatos: true }, false)).toBe(4)
  })

  it('--con-datos gives the hybrid bot the catalog, and a data classification in a phase-1 case counts as a wrong action', async () => {
    const conCertificado = () => {
      const dir = carpeta()
      const aprobado = { aprobado: true }
      escribir(dir, 'calificador-congelado.json', { huella: huellaCalificador(dir), ajuste: aprobado, ciego: aprobado, fecha: 'x' })
      // «no-se» would be what a data placeholder looks like to accionDe: it must still count as wrong
      escribir(dir, 'casos.json', [{ ...caso('c1', { accion: 'no-se' }, 'directa'), mensaje: '¿cuánto llevamos de venta hoy?' }])
      escribir(dir, 'secuencias.json', [])
      return dir
    }
    const con = fakeClient()
    con.create.mockResolvedValue(entendio('data', { capability: 'sales_today', day: 'today' }))
    const dir = conCertificado()
    await examen('hibrido', 'b-con-datos', con.client, dir, { conDatos: true })
    expect(con.create).toHaveBeenCalledTimes(1)
    const [body] = con.create.mock.calls[0]
    expect(body.instructions).toContain(UNDERSTAND_DATA_INSTRUCTIONS)
    expect(aiInput(body.input).catalog).toEqual(dataCatalogForAi())
    const fila = JSON.parse(fs.readFileSync(path.join(dir, 'resultado-hibrido-b-con-datos.json'), 'utf8')).casos[0]
    expect(fila.salida.accion).toBe('datos')
    expect(fila.nota).toMatchObject({ accionOk: false, pasa: false })
    // Without the flag the request is the phase-1 one: no catalog, no data block.
    const sin = fakeClient()
    sin.create.mockResolvedValue({
      ...entendio('unknown'),
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"kind":"unknown","standalone":"","guideIds":[]}' }] }],
    })
    await examen('hibrido', 'sin', sin.client, conCertificado())
    const [fase1] = sin.create.mock.calls[0]
    expect(fase1.instructions).not.toContain(UNDERSTAND_DATA_INSTRUCTIONS)
    expect(aiInput(fase1.input).catalog).toBeUndefined()
    expect(fase1.text.format.schema.properties.data).toBeUndefined()
  })
})

// T-F5: the exam's hybrid bot mirrors the worker: a chosen guide that depends on an unknown version asks first, with no partial
// answer and no notice (T-F2/T-F3 removed); only the cited guides as sources (T-F3); and, for the exam only, the guides understand
// chose when it asked and the draft the reviewer or judge rejected. Real library, fake provider: one queued reply per model call.
describe('the hybrid bot mirrors the worker (T-F5)', () => {
  const APP_PAGE = 'android/ordenes/agregar-productos-a-la-venta' // versionMin 2.25.4
  const PRODUCTS = 'dashboard/menu/gestionar-productos'
  const MENU = 'dashboard/menu/configurar-menu-avanzado'
  const reply = (payload: object) => ({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload) }] }],
    usage: null,
  })
  const question = (...guideIds: string[]) => reply({ kind: 'question', standalone: '¿Cómo encuentro un producto?', guideIds })
  const step = (quote: string) => ({ text: 'Busca el producto por nombre o revisa su categoría.', guideId: PRODUCTS, quote })
  const good = { covered: true, intro: null, steps: [step('Busca el producto por nombre o revisa la categoría correspondiente')] }
  const badQuote = { covered: true, intro: null, steps: [step('Busca el producto en la tablet y tócalo dos veces')] }

  // T-F15: the exam mirrors the worker's other-question line (T-F14) and records understand's mark in the output.
  it('T-F15: a marked second question ends the answer with the fixed line; an unmarked one does not', async () => {
    const dir = carpeta()
    const aprobado = { aprobado: true }
    escribir(dir, 'calificador-congelado.json', { huella: huellaCalificador(dir), ajuste: aprobado, ciego: aprobado, fecha: 'x' })
    const de = (id: string) => ({ ...caso(id, { accion: 'no-se' }), mensaje: '¿Cómo encuentro un producto? y ¿cómo cambio mi contraseña?' })
    escribir(dir, 'casos.json', [de('x'), de('y')])
    escribir(dir, 'secuencias.json', [])
    const { client, create } = fakeClient()
    const marked = reply({ kind: 'question', standalone: '¿Cómo encuentro un producto?', guideIds: [PRODUCTS], otherQuestion: true })
    for (const r of [
      marked,
      reply(good),
      reply({ supported: true, missing: [] }),
      question(PRODUCTS),
      reply(good),
      reply({ supported: true, missing: [] }),
    ])
      create.mockResolvedValueOnce(r)
    await examen('hibrido', 'tf15', client, dir)
    const [x, y]: Salida[] = JSON.parse(fs.readFileSync(path.join(dir, 'resultado-hibrido-tf15.json'), 'utf8')).casos.map(
      (f: FilaCaso) => f.salida,
    )
    expect(x).toMatchObject({ accion: 'contestar', otraPregunta: true })
    expect(x.texto.endsWith(`\n\n${SUPPORT_OTHER_QUESTION}`)).toBe(true)
    expect(y.otraPregunta).toBe(false)
    expect(y.texto).not.toContain(SUPPORT_OTHER_QUESTION)
  })

  it('asks when any chosen guide needs the unknown version, cites only what the draft cites and keeps a rejected draft', async () => {
    const dir = carpeta()
    const aprobado = { aprobado: true }
    escribir(dir, 'calificador-congelado.json', { huella: huellaCalificador(dir), ajuste: aprobado, ciego: aprobado, fecha: 'x' })
    const de = (id: string, app: Caso['app']) => ({ ...caso(id, { accion: 'no-se' }), app, mensaje: '¿Cómo encuentro un producto?' })
    escribir(dir, 'casos.json', [
      de('a', 'android'),
      de('b', 'dashboard'),
      de('c', 'dashboard'),
      de('d', 'dashboard'),
      de('e', 'dashboard'),
    ])
    escribir(dir, 'secuencias.json', [])
    const { client, create } = fakeClient()
    for (const r of [
      question(APP_PAGE, PRODUCTS), // a: the app page needs the unknown version → asks, nothing drafted
      ...[question(PRODUCTS), reply(good), reply({ supported: false })], // b: the judge rejects
      ...[question(PRODUCTS), reply({ covered: false, intro: null, steps: [] })], // c: not covered → «no encontré»
      ...[question(PRODUCTS, MENU), reply(good), reply({ supported: true, missing: [] })], // d: two pages drafted, one cited
      ...[question(PRODUCTS), reply(badQuote)], // e: the reviewer rejects
    ])
      create.mockResolvedValueOnce(r)
    await examen('hibrido', 'tf5', client, dir)
    expect(create).toHaveBeenCalledTimes(11)
    const salidas: Salida[] = JSON.parse(fs.readFileSync(path.join(dir, 'resultado-hibrido-tf5.json'), 'utf8')).casos.map(
      (f: FilaCaso) => f.salida,
    )
    const [a, b, c, d, e] = salidas
    expect(a).toMatchObject({
      accion: 'preguntar',
      fallback: 'ask-version',
      texto: SUPPORT_ASK_VERSION,
      guias: [],
      elegidas: [APP_PAGE, PRODUCTS],
    })
    expect(b).toMatchObject({ accion: 'contestar', fallback: 'judge-rejected', juez: false, guias: [PRODUCTS], rechazada: good })
    expect(c).toMatchObject({ accion: 'no-se', fallback: 'uncovered', texto: SUPPORT_HYBRID_UNKNOWN, guias: [] })
    expect(d).toMatchObject({ accion: 'contestar', guias: [PRODUCTS], redactada: true })
    expect(d.sourceIds).toHaveLength(1)
    expect(e).toMatchObject({ fallback: 'review-quote', revisor: 'quote', rechazada: badQuote })
    // The removed notice of T-F3 («Hay pasos que cambian según…») is nowhere.
    for (const salida of salidas) expect(salida.texto).not.toContain('Hay pasos que cambian')
  })

  // T-F7 to T-F12: like the worker, a draft that only lacked a condition shipped completed with the judge's lines («Importante»).
  // T-F13 (PARADA): like the worker, a real line of the cited guide in `missing` sends the literal guide (motivoJuez «falta»); a
  // number that is not one says nothing (the draft goes); a false claim is «falso». citasJuez keeps each number with its text (null
  // if it is not a line of the guide). Still three calls per answer. And Codex's repro 2: no section of general/overview, its card.
  it('any missing signal sends the whole guide (T-F13b fail-safe), never an appended line; no section, ever (T-F13)', async () => {
    const dir = carpeta()
    const aprobado = { aprobado: true }
    escribir(dir, 'calificador-congelado.json', { huella: huellaCalificador(dir), ajuste: aprobado, ciego: aprobado, fecha: 'x' })
    escribir(
      dir,
      'casos.json',
      ['a', 'b', 'c', 'd'].map(id => ({ ...caso(id, { accion: 'no-se' }), mensaje: '¿Cómo encuentro un producto?' })),
    )
    escribir(dir, 'secuencias.json', [])
    const library = loadSupportLibrary({ allowDraft: true })
    const products = library.find(g => g.id === PRODUCTS)!
    const overview = library.find(g => g.id === 'general/overview')!
    const lines = numberedGuide(products.body).lines
    const condition =
      'Si un producto no aparece para venta, revisa si está activo, si pertenece al menú correcto y si tiene categoría asignada.'
    const missing = [{ guideId: PRODUCTS, line: lines.indexOf(condition) + 1 }]
    expect(missing[0].line).toBeGreaterThan(0)
    const outOfRange = [{ guideId: PRODUCTS, line: lines.length + 1 }]
    // Codex's repro 2 (codex-tf12): a draft that says fiscal accounting is in Gratis, quoting «Módulos principales»; the judge rejects it.
    const fiscalLine = {
      text: 'Sí, el plan Gratis incluye la contabilidad: pólizas de doble partida generadas desde cada venta, cobro y gasto.',
      guideId: overview.id,
      quote: 'pólizas de doble partida generadas desde cada venta, cobro y gasto',
    }
    const fiscal = { covered: true, intro: null, steps: [fiscalLine] }
    const { client, create } = fakeClient()
    for (const r of [
      ...[question(PRODUCTS), reply(good), reply({ supported: true, missing })], // a: a real line is missing
      ...[question(PRODUCTS), reply(good), reply({ supported: true, missing: outOfRange })], // b: a number that is not a line (fail-safe: still the whole guide)
      ...[question(PRODUCTS), reply(good), reply({ supported: false, missing })], // c: a false claim
      ...[question(overview.id), reply(fiscal), reply({ supported: false, missing: [] })], // d: Codex repro 2
    ])
      create.mockResolvedValueOnce(r)
    await examen('hibrido', 'tf13', client, dir)
    expect(create).toHaveBeenCalledTimes(12)
    const [a, b, c, d]: Salida[] = JSON.parse(fs.readFileSync(path.join(dir, 'resultado-hibrido-tf13.json'), 'utf8')).casos.map(
      (f: FilaCaso) => f.salida,
    )
    const resolved = [{ ...missing[0], quote: condition }]
    expect(a).toMatchObject({
      accion: 'contestar',
      fallback: 'judge-rejected',
      juez: true,
      motivoJuez: 'falta',
      citasJuez: resolved,
      rechazada: good,
      texto: literalSupportAnswer([products], null),
    })
    expect(a.texto).toContain(wholeGuide(products.body))
    // T-F13b (fail-safe): a number that is not a line still means the judge saw something missing → the whole guide.
    expect(b).toMatchObject({
      fallback: 'judge-rejected',
      juez: true,
      motivoJuez: 'falta',
      citasJuez: [{ ...outOfRange[0], quote: null }],
      texto: literalSupportAnswer([products], null),
    })
    expect(c).toMatchObject({ fallback: 'judge-rejected', juez: false, motivoJuez: 'falso', citasJuez: resolved, rechazada: good })
    expect(d).toMatchObject({ fallback: 'judge-rejected', juez: false, motivoJuez: 'falso', texto: literalSupportAnswer([overview], null) })
    expect(d.texto).toContain(SUPPORT_GUIDE_TOO_LONG)
    expect(d.texto).not.toContain('pólizas de doble partida')
    for (const salida of [a, b, c, d]) {
      expect(salida.texto).not.toContain('Importante:')
      expect(salida).not.toHaveProperty('importante')
    }
  })

  // T-F13 (ruling T-F13.3): the judge mini-exam (juez.json) measured only `supported`. Its «falta-advertencia» pairs (true and verbatim,
  // but without the key warning of the guide) get a third bar: the judge reports `missing` with a real line of the guide, ≥ 90 %. The
  // two bars of before keep their pairs (11 altered, 11 correct). A fake provider answers every pair in order.
  it('the judge mini-exam has a third bar: detects missing ≥ 90 % on the «falta-advertencia» pairs; the old two bars keep their pairs', async () => {
    type Par = { id: string; guideId: string; supported: boolean; falta?: string }
    const pares: Par[] = leer('juez.json')
    const library = loadSupportLibrary({ allowDraft: true })
    const lineOf = (p: Par) => numberedGuide(library.find(g => g.id === p.guideId)!.body).lines.indexOf(p.falta!) + 1
    const verdict = (p: Par, catches = true) =>
      reply(
        !p.supported
          ? { supported: false, missing: [] }
          : p.falta && catches
            ? { supported: true, missing: [{ guideId: p.guideId, line: lineOf(p) }] }
            : { supported: true, missing: [] },
      )
    const run = async (label: string, miss: string[]) => {
      const { client, create } = fakeClient()
      for (const p of pares) create.mockResolvedValueOnce(verdict(p, !miss.includes(p.id)))
      const lines = await examen('juez', label, client, carpeta())
      expect(create).toHaveBeenCalledTimes(pares.length)
      return lines.join('\n')
    }
    expect(pares.filter(p => p.falta)).toHaveLength(8)
    const all = await run('tf13', [])
    expect(all).toContain('- Detecta alteradas: **11/11** (100 %; barra ≥ 90 %)')
    expect(all).toContain('- Rechaza correctas: **0/11** (0 %; barra ≤ 10 %)')
    expect(all).toContain('- Detecta faltantes: **8/8** (100 %; barra ≥ 90 %)')
    expect(all).toContain('- Veredicto: **PASA**')
    // One pair missed (j27, a refund) is 7/8 = 88 %: under the bar, and the verdict fails although the other two pass.
    const one = await run('tf13-falla', ['j27'])
    expect(one).toContain('- Detecta alteradas: **11/11** (100 %; barra ≥ 90 %)')
    expect(one).toContain('- Detecta faltantes: **7/8** (88 %; barra ≥ 90 %)')
    expect(one).toContain('- Veredicto: **NO PASA**')
  })

  // T-F8: the exam can measure the judge with less reasoning (`--esfuerzo-juez=minimal`); without it, 'low', as the worker. Only
  // the judge changes: understand keeps 'medium' and the draft 'low'.
  // T-F11: the provider accepts none (and rejects minimal with a 400, b-tf8-minimal), so the flag takes none too.
  // T-F12b: without the flag the exam follows production, which judges with none now; low stays available to compare.
  it.each([
    [undefined, 'none'],
    ['low', 'low'],
    ['minimal', 'minimal'],
    ['none', 'none'],
  ] as const)('the judge reasons with %s → %s; understand and the draft do not change (T-F8)', async (esfuerzoJuez, effort) => {
    const dir = carpeta()
    const aprobado = { aprobado: true }
    escribir(dir, 'calificador-congelado.json', { huella: huellaCalificador(dir), ajuste: aprobado, ciego: aprobado, fecha: 'x' })
    escribir(dir, 'casos.json', [{ ...caso('a', { accion: 'no-se' }), mensaje: '¿Cómo encuentro un producto?' }])
    escribir(dir, 'secuencias.json', [])
    const { client, create } = fakeClient()
    for (const r of [question(PRODUCTS), reply(good), reply({ supported: true, missing: [] })]) create.mockResolvedValueOnce(r)
    await examen('hibrido', 'esfuerzo', client, dir, esfuerzoJuez ? { esfuerzoJuez } : {})
    expect(create.mock.calls.map(c => (c[0] as { reasoning: { effort: string } }).reasoning.effort)).toEqual(['medium', 'low', effort])
  })

  it('T-F11: --esfuerzo-juez takes none, minimal or low; without it, nothing (the run follows production, none since T-F12b); any other value stops the run', () => {
    expect(esfuerzoJuezDe(['juez', 'tf11', '--esfuerzo-juez=none'])).toBe('none')
    expect(esfuerzoJuezDe(['hibrido', 'x', '--con-datos', '--esfuerzo-juez=low'])).toBe('low')
    expect(esfuerzoJuezDe(['hibrido', 'x', '--esfuerzo-juez=minimal'])).toBe('minimal')
    expect(esfuerzoJuezDe(['hibrido', 'x'])).toBeUndefined()
    for (const otro of ['medium', 'high', 'NONE', ''])
      expect(() => esfuerzoJuezDe(['juez', 'x', `--esfuerzo-juez=${otro}`])).toThrow('--esfuerzo-juez: none, minimal o low')
  })
})

// T-F15: `otraPregunta` in a case says whether the message carries a second question: true asks for understand's mark AND the fixed
// line in what was sent; false for neither. A case without it is not graded on this.
describe('T-F15: grading the second question', () => {
  const contestar = { accion: 'contestar' as const, guias: ['g'], debeDecir: ['algo'] }
  const conLinea = { ...salida('contestar', ['g'], `Respuesta.\n\n${SUPPORT_OTHER_QUESTION}`), otraPregunta: true }
  const sinLinea = { ...salida('contestar', ['g'], 'Respuesta.'), otraPregunta: false }
  const nota = (e: Caso['esperado'], s: Salida) => calificar(e, s, 'p', siempre('cumple'))
  it('expected: the mark and the line pass; missing either fails', async () => {
    const e = { ...contestar, otraPregunta: true }
    expect(await nota(e, conLinea)).toMatchObject({ otraPreguntaOk: true, pasa: true })
    expect(await nota(e, sinLinea)).toMatchObject({ otraPreguntaOk: false, pasa: false })
    expect(await nota(e, { ...conLinea, texto: 'Respuesta.' })).toMatchObject({ otraPreguntaOk: false, pasa: false })
    expect(await nota(e, { ...sinLinea, otraPregunta: undefined })).toMatchObject({ otraPreguntaOk: false, pasa: false })
  })
  it('not expected: the line or the mark fail', async () => {
    const e = { ...contestar, otraPregunta: false }
    expect(await nota(e, sinLinea)).toMatchObject({ otraPreguntaOk: true, pasa: true })
    expect(await nota(e, conLinea)).toMatchObject({ otraPreguntaOk: false, pasa: false })
  })
  it('a case without the field is not graded on it', async () => {
    expect(await nota(contestar, conLinea)).toMatchObject({ otraPreguntaOk: true, pasa: true })
  })
  it('validarCaso: otraPregunta must be a boolean', () => {
    expect(validarCaso(caso('v', { ...contestar, otraPregunta: 'sí' } as unknown as Caso['esperado']))).toEqual([
      'v: otraPregunta no es true ni false',
    ])
  })
  it('the two exam cases: a second question expects the line, one long question on one topic does not', () => {
    const casos = leer<Caso[]>('casos.json')
    const doble = casos.find(c => c.mensaje === '¿cómo cierro caja? y también ¿cómo cambio mi contraseña?')
    expect(doble?.esperado).toMatchObject({ accion: 'contestar', otraPregunta: true })
    const una = casos.filter(c => c.esperado.otraPregunta === false)
    expect(una).toHaveLength(1)
    expect(validarCaso(doble!)).toEqual([])
    expect(validarCaso(una[0])).toEqual([])
  })
})
