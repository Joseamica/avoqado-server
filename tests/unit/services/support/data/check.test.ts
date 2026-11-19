import { checkRendered, template } from '@/services/support/data/check'

// check.test.ts
const TZ = 'America/Mexico_City'
const good = () => {
  const t = template(TZ)
  return t.done(`Ventas netas ${t.money(12345.6)} · ${t.count(58)} transacciones en ${t.text('Mesa 12')}`)
}
it('a clean template passes', () => expect(checkRendered(good(), TZ)).toBe(true))
it('a digit outside a hole fails', () => expect(checkRendered({ ...good(), text: good().text + ' y 7 más' }, TZ)).toBe(false))
it('a hole that prints another field fails', () =>
  expect(checkRendered({ text: 'Ventas netas $12,900.00', figures: [{ kind: 'money', shown: '$12,900.00', value: 12345.6 }] }, TZ)).toBe(
    false,
  ))
it('a name that skipped safeDbText fails', () =>
  expect(
    checkRendered(
      { text: 'Con Ana ana@correo.com', figures: [{ kind: 'text', shown: 'Ana ana@correo.com', value: 'Ana ana@correo.com' }] },
      TZ,
    ),
  ).toBe(false))
it('8 digits in a row fail even inside a hole', () =>
  expect(checkRendered({ text: 'Folio 12345678', figures: [{ kind: 'count', shown: '12345678', value: 12345678 }] }, TZ)).toBe(false))
