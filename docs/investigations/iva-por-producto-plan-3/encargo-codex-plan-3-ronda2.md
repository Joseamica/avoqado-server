# Auditoría del PLAN 3 v2 — IVA por producto (ronda 2)

IMPORTANT: READ-ONLY. No edites, crees ni borres archivos. No te conectes a bases. No corras pruebas. Responde en ESPAÑOL.

## Cómo quiero que respondas (instrucción del founder, igual que la ronda 1)

**Sé franco y directo. Nada de sobre-ingeniería.** El founder quiere la facturación BIEN hecha, no un sistema más grande de lo
necesario.

- Un P1 exige un **escenario concreto** (entradas → factura o dinero mal, o algo que se pierde). Sin escenario, no es P1.
- **Reporta también lo que SOBRA**, incluido lo que YO agregué en esta v2 para cerrar tus hallazgos: si algún cierre es más grande
  de lo que el escenario pide, dilo.
- No propongas mecanismo nuevo salvo que cierre un escenario concreto que sin él falla.
- Si un cierre está bien, dilo en una línea. Máximo ~8 hallazgos, por gravedad.

## Qué cambió

Tu informe de la ronda 1 (RECHAZO, 6 P1 + 2 P2): `docs/investigations/iva-por-producto-plan-3/informe-codex-plan-3.md`.
El plan v2 (mismo archivo, commit más reciente de la rama `iva-por-producto`):
`docs/superpowers/plans/2026-09-26-iva-por-producto-plan-3-facturacion.md`. El diff contra la v1: `git show HEAD -- <plan>`.

Cómo intenté cerrar cada uno:
1. **Respuesta tardía** → recapturar sólo con rechazo definitivo del PAC (`Cfdi.falloDefinitivo`) o búsqueda negativa + 10 min desde
   `Cfdi.enviadoAt`; versión = `Cfdi.attempts` con CAS en toda escritura; versión vieja con documento ⇒ no pisa, alerta
   `CFDI_TIMBRE_DUPLICADO`; el finalizador no revive cancelaciones (Global Constraints, Tareas 6 y 7).
2. **Egreso con IVA del catálogo** → reparto al 16 % de la original (B+ sólo admite originales todo-16) (Tarea 11).
3. **Carrera global ↔ individual** → la global bloquea las órdenes `FOR UPDATE` en orden estable y relee elegibilidad; el motivo de
   `excluirSiEstaEnGlobal` se consume (409 sin fila ni sellos) (Tareas 6 y 10).
4. **Reintentos de global y egreso** → mismas reglas que la individual (Tareas 10 y 11).
5. **Recuperación por RFC + total** → sólo para filas viejas (`protocoloIva IS NULL`); las nuevas, sólo por identidad (Tareas 6 y 7).
6. **Delivery** → condición de encendido del plan 6 (se niega el encendido con motivo visible si hay delivery activo) («Qué NO entra»).
7. **Entrada inventada** → documento viejo sin entrada se finaliza con `entrada = NULL`, sin sellos.
8. **Motivo del egreso** → el controlador lo mapea a 409; prueba por la ruta real.
Además: quité el enum de causas (queda la tabla renglón ↔ CFDI con `intento Int`); la entrada guarda los parámetros ya resueltos
(`params`) + `montos` + `renglones` + `replacesCfdiId`; golden de montos guardados, motivos y orden con `taxAmount > 0`; CAS nuevo en
la cancelación directa; sonda del `idempotency_key` de Facturapi en sandbox (sin cambiar la regla de recaptura).

## Preguntas

1. ¿Queda algún escenario en que se timbre con el IVA equivocado, por un importe distinto de lo cobrado, o dos documentos por la
   misma venta?
2. ¿Los 10 minutos de ventana y la distinción «rechazo definitivo vs timeout» son suficientes y verificables con el adaptador actual
   (`src/services/fiscal/providers/facturapi.provider.ts`)? ¿Cómo distingue hoy el adaptador un rechazo de un timeout?
3. ¿Algún cierre de la v2 es más grande de lo necesario?

## Formato

1. Primera línea: **AUTORIZO el plan 3** (con condiciones concretas) o **RECHAZO** (lista mínima).
2. Hallazgos P1 / P2 / P3 con archivo:línea y escenario.
3. «Lo que sobra».
4. Cierre de 3 líneas en lenguaje llano para el founder.
