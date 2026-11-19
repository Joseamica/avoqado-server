import crypto from 'crypto'
import * as T from '@/services/support/data/texts'
import { SUPPORT_HANDOFF_OFFER, SUPPORT_HYBRID_UNKNOWN, SUPPORT_SECOND_FAILURE, SUPPORT_SEND_RETRY_NOTICE } from '@/services/support/texts'

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

it('the notice starts and names the button as approved, and its hash follows the text', () => {
  expect(
    T.SUPPORT_DATA_NOTICE.es.startsWith('Para mostrarte datos de tu negocio por WhatsApp necesito tu permiso. Sólo leo; no cambio nada.'),
  ).toBe(true)
  expect(T.SUPPORT_DATA_NOTICE.es).toContain('tienes que tocar «Consultar datos por WhatsApp hoy» aquí, en el panel, cada día')
  expect(T.SUPPORT_DATA_NOTICE.es.endsWith('y un registro sin cifras de qué consultaste 90 días.')).toBe(true)
  expect(T.supportDataNoticeHashes()).toEqual([sha(T.SUPPORT_DATA_NOTICE.es), sha(T.SUPPORT_DATA_NOTICE.en)])
  expect(T.supportDataNoticeHash('es')).toBe(sha(T.SUPPORT_DATA_NOTICE.es))
  expect(T.supportDataNoticeHash('en')).toBe(sha(T.SUPPORT_DATA_NOTICE.en))
})

