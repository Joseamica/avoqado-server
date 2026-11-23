import * as fs from 'fs'
import * as path from 'path'
import { buildHandoffEmail, buildHeldDigestEmail, buildWeeklyEmail, type WeeklyReport } from '@/services/support/noticeEmails'
import { weeklyReportWindow } from '@/services/support/notices.service'
import type { HandoffMeta } from '@/services/support/handoff.service'
import { SUPPORT_HANDOFF_GREETING } from '@/services/support/texts'
import * as catalogModule from '@/services/support/data/catalog'
import { dataCatalog } from '@/services/support/data/catalog'
import { ROOT } from '@tests/__helpers__/tsGuard'

const LOGO = 'https://avoqado.io/isotipo.svg'
// Pictographs, flags (regional indicators), skin tones, keycaps, variation selector and joiner.
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u{20E3}\u{FE0F}\u{200D}]/u
const NON_ASCII = /[\u{80}-\u{10FFFF}]/u
/** The HTML carries every non-ASCII character as an entity; the checks read it back as text. */
const decoded = (html: string) => html.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
const person = (extra: Partial<HandoffMeta['people'][number]> = {}): HandoffMeta['people'][number] => ({
  staffId: 'cperson0000000000000000001',
  name: 'Ana López',
  role: 'CASHIER',
  venues: [{ id: 'cvenue00000000000000000001', name: 'Sucursal Norte' }],
  organization: 'Cafetería La Esquina',
  ...extra,
})
const meta = (extra: Partial<HandoffMeta> = {}): HandoffMeta => ({
  requestedAt: '2026-11-12T16:32:00.000Z',
  reason: 'REQUESTED',
  phone: '+525512345678',
  app: 'tpv',
  appVersion: '2.25.4',
  deviceFamily: 'PAX',
  multipleProfiles: false,
  people: [person()],
  guides: ['Cobrar con tarjeta en la PAX', 'Agregar propina'],
  ...extra,
})

