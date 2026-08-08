# Endurecimiento de crons contra estampidas del pool

**Fecha:** 2026-08-07  
**Estado:** aprobado por el founder  
**Origen:** P1001 y P2024 observados a las 03:06; el P2024 del watchdog falló correctamente sin reintento.

## Corrección al diagnóstico original

Marketing (`:05`), recordatorios (`:20`), auto no-show (`:35`) y monitor POS (minuto `:01/:06/...`) no comienzan juntos a `:25`. Los tres primeros ya estaban escalonados. No se cambiarán por este hallazgo.

La convergencia real ocurre porque watchdog de pagos, reconciliación Blumon y sweepers de Google Calendar arrancan simultáneamente a los segundos `:00` y `:30`. En ciertos minutos también comienzan TPV Health y POS Connection Monitor en el segundo cero.

Seis arranques no demuestran por sí solos la causa raíz de un pool de 18 conexiones, pero sí son un detonador evitable y el patrón P2024 ya ha reincidido.

## Decisiones

### Desfasar, sin reducir frecuencia

Los trabajos conservarán su cadencia y sus ventanas de negocio. Sólo cambia la fase dentro del minuto. Los offsets deben ser distintos entre sí y evitar los segundos ocupados por trabajos existentes (`:05`, `:20`, `:35`, `:45`).

Los patrones se centralizarán en un módulo pequeño para que una prueba pueda expandir diez minutos de cron y comprobar dos propiedades:

1. ningún trabajo de este grupo comienza en el mismo segundo que otro;
2. cada trabajo conserva la cantidad de ejecuciones esperada por intervalo.

### No solapar una segunda pasada

Watchdog de pagos, reconciliación Blumon, TPV Health y POS Connection Monitor tendrán guardas locales `isRunning`. Inbox y outbox de Google Calendar ya las tienen.

Si llega un tick mientras la pasada anterior sigue viva, el tick nuevo se omite y se registra. No se cancela la pasada actual. La guarda se libera en `finally`.

La omisión es segura porque:

- watchdog prioriza mantener el candado antes que arriesgar doble cobro;
- Blumon y Google Calendar trabajan sobre filas durables pendientes;
- TPV/POS sólo retrasan una actualización de estado hasta el siguiente tick.

### Política de reintentos

No se modifica `shouldRetryDbConnectionError`:

- P2024 no se reintenta: añadir trabajo a un pool agotado agrava la cola.
- P1001 puede reintentarse sólo en lecturas u operaciones idempotentes ya protegidas.
- No se introducen reintentos generales de pagos o escrituras ambiguas.

## Observabilidad

Una pasada omitida por solapamiento debe dejar un warn con nombre de job. Las pasadas con trabajo o lentas deben informar duración y filas cuando el servicio ya exponga esos conteos; no se generará un log exitoso cada 30 segundos cuando no haya trabajo.

## Criterios de aceptación

1. Los seis trabajos relevantes no comparten segundo de inicio en una ventana representativa de diez minutos.
2. La cantidad de ejecuciones por diez minutos permanece: trabajos de 30 segundos = 20; TPV Health = 5; POS monitor = 2.
3. Dos llamadas concurrentes a cada job sin guarda ejecutan una sola operación subyacente; una tercera llamada después de finalizar sí corre.
4. Un error siempre libera la guarda mediante `finally`.
5. Los tests existentes de Google Calendar y retry siguen verdes.
6. P2024 continúa fallando inmediatamente y el tick siguiente sigue disponible.
7. No se cambia el tamaño ni el timeout del pool.

