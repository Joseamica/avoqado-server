import crypto from 'crypto'
import type OpenAI from 'openai'
import { LUNA_SUPPORT_PRICING as pricing } from '@/config/supportWhatsapp'
import type { HelpApp, LibraryGuide } from '@/services/support/knowledge.service'
import type { DataAiRow } from '@/services/support/data/catalog'
import { aiInput } from '@tests/__helpers__/supportAiInput'
import {
  UNDERSTAND_DATA_INSTRUCTIONS,
  UNDERSTAND_INSTRUCTIONS,
  hybridFixedReply,
  understandSupportMessage,
  type HybridTurn,
  type Understanding,
} from '@/services/support/hybrid.service'

const guide = (id: string, app: HelpApp, title: string, general = false, keywords: string[] = []): LibraryGuide => ({
  id,
  app,
  title,
  summary: `Resumen de ${title}.`,
  steps: [`PASO-SECRETO de ${title}`],
  publicUrl: `https://avoqado.io/help/${id}`,
  requiredPermissions: [],
  keywords,
  body: `CUERPO-SECRETO de ${title}`,
  general,
  internal: false,
  hash: 'a'.repeat(64),
})
const products = guide('dashboard/menu/gestionar-productos', 'dashboard', 'Gestionar productos', false, [
  'producto nuevo no aparece',
  'precio no se actualiza',
])
const branch = guide('dashboard/inicio/cambiar-de-sucursal', 'dashboard', 'Cambiar de sucursal')
const cashbox = guide('android/caja/abrir-caja', 'android', 'Abrir la caja')
const terminal = guide('tpv/cobro/cobrar-con-tarjeta', 'tpv', 'Cobrar con tarjeta')
// The two overviews are shipped once PER APP: same id, four copies.
const overviews = (['dashboard', 'android', 'windows', 'tpv'] as HelpApp[]).flatMap(app => [
  guide('general/overview', app, 'Qué es Avoqado', true),
  guide('general/facturacion-y-contabilidad', app, 'Facturación y contabilidad', true),
])
const library = [products, branch, cashbox, terminal, ...overviews]
const INDEX_IDS = [products.id, branch.id, cashbox.id, terminal.id, 'general/overview', 'general/facturacion-y-contabilidad']
const usage = { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }

type Payload = { kind: string; standalone?: string; guideIds?: string[] }
function fakeClient(payload: Payload | string, status = 'completed') {
  const create = jest.fn(async (_request: Record<string, unknown>) => ({
    status,
    usage,
    _request_id: 'req_fixture',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: typeof payload === 'string' ? payload : JSON.stringify({ standalone: '', guideIds: [], ...payload }),
            annotations: [],
          },
        ],
      },
    ],
  }))
  return { client: { responses: { create } } as unknown as OpenAI, create }
}
const run = (client: OpenAI, extra: Partial<Parameters<typeof understandSupportMessage>[1]> = {}) =>
  understandSupportMessage(client, { message: '¿Cómo cambio de sucursal?', app: 'dashboard', history: [], library, ...extra }, pricing)
const sentInput = (create: jest.Mock) => aiInput(create.mock.calls[0][0].input)
const UNKNOWN = { kind: 'unknown' }

/** T-F14: el renglón de CAMPOS de la otra pregunta, justo después del de guideIds; quitarlo (y su campo) da el pedido de T-F12. */
const OTHER_QUESTION_RULE =
  '\n- otherQuestion: true si el mensaje trae otra pregunta o petición que lo que devuelves no contesta (por ejemplo, «¿quién abrió la caja hoy y cómo agrego un producto?», cuando clasificas sólo una de las dos); false si trae una sola, o si lo que devuelves contesta todo (una question con las guías de sus dos temas).'
/** T-F14: el cuerpo sin el renglón de la otra pregunta ni el campo `otherQuestion` del esquema: todo lo demás, en su lugar. */
function withoutOtherQuestion(body: Record<string, any>): Record<string, any> {
  const schema = body.text.format.schema
  const properties = { ...schema.properties }
  delete properties.otherQuestion
  return {
    ...body,
    instructions: String(body.instructions).replace(OTHER_QUESTION_RULE, ''),
    text: {
      ...body.text,
      format: {
        ...body.text.format,
        schema: { ...schema, required: schema.required.filter((k: string) => k !== 'otherQuestion'), properties },
      },
    },
  }
}
/**
 * T-F22 (c13 del examen b-tf21-r1): la frase que se agrega al final del renglón de general/overview; quitarla da exactamente el
 * pedido de T-F14 (golden). Una pregunta de sí o no que el resumen contesta va sólo con el resumen, aunque exista una guía de pasos.
 */
const OVERVIEW_YES_NO_RULE =
  ' Si la persona sólo pregunta si se puede algo y el resumen ya lo contesta (por ejemplo, «¿la terminal acepta tarjetas con chip o sólo sin contacto?»), elige sólo general/overview, aunque haya una guía con los pasos de esa operación. Si pregunta cómo hacerlo, o por un caso que una guía trata (por ejemplo, qué se puede cobrar sin internet), elige esa guía.'
/** T-F12: la excepción a la regla del dinero, al final de su renglón; quitarla da exactamente el pedido de T-F11 (golden). */
const MONEY_DATA_EXCEPTION =
  ' Si estas instrucciones traen también DATOS DEL NEGOCIO y uno de sus datos contesta lo que pregunta (por ejemplo, find_payment para «se trabó la terminal, ¿sí entró el cobro de $275?»), sigue DATOS DEL NEGOCIO y no esta regla.'