it('exact fixed replies', () => {
  expect(T.SUPPORT_DATA_NEEDS_UNLOCK).toBe(
    'Para consultar datos de tu negocio, abre el panel › Soporte por WhatsApp › Consultar datos por WhatsApp hoy: https://dashboard.avoqado.io/support/whatsapp',
  )
  expect(
    T.supportDataOutOfCatalog([
      'ventas de hoy',
      'lo que cae en el banco esta semana',
      'buscar un cobro por su monto',
      'si la venta de ese cobro tiene factura',
      'quién abrió o cerró la caja',
      'cuentas abiertas',
      'reservaciones de hoy',
      'el estado de tu plan',
    ]),
  ).toBe(
    'Todavía no consulto ese dato por WhatsApp. Por aquí puedo darte: ventas de hoy, lo que cae en el banco esta semana, buscar un cobro por su monto, si la venta de ese cobro tiene factura, quién abrió o cerró la caja, cuentas abiertas, reservaciones de hoy y el estado de tu plan.',
  )
  expect(T.supportDataNoPermission('las ventas de hoy')).toBe(
    'Con tus permisos en esta sucursal no puedo mostrarte las ventas de hoy. Pídeselo a quien administra tu negocio.',
  )
  expect(T.SUPPORT_DATA_OTHER_VENUE).toBe('Sólo veo la sucursal que tienes elegida. Para otra sucursal, escribe SUCURSAL.')
  expect(T.SUPPORT_DATA_REFUSALS.PARAM_AMOUNT).toBe('No te entendí el monto. Escríbelo así: «¿entró un cobro de $850 hoy a las 14:30?».')
  expect(T.supportDataHistoryMark('ventas de hoy')).toBe('[respuesta con datos de ventas de hoy; no se muestran al asistente]')
  // C1 · ventas de hoy
  expect(T.SUPPORT_DATA_REFUSALS.SALES_LEGACY_QR).toBe(
    'Las ventas de esta sucursal todavía incluyen cobros del sistema anterior, y por aquí no puedo darte el total completo. Velo en Reportes › Resumen de ventas.',
  )
  expect(T.SUPPORT_DATA_REFUSALS.SALES_TODAY_ONLY).toBe(
    'Por aquí sólo veo las ventas de hoy; las demás están en Reportes › Resumen de ventas.',
  )
  // C2 · buscar un cobro por su monto (PARAM_AMOUNT y PARAM_DAY ya están fijados arriba y abajo)
  // T-B48: el «$» es la salida de un monto chico junto a una hora, así que la negativa de la hora lo dice
  expect(T.SUPPORT_DATA_REFUSALS.PARAM_TIME).toBe(
    'No te entendí la hora. Escribe el monto con $ y la hora así: «¿entró un cobro de $850 hoy a las 14:30?».',
  )
  // …con los mismos dígitos que las otras dos de parámetros (y que el texto de antes): la regla de salida la trata igual
  expect(T.SUPPORT_DATA_REFUSALS.PARAM_TIME.match(/\d/g)?.join('')).toBe('8501430')
  expect(T.SUPPORT_DATA_REFUSALS.PARAM_AMOUNT.match(/\d/g)?.join('')).toBe('8501430')
  // C4 · reservaciones de hoy (PLAN_RESERVATIONS es del bloque 2)
  expect(T.SUPPORT_DATA_REFUSALS.PLAN_RESERVATIONS).toBe('Reservaciones es parte del plan Pro.')
  expect(T.SUPPORT_DATA_REFUSALS.RESERVATIONS_TODAY_ONLY).toBe('Por aquí sólo veo las reservaciones de hoy; las demás están en el panel.')
  // C6 · lo que cae en el banco esta semana
  expect(T.SUPPORT_DATA_REFUSALS.PLAN_DEPOSITS).toBe('Saldo Disponible es parte del plan Pro.')
  expect(T.SUPPORT_DATA_REFUSALS.DEPOSITS_NEEDS_KYC).toBe('Saldo Disponible se abre cuando tu negocio tiene aprobada su verificación.')
  expect(T.SUPPORT_DATA_REFUSALS.DEPOSITS_THIS_WEEK_ONLY).toBe(
    'Por aquí sólo veo lo que cae esta semana; las demás están en Reportes › Saldo Disponible.',
  )
  expect(T.SUPPORT_DATA_REFUSALS.DEPOSITS_OVER_CAP).toBe(
    'Esta semana no puedo calcularlo por aquí con exactitud. Velo en Reportes › Saldo Disponible.',
  )
  // C7 · si la venta de ese cobro tiene factura (PARAM_DAY, PARAM_AMOUNT y PARAM_TIME son los de C2)
  expect(T.SUPPORT_DATA_REFUSALS.PLAN_INVOICES).toBe('Facturación es parte del plan Premium.')
  // C8 · quién abrió o cerró la caja
  expect(T.SUPPORT_DATA_REFUSALS.CASH_DRAWER_TODAY_OR_YESTERDAY).toBe(
    'Por aquí sólo veo la caja de hoy y de ayer; lo demás está en Turnos de caja.',
  )
})

it('no fixed text asks for a code or for a yes (case 4), and none carries 8 digits in a row', () => {
  const all = [
    ...(Object.values(T) as unknown[]).filter((v): v is string => typeof v === 'string'),
    T.SUPPORT_DATA_NOTICE.es,
    T.SUPPORT_DATA_NOTICE.en,
    ...Object.values(T.SUPPORT_DATA_REFUSALS),
    T.supportDataNoPermission('las ventas de hoy'),
    T.supportDataOutOfCatalog(['ventas de hoy']),
  ]
  for (const text of all) {
    expect(text).not.toMatch(/¿\s*aceptas|responde\s+s[ií]|(escribe|dime|manda|env[ií]a)(me)?\s+(tu|el|un)\s+c[oó]digo/i)
    expect(text).not.toMatch(/\d{8,}/)
  }
})