it('more than 1,500 characters or more than 7 lines fail', () => {
  expect(checkRendered({ text: 'a'.repeat(1501), figures: [] }, TZ)).toBe(false)
  expect(checkRendered({ text: Array(8).fill('a').join('\n'), figures: [] }, TZ)).toBe(false)
})
it('a strict hole is checked with its own rule and fallback', () => {
  const t = template(TZ),
    ok = t.done(`Caja de ${t.strict('Flautas $850', 'tu sucursal')}: ${t.strict(null, 'una persona')} la abrió`)
  expect(ok.text).toBe('Caja de tu sucursal: una persona la abrió')
  expect(checkRendered(ok, TZ)).toBe(true)
  expect(
    checkRendered(
      {
        text: 'Caja de Flautas $850',
        figures: [{ kind: 'strictText', shown: 'Flautas $850', value: 'Flautas $850', fallback: 'tu sucursal' }],
      },
      TZ,
    ),
  ).toBe(false)
})
it('a figure missing from the text, or a digit hidden as a superscript, fails', () => {
  expect(checkRendered({ text: 'Ventas netas', figures: [{ kind: 'money', shown: '$850.00', value: 850 }] }, TZ)).toBe(false)
  expect(checkRendered({ text: 'Folio ¹²³', figures: [] }, TZ)).toBe(false)
  expect(
    checkRendered(
      {
        text: 'Tarjetas 4242\u200b4242',
        figures: [
          { kind: 'last4', shown: '4242', value: '4242' },
          { kind: 'last4', shown: '4242', value: '4242' },
        ],
      },
      TZ,
    ),
  ).toBe(false)
})
// Ronda de arreglos 1
// 2 · el texto fijo de un hueco estricto no puede traer cifras ni signo de moneda
it('a strict fallback with a figure or a currency sign fails when the template is built and in the check', () => {
  expect(() => template(TZ).strict('Ana $850', 'fondo 1,250.00')).toThrow()
  expect(() => template(TZ).strict('Ana', 'fondo $')).toThrow()
  expect(() => template(TZ).strict('Ana', 'fondo ❶')).toThrow()
  expect(
    checkRendered(
      {
        text: 'Fondo: fondo 1,250.00',
        figures: [{ kind: 'strictText', shown: 'fondo 1,250.00', value: 'Ana $850', fallback: 'fondo 1,250.00' }],
      },
      TZ,
    ),
  ).toBe(false)
})
// m3 · dígitos encerrados o de adorno también son dígitos, fuera de un hueco y en una corrida de 8
it('dingbat digits outside a hole, or next to a hole, fail', () => {
  expect(checkRendered({ text: 'Folio ❶❷❸', figures: [] }, TZ)).toBe(false)
  const t = template(TZ)
  expect(checkRendered(t.done(`Mesa ${t.text('❶❷❸❹')}${t.last4('4242')}`), TZ)).toBe(false)
})
// m5 · un signo de menos pegado a un importe positivo
it('a minus sign before a positive amount fails; the amount carries its own sign', () => {
  for (const sign of ['-', '–', '−', '- ']) {
    const t = template(TZ)
    expect(checkRendered(t.done(`Neto ${sign}${t.money(150)}`), TZ)).toBe(false)
  }
  const t = template(TZ)
  expect(checkRendered(t.done(`Neto ${t.money(-150)}`), TZ)).toBe(true)
})
// Ronda de arreglos 2 · así se imprime un descuento o una devolución: con su importe en negativo, nunca con un «−» fijo
it('a discount goes in as its negative amount: −$200.00, and zero stays $0.00', () => {
  const t = template(TZ)
  expect(checkRendered(t.done(`Descuentos ${t.money(-200)} · Devoluciones ${t.money(-0)}`), TZ)).toBe(true)
})
// Ronda de arreglos 3 · un nombre que termina en guion ya no tumba el importe que sigue
it('a name ending in a dash before an amount passes the check', () => {
  for (const name of ['Corte -', 'Manicure –']) {
    const t = template(TZ)
    expect(checkRendered(t.done(`${t.text(name)} ${t.money(250)}`), TZ)).toBe(true)
  }
})
// Ronda de arreglos 5 · M-3: un guion seguido de un invisible que no es de formato ya no queda antes del importe
it('a name ending in a dash and a non-format invisible prints without the dash, and the amount after it passes', () => {
  const t = template(TZ)
  const rendered = t.done(`${t.text('Corte -\u034f')} ${t.money(250)}`)
  expect(rendered.text).toBe('Corte $250.00')
  expect(checkRendered(rendered, TZ)).toBe(true)
})
it('➖ or ˗ before a positive amount fails', () => {
  for (const sign of ['➖', '˗']) {
    const t = template(TZ)
    expect(checkRendered(t.done(`Neto ${sign}${t.money(150)}`), TZ)).toBe(false)
  }
})
// M-5 · «〇» (una letra-número) es un dígito
it('a letter-number digit outside a hole fails', () => expect(checkRendered({ text: 'Folio 〇', figures: [] }, TZ)).toBe(false))
// Ajuste 1 · un relleno que se ve como espacio tras el guion: el guion se va y el importe pasa
it('a name ending in a dash and a filler that looks like a space prints «Corte» and the amount after it passes', () => {
  const t = template(TZ)
  const rendered = t.done(`${t.text('Corte -\u3164')} ${t.money(250)}`)
  expect(rendered.text).toBe('Corte $250.00')
  expect(checkRendered(rendered, TZ)).toBe(true)
})
// Ajuste 2 · ─, ━ y ⁃ antes de un importe positivo también se leen como menos
it('─, ━ or ⁃ before a positive amount fails', () => {
  for (const sign of ['─', '━', '⁃']) {
    const t = template(TZ)
    expect(checkRendered(t.done(`Neto ${sign}${t.money(150)}`), TZ)).toBe(false)
  }
})
// Retoque 2 · los demás invisibles «ignorables por omisión» (jemer, mongol) tampoco dejan un guion antes del importe
it('a dash followed by a Khmer or Mongolian invisible prints «Corte» and the amount after it passes', () => {
  for (const name of ['Corte -\u17b4', 'Corte -\u180b']) {
    const t = template(TZ)
    const rendered = t.done(`${t.text(name)} ${t.money(250)}`)
    expect(rendered.text).toBe('Corte $250.00')
    expect(checkRendered(rendered, TZ)).toBe(true)
  }
})
// T-B39 · la regla de salida vale para la respuesta ENTERA, no sólo para sus huecos: una plantilla que pega texto de la base sin
// t.text() no puede colar una liga ni un correo.
describe('a link or an email outside the holes (T-B39)', () => {
  const answer = (tail: string) => {
    const t = template(TZ)
    return t.done(`Ventas en ${t.text('Norte')} (corte ${t.time(new Date('2026-11-16T20:30:00Z'))}): ${t.money(850)}${tail}`)
  }
  it.each([' · https://ejemplo.com', ' · ana@correo.com', ' · ftp://x', ' · ver avoqado.io', ' · 10.0.0.1'])(
    'fails with «%s» glued after correct holes',
    tail => expect(checkRendered(answer(tail), TZ)).toBe(false),
  )
  it('a glued dot in the fixed text fails: «Ver avoqado.io»', () => {
    const t = template(TZ)
    expect(checkRendered(t.done(`Ver avoqado.io para ${t.text('Ana')}`), TZ)).toBe(false)
  })
  it('a correct answer with names, money, a date and a time passes', () => {
    const t = template(TZ)
    const at = new Date('2026-11-12T20:30:00Z')
    const rendered = t.done(
      `Cobro en ${t.text('Norte')}, ${t.shortDay(at)} ${t.date(at)} a las ${t.time(at)}: ${t.money(1250.5)} de ${t.text('Ana Pérez')}, ` +
        `${t.count(1234)} cuentas, tarjeta ${t.last4('4242')}. Atendió ${t.strict('Luis', 'una persona')}.\nListo.`,
    )
    expect(rendered.text).toBe(
      'Cobro en Norte, jue 12-nov 12-nov-2026 a las 14:30: $1,250.50 de Ana Pérez, 1,234 cuentas, tarjeta 4242. Atendió Luis.\nListo.',
    )
    expect(checkRendered(rendered, TZ)).toBe(true)
  })
  it('a name with a dot is cut by safeDbText and passes: «Ma.Luisa» prints «Ma. Luisa»', () => {
    const t = template(TZ)
    const rendered = t.done(`Atendió ${t.text('Ma.Luisa')}`)
    expect(rendered.text).toBe('Atendió Ma. Luisa')
    expect(checkRendered(rendered, TZ)).toBe(true)
  })
  it('no format output carries a link shape: every hole kind, negatives, thousands and the year boundary', () => {
    for (const at of ['2026-01-01T06:00:00Z', '2026-12-31T23:59:00Z', '2026-03-08T08:30:00Z']) {
      const t = template(TZ)
      const d = new Date(at)
      const rendered = t.done(
        `${t.money(-1234567.89)} ${t.money(0.5)} ${t.count(9999)} ${t.time(d)} ${t.shortDay(d)} ${t.date(d)} ${t.date('2026-11-16')}.`,
      )
      expect(checkRendered(rendered, TZ)).toBe(true)
    }
  })
})
// T-B39b · un nombre que termina en punto, junto a la puntuación de la plantilla, ya no tumba la respuesta
describe('a dot followed by punctuation is not a link (T-B39b)', () => {
  const at = new Date('2026-11-12T20:30:00Z')
  it.each([
    [
      '«Abarrotes S.A.» + coma',
      () => {
        const t = template(TZ)
        return t.done(`Cobro en ${t.text('Abarrotes S.A.')}, ${t.money(850)}`)
      },
      'Cobro en Abarrotes S. A., $850.00',
    ],
    [
      '«Tacos Hnos.» + dos puntos',
      () => {
        const t = template(TZ)
        return t.done(`${t.text('Tacos Hnos.')}: ${t.money(850)}`)
      },
      'Tacos Hnos.: $850.00',
    ],
    [
      '«(Ana Pérez Jr.)»',
      () => {
        const t = template(TZ)
        return t.done(`Atendió (${t.text('Ana Pérez Jr.')})`)
      },
      'Atendió (Ana Pérez Jr.)',
    ],
    [
      '«Ana Jr.» entre comillas',
      () => {
        const t = template(TZ)
        return t.done(`Atendió «${t.text('Ana Jr.')}».`)
      },
      'Atendió «Ana Jr.».',
    ],
    [
      'texto fijo «y más...»',
      () => {
        const t = template(TZ)
        return t.done(`Ventas de ${t.text('Ana')} y más...`)
      },
      'Ventas de Ana y más...',
    ],
    [
      'texto fijo «etc.)»',
      () => {
        const t = template(TZ)
        return t.done(`Ventas (cortes, etc.) de ${t.text('Ana')}`)
      },
      'Ventas (cortes, etc.) de Ana',
    ],
    [
      'texto fijo «(aprox.)»',
      () => {
        const t = template(TZ)
        return t.done(`Ventas ${t.money(850)} (aprox.)`)
      },
      'Ventas $850.00 (aprox.)',
    ],
  ])('passes: %s', (_name, build, text) => {
    const rendered = build()
    expect(rendered.text).toBe(text)
    expect(checkRendered(rendered, TZ)).toBe(true)
  })
  it.each([
    [
      'texto fijo «Ver avoqado.io»',
      () => {
        const t = template(TZ)
        return t.done(`Ver avoqado.io para ${t.text('Ana')}`)
      },
    ],
    [
      'hueco de texto + «.io» fijo',
      () => {
        const t = template(TZ)
        return t.done(`Ver ${t.text('avoqado')}.io`)
      },
    ],
    [
      'hueco de fecha + «.mx»',
      () => {
        const t = template(TZ)
        return t.done(`Ver ${t.date(at)}.mx`)
      },
    ],
    [
      'texto fijo + hueco de día («cafe.jue 12-nov»)',
      () => {
        const t = template(TZ)
        return t.done(`Ver cafe.${t.shortDay(at)}`)
      },
    ],
    [
      '«https:/» fijo + hueco «/x»',
      () => {
        const t = template(TZ)
        return t.done(`Ver https:/${t.text('/x')}`)
      },
    ],
    [
      'un correo',
      () => {
        const t = template(TZ)
        return t.done(`Escribe a ana@correo.com, ${t.text('Ana')}`)
      },
    ],
  ])('still fails: %s', (_name, build) => expect(checkRendered(build(), TZ)).toBe(false))
})
// T-B39c · un valor que empieza con punto ya no tumba la respuesta cuando la plantilla le pega «» o «(»
describe('a value that starts with a dot (T-B39c)', () => {
  it.each([
    ['entre comillas', (t: ReturnType<typeof template>) => t.done(`Atendió «${t.text('.Ana')}».`), 'Atendió «. Ana».'],
    ['entre paréntesis', (t: ReturnType<typeof template>) => t.done(`(${t.text('.Ana')})`), '(. Ana)'],
    [
      'punto y dígito, antes de un importe',
      (t: ReturnType<typeof template>) => t.done(`${t.text('.5 litros')} ${t.money(250)}`),
      '. 5 litros $250.00',
    ],
  ])('passes: %s', (_name, build, text) => {
    const rendered = build(template(TZ))
    expect(rendered.text).toBe(text)
    expect(checkRendered(rendered, TZ)).toBe(true)
  })
  it('fixed text glued to the hole: the dot already comes split from the data', () => {
    const t = template(TZ)
    expect(t.done(`Sucursal${t.text('.mx/pago')}`).text).toBe('Sucursal. mx/pago')
  })
})