describe('understandSupportMessage', () => {
  it('sends the whole index (id, title, summary, keywords) and no bodies, for any app', async () => {
    for (const app of ['dashboard', 'android', 'windows', 'tpv'] as HelpApp[]) {
      const { client, create } = fakeClient({ kind: 'greeting' })
      await run(client, { app })
      expect(create).toHaveBeenCalledTimes(1)
      const request = create.mock.calls[0][0] as Record<string, any>
      const input = sentInput(create)
      expect(input.app).toBe(app)
      // whole library, each id once, in library order
      expect(input.index.map((g: { id: string }) => g.id)).toEqual(INDEX_IDS)
      // T-F1: las palabras del síntoma (keywords) van en el renglón; antes sólo las veía el buscador previo.
      expect(input.index[0]).toEqual({
        id: products.id,
        title: products.title,
        summary: products.summary,
        keywords: 'producto nuevo no aparece, precio no se actualiza',
      })
      expect(input.index[1]).toEqual({ id: branch.id, title: branch.title, summary: branch.summary, keywords: '' })
      expect(input.index.every((g: object) => Object.keys(g).join() === 'id,title,summary,keywords')).toBe(true)
      expect(JSON.stringify(request)).not.toMatch(/CUERPO-SECRETO|PASO-SECRETO/)
      expect(request.text.format.schema.properties.guideIds.items.enum).toEqual(INDEX_IDS)
      expect(request).toMatchObject({
        model: pricing.model,
        store: false,
        stream: false,
        background: false,
        max_output_tokens: 800,
        service_tier: 'default',
        truncation: 'disabled',
        instructions: UNDERSTAND_INSTRUCTIONS,
        text: { format: { type: 'json_schema', strict: true } },
      })
      for (const key of ['tools', 'previous_response_id', 'metadata', 'user']) expect(request).not.toHaveProperty(key)
      const schema = request.text.format.schema
      expect(schema.additionalProperties).toBe(false)
      expect(schema.required).toEqual(['kind', 'standalone', 'guideIds', 'otherQuestion'])
      expect(schema.properties.otherQuestion).toEqual({ type: 'boolean' })
      expect(schema.properties.kind.enum).toEqual(['question', 'clarify', 'greeting', 'nonsense', 'off_topic', 'human', 'unknown'])
    }
  })

  it('maps each valid answer, keeping usage and request id', async () => {
    const question = fakeClient({
      kind: 'question',
      standalone: 'Cómo cambio de sucursal en el panel',
      guideIds: [branch.id, 'general/overview'],
    })
    expect(await run(question.client)).toEqual({
      result: { kind: 'question', standalone: 'Cómo cambio de sucursal en el panel', guideIds: [branch.id, 'general/overview'] },
      usage,
      requestId: 'req_fixture',
      called: true,
    })
    const clarify = fakeClient({ kind: 'clarify', standalone: 'ignorado', guideIds: [products.id, branch.id, cashbox.id] })
    expect((await run(clarify.client)).result).toEqual({ kind: 'clarify', guideIds: [products.id, branch.id, cashbox.id] })
    // standalone / guideIds are ignored when they do not apply
    for (const kind of ['greeting', 'nonsense', 'off_topic', 'human', 'unknown']) {
      const other = fakeClient({ kind, standalone: 'x'.repeat(900), guideIds: ['fuera/del/indice'] })
      expect((await run(other.client)).result).toEqual({ kind })
    }
  })

  it.each([
    ['an id outside the index', { kind: 'question', standalone: 'Cómo cambio de sucursal', guideIds: ['dashboard/privado/otra'] }],
    ['a repeated id', { kind: 'question', standalone: 'Cómo cambio de sucursal', guideIds: [branch.id, branch.id] }],
    [
      'three ids for a question',
      { kind: 'question', standalone: 'Cómo cambio de sucursal', guideIds: [branch.id, products.id, cashbox.id] },
    ],
    ['no ids for a question', { kind: 'question', standalone: 'Cómo cambio de sucursal', guideIds: [] }],
    ['an empty standalone', { kind: 'question', standalone: '   ', guideIds: [branch.id] }],
    ['a standalone over 300 characters', { kind: 'question', standalone: 'a'.repeat(301), guideIds: [branch.id] }],
    ['a repeated id in a clarify', { kind: 'clarify', guideIds: [branch.id, branch.id] }],
    ['an outside id in a clarify', { kind: 'clarify', guideIds: [branch.id, 'dashboard/privado/otra'] }],
  ])('rejects ids outside the index or repeated, and bad standalones: %s', async (_name, payload) => {
    const { client } = fakeClient(payload)
    expect(await run(client)).toEqual({ result: UNKNOWN, usage, requestId: 'req_fixture', called: true })
  })

  it.each([
    ['1 id', [branch.id]],
    ['4 ids', [branch.id, products.id, cashbox.id, terminal.id]],
    ['0 ids', []],
  ])('clarify with %s is unknown', async (_name, guideIds) => {
    const { client } = fakeClient({ kind: 'clarify', guideIds })
    expect((await run(client)).result).toEqual(UNKNOWN)
  })

  it('clarify with 2 or 3 ids is accepted', async () => {
    for (const guideIds of [
      [branch.id, products.id],
      [branch.id, products.id, cashbox.id],
    ]) {
      const { client } = fakeClient({ kind: 'clarify', guideIds })
      expect((await run(client)).result).toEqual({ kind: 'clarify', guideIds })
    }
  })

  it.each([
    ['not json', 'completed'],
    ['{"kind":"question"}', 'completed'],
    [JSON.stringify({ kind: 'maybe', standalone: '', guideIds: [] }), 'completed'],
    [JSON.stringify({ kind: 'greeting', standalone: '', guideIds: [], answer: 'Ya cobré la tarjeta.' }), 'completed'],
    [JSON.stringify({ kind: 'greeting', standalone: '', guideIds: [] }), 'incomplete'],
  ])('invalid or incomplete model output %s / %s is unknown, with usage preserved', async (text, status) => {
    const { client, create } = fakeClient(text, status)
    const out = await run(client)
    expect(create).toHaveBeenCalledTimes(1)
    expect(out).toEqual({ result: UNKNOWN, usage, requestId: 'req_fixture', called: true })
    expect(JSON.stringify(out)).not.toContain('Ya cobré')
  })

  it.each([
    ['a password', 'mi contraseña: Secreta123 ¿cómo cambio de sucursal?'],
    ['an email', 'escríbeme a juan@correo.com sobre mi sucursal'],
    ['an empty message', '   '],
    ['a message over 2,000 characters', 'hola '.repeat(500)],
  ])('a sensitive or empty message never calls the model (%s)', async (_name, message) => {
    const { client, create } = fakeClient({ kind: 'greeting' })
    expect(await run(client, { message })).toEqual({ result: UNKNOWN, usage: null, requestId: undefined, called: false })
    expect(create).not.toHaveBeenCalled()
  })

  it('T-F1: the keywords of an index row are whole keywords, at most 240 characters', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `palabra clave número ${String(i).padStart(2, '0')}`)
    const long = guide('dashboard/menu/muchas-palabras', 'dashboard', 'Muchas palabras', false, many)
    const { client, create } = fakeClient({ kind: 'greeting' })
    await run(client, { library: [long, ...library] })
    const row = sentInput(create).index.find((g: { id: string }) => g.id === long.id)
    expect(row.keywords.length).toBeLessThanOrEqual(240)
    expect(row.keywords.length).toBeGreaterThan(200)
    const kept = row.keywords.split(', ')
    expect(kept).toEqual(many.slice(0, kept.length))
  })

  it('an empty library never calls the model', async () => {
    const { client, create } = fakeClient({ kind: 'greeting' })
    expect(await run(client, { library: [] })).toMatchObject({ result: UNKNOWN, called: false })
    expect(create).not.toHaveBeenCalled()
  })

  it('a sensitive standalone from the model is discarded', async () => {
    for (const standalone of ['Mi PIN es 123456 y cómo cambio de sucursal', 'Escribe a hola@avoqado.io para cambiar de sucursal']) {
      const { client } = fakeClient({ kind: 'question', standalone, guideIds: [branch.id] })
      expect((await run(client)).result).toEqual(UNKNOWN)
    }
  })

  it('history is scrubbed and capped at 4 turns; a sensitive user turn is dropped; an assistant turn with hola@avoqado.io stays, sanitized', async () => {
    const history: HybridTurn[] = [
      { role: 'user', text: 'turno viejo uno' },
      { role: 'assistant', text: 'turno viejo dos' },
      { role: 'user', text: 'mi contraseña: Secreta123' },
      { role: 'assistant', text: 'No encontré eso. Escríbenos a hola@avoqado.io y te ayudamos.' },
      { role: 'user', text: 'quiero cambiar mi sucursal' },
      { role: 'user', text: '\u0007Se me olvidó cómo\u0000 hacerlo' },
    ]
    const { client, create } = fakeClient({ kind: 'greeting' })
    await run(client, { history })
    const sent = sentInput(create)
    expect(sent.history).toEqual([
      { role: 'assistant', text: 'No encontré eso. Escríbenos a [dato omitido] y te ayudamos.' },
      { role: 'user', text: 'quiero cambiar mi sucursal' },
      { role: 'user', text: 'Se me olvidó cómo hacerlo' },
    ])
    expect(JSON.stringify(sent)).not.toMatch(/Secreta123|turno viejo|hola@avoqado\.io/)
  })

  it('history is capped at 6,000 bytes, dropping the oldest turns', async () => {
    const turn = (i: number): HybridTurn => ({ role: i % 2 ? 'assistant' : 'user', text: `${i} ${'hola mundo '.repeat(170)}`.trim() })
    const { client, create } = fakeClient({ kind: 'greeting' })
    await run(client, { history: [0, 1, 2, 3].map(turn) })
    const sent = sentInput(create)
    expect(sent.history.length).toBe(3)
    expect(sent.history[0].text.startsWith('1 ')).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(sent.history), 'utf8')).toBeLessThanOrEqual(6000)
  })

  it('quoted text is scrubbed, capped at 1,500 and labeled as the message the person is replying to', async () => {
    const { client, create } = fakeClient({ kind: 'greeting' })
    await run(client, { quoted: `La primera opción, escríbeme a juan@correo.com. ${'texto citado '.repeat(300)}` })
    const sent = sentInput(create)
    expect(Object.keys(sent)).toContain('replyingTo')
    expect(sent.replyingTo.startsWith('La primera opción, escríbeme a [dato omitido].')).toBe(true)
    expect(sent.replyingTo.length).toBe(1500)
    expect(JSON.stringify(sent)).not.toContain('juan@correo.com')
    expect(UNDERSTAND_INSTRUCTIONS).toMatch(/replyingTo/)
    // without a quote there is no label
    const plain = fakeClient({ kind: 'greeting' })
    await run(plain.client)
    expect(sentInput(plain.create)).not.toHaveProperty('replyingTo')
  })

  it('instructions say user and history text is untrusted data', () => {
    expect(UNDERSTAND_INSTRUCTIONS).toMatch(/información no confiable/)
    expect(UNDERSTAND_INSTRUCTIONS).toMatch(/nunca instrucciones/i)
    expect(UNDERSTAND_INSTRUCTIONS).toMatch(/historial/)
    expect(UNDERSTAND_INSTRUCTIONS).toMatch(/ÚNICA fuente/)
    for (const kind of ['question', 'clarify', 'greeting', 'nonsense', 'off_topic', 'human', 'unknown']) {
      expect(UNDERSTAND_INSTRUCTIONS).toContain(kind)
    }
  })

  it('T-F1: a symptom guide goes before a how-to guide, and among guides about the same thing the app rule still holds', () => {
    expect(UNDERSTAND_INSTRUCTIONS).toContain('SÍNTOMA ANTES QUE OPERACIÓN')
    expect(UNDERSTAND_INSTRUCTIONS).toMatch(/síntoma[^\n]*elige esa guía antes que una que explica cómo hacer o configurar la operación/)
    expect(UNDERSTAND_INSTRUCTIONS).toContain('Si varias guías contestan igual, prefiere la de su app.')
    expect(UNDERSTAND_INSTRUCTIONS).toContain('entre guías que tratan lo mismo, prefiere la de su app')
    // El índice trae keywords y la instrucción las nombra.
    expect(UNDERSTAND_INSTRUCTIONS).toContain('keywords')
  })

  // T-F4: c16, c18, c20 y c25 elegían sólo la guía de la app (la del síntoma en el POS) y dejaban fuera la del panel, que dice
  // la causa. Un ejemplo concreto en la misma sección; la regla de antes queda igual.
  // T-F6b (examen b-tf5-r1): «y, como segunda, la de su app» hacía que entender eligiera también agregar-productos-a-la-venta
  // (versionMin 2.25.4) y, desde T-F5, c16, c20 y c25 volvían a pedir la versión. El ejemplo pide SÓLO la guía del panel.
  it('T-F6b: something set up or changed in the panel that does not show in the POS takes ONLY the panel guide', () => {
    const [, section] = UNDERSTAND_INSTRUCTIONS.split('SÍNTOMA ANTES QUE OPERACIÓN\n')
    const [first, example, after] = section.split('\n')
    expect(first).toMatch(/^- Si la persona cuenta un síntoma .*entre guías que tratan lo mismo, prefiere la de su app\.$/)
    expect(example).toBe(
      '- Ejemplo: algo que se dio de alta o se cambió en el panel no sale, o sale como antes, en el POS o la terminal («di de alta un producto y no me sale en la tablet»). La causa se revisa en el panel: elige sólo la guía del panel que trata ese síntoma, sin agregar la de su app.',
    )
    // The example no longer asks for the app guide as a second one.
    expect(example).not.toMatch(/como segunda|segunda/)
    expect(after).toBe('')
  })

  // T-F11 (examen b-tf10c-r1, c39): «la pax se trabó cobrando y no sé si pasó, ¿cómo le pongo que no se cobró?» salió con
  // tpv/ayuda/reiniciar-la-app por su keyword «la app se trabó» (SÍNTOMA ANTES QUE OPERACIÓN). Las guías del cobro sin confirmar
  // siguen fuera de la biblioteca hasta su prueba en aparato, y mandar a reiniciar a media duda de un cobro es peligroso: un cobro
  // en duda sólo toma una guía que lo trate; si no hay, unknown. Las demás reglas no cambian (lo fija el golden de T8).
  it('T-F11: a charge in doubt only takes a guide that treats it; with none in the index it is unknown, never a guide about something else', () => {
    expect(UNDERSTAND_INSTRUCTIONS).toContain('sin agregar la de su app.\n\nCOBRO EN DUDA (DINERO)\n')
    const [, section] = UNDERSTAND_INSTRUCTIONS.split('COBRO EN DUDA (DINERO)\n')
    const [rule, example, after, next] = section.split('\n')
    // T-F12: the rule line also carries its exception (MONEY_DATA_EXCEPTION, next test), at its end.
    expect(rule).toBe(
      `- Un cobro en duda es cuando la persona no sabe si un cobro pasó (por ejemplo, la terminal o la app se trabó, se cerró o se quedó sin internet a media venta), quiere marcar que un cobro no se hizo, al cliente le cobraron dos veces o un reembolso no salió. Ahí sólo vale una guía que trate ESO (un cobro sin confirmar, marcar que no se cobró, un cobro doble o un reembolso que no salió): su título, su resumen o sus keywords lo nombran. Si ninguna guía del índice lo trata, es unknown, nunca una guía de otra cosa, aunque comparta una palabra o un síntoma del mensaje. Esta regla va antes que SÍNTOMA ANTES QUE OPERACIÓN.${MONEY_DATA_EXCEPTION}`,
    )
    expect(example).toBe(
      '- Ejemplo: «la terminal se quedó pensando y no sé si le cobró a la clienta» es un cobro en duda. Si ninguna guía trata un cobro sin confirmar, es unknown, no la guía de reiniciar la app.',
    )
    // One rule and one example, between SÍNTOMA ANTES QUE OPERACIÓN and APP; the example is not the exam's c39 message.
    expect([after, next]).toEqual(['', 'APP'])
    expect(example).not.toMatch(/pax|trab/i)
  })

  // T-F12 (examen de datos tf11, b29): «entró un cobro de $349? a las 11 y media» cayó a unknown: la regla del dinero le ganó a
  // find_payment. Con la B, si un dato del catálogo contesta, va la regla de datos (su «no encontré» ya avisa que no prueba que no
  // se cobró, T-F11b). Sin catálogo esa sección no viene en el pedido, así que la frase no aplica. b29 sólo lo confirma el examen
  // con IA; aquí se fija que la frase está, en su lugar, y que su ejemplo no es el mensaje del examen.
  it('T-F12: with a catalog, a data capability that answers wins over the money rule; the sentence closes the rule line', () => {
    const [, section] = UNDERSTAND_INSTRUCTIONS.split('COBRO EN DUDA (DINERO)\n')
    const [rule] = section.split('\n')
    expect(rule.endsWith(`Esta regla va antes que SÍNTOMA ANTES QUE OPERACIÓN.${MONEY_DATA_EXCEPTION}`)).toBe(true)
    expect(UNDERSTAND_INSTRUCTIONS.split(MONEY_DATA_EXCEPTION)).toHaveLength(2)
    // It names the data block by its title, which only comes with a catalog: the phase-1 request still never says «catalog».
    expect(UNDERSTAND_DATA_INSTRUCTIONS.startsWith('DATOS DEL NEGOCIO (kind: data)\n')).toBe(true)
    expect(MONEY_DATA_EXCEPTION).not.toContain('catalog')
    // Its example is not b29 (nor any other exam message): «$349», «11 y media».
    expect(MONEY_DATA_EXCEPTION).not.toMatch(/349|11 y media/)
  })

  // T-F22 (examen b-tf21-r1, c13): «con la terminal tmb se puede cobrar en efectivo o nomas tarjeta» eligió
  // tpv/cobro/cobrar-en-efectivo (versionMin 2.9.1) por «cuando no hay una guía de pasos para eso», y sin versión se preguntó la
  // versión para un sí que el resumen ya da (b-tf19-r1 eligió general/overview y pasó). La frase va al final del renglón del resumen;
  // el cómo y los casos que una guía trata (sin internet: c15) siguen con su guía, que pide la versión (c15, c38, c40 y c41).
  it('T-F22: a yes or no that general/overview answers takes only general/overview, even with a steps guide; a how-to or a case keeps its guide', () => {
    const line = UNDERSTAND_INSTRUCTIONS.split('\n').find(l => l.startsWith('- general/overview resume'))!
    expect(line.endsWith(`cuando no hay una guía de pasos para eso.${OVERVIEW_YES_NO_RULE}`)).toBe(true)
    expect(UNDERSTAND_INSTRUCTIONS.split(OVERVIEW_YES_NO_RULE)).toHaveLength(2)
    // Its example is not c13 (nor another exam message): no cash, no «nomás», no «jala».
    expect(OVERVIEW_YES_NO_RULE).not.toMatch(/efectivo|nom[aá]s|jala/i)
  })

  it('T-F1: invoices point to the facturas/ guides first; the general summary is not THE invoice guide anymore', () => {
    expect(UNDERSTAND_INSTRUCTIONS).not.toContain(
      'general/facturacion-y-contabilidad explica la facturación CFDI a los clientes del negocio y la contabilidad.',
    )
    expect(UNDERSTAND_INSTRUCTIONS).toMatch(/las guías facturas\/…[^\n]*general\/facturacion-y-contabilidad/)
  })

  it('a provider failure is not swallowed', async () => {
    const create = jest.fn(async () => {
      throw new Error('timeout')
    })
    await expect(run({ responses: { create } } as unknown as OpenAI)).rejects.toThrow('timeout')
    expect(create).toHaveBeenCalledTimes(1)
  })

  // T-F7.3 (sin IA): el índice ya era idéntico entre dos mensajes de la misma app y ya iba antes de lo variable, pero en el MISMO
  // mensaje que el mensaje de la persona: el proveedor sólo guarda el final del último mensaje, así que nunca lo reusaba. Ahora va
  // en su propio mensaje con un punto de caché explícito, y todo lo que cambia por mensaje va en el segundo.
  it('T-F7.3: the index goes alone in a first message with an explicit cache breakpoint; two messages of one app share it byte for byte', async () => {
    const bodyOf = async (extra: Partial<Parameters<typeof understandSupportMessage>[1]>) => {
      const { client, create } = fakeClient({ kind: 'greeting' })
      await run(client, extra)
      return create.mock.calls[0][0] as Record<string, any>
    }
    const a = await bodyOf({ app: 'android', message: '¿Cómo abro MENSAJE-UNO?' })
    const b = await bodyOf({
      app: 'android',
      message: '¿Y MENSAJE-DOS?',
      history: [
        { role: 'user', text: 'HISTORIAL-UNO' },
        { role: 'assistant', text: 'Abre Menú.' },
      ],
      quoted: 'CITA-UNO',
    })
    expect(a.input).toHaveLength(2)
    const index = sentInput({ mock: { calls: [[a]] } } as unknown as jest.Mock).index
    expect(a.input[0]).toEqual({
      role: 'user',
      content: [{ type: 'input_text', text: JSON.stringify({ index }), prompt_cache_breakpoint: { mode: 'explicit' } }],
    })
    expect(a.input[1]).toEqual({
      role: 'user',
      content: [{ type: 'input_text', text: JSON.stringify({ app: 'android', history: [], message: '¿Cómo abro MENSAJE-UNO?' }) }],
    })
    // Same app: instructions, schema and the whole first message are identical; only the second one changes.
    expect(b.instructions).toBe(a.instructions)
    expect(b.text).toEqual(a.text)
    expect(b.input[0]).toEqual(a.input[0])
    expect(Object.keys(JSON.parse(b.input[1].content[0].text))).toEqual(['app', 'history', 'replyingTo', 'message'])
    for (const word of ['MENSAJE-UNO', 'MENSAJE-DOS', 'HISTORIAL-UNO', 'CITA-UNO']) {
      expect(a.input[0].content[0].text).not.toContain(word)
      expect(b.input[0].content[0].text).not.toContain(word)
    }
    // Another app sees another index (the worker scopes the library by app first), so it has its own cached prefix.
    const tpvOnly = library.filter(g => g.app === 'tpv' || g.app === 'dashboard')
    expect((await bodyOf({ app: 'tpv', message: '¿Cómo abro MENSAJE-UNO?', library: tpvOnly })).input[0]).not.toEqual(a.input[0])
  })
})

