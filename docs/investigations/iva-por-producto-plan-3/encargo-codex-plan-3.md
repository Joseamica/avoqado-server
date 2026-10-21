# Auditoría del PLAN 3 — IVA por producto: la factura con IVA por producto (opción B+)

IMPORTANT: READ-ONLY. No edites, crees ni borres archivos. No te conectes a bases. No corras pruebas. Responde en ESPAÑOL.

## Cómo quiero que respondas (instrucción del founder)

**Sé franco y directo. Nada de sobre-ingeniería.** El founder no quiere un sistema más grande de lo necesario; quiere que la
facturación quede BIEN hecha, no que tenga todo lo imaginable. Por eso:

- Un hallazgo P1 exige un **escenario concreto** (entradas → qué factura o qué dinero sale mal, o qué se pierde). Si no puedes
  escribir el escenario, no es P1.
- **También reporta lo que SOBRA:** piezas del plan que se pueden quitar o simplificar sin perder una garantía real. Eso vale
  tanto como un hueco.
- No propongas mecanismo nuevo (tablas, candados, jobs, estados) salvo que cierre un escenario concreto que sin él falla.
- Si algo del plan está bien, dilo en una línea y sigue. No repitas el plan.
- Máximo ~10 hallazgos en total. Ordena por gravedad.

## Contexto

Repo: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto` (rama `iva-por-producto`,
trae `develop` al 25-sep). Planes 1 y 2 del proyecto ya están construidos en esta rama:
- Plan 1: `Product.ivaTratamiento` (IVA_16, IVA_8, IVA_0, EXENTO, NO_OBJETO, BLOQUEADO_03, BLOQUEADO_04) con triggers de barrera:
  mientras la bandera por negocio `VenueIvaPorProducto` esté apagada (hoy para todos), ningún producto puede ser ≠ IVA_16.
- Plan 2: `Order.contratoDePrecio` (IVA_INCLUIDO / IVA_APARTE / DESCONOCIDO), declarado por los 23 escritores de órdenes, y la
  confirmación histórica `confirmarContratoIvaIncluido` (candado por versión + ActivityLog, MCP `confirm_order_price_contract`).

Diseño autorizado por ti en la ronda 6 (`/Users/amieva/Documents/Programming/Avoqado/docs/superpowers/plans/2026-09-24-iva-por-producto.md`,
secciones v4, v5, v6 y «Ronda 6»; tu informe: `/Users/amieva/Documents/Programming/Avoqado/docs/auditorias/2026-09-24-auditoria-codex-iva-por-producto-ronda6.md`).

**Recorte decidido por el founder el 26-sep («opción B+»)**, con estos datos medidos en producción (sólo lectura):
- Facturas individuales: 23 en toda la historia (19 vigentes, 3 canceladas, 1 bloqueada). Globales: **0**. Notas de crédito: **0**.
  Comercios con la global encendida: **0**. Pagos de delivery con desglose fiscal: **0**.
- Ventas con `taxAmount` negativo (motor de descuentos viejo): **0**. Ventas de Testarudo con `taxAmount > 0`: 31,256, todas de
  antes del 12-ago (puente SoftRestaurant); desde entonces 5,514 con IVA 0.
- Investigación de mercado (`docs/investigations/iva-por-producto-plan-3/investigacion-facturacion-*.md`): Alegra factura desde los
  datos CONGELADOS del ticket; Parrot, Alegra y eleventa impiden que un ticket esté en la global y en una factura propia; nadie
  documenta notas de crédito calculadas contra la factura original; la comida de delivery se factura como venta normal.

Por eso B+: factura individual completa (sello + entrada congelada), exclusión global ↔ individual en los dos sentidos, y la global
y la nota de crédito **bloquean con motivo** las ventas con IVA ≠ 16 %. Delivery y reportes quedan fuera (plan 4); los escritores de
renglones con candado de orden (tu condición 2 de la ronda 6) van en un plan 3b antes del encendido.

## Qué revisar

**El plan:** `docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md` (12 tareas). Mapas del código actual que usé
para escribirlo: `docs/investigations/iva-por-producto-plan-3/plan3-mapa-{A-individual,B-global-egreso-delivery,C-escritores-de-renglones}.md`.
Verifica contra el CÓDIGO (archivo:línea), no contra los mapas.

Preguntas concretas:
1. **¿Algún escenario en que este plan timbre una factura con el IVA equivocado, o por un importe distinto de lo cobrado?**
   Incluye reintentos, timbrados tardíos, sustitución, cancelación y la exclusión con la global.
2. **La rama todo-16 debe quedar byte a byte igual a hoy.** ¿Hay alguna tarea que la cambie sin querer (payload, montos guardados,
   motivos, `objetoImp`)?
3. **Ciclo de vida del intento (tareas 6, 7, 8):** reservar y sellar en una transacción, recapturar la entrada sólo cuando el PAC
   confirma que no hay documento, re-sellar en el finalizador, liberar al confirmarse la cancelación. ¿Cierra tu condición 1 de la
   ronda 6 sin mecanismo de más? ¿Sobra algo (p. ej. la tabla de causas de sello, dado que en B+ sólo hay dos causas)?
4. **¿B+ deja algún hueco que haga la facturación incorrecta** (no «incompleta»)? En particular: órdenes con IVA mixto fuera de la
   global; notas de crédito bloqueadas; delivery sin cambios.
5. **¿Qué quitarías o simplificarías** sin perder una garantía real?
6. ¿El orden de las tareas y sus pruebas (golden de la rama todo-16, sandbox real de Facturapi) bastan para confiar en el resultado?

## Formato

1. Veredicto en la primera línea: **AUTORIZO el plan 3** (con condiciones concretas) o **RECHAZO** (con la lista mínima).
2. Hallazgos P1 / P2 / P3, cada uno con archivo:línea y escenario (máximo ~10).
3. «Lo que sobra»: lista corta de lo que quitarías, con por qué.
4. Cierre de 3 líneas en lenguaje llano para el founder.