describe('buildHandoffEmail', () => {
  it('subject has no emoji, 4 parts of ≤ 30 chars', () => {
    const long = meta({
      people: [person({ organization: '🍕 Pizzería del Centro Histórico de la Ciudad de México' })],
      guides: ['Una guía con un título larguísimo que no cabe en el asunto 🎉'],
    })
    const emoji = [
      meta({ people: [person({ organization: 'Tacos 🇲🇽' })], guides: ['👍🏽 Agregar propina'] }),
      meta({ people: [person({ organization: '1️⃣ Café' })], guides: ['👨‍👩‍👧 Familia'] }),
      // Only emoji: the part keeps a fixed fallback, never empty.
      meta({ people: [person({ organization: '🍕🍔' })], guides: ['🎉'] }),
      // An astral letter on the cut: counted and cut by code points, never half a pair.
      meta({ people: [person({ organization: `${'𝔸'.repeat(40)}` })] }),
    ]
    for (const m of [meta(), long, meta({ guides: [] }), meta({ app: null, people: [] }), ...emoji]) {
      const { subject } = buildHandoffEmail(m, 'soporte@test.local')
      expect(subject).not.toMatch(EMOJI)
      expect(subject).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
      const parts = subject.split(' · ')
      expect(parts).toHaveLength(4)
      expect(parts[0]).toBe('Soporte')
      for (const p of parts) {
        expect(p.trim().length).toBeGreaterThan(0)
        expect(Array.from(p).length).toBeLessThanOrEqual(30)
      }
    }
    expect(buildHandoffEmail(emoji[0], 'x@test.local').subject).toBe('Soporte · Tacos · Terminal de cobro · Agregar propina')
    expect(buildHandoffEmail(emoji[1], 'x@test.local').subject).toBe('Soporte · 1 Café · Terminal de cobro · Familia')
    expect(buildHandoffEmail(emoji[2], 'x@test.local').subject).toBe('Soporte · Sin nombre · Terminal de cobro · Sin nombre')
    expect(buildHandoffEmail(emoji[3], 'x@test.local').subject.split(' · ')[1]).toBe(`${'𝔸'.repeat(29)}…`)
    expect(buildHandoffEmail(meta(), 'soporte@test.local').subject).toBe(
      'Soporte · Cafetería La Esquina · Terminal de cobro · Cobrar con tarjeta en la PAX',
    )
    // Without an attempted guide the topic is the request itself.
    expect(buildHandoffEmail(meta({ guides: [] }), 'x@test.local').subject.split(' · ')[3]).toBe('pidió una persona')
    // A DATA handoff says what happened, never «pidió una persona».
    const data = buildHandoffEmail(meta({ reason: 'DATA', dataCapability: 'ventas de hoy', guides: [] }), 'x@test.local').subject
    expect(data).not.toContain('pidió una persona')
  })

  it('the subject of a DATA handoff is not clipped: its own short topic, while the body keeps the long sentence', () => {
    const { subject, text } = buildHandoffEmail(meta({ reason: 'DATA', dataCapability: 'ventas de hoy', guides: [] }), 'x@test.local')
    expect(subject.split(' · ')[3]).toBe('quería un dato')
    expect(subject).not.toContain('…')
    expect(text).toContain('no pudo consultar un dato y acepto')
  })

  it('logo appears twice, CTA is #000000 and opens wa.me with the customer digits and the greeting', () => {
    const { html, to } = buildHandoffEmail(meta(), 'soporte@test.local')
    expect(to).toBe('soporte@test.local')
    expect(html.split(LOGO)).toHaveLength(3)
    expect(html).toMatch(/<img src="https:\/\/avoqado\.io\/isotipo\.svg"[^>]*width="32" height="32"/)
    expect(html).toMatch(/<img src="https:\/\/avoqado\.io\/isotipo\.svg"[^>]*width="24" height="24"/)
    expect(html).toContain('background-color: #000000')
    expect(html).toContain('background-color: #ffffff')
    expect(html).toContain(`href="https://wa.me/525512345678?text=${encodeURIComponent(SUPPORT_HANDOFF_GREETING)}"`)
    expect(decoded(html)).toContain('Escribirle por WhatsApp')
    // Gray uppercase section labels and the key/value table of the standard.
    expect(html).toContain('text-transform: uppercase')
    expect(html).toContain('border: 1px solid #e5e7eb; border-radius: 8px')
    expect(html).toContain('width: 160px')
    // Every non-ASCII character travels as an entity.
    expect(html).not.toMatch(NON_ASCII)
  })

  it('plain text is not empty and has the footer', () => {
    const { text } = buildHandoffEmail(meta(), 'soporte@test.local')
    expect(text.trim().length).toBeGreaterThan(0)
    expect(text).toContain('Servicios Tecnologicos Avo S.A. de C.V.')
    expect(text).toContain('https://avoqado.io/privacy')
    expect(text).toContain(`https://wa.me/525512345678?text=${encodeURIComponent(SUPPORT_HANDOFF_GREETING)}`)
    // Plain ASCII: accents folded (EMAIL_STANDARDS).
    expect(text).not.toMatch(NON_ASCII)
    expect(text).toContain('Ana Lopez')
    const { html } = buildHandoffEmail(meta(), 'soporte@test.local')
    expect(decoded(html)).toContain('Servicios Tecnologicos Avo S.A. de C.V.')
    expect(html).toContain('href="https://avoqado.io/privacy"')
  })

  it('plain text is plain ASCII: accents folded, ¿ ¡ and emoji out, curly quotes made straight', () => {
    const m = meta({
      people: [person({ name: '¡Ñoño “El Güero”!', organization: '‘Tacos’ 🇲🇽 «Doña Pepa»' })],
      guides: ['¿Cómo cobro con tarjeta? 👍🏽'],
    })
    for (const { text } of [buildHandoffEmail(m, 'x@test.local'), buildHeldDigestEmail('2026-11-11', [m], 'x@test.local')]) {
      expect(text).not.toMatch(NON_ASCII)
      expect(text).toContain('Nono "El Guero"!')
      expect(text).toContain(`'Tacos'  "Dona Pepa"`)
    }
    expect(buildHandoffEmail(m, 'x@test.local').text).toContain('Como cobro con tarjeta? ')
  })

  it('shows only what meta brings: business, venue, person, role, number, app, version, device, guides and the CDMX hour', () => {
    const { html, text } = buildHandoffEmail(meta(), 'soporte@test.local')
    const page = decoded(html)
    for (const value of [
      'Cafetería La Esquina',
      'Sucursal Norte',
      'Ana López',
      'Cajero',
      '+525512345678',
      'Terminal de cobro',
      '2.25.4',
      'PAX',
      'Cobrar con tarjeta en la PAX, Agregar propina',
      // 16:32 UTC is 10:32 in Mexico City.
      '10:32',
      '12 de noviembre de 2026',
    ])
      expect(page).toContain(value)
    expect(text).toContain('10:32')
    // Names are escaped, never markup.
    const hostile = buildHandoffEmail(meta({ people: [person({ name: '<script>x</script>' })] }), 'x@test.local')
    expect(hostile.html).not.toContain('<script>')
    expect(hostile.html).toContain('&lt;script&gt;')
  })

  it('several profiles: «Número registrado en varios perfiles» and each listed', () => {
    const other = person({
      staffId: 'cperson0000000000000000002',
      name: 'Beto Ruiz',
      role: 'MANAGER',
      venues: [
        { id: 'cvenue00000000000000000002', name: 'Sucursal Sur' },
        { id: 'cvenue00000000000000000003', name: 'Sucursal Centro' },
      ],
      organization: 'Taller Ruiz',
    })
    const m = meta({ multipleProfiles: true, people: [person(), other] })
    const { html, text, subject } = buildHandoffEmail(m, 'soporte@test.local')
    const page = decoded(html)
    expect(page).toContain('Número registrado en varios perfiles')
    expect(text).toContain('Numero registrado en varios perfiles')
    for (const value of [
      'Ana López',
      'Cajero',
      'Cafetería La Esquina',
      'Sucursal Norte',
      'Beto Ruiz',
      'Gerente',
      'Taller Ruiz',
      'Sucursal Sur, Sucursal Centro',
    ])
      expect(page).toContain(value)
    // Without picking anyone: the subject names neither business.
    expect(subject).toBe('Soporte · Varios perfiles · Terminal de cobro · Cobrar con tarjeta en la PAX')
  })

  it.each([
    ['REQUESTED', 'pidió una persona', 'pidio una persona'],
    ['TWO_FAILURES', 'no encontré dos veces y aceptó', 'no encontre dos veces y acepto'],
    ['OLD_VERSION', 'tenía una versión vieja y aceptó', 'tenia una version vieja y acepto'],
  ] as const)('says what happened for %s', (reason, said, plain) => {
    const { html, text } = buildHandoffEmail(meta({ reason }), 'soporte@test.local')
    expect(decoded(html)).toContain(said)
    expect(text).toContain(plain)
  })

  it('a DATA handoff shows «Dato que intentó: dato de prueba» and «no pudo consultar un dato y aceptó»', () => {
    const { html, text } = buildHandoffEmail(meta({ reason: 'DATA', dataCapability: 'dato de prueba', guides: [] }), 'soporte@test.local')
    const page = decoded(html)
    expect(page).toContain('no pudo consultar un dato y aceptó')
    expect(page).toMatch(/Dato que intentó<\/td>\s*<td[^>]*>dato de prueba</)
    expect(text).toContain('no pudo consultar un dato y acepto')
    expect(text).toContain('Dato que intento: dato de prueba')
    // Any other handoff has no such row.
    expect(decoded(buildHandoffEmail(meta(), 'soporte@test.local').html)).not.toContain('Dato que intentó')
  })

  it('is pure: the same meta gives the same email', () => {
    expect(buildHandoffEmail(meta(), 'a@test.local')).toEqual(buildHandoffEmail(meta(), 'a@test.local'))
  })
})

