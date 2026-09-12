# Conciliación CSV Blumon — orden de $88, 11-sep-2026

Continuación de [la auditoría del 409](./409-cancelar-orden-2026-09-11-auditoria-codex.md).
El founder autorizó revisar/liberar/arreglar el caso mientras se termina el cambio y entregó el CSV del portal.
Se utilizó psql contra la base indicada, con transacciones READ ONLY. No se modificó producción.

## Archivo y alcance

- Fuente: /Users/amieva/Downloads/tableExport.csv, entregado por el founder.
- SHA-256: c4eec28a354344fd591d2e9485998b99850d5fad4322ffbbb7f9efdedc857ff3.
- 200 operaciones más encabezado; del 8-sep 11:09:56 al 11-sep 11:36:08, hora del CSV.
- 189 APROBADA y 11 negativas en el archivo. El 11-sep: 49 operaciones, 44 aprobadas y 5 negativas.
- Se revisaron las 200 filas para ubicar el caso. El cruce bancario individual con Postgres se limitó a las dos aprobaciones de $88 del 11-sep, ambas en terminal 2841653112. No es una conciliación de los 200 pagos.
- No se copió el export completo al repositorio.

## Coincidencias exactas

| Hora CSV (Testarudo) | Operación Blumon | Autorización | hostResponse / referenceNumber | Payment de Avoqado | Orden |
|---|---|---|---|---|---|
| 10:21:43 | 24392577 | 771532 | 137392665661 | cmtx5ytot01q3o82a0er3hk2v | cmtx5ymqq01pto82aq842rghd |
| 10:23:48 | 24392661 | 469858 | 955104382646 | cmtx61i1a01rho82aoat3xmml | cmtx61ctj01r5o82aasn36n1b |

Ambos Payment son REGULAR/COMPLETED, $80 + $8, terminal AVQD-2841653112. Se registraron a las 16:21:44.525 y 16:23:49.391 UTC, respectivamente.
Se empataron por autorización, referencia y terminal, no sólo por monto/hora.
En el CSV el total aprobado aparece como Monto=88 y Monto adicional=0: comparar contra amount+tipAmount de Avoqado.
La referencia bancaria que corresponde a Payment.referenceNumber es hostResponse del export, no la columna Referencia con formato de fecha.

## Orden original

Consulta psql finalizada correctamente; corte 2026-09-11 17:41:26.886187 UTC:

- Orden cmtx607hq01qlo82aohazdp79, ORD-1789143769063: CONFIRMED/PENDING, $88.
- Cero Payment, cero referidos vinculados y ninguna mesa vinculada.
- updatedAt todavía 2026-09-11 16:22:49.070 UTC.
- Solicitud 2e183233-3593-47b5-9134-01a59245f054: CANCELLED, failureCode=CANCELLED, sin paymentId ni resultado de terminal guardado.
- Su cambio a CANCELLED ocurrió a las 16:23:38.011 UTC por el temporizador de producción.

No hay una tercera aprobación de $88 del 11-sep en el CSV, ni una operación de las 10:22 que corresponda al intento original. Esto respalda que los dos cargos visibles están registrados correctamente; no constituye un resultado terminal acreditado del intento ausente ni una garantía sobre datos posteriores al corte del export.

## Estado operativo y decisión

En la comprobación previa con psql, a las 17:18:40 UTC, la PAX no tenía solicitudes en PENDING/SENT/CANCEL_REQUESTED/UNKNOWN. El cobro nuevo 71447871-50c6-49e6-a755-ad5c9ae5542f había pasado a COMPLETED a las 17:17:54.510 UTC. El incidente antiguo ya no ocupaba el candado de producción.

No había que liberar esa reserva. No se reclasificó su CANCELLED como confirmación bancaria, no se asignó ninguno de los otros Payment a la orden original y no se canceló la orden basándose únicamente en una ausencia del CSV. Permanece pendiente la conciliación definitiva de ese intento; hace falta un desenlace acreditado de terminal/procesador o resolver explícitamente el procedimiento manual de evidencia del legado.

No hubo UPDATE, INSERT, DELETE, commit Git, push ni deploy. Se creó únicamente este documento local.

