import { Prisma } from '@prisma/client'
import { fmtTime } from '@/services/support/data/format'
import {
  amountsIn,
  dayBounds,
  lastDaysStart,
  matchAmount,
  timeWindows,
  wholeDayBounds,
  type TimeWindow,
} from '@/services/support/data/params'
import { venueDayKey } from '@/utils/venueDateKeys'

it.each([
  ['¿entró un cobro de $850 hoy a las 14:30?', '850', '850.00'],
  ['cobré $1,250 hace rato', '1250', '1250.00'],
  ['fueron 850 pesos', '$850.00', '850.00'],
  ['un cobro de 850.5', '850.5', '850.50'],
  ['850.50 exactos', '850.50', '850.50'],
  ['¿ya entró la 1,250?', '1250', '1250.00'], // «la 1» no es una hora si sigue «,250» (m5)
  ['cobré las 12,500', '12500', '12500.00'],
])('matches the amount however the person wrote it: «%s» / %s', (message, claimed, pesos) =>
  expect(matchAmount(message, claimed)?.toFixed(2)).toBe(pesos),
)
it.each([
  ['cobré 850', '900'], // la IA lo inventó (caso 30)
  ['cobré a las 2', '2'], // es una hora
  ['cobré 850.505', '850.505'], // tres decimales no es un monto
  ['cobré 99999999', '99999999'], // pasa del tope
  ['cobré 850', null],
  ['¿entró mi cobro?', '850'],
  ['cobré 0', '0'], // cero no es un monto (m6)
  ['cobré 0.00', '0.00'],
  ['mi número es 5512345678', '5512345678'], // un teléfono no es un monto
])('does not match: «%s» / %s', (message, claimed) => expect(matchAmount(message, claimed)).toBeNull())
// C7 r1: el número de algo (la mesa, el ticket, la orden…) no es un monto: «la venta de la mesa 5» no es un cobro de $5.00
it.each([
  ['¿Ya está facturada la venta de la mesa 5?', '5'],
  ['¿ya tiene factura el ticket 12?', '12'],
  ['¿Ya facturaron la Órden 34?', '34'],
  ['¿entró el pedido 56?', '56'],
  ['¿ya tiene factura el FOLIO 78?', '78'],
  ['¿cuánto entró en la caja 2?', '2'],
  ['¿entró en la terminal 3?', '3'],
  ['¿ya tiene factura la cuenta #9?', '9'],
  ['¿ya tiene factura la cuenta # 9?', '9'],
  ['¿ya tiene factura la venta No. 7?', '7'],
  ['¿ya tiene factura la venta no.7?', '7'],
  ['¿la MESA 1,250 ya pagó?', '1250'],
])('a number right after its word is the number of something, not an amount: «%s» / %s', (message, claimed) => {
  expect(amountsIn(message)).toEqual([])
  expect(matchAmount(message, claimed)).toBeNull()
})
// T-B49 (Codex bloque 3 r3): la regla de arriba nunca borra un número con marca de dinero («$» justo antes, «peso», «pesos» o «mxn»
// justo después); sigue borrando el número SUELTO tras la palabra. Ni a medias: «caja 1,250 pesos» no deja un «0» ni un «250» sueltos
it.each([
  ['¿Entraron a caja 850 pesos hoy?', '850', ['850.00']], // Codex r3: la IA acierta y antes de C7 contestaba
  ['¿Entró el cobro de ochocientos? No. 850 pesos, hoy.', '850', ['850.00']], // Codex r3: una corrección con «No.»
  ['¿entró en caja 850 MXN?', '850', ['850.00']],
  ['¿entró en caja 850 peso?', '850', ['850.00']],
  ['¿entraron a la caja 1,250 pesos?', '1250', ['1250.00']],
  ['¿entró en el ticket 850.50 pesos?', '850.50', ['850.50']],
  ['¿entró en la caja $850?', '850', ['850.00']], // el «$» justo antes: nunca fue una referencia
  ['$850 de la mesa 2', '850', ['850.00']], // la mesa sí se va, el monto se queda
  ['la mesa 5, un cobro de 850 pesos', '850', ['850.00']], // sólo el monto: el 5 de la mesa no
  ['850 MXN', '850', ['850.00']],
])('T-B49: a number with a money mark is always an amount: «%s» (claimed %s) → %j', (message, claimed, amounts) => {
  expect(amountsIn(message)).toEqual(amounts)
  expect(matchAmount(message, claimed)?.toFixed(2)).toBe(amounts[0])
})
it.each([
  ['mesa 5', '5'],
  ['caja 850', '850'], // costo aceptado (T-B49): sin «$» ni «pesos», el número tras «caja» es la caja
  ['¿entraron a caja 850?', '850'],
  ['cobro no. 850', '850'],
])('T-B49: a BARE number after its word is still not an amount: «%s»', (message, claimed) => {
  expect(amountsIn(message)).toEqual([])
  expect(matchAmount(message, claimed)).toBeNull()
})
it('the control: «un cobro de 5 en la mesa 3» is $5.00, and the 3 of the table is not an amount', () => {
  expect(amountsIn('un cobro de 5 en la mesa 3')).toEqual(['5.00'])
  expect(matchAmount('un cobro de 5 en la mesa 3', '5')?.toFixed(2)).toBe('5.00')
  expect(matchAmount('un cobro de 5 en la mesa 3', '3')).toBeNull()
  // la palabra sola, sin el número pegado, no quita nada: «mesas» o «cajas de 850» siguen siendo montos
  expect(amountsIn('cobré 850 de las mesas')).toEqual(['850.00'])
  expect(amountsIn('las cajas de 850 pesos')).toEqual(['850.00'])
})
it('the hour is not an amount', () => expect(amountsIn('¿entró un cobro de $850 hoy a las 14:30?')).toEqual(['850.00']))
it('«a las 2.30» is an hour, not an amount', () => expect(amountsIn('a las 2.30 cobré 300')).toEqual(['300.00']))
it.each([
  ['cobré 850 a las 2.30', ['850.00']],
  ['las 3 de 1,250', ['1250.00']],
  ['la de 12.50', ['12.50']],
  ['cobré $12,50', []], // coma decimal: no se adivina
  ['cobré 1.250,00', []],
  ['cobré 85 en la tarde', ['85.00']], // «en la tarde» sólo se vuelve «de la tarde» tras una hora (T-B36, M1)
  ['a las 2 de 12.50', ['12.50']],
  ['a las 2, no, 2,45', []], // O2: «H,MM» no es monto ni antes ni ahora
  ['cobré 850 a las 2 del día de hoy', ['850.00']], // T-B36c
])('amounts do not change with the day-part marks (T-B36): «%s» → %j', (message, amounts) => expect(amountsIn(message)).toEqual(amounts))