describe('buildHeldDigestEmail', () => {
  it('one email with every held notice, its own WhatsApp button each, and the standard', () => {
    const second = meta({ phone: '+525587654321', reason: 'TWO_FAILURES', people: [person({ name: 'Carla Díaz' })], guides: [] })
    const { subject, html, text, to } = buildHeldDigestEmail('2026-11-11', [meta(), second], 'soporte@test.local')
    expect(to).toBe('soporte@test.local')
    expect(subject).not.toMatch(EMOJI)
    expect(subject.length).toBeLessThanOrEqual(60)
    expect(subject).toContain('2026-11-11')
    expect(html.split(LOGO)).toHaveLength(3)
    // One black «Escribirle por WhatsApp» link per notice.
    expect(html.match(/style="font-size: 13px; font-weight: 600; color: #000000;">Escribirle por WhatsApp</g)).toHaveLength(2)
    expect(html).toContain(`https://wa.me/525512345678?text=`)
    expect(html).toContain(`https://wa.me/525587654321?text=`)
    const page = decoded(html)
    expect(page).toContain('Ana López')
    expect(page).toContain('Carla Díaz')
    expect(page).toContain('no encontré dos veces y aceptó')
    expect(page).toContain('11 de noviembre de 2026')
    // Compact: hour · business · venues, then person (role) · app version · what happened.
    expect(page).toContain('10:32 a.m. · Cafetería La Esquina · Sucursal Norte')
    expect(page).toContain('Ana López (Cajero) · Terminal de cobro 2.25.4 · pidió una persona')
    expect(text).toContain('Carla Diaz')
    expect(text).toContain('Servicios Tecnologicos Avo S.A. de C.V.')
    expect(text).not.toMatch(NON_ASCII)
    expect(buildHeldDigestEmail('2026-11-11', [meta(), second], 'soporte@test.local')).toEqual({ subject, html, text, to })
  })

  it('several profiles in a digest row: «Número registrado en varios perfiles» and each one, without picking', () => {
    const several = meta({
      multipleProfiles: true,
      people: [person(), person({ staffId: 'c2', name: 'Beto Ruiz', role: 'MANAGER', organization: 'Taller Ruiz', venues: [] })],
    })
    const page = decoded(buildHeldDigestEmail('2026-11-11', [several], 'x@test.local').html)
    expect(page).toContain('10:32 a.m. · Número registrado en varios perfiles')
    expect(page).toContain('Ana López (Cajero): Cafetería La Esquina · Sucursal Norte; Beto Ruiz (Gerente): Taller Ruiz · Sin sucursal')
  })

  it('100 notices with long names stay under 100 KB of html (Gmail clips at ~102 KB)', () => {
    const long = (label: string) => `${label} ${'Ñandú Pérez Álvarez de la Peña '.repeat(4)}`.trim()
    const items = Array.from({ length: 100 }, (_, i) =>
      meta({
        phone: `+5255${String(10_000_000 + i)}`,
        reason: (['REQUESTED', 'TWO_FAILURES', 'OLD_VERSION'] as const)[i % 3],
        people: [
          person({
            name: long('Persona'),
            organization: long('Organización'),
            venues: [1, 2, 3].map(n => ({ id: `v${n}`, name: long(`Sucursal ${n}`) })),
          }),
        ],
        guides: [long('Guía'), long('Otra guía'), long('Tercera guía')],
      }),
    )
    const { html, text } = buildHeldDigestEmail('2026-11-11', items, 'x@test.local')
    expect(Buffer.byteLength(html)).toBeLessThan(100_000)
    expect(html.match(/Escribirle por WhatsApp/g)).toHaveLength(100)
    expect(text.match(/Escribirle por WhatsApp/g)).toHaveLength(100)
  })
})