describe('understandSupportMessage with the data catalog (la B)', () => {
  type Extra = { data?: DataAiRow[] }
  /** El cuerpo que recibió `client.responses.create` al clasificar un mensaje fijo con la biblioteca de este archivo; `extra` se mezcla en el `input`. */
  const sent = async (
    extra: Extra,
  ): Promise<{ instructions: string; input: string; text: { format: { schema: { properties: Record<string, any> } } } }> => {
    const { client, create } = fakeClient({ kind: 'greeting' })
    await run(client, extra)
    return create.mock.calls[0][0] as any
  }
  /** `understandSupportMessage` con un cliente de mentira que contesta `modelReply`. */
  const understand = async (modelReply: object, extra: Extra): Promise<{ result: Understanding }> =>
    run(fakeClient(JSON.stringify(modelReply)).client, extra)
  const CATALOG: DataAiRow[] = [{ capability: 'sales_today', description: 'Cuánto vendió hoy la sucursal.' }]
  const reply = (data: object) => ({
    kind: 'data',
    standalone: '',
    guideIds: [],
    data: { capability: 'sales_today', day: 'today', amount: '', time: '', otherVenue: false, ...data },
  })

  it('without a catalog the request is byte-identical to today', async () => {
    const [off, empty] = [await sent({}), await sent({ data: [] })] // sent(): el cuerpo que recibió client.responses.create
    expect(JSON.stringify(empty)).toBe(JSON.stringify(off))
    expect(off.instructions).toBe(UNDERSTAND_INSTRUCTIONS)
    expect(JSON.stringify(off)).not.toContain('catalog')
    expect(off.text.format.schema.properties.kind.enum).not.toContain('data')
    expect(Object.keys(off.text.format.schema.properties)).toEqual(['kind', 'standalone', 'guideIds', 'otherQuestion'])
    expect(Object.keys(aiInput(off.input))).toEqual(['index', 'app', 'history', 'message'])
  })

  /**
   * La huella de la petición de la fase 1: sha256 de los 12 cuerpos que recibe client.responses.create (4 apps × nada /
   * historial / mensaje citado, en ese orden), cada uno con JSON.stringify y unidos con «\n». Es determinista: entradas fijas
   * de este archivo, JSON.stringify sigue el orden en que se escriben las llaves, y no entra reloj, azar ni variable de entorno
   * (el modelo y el tope salen de LUNA_SUPPORT_PRICING). Se calculó con el hybrid.service.ts de ANTES de la B (16-nov). Sólo
   * cambia si la fase 1 cambia a propósito (instrucciones, esquema, modelo u orden del input): entonces se recalcula y se dice.
   *
   * T-F1 (17-nov): cambio de la fase 1, no de la B. Las instrucciones ganan la regla «síntoma antes que operación», la línea de
   * keywords y el párrafo de facturas al día, y cada renglón del índice trae sus keywords (aquí, las de gestionar-productos).
   * Antes: 6a77c38a3a34d1cf8ae78a12646a1776e3bb81a14df4c35771d31c083d164cd5. Se comprobó fuera de las pruebas que quitar sólo
   * esas cuatro cosas de los 12 cuerpos de hoy regresa exactamente a ese hash. Con la B prendida el catálogo sólo agrega su
   * bloque (siguiente prueba).
   *
   * T-F4 (17-nov): cambio de la fase 1, no de la B. «SÍNTOMA ANTES QUE OPERACIÓN» gana un renglón de ejemplo (lo dado de alta o
   * cambiado en el panel que no sale en el POS: primero la guía del panel y, como segunda, la de su app). Las keywords nuevas
   * de las guías no entran aquí: esta biblioteca es la de este archivo. Antes: 02d2d6c970219eb4b8c5235fcc4915dabd870b9ad9cf9b49e60a054eb5787320.
   * Se comprobó fuera de las pruebas que quitar sólo ese renglón de los 12 cuerpos de hoy regresa exactamente a ese hash.
   *
   * T-F6b (17-nov): cambio de la fase 1, no de la B. El ejemplo de «SÍNTOMA ANTES QUE OPERACIÓN» pide SÓLO la guía del panel
   * («elige sólo la guía del panel que trata ese síntoma, sin agregar la de su app»), en vez de «primero la del panel y, como
   * segunda, la de su app»: entender elegía también la guía de la app con versión y, desde T-F5, se volvía a pedir la versión
   * (c16, c20 y c25 del examen b-tf5-r1). Antes: 92b9febcb5c891537fff181b3c820af3822f76a29eb2bfe836890a716eada066. Se comprobó
   * que regresar sólo esa frase a la de T-F4 da exactamente ese hash (reporte de T-F6).
   *
   * T-F7 (17-nov): cambio de la fase 1, no de la B, y sólo de FORMA. La entrada va en dos mensajes: el índice (y el catálogo, si
   * hay) con un punto de caché explícito al final, y después app, historial, mensaje citado y mensaje. En un solo mensaje el
   * proveedor sólo guardaba el pedido entero y el índice nunca se reusaba (b-tf6-r1: 211k de 846k tokens de caché). Instrucciones,
   * esquema, modelo, llaves y valores no cambian: unir otra vez las dos partes en una cadena da exactamente el hash de antes,
   * 2edb25253ed78234eb2df1bd442a186c8f940e709d543b450172ca51e8c0ce9c (lo comprueba esta misma prueba).
   *
   * T-F11 (17-nov): cambio de la fase 1, no de la B. Las instrucciones ganan la sección «COBRO EN DUDA (DINERO)» (una regla y un
   * ejemplo) entre «SÍNTOMA ANTES QUE OPERACIÓN» y «APP»: un cobro en duda sólo toma una guía que lo trate; si no hay, unknown
   * (c39 del examen b-tf10c-r1 salió con la guía de reiniciar la app). Lo demás, palabra por palabra. Antes:
   * 71a55652afaceb7f7ea58b964ca6425ce97eed325f4248b51f2f5615a3da606e. Esta misma prueba quita sólo esa sección de los 12 cuerpos
   * de hoy y comprueba que regresan exactamente a ese hash y, juntando otra vez las dos partes de la entrada, al de T-F6b.
   *
   * T-F12 (18-nov): cambio de la fase 1 en el texto, no en lo que hace sin la B. El renglón de la regla del dinero gana una frase al
   * final (MONEY_DATA_EXCEPTION): con la sección DATOS DEL NEGOCIO, que sólo llega con catálogo, un dato que contesta sigue esa
   * regla (b29 del examen de datos tf11 cayó a unknown). Antes: f6b9c8f6cab1e96524d5512fbe5ff5dfef7a9d899366b2cf00c9085c383c234a.
   * Esta misma prueba quita sólo esa frase de los 12 cuerpos de hoy y comprueba que regresan exactamente a ese hash; y quitando la
   * sección entera (con la frase dentro), al de antes de T-F11.
   *
   * T-F14 (18-nov): cambio de la fase 1, a propósito (H-T15-1, la prueba del founder en su celular: «quién abrió la caja hoy y cómo
   * agrego un producto» contestó sólo lo de la caja y la otra pregunta se perdió sin aviso). Entender reporta si el mensaje trae
   * otra pregunta que no contesta: el esquema gana el campo booleano `otherQuestion` (al final de properties y de required) y CAMPOS
   * gana su renglón (OTHER_QUESTION_RULE), justo después del de guideIds. Sin llamada nueva a la IA. Lo demás, palabra por
   * palabra. Antes: 536ddaf33c40333c88c9d8ef3a6b5f06f630e135d7b7e604a18444328d07532b. Esta misma prueba quita sólo ese renglón y
   * ese campo de los 12 cuerpos de hoy y comprueba que regresan exactamente a ese hash; las comprobaciones de antes corren sobre eso.
   *
   * T-F22 (19-nov): cambio de la fase 1, a propósito (c13 del examen b-tf21-r1 pidió la versión para un sí o no que el resumen
   * contesta). El renglón de general/overview gana una frase al final (OVERVIEW_YES_NO_RULE). Sin llamada nueva a la IA; esquema,
   * modelo, entrada y lo demás, palabra por palabra. Antes: e0c07ef852c9fd58982558d3363bd4c2242fd0d5b40567ac84c8267273468fb2. Esta
   * misma prueba quita sólo esa frase de los 12 cuerpos de hoy y comprueba que regresan exactamente a ese hash; las comprobaciones
   * de antes corren sobre eso.
   */
  const PHASE1_REQUESTS_SHA256 = '2010caeeda6e46953238f07d3b1a4a8393b3b7625062bc933346acac47f8e6f8'
  const BEFORE_T_F22_SHA256 = 'e0c07ef852c9fd58982558d3363bd4c2242fd0d5b40567ac84c8267273468fb2'
  const BEFORE_T_F14_SHA256 = '536ddaf33c40333c88c9d8ef3a6b5f06f630e135d7b7e604a18444328d07532b'
  const BEFORE_T_F12_SHA256 = 'f6b9c8f6cab1e96524d5512fbe5ff5dfef7a9d899366b2cf00c9085c383c234a'
  const BEFORE_T_F11_SHA256 = '71a55652afaceb7f7ea58b964ca6425ce97eed325f4248b51f2f5615a3da606e'
  const BEFORE_T_F7_SHA256 = '2edb25253ed78234eb2df1bd442a186c8f940e709d543b450172ca51e8c0ce9c'
  /** T-F11: la sección del dinero con el renglón en blanco que la separa de la anterior; sin ella, las instrucciones de antes. */
  const MONEY_SECTION = /\n\nCOBRO EN DUDA \(DINERO\)\n.*\n.*(?=\n\nAPP\n)/
  it('without a catalog the 12 phase-1 requests hash to the golden taken before la B', async () => {
    const variants = [
      {},
      {
        history: [
          { role: 'user' as const, text: '¿y para borrarlo?' },
          { role: 'assistant' as const, text: 'Abre Menú.' },
        ],
      },
      { quoted: 'La primera opción' },
    ]
    const sha = (bodies: string[]) => crypto.createHash('sha256').update(bodies.join('\n')).digest('hex')
    for (const extra of [{}, { data: [] }]) {
      const bodies: Record<string, unknown>[] = []
      for (const app of ['dashboard', 'android', 'windows', 'tpv'] as HelpApp[])
        for (const variant of variants) {
          const { client, create } = fakeClient({ kind: 'greeting' })
          await run(client, { app, ...variant, ...extra })
          bodies.push(create.mock.calls[0][0])
        }
      expect(sha(bodies.map(b => JSON.stringify(b)))).toBe(PHASE1_REQUESTS_SHA256)
      // T-F22: without only the yes-or-no sentence of general/overview (same place in the body), the 12 are exactly T-F14's.
      expect(bodies.every(b => String(b.instructions).split(OVERVIEW_YES_NO_RULE).length === 2)).toBe(true)
      const beforeTF22 = bodies.map(
        (b): Record<string, unknown> => ({ ...b, instructions: String(b.instructions).replace(OVERVIEW_YES_NO_RULE, '') }),
      )
      expect(sha(beforeTF22.map(b => JSON.stringify(b)))).toBe(BEFORE_T_F22_SHA256)
      // T-F14: without only the other-question line and its schema field (same places in the body), the 12 are exactly T-F12's.
      expect(beforeTF22.every(b => String(b.instructions).includes(OTHER_QUESTION_RULE))).toBe(true)
      const prior = beforeTF22.map(withoutOtherQuestion)
      expect(prior.every(b => !JSON.stringify(b).includes('otherQuestion'))).toBe(true)
      expect(sha(prior.map(b => JSON.stringify(b)))).toBe(BEFORE_T_F14_SHA256)
      // T-F12: without only the exception sentence (same place in the body), the 12 are exactly T-F11's.
      const withoutException = prior.map(
        (b): Record<string, unknown> => ({
          ...b,
          instructions: String(b.instructions).replace(MONEY_DATA_EXCEPTION, ''),
        }),
      )
      expect(withoutException.every(b => !String(b.instructions).includes('DATOS DEL NEGOCIO'))).toBe(true)
      expect(sha(withoutException.map(b => JSON.stringify(b)))).toBe(BEFORE_T_F12_SHA256)
      // T-F11: without only the money section (same place in the body), the 12 are exactly T-F7's.
      const before = prior.map((b): Record<string, unknown> => ({ ...b, instructions: String(b.instructions).replace(MONEY_SECTION, '') }))
      expect(before.every(b => !String(b.instructions).includes('COBRO EN DUDA'))).toBe(true)
      expect(sha(before.map(b => JSON.stringify(b)))).toBe(BEFORE_T_F11_SHA256)
      // T-F7: the only change is the shape of `input`. Joined back into one string (same place in the body), the 12 are T-F6b's.
      expect(sha(before.map(b => JSON.stringify({ ...b, input: JSON.stringify(aiInput(b.input)) })))).toBe(BEFORE_T_F7_SHA256)
    }
  })

  it('with a catalog: the data block, a closed capability list, and the catalog rows in the input', async () => {
    const [on, off] = [await sent({ data: CATALOG }), await sent({})]
    expect(Object.keys(aiInput(on.input))).toEqual(['index', 'catalog', 'app', 'history', 'message'])
    expect(on.instructions).toContain(UNDERSTAND_DATA_INSTRUCTIONS)
    // T-F1: lo de la fase 1 (instrucciones e índice con keywords) es el mismo con la B prendida; el catálogo sólo agrega su bloque.
    expect(on.instructions).toBe(`${off.instructions}\n\n${UNDERSTAND_DATA_INSTRUCTIONS}`)
    expect(aiInput(on.input).index).toEqual(aiInput(off.input).index)
    expect(on.text.format.schema.properties.data.properties.capability.enum).toEqual(['sales_today', 'other', 'none'])
    expect(aiInput(on.input).catalog).toEqual(CATALOG)
    // T-F7.3: the catalog rows are fixed, so they go in the stable first message, after the index.
    expect(Object.keys(JSON.parse((on.input as any)[0].content[0].text))).toEqual(['index', 'catalog'])
    expect((on.input as any)[0].content[0].prompt_cache_breakpoint).toEqual({ mode: 'explicit' })
  })

  it('a data answer becomes a request', async () =>
    expect((await understand(reply({ amount: '$850', day: 'none' }), { data: CATALOG })).result).toEqual({
      kind: 'data',
      request: { capability: 'sales_today', day: null, amount: '$850', time: null, otherVenue: false },
    }))

  it.each([
    { capability: 'cash_drawer' },
    { capability: 'none' },
    { amount: '4111111111111111' },
    { time: 'x'.repeat(25) },
    { time: 'el cobro no fue a las 2 de la tarde' }, // T-B52b (Codex): una hora larga sigue siendo unknown
  ])('an invalid data field is unknown, never a request: %j', async data =>
    expect((await understand(reply(data), { data: CATALOG })).result).toEqual({ kind: 'unknown' }),
  )

  // Lo que sólo atrapa scrubSupportText: cabe en el patrón y el largo, pero es una tarjeta o un PIN.
  it.each([{ amount: '5212345678901' }, { time: 'pin 1234' }])('a sensitive amount or time is unknown: %j', async data =>
    expect((await understand(reply(data), { data: CATALOG })).result).toEqual({ kind: 'unknown' }),
  )

  // Cortos, así que el largo no los atrapa: sólo la clase de caracteres.
  it.each([{ time: '14:30-15:00' }])('a character the time does not allow is unknown: %j', async data =>
    expect((await understand(reply(data), { data: CATALOG })).result).toEqual({ kind: 'unknown' }),
  )

  // T-B52: un monto que no viene en cifras deja la pregunta de datos con el monto vacío (params.ts pide escribirlo).
  // La hora conserva su tope de 24 caracteres (T-B52b).
  it.each([{ amount: 'ochocientos' }, { amount: 'ochocientos cincuenta' }, { amount: '3 mil 200' }])(
    'an amount not written in figures stays a data request with no amount: %j',
    async data => {
      const result = (await understand(reply(data), { data: CATALOG })).result
      expect(result).toMatchObject({ kind: 'data', request: { amount: null } })
    },
  )

  it('without a catalog a data answer is unknown, as today', async () => {
    expect((await understand(reply({}), {})).result).toEqual({ kind: 'unknown' })
    expect((await understand(reply({}), { data: [] })).result).toEqual({ kind: 'unknown' })
  })

  it('hybridFixedReply has no fixed text for data: the worker answers it', () =>
    expect(
      hybridFixedReply(
        { kind: 'data', request: { capability: 'sales_today', day: null, amount: null, time: null, otherVenue: false } },
        false,
        [],
      ),
    ).toBeNull())

  it('with the catalog on, the other kinds parse as today', async () => {
    const data = { capability: 'none', day: 'none', amount: '', time: '', otherVenue: false }
    const answers: [object, Understanding][] = [
      [
        { kind: 'question', standalone: 'Cómo cambio de sucursal en el panel', guideIds: [branch.id] },
        { kind: 'question', standalone: 'Cómo cambio de sucursal en el panel', guideIds: [branch.id] },
      ],
      [
        { kind: 'clarify', standalone: '', guideIds: [products.id, branch.id] },
        { kind: 'clarify', guideIds: [products.id, branch.id] },
      ],
      [{ kind: 'human', standalone: '', guideIds: [] }, { kind: 'human' }],
      [{ kind: 'off_topic', standalone: '', guideIds: [] }, { kind: 'off_topic' }],
    ]
    for (const [answer, expected] of answers) expect((await understand({ ...answer, data }, { data: CATALOG })).result).toEqual(expected)
  })
})