const TZ = 'America/Mexico_City',
  at = (hhmm: string) => ({ timezone: TZ, now: new Date(`2026-11-12T${hhmm}:00-06:00`) })
const shown = (w: TimeWindow[] | null, tz = TZ) => w?.map(x => `${fmtTime(x.from, tz)}-${fmtTime(x.to, tz)}`)
it.each([
  ['14:30', 'ayer a las 14:30', ['14:00-15:00']],
  ['a las 2', 'ayer a las 2', ['01:30-02:30', '13:30-14:30']],
  ['a las 2 de la tarde', 'ayer a las 2 de la tarde', ['13:30-14:30']],
  ['2 pm', 'como a las 2 pm', ['13:30-14:30']],
  ['a las 9 de la noche', 'a las 9 de la noche', ['20:30-21:30']],
  ['a las 12', 'a las 12', ['00:00-00:30', '11:30-12:30']],
  ['a las 2.30', 'a las 2.30', ['02:00-03:00', '14:00-15:00']], // minutos con punto, igual que «2:30»
  ['2:30', 'ayer 2:30', ['02:00-03:00', '14:00-15:00']],
  ['a la 1 de la noche', 'a la 1 de la noche', ['00:30-01:30']], // de 1 a 5, «de la noche» es de madrugada (m1)
  ['a las 8 de la noche', 'a las 8 de la noche', ['19:30-20:30']],
  ['12 del día', 'a las 12 del día', ['11:30-12:30']], // mediodía (m2)
  ['12 pm', 'a las 12 pm', ['11:30-12:30']],
  ['2pm', 'como a las 2 p.m.', ['13:30-14:30']], // am/pm y «hrs» con o sin espacio y puntos (m3)
  ['2 p.m.', 'a las 2pm', ['13:30-14:30']],
  ['14:30hrs', 'a las 14:30 hrs', ['14:00-15:00']],
  ['14:30 hrs', 'a las 14:30hrs', ['14:00-15:00']],
  ['a las 5 de la noche', 'a las 5 de la noche', ['04:30-05:30']], // el borde de «de la noche»: 5 de madrugada, 6 de la tarde
  ['a las 6 de la noche', 'a las 6 de la noche', ['17:30-18:30']],
  ['2:30', 'a las 2:30', ['02:00-03:00', '14:00-15:00']], // lo que ya funcionaba sigue igual (T-B32)
  ['a las 2', 'a las 2 en punto', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', '¿entró algo a las 2?', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', 'a las 2, de 850', ['01:30-02:30', '13:30-14:30']],
  // T-B32b: tras «y» o «con», una palabra de la lista fija no puede ser minutos ni otra hora
  ['a las 2', 'cobré 850 a las 2 y no aparece', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', '¿entró a las 2 y no lo veo?', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', 'a las 2 y todavía no entra', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', '¿entró un cobro a las 2 con tarjeta?', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', 'a las 2 con Visa', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', 'a las 2 con la terminal', ['01:30-02:30', '13:30-14:30']],
  // T-B36: lo que queda fuera de la hora no puede cambiarla; los montos y lo que no es número pasan
  ['a las 2', 'cobré 50 a las 2', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', 'un cobro de 85 a las 2', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', 'cobré 45 a las 2', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', 'a las 2 cobré 85', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', 'a las 2, de $45', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', 'cobré $20 a las 2', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', 'cobré 20 pesos a las 2', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', 'a las 2.', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', '¿entró a las 2?', ['01:30-02:30', '13:30-14:30']],
  ['a las 9 en la mañana', 'a las 9 en la mañana', ['08:30-09:30']], // «en/por la», «de esta» + mañana/tarde… = «de la …» (M1)
  ['a las 9 por la noche', 'a las 9 por la noche', ['20:30-21:30']],
  ['a las 9 de esta mañana', 'a las 9 de esta mañana', ['08:30-09:30']],
  // T-B36b: «H.MM» después de la hora niega; antes es un monto
  ['a las 2', 'cobré 12.50 a las 2', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', 'a las 2 de $12.50', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', 'a las 2, de 12.50 pesos', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', 'a las 2 cobré 85.50', ['01:30-02:30', '13:30-14:30']], // 85 no es una hora
  ['a las 2', 'a las 2 de 45 mxn', ['01:30-02:30', '13:30-14:30']], // marca de dinero «mxn»
  ['a las 2', 'ayer en la tarde a las 2', ['01:30-02:30', '13:30-14:30']], // O1: sin marca en la hora de la IA no aplica
  ['2 pm', '¿entró a las 2 pm?', ['13:30-14:30']],
  ['a las 2', '¿entró el cobro de una clienta a las 2?', ['01:30-02:30', '13:30-14:30']], // O4: «una» sola no es «una hora»
  // O3: la hora puede empezar al inicio, tras un espacio, «¿» o «(»
  ['a las 2', '¿a las 2 entró algo?', ['01:30-02:30', '13:30-14:30']],
  ['a las 2', 'el cobro (a las 2) no sale', ['01:30-02:30', '13:30-14:30']],
  ['2:30', '¿2:30?', ['02:00-03:00', '14:00-15:00']],
  ['14:30', '14:30 con tarjeta', ['14:00-15:00']],
  // T-B36c: «del día de hoy/ayer» es una fecha, no la marca del mediodía
  ['a las 2', '¿entró a las 2 del día de hoy?', ['01:30-02:30', '13:30-14:30']],
  ['las 2', 'el cobro de las 2 del día de ayer', ['01:30-02:30', '13:30-14:30']],
  ['a las 2 pm', '¿entró a las 2 pm del día de hoy?', ['13:30-14:30']],
  ['a las 12 del día', 'a las 12 del día', ['11:30-12:30']], // la hora de la IA no cambia: sigue siendo mediodía
])('yesterday, «%s» → %j', (time, message, windows) => expect(shown(timeWindows(time, message, 'yesterday', at('13:00')))).toEqual(windows))
it('a reading in the future is dropped: «a las 2» today at 13:00 keeps only the morning one', () =>
  expect(shown(timeWindows('a las 2', 'hoy a las 2', 'today', at('13:00')))).toEqual(['01:30-02:30']))
it('a window that reaches now is cut at now', () =>
  expect(shown(timeWindows('13:00', 'a las 13:00', 'today', at('13:10')))).toEqual(['12:30-13:10']))
it('both readings in the future → null: «a las 9» today at 08:00', () =>
  expect(timeWindows('a las 9', 'a las 9', 'today', at('08:00'))).toBeNull())
it.each([
  ['14:30', 'cobré 850'],
  ['25:00', 'a las 25:00'],
  ['a las 13 de la mañana', 'a las 13 de la mañana'],
  ['5', 'el cobro de 850 de la mesa 5'], // un número suelto no dice que sea una hora
  ['a las 1', 'a las 10'],
  ['2 pm', 'a las 12 pm'],
  ['2 pm', 'a las 12pm'], // los dígitos siguen siendo los que escribió
  ['a las 2', 'a las 2.30'], // la IA cortó la hora: la persona dijo 2:30
  ['a las 2', 'a las 2 y media'],
  ['a las 2', 'a las 2 y cuarto'],
  ['a las 2 y media', 'a las 2 y media'], // no se entiende «y media»
  ['14:75', 'a las 14:75'], // minutos de más de 59
  ['a las 12 de la noche', 'a las 12 de la noche'], // ¿la medianoche que empieza el día o la que lo termina? (m2)
  ['14.30', 'un cobro de 14.30'], // con punto y sin «las» puede ser un monto
  ['a la 1', '¿entró hasta la 1?'], // O3: «a la 1» no empieza dentro de «hasta la 1»
  ['a las 2', 'hasta las 2'],
  ['3 pm', 'a las 2,3 pm'],
  ['cuarenta para las 3', 'cuarenta para las 3'], // O5: la hora de la IA lleva una palabra de número
  ['cuarto para las 3', 'cuarto para las 3'],
])('an hour that is not in the message or is not an hour → null: %s', (time, message) =>
  expect(timeWindows(time, message, 'yesterday', at('13:00'))).toBeNull(),
)
it.each([
  // T-B32: lo que sigue a la hora dice que la persona escribió más (minutos, otra hora, «y/menos/con» o la marca de mañana o tarde)
  ['a las 2', 'a las 2 30'],
  ['a las 2', 'a las 2,30'],
  ['a las 2', 'a las 2y30'],
  ['a las 2', 'a las 2 y30'],
  ['a las 2', 'a las 2 y cuarenta'],
  ['a las 2', 'a las 2 y treinta'],
  ['a las 2', 'a las 2 con 30'],
  ['a las 2', 'a las 2 1/2'],
  ['a las 2', 'a las 2, y media'],
  ['a las 14', 'a las 14h30'],
  ['a las 2', 'a las 2 menos cuarto'],
  ['a las 2', 'a las 2 y 10'],
  ['a las 2', 'a las 2-3'],
  ['a las 2', 'a las 2 - 3'],
  ['a las 2', 'a las 2 o 3'],
  ['las 2', 'entre las 2 y las 3'],
  ['entre las 2', 'entre las 2 y las 3'],
  ['las 3', 'entre las 2 y las 3'], // la IA tomó el final del rango
  ['a las 3', 'de las 2 a las 3'],
  ['las 2', 'de las 2 a las 3'],
  ['desde las 2', 'desde las 2'], // sólo la niega el borde de rango dentro de la hora de la IA
  ['a las 2', 'a las 2 pm'],
  ['a las 2', 'a las 2am'],
  ['a las 2', 'a las 2 de la tarde'],
  ['a las 8', 'a las 8 de la noche'],
  ['2:30', 'a las 2:30 pm'],
  ['a las 2', 'a las 2 pm, o sea a las 2'], // basta una vez cortada
  // T-B32b: lo que no está en la lista se sigue negando
  ['a las 2', 'a las 2 y veinte'],
  ['a las 2', 'a las 2 y las 3'],
  ['a las 2', 'a las 2 con treinta'],
  ['a las 2', 'a las 2 con tarjta'], // un error de dedo se niega, no se adivina
  ['a las 2', 'a las 2 y no, a las 3'], // después de la palabra permitida viene otra hora
  // «del día» sólo es mediodía con 12; «12 de la mañana» se usa para el mediodía y para la medianoche
  ['a las 9 del día', 'a las 9 del día'],
  ['a las 9', 'a las 9 del día 11'],
  ['a las 9', 'a las 9 del día'], // la marca que la IA no copió (T-B36c: sigue siendo marca)
  ['12 de la mañana', 'a las 12 de la mañana'],
])('a cut-short time, a range or a dropped marker → null: «%s» in «%s»', (time, message) =>
  expect(timeWindows(time, message, 'yesterday', at('13:00'))).toBeNull(),
)
it.each([
  // T-B36: nada que pueda cambiar la hora puede quedar fuera de ella
  ['a las 2', 'a las 2 y no, 3'],
  ['a las 2', 'a las 2 y no, a las tres'],
  ['a las 2', 'a las 2 y no, y media'],
  ['a las 2', 'a las 2 y ya eran y media'],
  ['a las 2', 'a las 2 cuarenta'],
  ['a las 2', 'a las 2 quince'],
  ['3 pm', 'entre 2 y 3 pm'],
  ['3 pm', 'de 2 a 3 pm'],
  ['3 pm', '2-3 pm'],
  ['3 pm', '2 o 3 pm'],
  ['a las 3', 'de 2 a las 3'],
  ['a las 2', 'a las 2, no, 3'],
  ['a las 2', 'a las 2 o a la una'],
  ['a las 2', 'a las 2 o tipo 3'],
  ['a las 2', 'a las 2, no, 2 y media'],
  ['a las 2', 'a las 2 y no, al mediodía'],
  ['a las 2', 'a las 2 y no, más bien 3'],
  ['a las 2', 'a las 2 treinta y cinco'],
  ['a las 2', 'a las 2–3'], // raya
  ['a las 2', 'a las 2;30'],
  ['a las 14', 'a las 14hrs30'],
  ['las 2', 'después de las 2'], // R4: la hora es el borde de un rango
  ['las 2', 'desde las 2'],
  ['las 2', 'entre las 2 y que cerramos'], // sólo R4 la niega: no hay número ni palabra de más
  ['a las 9', 'a las 9 en la mañana'], // la marca que la IA no copió (M1)
  ['a las 2', 'a las 2, no, 2.30'], // T-B36b: «H.MM» después de la hora
  ['a las 2', 'a las 2, no, 14.30'],
  ['a las 2', 'a las 2, no, 2,45'], // O2: «H,MM» también
  ['a las 2', 'a las 2 y no, 2,45'],
  ['a las 2 de la mañana', 'a las 2 de la mañana, no, de la tarde'], // O1: otra marca fuera de la hora marcada
  ['a las 2 am', 'a las 2 am, no, pm'],
  ['a las 10 por la mañana', 'a las 10 por la mañana no, por la tarde'],
  ['a las 9 de la noche', 'a las 9 de la noche, digo, de la mañana'],
  ['a las 2', 'a las 2 y no, una hora después'], // O4: «una hora»
  ['a las 2', 'a las 2, como una hora más tarde'],
])('nothing left over may change the time (T-B36) → null: «%s» in «%s»', (time, message) =>
  expect(timeWindows(time, message, 'yesterday', at('13:00'))).toBeNull(),
)
it.each([
  ['a las 2', 'a las 2 con una tarjeta'],
  ['a las 2', 'a las 2 y luego otro'],
  // T-B36: un número chico sin marca de dinero o una palabra de número fuera de la hora también se niegan
  ['a las 2', 'mesa 5 a las 2'],
  ['a las 3', '2 personas pagaron a las 3'],
  ['a las 2', 'cobré 20 a las 2'],
  ['a las 2', 'a las 2 de 45'],
  ['a las 2', 'dos cobros a las 2'],
  ['a las 2', 'a las 2 en la terminal 3'],
  ['las 3', 'cuarto para las 3'],
  ['a las 2', 'abrí a las 9 y a las 2 cobré 850'], // otra hora en el mensaje (T-B32b)
  ['a las 2', 'a las 2 de 12.50'], // T-B36b: un monto con centavos después de la hora parece «H.MM»
  ['2 pm', 'ayer en la tarde, a las 2 pm'], // O1: con la hora marcada, otra marca fuera de ella niega aunque coincida
])('accepted cost: «%s» in «%s» answers «No te entendí la hora» and the person rephrases', (time, message) =>
  expect(timeWindows(time, message, 'yesterday', at('13:00'))).toBeNull(),
)
// T-B48 (Codex bloque 3 r1 y r2): `timeWindows` no excusa el monto. Un monto chico sin «$» junto a una hora niega, como en T-B36: la IA
// puede haber tomado por monto la hora corregida. Con «$» contesta. `matchAmount` sí acepta el monto en todos (está en el mensaje).
const BOTH = ['01:30-02:30', '13:30-14:30']
it.each([
  ['a las 2', 'cobro de 20 a las 2', '20'], // T-B48: costo aceptado, un monto chico sin «$» antes de la hora pide reformular
  ['a las 2', 'a las 2 un cobro de 20', '20'], // T-B48: costo aceptado, también después de la hora
  ['a las 14:30', 'de 5 como a las 14:30', '5'], // T-B48: costo aceptado
  ['a las 2', 'cobro de 2 a las 2', '2'], // T-B48: costo aceptado, el monto y la hora con el mismo número
  // Codex bloque 3 r1: la IA tomó por monto el 3 que corrige la hora
  ['a las 2', 'cobré 850 a las 2, no, 3', '3'],
  ['a las 2', 'cobré 850 a las 2, perdón, 3', '3'],
  ['a las 2', '850 a las 2 digo 3', '3'],
  ['a las 2', 'un cobro a las 2, bueno, 3', '3'],
  ['a las 2', 'un cobro a las 2 quise decir 3', '3'],
  // Codex bloque 3 r2: «mil» no es un monto que `amountsIn` lea, y la IA tomó por monto la hora descartada
  ['a las 2', '¿Entró el cobro de mil? Fue tipo 3, no, a las 2.', '3'],
])('T-B48: a small amount without «$» next to the time → null: «%s» in «%s» (amount %s)', (time, message, claimed) => {
  expect(matchAmount(message, claimed)?.toFixed(2)).toBe(new Prisma.Decimal(claimed).toFixed(2))
  expect(timeWindows(time, message, 'yesterday', at('13:00'))).toBeNull()
})
it.each([
  ['a las 2', 'cobro de $20 a las 2', '20', BOTH],
  ['a las 2', 'a las 2 un cobro de $20', '20', BOTH],
  ['a las 14:30', 'de $5 como a las 14:30', '5', ['14:00-15:00']],
  ['a las 2', 'cobro de $2 a las 2', '2', BOTH],
])('T-B48: the «$» twin answers: «%s» in «%s» (amount %s) → %j', (time, message, claimed, windows) => {
  expect(matchAmount(message, claimed)?.toFixed(2)).toBe(new Prisma.Decimal(claimed).toFixed(2))
  expect(shown(timeWindows(time, message, 'yesterday', at('13:00')))).toEqual(windows)
})
it('no hour → the whole day: today until now, yesterday complete', () => {
  expect(shown(timeWindows(null, 'un cobro de 850', 'today', at('13:00')))).toEqual(['00:00-13:00'])
  expect(shown(timeWindows(null, 'un cobro de 850 ayer', 'yesterday', at('13:00')))).toEqual(['00:00-23:59'])
  expect(shown(timeWindows('', 'un cobro de 850', 'today', at('13:00')))).toEqual(['00:00-13:00'])
  expect(shown(timeWindows('   ', 'un cobro de 850', 'today', at('13:00')))).toEqual(['00:00-13:00']) // m4
})
it('Cancún: yesterday is the calendar day of that venue', () => {
  const w = dayBounds('yesterday', { timezone: 'America/Cancun', now: new Date('2026-11-12T05:30:00Z') }) // 00:30 del 12 en Cancún
  expect([venueDayKey(w.from, 'America/Cancun'), venueDayKey(w.to, 'America/Cancun')]).toEqual(['2026-11-11', '2026-11-11'])
})

it('a day when the clocks change: Tijuana lasts 25 h on 1-nov-2026 and 23 h on 8-mar-2026', () => {
  const tz = 'America/Tijuana'
  const iso = (w: TimeWindow) => [w.from.toISOString(), w.to.toISOString()]
  expect(iso(dayBounds('yesterday', { timezone: tz, now: new Date('2026-11-02T18:00:00Z') }))).toEqual([
    '2026-11-01T07:00:00.000Z',
    '2026-11-02T07:59:59.999Z',
  ])
  expect(iso(dayBounds('yesterday', { timezone: tz, now: new Date('2026-03-09T18:00:00Z') }))).toEqual([
    '2026-03-08T08:00:00.000Z',
    '2026-03-09T06:59:59.999Z',
  ])
  const after = timeWindows('14:30', 'ayer a las 14:30', 'yesterday', { timezone: tz, now: new Date('2026-11-02T18:00:00Z') })
  expect(shown(after, tz)).toEqual(['14:00-15:00'])
  expect(after?.[0].from.toISOString()).toBe('2026-11-01T22:00:00.000Z') // 14:00 ya en hora de invierno (UTC−8)
})

// C1: el día calendario ENTERO de la sucursal, escrito como texto (nunca la zona del proceso, D19). Este archivo se corre también con
// TZ=UTC, America/Havana, America/Mexico_City y America/Tijuana delante de jest: un `process.env.TZ` dentro de la prueba no llega al proceso.
describe('wholeDayBounds', () => {
  const iso = (w: TimeWindow) => [w.from.toISOString(), w.to.toISOString()]
  it('wholeDayBounds: today and yesterday are whole calendar days of the venue, in Cancún and in Mexico City, and 25 h in Tijuana on 1-nov-2026', () => {
    // 14:32 del jueves 12-nov en la CDMX (UTC−6 todo el año)
    const cdmx = { timezone: 'America/Mexico_City', now: new Date('2026-11-12T20:32:00Z') }
    expect(iso(wholeDayBounds('today', cdmx))).toEqual(['2026-11-12T06:00:00.000Z', '2026-11-13T05:59:59.999Z'])
    expect(iso(wholeDayBounds('yesterday', cdmx))).toEqual(['2026-11-11T06:00:00.000Z', '2026-11-12T05:59:59.999Z'])
    // 05:30Z: en Cancún (UTC−5) ya son las 00:30 del 12; en la CDMX todavía son las 23:30 del 11
    const at = new Date('2026-11-12T05:30:00Z')
    expect(iso(wholeDayBounds('today', { timezone: 'America/Cancun', now: at }))).toEqual([
      '2026-11-12T05:00:00.000Z',
      '2026-11-13T04:59:59.999Z',
    ])
    expect(iso(wholeDayBounds('yesterday', { timezone: 'America/Cancun', now: at }))).toEqual([
      '2026-11-11T05:00:00.000Z',
      '2026-11-12T04:59:59.999Z',
    ])
    expect(iso(wholeDayBounds('today', { timezone: 'America/Mexico_City', now: at }))).toEqual([
      '2026-11-11T06:00:00.000Z',
      '2026-11-12T05:59:59.999Z',
    ])
    // Tijuana atrasa el reloj el domingo 1-nov-2026: ese día dura 25 h (00:00 PDT, UTC−7, a 23:59:59.999 PST, UTC−8)
    const tijuana = { timezone: 'America/Tijuana', now: new Date('2026-11-01T20:00:00Z') }
    const sunday = wholeDayBounds('today', tijuana)
    expect(iso(sunday)).toEqual(['2026-11-01T07:00:00.000Z', '2026-11-02T07:59:59.999Z'])
    expect(sunday.to.getTime() + 1 - sunday.from.getTime()).toBe(25 * 3_600_000)
    expect(iso(wholeDayBounds('yesterday', { timezone: 'America/Tijuana', now: new Date('2026-11-02T18:00:00Z') }))).toEqual(iso(sunday))
  })
  it('wholeDayBounds today is 23 h in Tijuana on 8-mar-2026, when the clocks go forward', () => {
    // 00:00 PST (UTC−8) a 23:59:59.999 PDT (UTC−7)
    const sunday = wholeDayBounds('today', { timezone: 'America/Tijuana', now: new Date('2026-03-08T20:00:00Z') })
    expect(iso(sunday)).toEqual(['2026-03-08T08:00:00.000Z', '2026-03-09T06:59:59.999Z'])
    expect(sunday.to.getTime() + 1 - sunday.from.getTime()).toBe(23 * 3_600_000)
  })
  it('dayBounds keeps its from and ends today at now', () => {
    for (const clock of [
      { timezone: 'America/Mexico_City', now: new Date('2026-11-12T20:32:00Z') },
      { timezone: 'America/Cancun', now: new Date('2026-11-12T05:30:00Z') },
      { timezone: 'America/Tijuana', now: new Date('2026-11-01T20:00:00Z') },
    ]) {
      expect(dayBounds('today', clock)).toEqual({ from: wholeDayBounds('today', clock).from, to: clock.now })
      expect(dayBounds('yesterday', clock)).toEqual(wholeDayBounds('yesterday', clock))
    }
  })
})

describe('lastDaysStart', () => {
  it('the last 7 calendar days of the venue, today included: from 00:00 six days back (the «Últimos 7 días» of the panel), in CDMX and Cancún', () => {
    // 14:32 del jueves 12-nov en la CDMX: del viernes 6-nov a las 00:00
    const cdmx = { timezone: 'America/Mexico_City', now: new Date('2026-11-12T20:32:00Z') }
    expect(lastDaysStart(7, cdmx).toISOString()).toBe('2026-11-06T06:00:00.000Z')
    expect(lastDaysStart(1, cdmx)).toEqual(wholeDayBounds('today', cdmx).from)
    expect(lastDaysStart(2, cdmx)).toEqual(wholeDayBounds('yesterday', cdmx).from)
    // 05:30Z: en Cancún ya es el 12 (del 6-nov), en la CDMX todavía el 11 (del 5-nov)
    const at = new Date('2026-11-12T05:30:00Z')
    expect(lastDaysStart(7, { timezone: 'America/Cancun', now: at }).toISOString()).toBe('2026-11-06T05:00:00.000Z')
    expect(lastDaysStart(7, { timezone: 'America/Mexico_City', now: at }).toISOString()).toBe('2026-11-05T06:00:00.000Z')
  })
  it('across the night Tijuana turns its clock back (1-nov-2026): the first day starts at its own 00:00 PDT, not 7 × 24 h back', () => {
    // martes 3-nov 10:00 PST (UTC−8) → miércoles 28-oct a las 00:00 PDT (UTC−7)
    const tijuana = { timezone: 'America/Tijuana', now: new Date('2026-11-03T18:00:00Z') }
    expect(lastDaysStart(7, tijuana).toISOString()).toBe('2026-10-28T07:00:00.000Z')
    expect(venueDayKey(lastDaysStart(7, tijuana), 'America/Tijuana')).toBe('2026-10-28')
  })
  it('on the 23-hour day (Tijuana, 8-mar-2026, the clock goes forward): the first day starts at its 00:00 PST, not 24 h multiples back', () => {
    // el mismo domingo, a las 13:00 PDT: el día empezó a las 00:00 PST (UTC−8)
    const sunday = { timezone: 'America/Tijuana', now: new Date('2026-03-08T20:00:00Z') }
    expect(lastDaysStart(1, sunday).toISOString()).toBe('2026-03-08T08:00:00.000Z')
    expect(lastDaysStart(1, sunday)).toEqual(wholeDayBounds('today', sunday).from)
    // lunes 9-mar a las 12:00 PDT: los últimos 2 días empiezan el domingo a las 00:00 PST; 48 h atrás caería en el sábado 7
    const monday = { timezone: 'America/Tijuana', now: new Date('2026-03-09T19:00:00Z') }
    expect(lastDaysStart(2, monday).toISOString()).toBe('2026-03-08T08:00:00.000Z')
    expect(venueDayKey(new Date(monday.now.getTime() - 2 * 86_400_000), 'America/Tijuana')).toBe('2026-03-07')
    // sábado 14-mar a las 13:00 PDT: los últimos 7 días también empiezan el domingo 8 a las 00:00 PST
    expect(lastDaysStart(7, { timezone: 'America/Tijuana', now: new Date('2026-03-14T20:00:00Z') }).toISOString()).toBe(
      '2026-03-08T08:00:00.000Z',
    )
  })
})
