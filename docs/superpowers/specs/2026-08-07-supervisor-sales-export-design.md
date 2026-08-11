# Exportación de ventas del Supervisor sin bloquear pagos

**Fecha:** 2026-08-07  
**Estado:** aprobado por el founder  
**Origen:** `stores-analysis/activity-feed` retuvo el event loop entre 4.7 s y 8.7 s al cargar un año con `limit=10000`.

## Objetivo

Conservar el reporte anual completo que usa Isaac Mayoral (OWNER de PlayTelecom), incluidos Excel, CSV y Google Sheets, sin cargar miles de
órdenes, asistencias, relaciones y fotografías en una sola petición periódica del servidor.

## Evidencia

- El dashboard solicita `activity-feed?limit=10000` cada 30 segundos, aun cuando sólo necesita la tabla reciente.
- El backend consulta hasta 10,000 órdenes y 10,000 asistencias, construye hasta tres eventos por registro, ordena el arreglo completo y lo
  serializa.
- En producción el rango observado contenía 5,706 órdenes y 1,806 asistencias, aproximadamente 9,300 eventos.
- La exportación actual ocurre en el navegador. PostgreSQL y `ActivityLog` no registran el formato elegido.
- Isaac es OWNER de PlayTelecom. La organización tiene 47 venues activos; tiene 41 asignaciones `StaffVenue`, pero el OWNER debe conservar
  alcance organizacional.

## Decisiones

### Separar lectura interactiva y exportación

La tabla interactiva usará `activity-feed` con 100 eventos y un máximo ineludible de 200 impuesto por el backend. Sólo estará habilitada en
la pestaña operativa. El polling de 30 segundos sólo correrá si el rango contiene el instante actual; los rangos históricos se consultan una
vez.

La exportación usará un endpoint nuevo de ventas paginadas. Cada página contendrá como máximo 500 órdenes y seleccionará exclusivamente los
campos que aparecen en el archivo: identificador, tienda, monto, fecha, promotor, código interno e ICCID. No traerá asistencias, pagos,
verificaciones, fotos, tags ni categorías que el archivo no consume.

El navegador solicitará páginas secuenciales y construirá el CSV/XLSX con las utilidades existentes. Esto mantiene la CPU de Excel fuera del
proceso Node. Google Sheets conservará el comportamiento actual (descargar CSV y abrir Sheets); la pestaña se abrirá sincrónicamente al clic
para evitar el bloqueador de popups durante la espera asíncrona.

### Límites explícitos

- Rango máximo: 370 días para tolerar límites inclusivos y conversiones de zona horaria alrededor de un año.
- Máximo: 25,000 ventas por exportación.
- Si se rebasa cualquier límite, el backend responde un error claro antes de transferir páginas. Nunca devuelve un archivo truncado.
- La primera página obtiene el conteo total; las demás no repiten ese conteo.

### Orden y cursor

La paginación es keyset, ordenada por `createdAt DESC, id DESC`. El cursor opaco contiene ambos valores. Así una venta insertada mientras se
genera el reporte no duplica ni desplaza filas ya leídas.

### Autorización

- `OWNER`, `ADMIN` y `SUPERADMIN`: todos los venues activos de la organización; un filtro explícito debe pertenecer a esa organización.
- Los demás roles: sólo sus `StaffVenue` activos dentro de la organización.
- Un `filterVenueId` fuera del alcance devuelve 403.
- El venue de la URL sigue siendo el contexto de autenticación; no limita por sí solo un reporte organizacional del OWNER.

### Auditoría

Después de generar el archivo, el cliente enviará un evento autenticado `SALES_REPORT_EXPORTED`. `ActivityLog` guardará actor, venue de
contexto, formato, rango, filtro y cantidad de filas. La auditoría es best-effort y nunca convierte una descarga correcta en error.

## Contratos

`GET /api/v1/dashboard/venues/:venueId/stores-analysis/sales-export-rows`

- Query: `startDate`, `endDate`, `filterVenueId?`, `cursor?`, `limit?`.
- Respuesta: `{ rows, nextCursor, total? }`; `total` sólo aparece en la primera página.

Cada fila contiene:

```ts
{
  id: string
  venueName: string
  product: string
  iccid: string | null
  staffId: string | null
  staffName: string
  staffEmployeeCode: string | null
  amount: number
  timestamp: string
}
```

`POST /api/v1/dashboard/venues/:venueId/stores-analysis/sales-export-audit`

- Body: `{ format, startDate, endDate, filterVenueId?, rowCount }`.
- `format`: `csv | excel | sheets`.
- Respuesta: 204.

## Criterios de aceptación

1. `limit=10000`, inválido o negativo nunca provoca más de 200 eventos interactivos.
2. Una exportación de 5,706 ventas se obtiene en páginas secuenciales y produce las mismas columnas y formatos actuales.
3. No hay polling histórico ni consultas del feed fuera de la pestaña operativa.
4. OWNER conserva las 47 tiendas; MANAGER no puede leer ni exportar una tienda sin asignación.
5. Más de 25,000 filas o más de 370 días falla explícitamente, sin archivo parcial.
6. El formato queda consultable en `ActivityLog` después de una descarga.
7. No se cambia Prisma ni se añade una dependencia.