describe('weeklyReportWindow', () => {
  // CDMX is UTC-6 all year (no daylight saving since 2022).
  const lastWeek = { key: 'weekly:2026-11-02', from: new Date('2026-10-26T06:00:00.000Z'), to: new Date('2026-11-02T06:00:00.000Z') }
  const thisWeek = { key: 'weekly:2026-11-09', from: new Date('2026-11-02T06:00:00.000Z'), to: new Date('2026-11-09T06:00:00.000Z') }
  it.each(['UTC', 'America/Mexico_City'])(
    "window: Monday 08:59 CDMX is still last week's key; Monday 09:00 is this Monday; Sunday is last Monday (process clock in %s)",
    zone => {
      const saved = process.env.TZ
      process.env.TZ = zone
      try {
        // Monday 9 November 2026: 08:59:59.999 and 09:00 CDMX.
        expect(weeklyReportWindow(new Date('2026-11-09T14:59:59.999Z'), 9)).toEqual(lastWeek)
        expect(weeklyReportWindow(new Date('2026-11-09T15:00:00.000Z'), 9)).toEqual(thisWeek)
        // Sunday 8 November 23:59 CDMX is already Monday in UTC: still last Monday.
        expect(weeklyReportWindow(new Date('2026-11-09T05:59:00.000Z'), 9)).toEqual(lastWeek)
        // Sunday 15 November 23:59 CDMX and a Thursday: this Monday.
        expect(weeklyReportWindow(new Date('2026-11-16T05:59:00.000Z'), 9)).toEqual(thisWeek)
        expect(weeklyReportWindow(new Date('2026-11-12T18:00:00.000Z'), 9)).toEqual(thisWeek)
        // The hour comes from SUPPORT_WEEKLY_REPORT_HOUR.
        expect(weeklyReportWindow(new Date('2026-11-09T06:00:00.000Z'), 0)).toEqual(thisWeek)
        expect(weeklyReportWindow(new Date('2026-11-09T15:00:00.000Z'), 10)).toEqual(lastWeek)
        // Across the year.
        const newYear = { key: 'weekly:2026-12-28', from: new Date('2026-12-21T06:00:00.000Z'), to: new Date('2026-12-28T06:00:00.000Z') }
        expect(weeklyReportWindow(new Date('2027-01-01T18:00:00.000Z'), 9)).toEqual(newYear)
        expect(weeklyReportWindow(new Date('2027-01-04T15:00:00.000Z'), 9)).toEqual({
          key: 'weekly:2027-01-04',
          from: new Date('2026-12-28T06:00:00.000Z'),
          to: new Date('2027-01-04T06:00:00.000Z'),
        })
      } finally {
        if (saved === undefined) delete process.env.TZ
        else process.env.TZ = saved
      }
    },
  )
})

