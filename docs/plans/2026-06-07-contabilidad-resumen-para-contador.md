# Avoqado — Módulo de Contabilidad: resumen para revisión del contador

**Para:** el contador (y dueño de negocio) que va a revisar y aprobar el enfoque. **De:** Avoqado (plataforma de POS + pagos + facturación
CFDI para comercios en México). **Fecha:** 2026-06-07 · **Estatus:** diseño para aprobación (aún no construido).

> **Qué te pedimos:** que leas esto con ojo de contador, nos digas si el **enfoque fiscal es correcto**, qué **ajustarías**, y nos des tu
> **visto bueno** (o tus correcciones) en los puntos marcados "🔵 Necesitamos tu opinión".

---

## 1. El concepto en una frase

Avoqado ya es el **punto de venta, el cobro y la facturación (CFDI)** del comercio. Eso significa que **ya tiene de origen** los datos que
un sistema contable normalmente tiene que _importar o capturar a mano_: ventas, cobros, costos, comisiones y facturas. La idea es usar esos
datos para llevar la contabilidad **automáticamente y correcta desde el origen** — que el dueño vea cómo va su negocio, y que tú (su
contador) tengas los libros y reportes formales sin recapturar nada.

## 2. Son DOS contabilidades, no una

Esta es la decisión de diseño más importante. Las separamos a propósito:

|               | **Capa A — Gerencial**                 | **Capa B — Fiscal**                                                 |
| ------------- | -------------------------------------- | ------------------------------------------------------------------- |
| ¿Para quién?  | El **dueño** ("¿cómo voy este mes?")   | **Tú (el contador) y el SAT**                                       |
| ¿Qué muestra? | TODAS las ventas, incluido el efectivo | Solo lo que se factura/declara                                      |
| ¿Obligatorio? | Siempre visible                        | **Opcional** (se prende solo si el comercio quiere libros formales) |
| Tecnología    | Tablero de reportes                    | **Libros de doble partida** (contabilidad formal)                   |

La **Capa A** es un tablero para el dueño (utilidad, márgenes, gastos). La **Capa B** es la contabilidad formal de verdad: catálogo de
cuentas, pólizas, balanza, y la contabilidad electrónica del SAT. Tú trabajas con la Capa B.

## 3. Cómo cumple con el SAT (la Capa B — lo que más te importa)

Todo esto está **verificado contra el Anexo 24 de la RMF 2026 (DOF 13-ene-2026)** y los esquemas XSD vigentes (v1.3):

- **Contabilidad electrónica completa:**
  - **Catálogo de cuentas** con el **código agrupador del SAT** por cada cuenta (campo obligatorio). Pensamos traer un catálogo base por
    giro (restaurante, retail, etc.) ya mapeado al agrupador, que tú puedas **ajustar o importar el tuyo**.
  - **Balanza de comprobación mensual** en XML (con `SaldoInicial, Debe, Haber, SaldoFinal` por cuenta).
  - **Pólizas** en XML **solo a solicitud** (auditoría, devolución, compensación) — no mensuales, como marca la regla.
- **Doble partida real:** cada póliza cuadra (Σ Debe = Σ Haber) — es una regla dura del sistema, no puede postear algo descuadrado.
- **IVA en flujo de efectivo:** el IVA se reconoce **cuando se cobra/paga efectivamente** (Arts. 11, 17 y 1o-B LIVA), no al facturar.
  Manejamos cuentas puente de _IVA trasladado cobrado vs. no cobrado_ y _IVA acreditable pagado vs. pendiente_.
- **DIOT:** reporte mensual de operaciones con proveedores, con IVA desglosado por tasa y por RFC del tercero.
- **REP (complemento de pago)** para pagos en parcialidades/diferidos (PPD).
- **El CFDI es el respaldo:** cada ingreso y gasto deducible se liga a su **UUID de CFDI** (el comprobante timbrado), como exige la
  contabilidad electrónica.
- **Régimen fiscal:** el sistema **sabe el régimen** de cada contribuyente y ajusta las obligaciones. Importante: **RESICO (PF y PM),
  Arrendamiento, Servicios Profesionales y RIF están relevados del _envío_ mensual** de contabilidad electrónica — para esos solo llevamos
  los libros internos; el envío XML aplica a régimen general (PM 601 y mayores).
- **Saldos iniciales:** captura de saldos de apertura por cuenta (para comercios que ya operan) → genera el asiento de apertura fechado.
- **Cierre de periodo** y control de periodos (bloqueo).

## 4. El motor: "el sistema lleva los libros, tú los revisas"