// T-F14 (H-T15-1): «¿quién abrió la caja hoy y cómo agrego un producto?» contestaba una y la otra se perdía sin aviso. Entender
// marca en su misma salida (sin llamada nueva) que el mensaje trae otra pregunta que no contesta; el worker agrega la línea fija.
describe('T-F14: another question in the same message', () => {
  const CATALOG: DataAiRow[] = [{ capability: 'sales_today', description: 'Cuánto vendió hoy la sucursal.' }]
  const none = { capability: 'none', day: 'none', amount: '', time: '', otherVenue: false }
  const ask = (payload: object, extra: Partial<Parameters<typeof understandSupportMessage>[1]> = {}) =>
    run(fakeClient(JSON.stringify(payload)).client, extra)
  const branchQuestion = { kind: 'question', standalone: '¿Cómo cambio de sucursal?', guideIds: [branch.id] }

  it('the instructions name the field and the schema asks for it, with and without the catalog', async () => {
    expect(UNDERSTAND_INSTRUCTIONS).toContain(OTHER_QUESTION_RULE)
    expect(UNDERSTAND_DATA_INSTRUCTIONS).not.toContain('otherQuestion')
    for (const extra of [{}, { data: CATALOG }]) {
      const { client, create } = fakeClient({ kind: 'greeting' })
      await run(client, extra)
      const schema = (create.mock.calls[0][0] as any).text.format.schema
      expect(schema.properties.otherQuestion).toEqual({ type: 'boolean' })
      expect(schema.required.at(-1)).toBe('otherQuestion')
      expect(Object.keys(schema.properties).at(-1)).toBe('otherQuestion')
    }
  })

  it('true comes back with the result; false or missing does not; the result is the same', async () => {
    const marked = await ask({ ...branchQuestion, otherQuestion: true })
    expect(marked).toEqual({ result: branchQuestion, otherQuestion: true, usage, requestId: 'req_fixture', called: true })
    for (const payload of [{ ...branchQuestion, otherQuestion: false }, branchQuestion]) {
      const out = await ask(payload)
      expect(out.result).toEqual(branchQuestion)
      expect(out).not.toHaveProperty('otherQuestion')
    }
  })

  it.each(['clarify', 'unknown', 'greeting'])('it comes back with a %s too', async kind => {
    const payload =
      kind === 'clarify' ? { kind, standalone: '', guideIds: [branch.id, products.id] } : { kind, standalone: '', guideIds: [] }
    expect((await ask({ ...payload, otherQuestion: true })).otherQuestion).toBe(true)
  })

  it('with the catalog: a data question that leaves a how-to behind', async () => {
    const reply = {
      kind: 'data',
      standalone: '',
      guideIds: [],
      data: { ...none, capability: 'sales_today', day: 'today' },
      otherQuestion: true,
    }
    expect(await ask(reply, { data: CATALOG })).toMatchObject({
      result: { kind: 'data', request: { capability: 'sales_today', day: 'today', amount: null, time: null, otherVenue: false } },
      otherQuestion: true,
    })
  })

  it('a value that is not a boolean is an invalid reply: unknown, and no mark', async () => {
    const out = await ask({ ...branchQuestion, otherQuestion: 'sí' })
    expect(out.result).toEqual(UNKNOWN)
    expect(out).not.toHaveProperty('otherQuestion')
  })

  it('a message that never reaches the model carries no mark', async () => {
    const { client } = fakeClient(JSON.stringify({ ...branchQuestion, otherQuestion: true }))
    expect(await run(client, { message: 'mi contraseña: Secreta123 y ¿cómo cambio de sucursal?' })).not.toHaveProperty('otherQuestion')
  })
})