describe('buildWeeklyEmail', () => {
  const week = (extra: Partial<WeeklyReport> = {}): WeeklyReport => ({
    from: new Date('2026-11-02T06:00:00.000Z'),
    to: new Date('2026-11-09T06:00:00.000Z'),
    failures: [
      { app: 'android', kind: 'JUDGE_LITERAL', count: 3 },
      { app: 'android', kind: 'UNKNOWN', count: 1200 },
      { app: 'android', kind: 'CLARIFIED', count: 5 },
      { app: null, kind: 'UNKNOWN', count: 2 },
    ],
    guides: [
      { id: 'android/cobrar-efectivo', title: 'Cobrar en efectivo', count: 40 },
      { id: 'tpv/propina', title: 'tpv/propina', count: 1 },
    ],
    guidesMore: 7,
    handoffs: [
      { app: 'android', status: 'HELD', reason: 'TWO_FAILURES', count: 4 },
      { app: 'tpv', status: 'SENT', reason: 'REQUESTED', count: 146 },
    ],
    undelivered: [
      { kind: 'HANDOFF', status: 'FAILED', count: 2 },
      { kind: 'HANDOFF', status: 'SKIPPED', count: 1 },
      { kind: 'DAILY_DIGEST', status: 'UNCERTAIN', count: 1 },
    ],
    ...extra,
  })
  const empty = week({ failures: [], guides: [], guidesMore: 0, handoffs: [], undelivered: [] })

  it('the standard: subject without emoji under 60, the week of the report, logo twice, plain text in ASCII with the footer', () => {
    const { subject, html, text, to } = buildWeeklyEmail(week(), 'soporte@test.local')
    expect(to).toBe('soporte@test.local')
    // Monday 2 to Sunday 8 November in Mexico City.
    expect(subject).toBe('Soporte · Lista semanal · 2026-11-02 al 2026-11-08')
    expect(subject).not.toMatch(EMOJI)
    expect(subject.length).toBeLessThanOrEqual(60)
    expect(html.split(LOGO)).toHaveLength(3)
    expect(html).toMatch(/<img src="https:\/\/avoqado\.io\/isotipo\.svg"[^>]*width="32" height="32"/)
    expect(html).toMatch(/<img src="https:\/\/avoqado\.io\/isotipo\.svg"[^>]*width="24" height="24"/)
    expect(html).toContain('background-color: #ffffff')
    expect(html).toContain('border: 1px solid #e5e7eb; border-radius: 8px')
    expect(html).not.toMatch(NON_ASCII)
    expect(decoded(html)).toContain('Del 2 de noviembre de 2026 al 8 de noviembre de 2026')
    expect(text.trim().length).toBeGreaterThan(0)
    expect(text).not.toMatch(NON_ASCII)
    expect(text).toContain('Servicios Tecnologicos Avo S.A. de C.V.')
    expect(text).toContain('https://avoqado.io/privacy')
  })

  it('every count with its label: «no encontré», «juez rechazó» and «pidió aclarar» apart; 20 guides and «y N más»; HELD = «en el resumen del día»; UNCERTAIN = «aviso incierto»', () => {
    const { html, text } = buildWeeklyEmail(week(), 'soporte@test.local')
    const page = decoded(html)
    for (const value of [
      // Totals first: 1,210 failures, 150 handoffs and 4 notices not delivered.
      '1,210 preguntas que el asistente no contestó, 150 pasadas a una persona y 4 avisos no entregados.',
      'POS Android',
      'no encontré: 1,200 · juez rechazó: 3 · pidió aclarar: 5',
      'Sin app',
      'no encontré: 2',
      'Cobrar en efectivo',
      '40 veces',
      'tpv/propina',
      '1 vez',
      'y 7 más',
      '4 · no encontré dos veces y aceptó',
      'en el resumen del día',
      'Terminal de cobro',
      '146 · pidió una persona',
      'enviado',
      'Pasar a una persona',
      '2 · falló',
      '1 · no se mandó',
      'Resumen del día',
      '1 · aviso incierto',
    ])
      expect(page).toContain(value)
    for (const value of [
      'no encontre: 1,200 - juez rechazo: 3 - pidio aclarar: 5',
      'y 7 mas',
      '1 - aviso incierto',
      'en el resumen del dia',
    ])
      expect(text).toContain(value)
  })

  it('one of each in the totals is singular; none is plural', () => {
    const one = week({
      failures: [{ app: 'android', kind: 'UNKNOWN', count: 1 }],
      handoffs: [{ app: 'android', status: 'SENT', reason: 'REQUESTED', count: 1 }],
      undelivered: [{ kind: 'HANDOFF', status: 'FAILED', count: 1 }],
    })
    expect(decoded(buildWeeklyEmail(one, 'x@test.local').html)).toContain(
      '1 pregunta que el asistente no contestó, 1 pasada a una persona y 1 aviso no entregado.',
    )
    expect(decoded(buildWeeklyEmail(week({ handoffs: [], undelivered: [] }), 'x@test.local').html)).toContain(
      '1,210 preguntas que el asistente no contestó, 0 pasadas a una persona y 0 avisos no entregados.',
    )
  })

  it('a week with data questions counts them in the introduction; a week without them keeps the sentence as it was', () => {
    const data = (counts: number[]) =>
      counts.map((count, i) => ({
        capability: 'sales_today',
        label: 'ventas de hoy',
        result: (['ANSWERED', 'NEEDS_UNLOCK'] as const)[i],
        count,
      }))
    expect(decoded(buildWeeklyEmail({ ...empty, data: data([3, 1200]) }, 'x@test.local').html)).toContain(
      '0 preguntas que el asistente no contestó, 0 pasadas a una persona, 0 avisos no entregados y 1,203 consultas de datos.',
    )
    const one = buildWeeklyEmail({ ...week(), data: data([1]) }, 'x@test.local')
    expect(decoded(one.html)).toContain(
      '1,210 preguntas que el asistente no contestó, 150 pasadas a una persona, 4 avisos no entregados y 1 consulta de datos.',
    )
    expect(one.text).toContain('150 pasadas a una persona, 4 avisos no entregados y 1 consulta de datos.')
    expect(decoded(buildWeeklyEmail(week({ data: [] }), 'x@test.local').html)).toContain(
      '1,210 preguntas que el asistente no contestó, 150 pasadas a una persona y 4 avisos no entregados.',
    )
  })

  it('says the question texts stay in the database 30 days', () => {
    for (const report of [week(), empty]) {
      const { html, text } = buildWeeklyEmail(report, 'soporte@test.local')
      expect(decoded(html)).toContain('Esta lista sólo trae conteos: el texto de las preguntas se queda en la base 30 días.')
      expect(text).toContain('Esta lista solo trae conteos: el texto de las preguntas se queda en la base 30 dias.')
    }
  })

  it('empty week: «Nada que reportar esta semana.»', () => {
    const { html, text } = buildWeeklyEmail(empty, 'soporte@test.local')
    expect(decoded(html)).toContain('Nada que reportar esta semana.')
    expect(html).not.toContain('<h2')
    expect(text).toContain('Nada que reportar esta semana.')
    // A week with something never says it.
    expect(decoded(buildWeeklyEmail(week({ failures: [], guides: [], guidesMore: 0 }), 'x@test.local').html)).not.toContain(
      'Nada que reportar',
    )
  })

  it('built from the stored meta (dates as ISO strings) it is the same email: a retry never sends different content', () => {
    const stored = JSON.parse(JSON.stringify(week())) as WeeklyReport
    expect(typeof stored.from).toBe('string')
    expect(buildWeeklyEmail(stored, 'soporte@test.local')).toEqual(buildWeeklyEmail(week(), 'soporte@test.local'))
    expect(buildWeeklyEmail(week(), 'soporte@test.local')).toEqual(buildWeeklyEmail(week(), 'soporte@test.local'))
  })

  it('titles are escaped, never markup', () => {
    const { html } = buildWeeklyEmail(week({ guides: [{ id: 'x', title: '<script>x</script>', count: 1 }] }), 'x@test.local')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('the data section shows labels and counts, and a report stored without data still renders', () => {
    const results = [
      'ANSWERED',
      'NO_PERMISSION',
      'PLAN_REQUIRED',
      'NEEDS_UNLOCK',
      'PARAM_INVALID',
      'NOT_OFFERED',
      'OVER_CAP',
      'QUERY_FAILED',
      'CHECK_FAILED',
    ] as const
    const report = week({
      data: [
        // The label comes in `meta`, saved when the week closed.
        ...results.map((result, i) => ({ capability: 'sales_today', label: 'ventas de hoy', result, count: i + 1 })),
        // Stored before the label was saved: the key, escaped.
        { capability: '<b>gone_key</b>', result: 'ANSWERED', count: 1200 },
        { capability: '<b>gone_key</b>', result: 'CHECK_FAILED', count: 1 },
      ],
    })
    const mail = buildWeeklyEmail(report, 'soporte@test.local')
    const page = decoded(mail.html)
    for (const value of [
      'Consultas de datos',
      'ventas de hoy',
      'contestadas: 1 · sin permiso: 2 · sin el plan: 3 · sin el toque del día: 4 · no se entendió: 5 · no se ofrece ahí: 6 · no se pudo calcular con exactitud: 7 · falló la lectura: 8 · falló el cotejo: 9',
      '&lt;b&gt;gone_key&lt;/b&gt;',
      'contestadas: 1,200 · falló el cotejo: 1',
    ])
      expect(page).toContain(value)
    expect(mail.html).not.toContain('<b>gone_key')
    expect(mail.text).toContain('ventas de hoy: contestadas: 1 - sin permiso: 2 - sin el plan: 3 - sin el toque del dia: 4')
    expect(mail.text).toContain('<b>gone_key</b>: contestadas: 1,200 - fallo el cotejo: 1')
    // Only `meta` decides: the same meta gives the same email whatever the catalog says now (a deploy between a timed-out
    // attempt and its retry), and the template does not even import the catalog.
    // T-B44: the real catalog is frozen, so the module's export is swapped for a registered one and put back.
    const other = dataCatalog({
      key: 'sales_today',
      label: 'otra etiqueta',
      object: 'otro objeto',
      aiHint: 'Otra.',
      permissions: ['reports:read'],
      params: () => ({ ok: false, refusal: 'NOT_AVAILABLE' }),
      read: async () => null,
      render: () => ({ text: '', figures: [] }),
    })
    const swapped = jest.replaceProperty(catalogModule, 'DATA_CAPABILITIES', other)
    try {
      expect(buildWeeklyEmail(report, 'soporte@test.local')).toEqual(mail)
    } finally {
      swapped.restore()
    }
    expect(fs.readFileSync(path.join(ROOT, 'src/services/support/noticeEmails.ts'), 'utf8')).not.toMatch(/data\/catalog|DATA_CAPABILITIES/)
    // A data week alone is not «nothing to report».
    expect(decoded(buildWeeklyEmail({ ...empty, data: report.data }, 'x@test.local').html)).not.toContain('Nada que reportar')
    // Stored before la B (no `data`), or a week without data questions: the same email as before, with no data section.
    const stored = JSON.parse(JSON.stringify(week())) as WeeklyReport
    expect(stored).not.toHaveProperty('data')
    expect(buildWeeklyEmail(stored, 'soporte@test.local')).toEqual(buildWeeklyEmail(week({ data: [] }), 'soporte@test.local'))
    expect(decoded(buildWeeklyEmail(stored, 'soporte@test.local').html)).not.toContain('Consultas de datos')
  })
})

describe('ayuda pública: el aviso de un número no registrado (22-nov)', () => {
  const unknown = meta({ people: [], app: 'android', appVersion: null, deviceFamily: null, guides: [], unregistered: true })
  it('says it is a number with no account, in the body, the subject and the digest, and keeps the button to write back', () => {
    const email = buildHandoffEmail(unknown, 'soporte@test.local')
    expect(email.subject.split(' · ')[1]).toBe('Número no registrado')
    expect(decoded(email.html)).toContain('Número no registrado')
    expect(email.text).toContain('Persona: Numero no registrado')
    // The number shows masked; only the button to write back carries it whole.
    expect(email.text).toContain('Numero: ***5678')
    expect(decoded(email.html)).not.toContain('+525512345678')
    expect(email.text).toContain('https://wa.me/525512345678')
    expect(decoded(email.html)).not.toContain('Sin perfil')
    const digest = buildHeldDigestEmail('2026-11-12', [unknown], 'soporte@test.local')
    expect(decoded(digest.html)).toContain('Número no registrado')
    expect(decoded(digest.html)).not.toContain('Sin perfil')
  })
  it('a meta without the mark (registered, nobody left) still says «Sin perfil», as today', () => {
    expect(decoded(buildHandoffEmail(meta({ people: [] }), 'soporte@test.local').html)).toContain('Sin perfil')
  })
})