it('a refusal of la B without a capability is recognized by its text: alone, with the offer, or resent; nothing else is', () => {
  const without = [
    T.SUPPORT_DATA_OFF,
    T.SUPPORT_DATA_LINK_FIRST,
    T.SUPPORT_DATA_SUPERADMIN,
    T.supportDataOutOfCatalog(['ventas de hoy', 'cuentas abiertas']),
  ]
  for (const text of without)
    for (const saved of [
      text,
      `${text}\n\n${SUPPORT_HANDOFF_OFFER}`,
      `${SUPPORT_SEND_RETRY_NOTICE}\n\n${text}\n\n${SUPPORT_HANDOFF_OFFER}`,
    ])
      expect(T.isSupportDataRefusalWithoutCapability(saved)).toBe(true)
  // A refusal with its capability carries it in `dataCapability`; phase 1 and a figure never match.
  for (const saved of [
    null,
    '',
    `${T.SUPPORT_DATA_NEEDS_UNLOCK}\n\n${SUPPORT_HANDOFF_OFFER}`,
    `${SUPPORT_HYBRID_UNKNOWN}\n\n${SUPPORT_HANDOFF_OFFER}`,
    `${SUPPORT_SECOND_FAILURE}\n\n${SUPPORT_HANDOFF_OFFER}`,
    `Dato de prueba: ${T.SUPPORT_DATA_OFF}`,
  ])
    expect(T.isSupportDataRefusalWithoutCapability(saved)).toBe(false)
})

// T-B43: la negativa es un texto fijo, nunca un dato. Una capacidad elige la suya por llave, y lo que no es una llave del conjunto
// (un `as`, un `any`, una llave del prototipo) da la genérica: nunca el valor que llegó.
it('a refusal key gives its fixed text; anything else gives the generic one, never the value received', () => {
  for (const [key, text] of Object.entries(T.SUPPORT_DATA_REFUSALS)) expect(T.supportDataRefusal(key)).toBe(text)
  for (const other of ['Club $876.54', 'NO_SUCH_REFUSAL', 'constructor', '__proto__', 'toString', '', null, undefined, 42, {}])
    expect(T.supportDataRefusal(other)).toBe(T.SUPPORT_DATA_REFUSALS.NOT_AVAILABLE)
})

// T-B44 (Codex b2-r2 #1): `as const` no congela en ejecución; una capacidad hacía `Object.assign(SUPPORT_DATA_REFUSALS, …)` y la
// negativa genérica salía con el nombre de la sucursal. Todo objeto o arreglo de texts.ts nace congelado: escribirle lanza.
it('the set of refusals and the notice are frozen: writing to them throws and changes nothing', () => {
  const generic = T.SUPPORT_DATA_REFUSALS.NOT_AVAILABLE
  const notice = T.SUPPORT_DATA_NOTICE.es
  expect(() => Object.assign(T.SUPPORT_DATA_REFUSALS, { NOT_AVAILABLE: 'Club $876.54' })).toThrow(TypeError)
  expect(() => Object.defineProperty(T.SUPPORT_DATA_REFUSALS, 'PARAM_DAY', { value: 'Club $876.54' })).toThrow(TypeError)
  expect(Reflect.deleteProperty(T.SUPPORT_DATA_REFUSALS, 'PARAM_DAY')).toBe(false)
  expect(Reflect.set(T.SUPPORT_DATA_REFUSALS, 'NOT_AVAILABLE', 'Club $876.54')).toBe(false)
  expect(() => Object.assign(T.SUPPORT_DATA_NOTICE, { es: 'Club $876.54' })).toThrow(TypeError)
  expect(T.SUPPORT_DATA_REFUSALS.NOT_AVAILABLE).toBe(generic)
  expect(T.SUPPORT_DATA_REFUSALS.PARAM_DAY).toBe('No te entendí el día. Escríbelo así: «¿entró un cobro de $850 hoy a las 14:30?».')
  expect(T.supportDataRefusal('NOT_AVAILABLE')).toBe(generic)
  expect(T.SUPPORT_DATA_NOTICE.es).toBe(notice)
  expect(Object.isFrozen(T.SUPPORT_DATA_REFUSALS) && Object.isFrozen(T.SUPPORT_DATA_NOTICE)).toBe(true)
})

it('the history mark of a capability that left the catalog has no label: never the key saved in the database', () =>
  expect(T.supportDataHistoryMark(null)).toBe('[respuesta con datos; no se muestran al asistente]'))