La pieza clave es un **mapeo de cuentas** (qué cuenta usa cada tipo de movimiento: ventas → cuenta de ingresos, IVA → su cuenta, costo de
ventas, gastos, comisiones, etc.). Se configura una vez (con valores recomendados), y de ahí **cada póliza se genera sola** leyendo ese
mapeo. La diferencia con otros sistemas: como Avoqado **genera** los CFDI (no los importa del SAT), el posteo es **correcto desde el
origen** — tú **revisas y apruebas**, no recapturas.

Para varios negocios/sucursales de un mismo dueño:

- Si comparten **un solo RFC** → un solo juego de libros, **rebanado por sucursal** (centro de costos).
- Si son **RFCs distintos** → libros separados por contribuyente, con vista **consolidada** para el dueño.

## 5. Reportes que genera

Estado de resultados · Estado de situación financiera (balance) · **Balanza de comprobación** · Libro diario · Auxiliares (por cuenta y por
tercero) · Flujo de caja · **Reporte DIOT** · Reporte de impuestos y retenciones.

## 6. Lo que NO hace (por ahora — para que sepas los límites)

- **Nómina** (CFDI de nómina, IMSS, ISR retenido, subsidio) — **no incluido** en esta etapa. _(Nota: el competidor principal, Alegra,
  tampoco trae nómina en su producto de contabilidad en México.)_
- **Declaraciones de ISR** (pagos provisionales, coeficiente de utilidad, anual) — no incluido aún; queremos tu opinión sobre la prioridad.
- **Reexpresión por inflación (NIF B-10)** y temas avanzados de NIF — no incluido aún.
- **Conexión directa a bancos** — en lugar de eso, la conciliación se hará **subiendo el estado de cuenta (PDF/CSV)**, que es más simple y
  suficiente.

## 7. 🔵 Necesitamos tu opinión profesional (los puntos de aprobación)

1. **Tratamiento del IVA (el más importante).** Partimos de que en México **el precio al público ya incluye el IVA**: si el menú dice $100,
   el cliente paga $100 y ese monto ya trae el 16% adentro → **neto = $100 / 1.16 = $86.21**, **IVA trasladado = $13.79**.
   - ¿Confirmas que ese es el tratamiento correcto para este tipo de comercios?
   - _(Aparte: detectamos que la facturación actual podría estar **sumando** el 16% encima del precio en lugar de tratarlo como incluido. Lo
     estamos verificando contra facturas reales — tu opinión nos ayuda a confirmar cuál es lo correcto para que la factura cuadre
     exactamente con lo que el cliente pagó.)_
2. **Catálogo de cuentas base.** ¿Te parece bien partir de un catálogo estándar por giro, ya mapeado al código agrupador, que tú puedas
   ajustar/importar? ¿O prefieres siempre cargar el tuyo?
3. **Efectivo hacia el SAT.** El dueño decide, por canal de cobro, si el efectivo entra o no a los libros fiscales (toggle). ¿Te parece
   correcto manejarlo así?
4. **Reconocimiento por flujo de efectivo** (ingreso/IVA al cobrar, no al facturar). ¿De acuerdo, dado que es lo que exige la LIVA para
   estos contribuyentes?
5. **Prioridades.** De lo que NO está incluido (nómina, ISR, NIF inflación), ¿qué consideras indispensable y qué puede esperar?

## 8. Cómo lo construiríamos (alto nivel, por fases)

1. **Fase 1 — Tablero del dueño** ("¿cuánto gané?"): ingreso − costo − gastos, márgenes. Rápido, sobre datos que ya existen.
2. **Fase 2 — Gastos y proveedores:** captura de gastos + CFDI recibidos, cuentas por pagar, datos para DIOT.
3. **Fase 3 — Contabilidad formal:** libros de doble partida, catálogo, balanza y contabilidad electrónica del SAT, saldos iniciales, cierre
   de periodo.
4. **Fase 4 — (a evaluar) Nómina**, según demanda.

## 9. En resumen

Avoqado quiere ser el **sistema de registro** del comercio (lleva los libros correctos desde el origen) y dejarte a ti, el contador, en el
rol de **revisar, ajustar y aprobar** — no de recapturar. Queremos que el enfoque fiscal sea **correcto y aprobado por un profesional antes
de construir**.

**Tu visto bueno:** ¿apruebas el enfoque? ¿Qué corregirías? ¿Cuáles de los puntos 🔵 te preocupan o cambiarías?

Gracias por tu tiempo y tu criterio.
