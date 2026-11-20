-- «Salida olvidada» (hz:f0a89d19:D3) · SÓLO LECTURA · correr ANTES del «publica» del SERVIDOR, con el founder.
-- Cuántos turnos abiertos de más de 12 h hay hoy por negocio: son los que la regla cerrará en su primera pasada (en tandas
-- de 500 cada 15 min), con la salida de su horario o en 0 horas, y quedarán «Salida olvidada · revisar».
-- Producción corre en UTC: NOW() es UTC; las columnas guardan UTC.
SELECT o.name AS organizacion,
       v.name AS sucursal,
       COUNT(*) AS turnos_abiertos,
       MIN(te."clockInTime") AS el_mas_viejo_utc,
       ROUND(MAX(EXTRACT(EPOCH FROM (NOW() - te."clockInTime")) / 3600)::numeric, 1) AS horas_del_mas_viejo
FROM "TimeEntry" te
JOIN "Venue" v ON v.id = te."venueId"
JOIN "Organization" o ON o.id = v."organizationId"
LEFT JOIN "VenueSettings" s ON s."venueId" = v.id
WHERE te.status IN ('CLOCKED_IN', 'ON_BREAK')
  AND te."clockOutTime" IS NULL
  AND te."clockInTime" < NOW() - INTERVAL '12 hours'
GROUP BY o.name, v.name
ORDER BY turnos_abiertos DESC, sucursal
LIMIT 200;
