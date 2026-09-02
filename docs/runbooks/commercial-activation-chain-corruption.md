# Runbook: autoridad comercial, rollback y corrupción de cadena

Este procedimiento protege la autoridad comercial de Avoqado. No habilita checkout, no autoriza editar publicaciones inmutables y no
sustituye el release manifest aprobado. Toda acción se ejecuta primero en el laboratorio/preview con datos sintéticos.

```text
Publicación inmutable → puntero PRODUCTION → ledger denso de activaciones → outbox
                              │
                              └── única autoridad para catálogo, caché y consumidores
```

## Dos reglas deliberadamente distintas

```text
Catálogo:  v1 ──► v2 ──► v1 de emergencia previamente probado
Campaña:   v1 ──► v2 ──► v2 anterior/nueva; nunca vuelve a v1
```

- El catálogo puede reactivar un v1 únicamente si esa publicación exacta ya pertenecía a la cadena densa verificada. La acción es
  excepcional, exige revisión observada, confirmación y motivo, y queda auditada como `COMMERCIAL_PUBLICATION_V1_EMERGENCY_REACTIVATED`.
- Las campañas son roll-forward-only entre esquemas. Después del primer v1→v2 no existe ruta de emergencia a v1. Un rollback de campaña sólo
  puede apuntar a otra versión v2 verificada.
- Una reactivación normal de un catálogo v2 que ya pertenecía a la cadena se registra como `PUBLICATION_ROLLED_BACK`. Ese nombre describe
  pertenencia histórica, aunque operacionalmente la acción esté recuperando hacia adelante.

## Señales que bloquean cualquier mutación

- `COMMERCIAL_CATALOG_AUTHORITY_INVALID` o `COMMERCIAL_CATALOG_FALLBACK_PROVENANCE_INVALID`.
- Revisión ausente, duplicada o no contigua en el ledger de activaciones.
- El puntero no coincide con la publicación final del ledger.
- Checksum, schema, identidad de fila/snapshot o relación `previousPublicationId` inválidos.
- Un evento de activación no coincide con su revisión o `dedupeKey`.
- El artefacto objetivo no pasa el registry vigente.
- Un claim/outbox conserva un lease activo o cambió desde la inspección.

Ante cualquiera de estas señales: detener publicación, activación, recuperación de outbox y release. La lectura directa de un artefacto
activo v1/v2 válido puede seguir funcionando si la historia dañada no se necesita; eso no autoriza ninguna mutación.

## Diagnóstico seguro

1. Registrar ambiente, correlation ID, release manifest y hora en `America/Mexico_City`.
2. Sobre la base restaurada y aislada, ejecutar el preflight completo de sólo lectura. El comando devuelve únicamente el recibo aprobado o
   un código estable; nunca imprime la URL de conexión, snapshots ni errores crudos:

   ```bash
   DATABASE_URL=<restauracion-local-aislada> npm run commercial:release:preflight
   ```

   Un exit code distinto de cero bloquea el release. `COMMERCIAL_RELEASE_PREFLIGHT_FAILED` describe una autoridad comercial inválida;
   `COMMERCIAL_RELEASE_PREFLIGHT_UNAVAILABLE` describe infraestructura no disponible y no autoriza diagnosticar corrupción.

3. Usar las superficies de sólo lectura:
   - catálogo público y sus encabezados `ETag`, `X-Avoqado-Commercial-Fallback`, `X-Avoqado-Commercial-Active-Publication` y
     `X-Avoqado-Commercial-Served-Publication`;
   - `GET /api/v1/superadmin/commercial/outbox/failed`;
   - `GET /api/v1/superadmin/commercial/outbox/failed/:id`.
4. Confirmar que la inspección del outbox sólo muestra el código normalizado. Nunca copiar a tickets el `payload`, snapshot o `lastError`
   crudo.
5. Reproducir en una base restaurada y aislada. No usar la DB compartida ni datos de producción en preview.
6. Volver a ejecutar la prueba completa de autoridad sobre la restauración. No diagnosticar con consultas parciales tomadas en momentos
   distintos.

## Catálogo: reactivación v1 de emergencia

Usar únicamente cuando el incidente requiere volver al v1 exacto previamente activado y la cadena completa todavía se prueba.

> **Advertencia de compatibilidad:** esta operación puede cambiar deliberadamente el `head.schemaVersion` emitido por socket de `2` a `1`.
> El socket sólo ordena refetch; no transporta el catálogo. No usar la emergencia hasta que el release manifest demuestre compatibilidad
> explícita de schema 1/2 en Dashboard, Android, iOS, TPV y Desktop. Windows Service queda fuera de esta etapa. Volver después a un v2 que
> ya pertenecía a la cadena se audita correctamente como `PUBLICATION_ROLLED_BACK`, no como una publicación nueva.

1. Inspeccionar el puntero y anotar su revisión actual.
2. Verificar en laboratorio que el objetivo v1 es miembro exacto de la cadena y que el rollback completo funciona.
3. Obtener aprobación explícita del founder/data owner y registrar un motivo de 3–500 caracteres.
4. Ejecutar:

   ```http
   POST /api/v1/superadmin/commercial/publications/:publicationId/emergency-reactivate-v1
   Content-Type: application/json

   {
     "expectedActivationRevision": 7,
     "reason": "Incidente INC-0000 aprobado; volver al v1 previamente verificado",
     "confirm": true
   }
   ```

5. Confirmar respuesta `200`, revisión incrementada, audit action exacta y un evento `PUBLICATION_ROLLED_BACK` pendiente.
6. Dejar que el sweeper normal verifique y entregue el outbox. La ruta de emergencia no invalida caché ni emite socket directamente.
7. Confirmar que catálogo público, ETag y encabezados describen el artefacto realmente servido.

Un `409 COMMERCIAL_CATALOG_V1_EMERGENCY_ROLLBACK_INVALID` significa “no existe prueba suficiente”; no se reintenta cambiando SQL o
debilitando la validación. Un `409 COMMERCIAL_ACTIVATION_REVISION_CONFLICT` exige volver a inspeccionar desde cero.

## Outbox: recuperación inspeccionada

1. Listar y obtener la fila fallida; guardar `id`, `attempts` y `lastErrorCode` normalizado.
2. Corregir/desplegar primero la causa compatible. La recuperación no hace delivery directo ni evita el registry.
3. Ejecutar una sola solicitud con las coordenadas observadas:

   ```http
   POST /api/v1/superadmin/commercial/outbox/failed/:id/requeue
   Content-Type: application/json

   {
     "observedAttempts": 8,
     "observedLastErrorCode": "COMMERCIAL_OUTBOX_AUTHORITY_UNAVAILABLE",
     "reason": "Autoridad restaurada y verificada en el laboratorio",
     "confirm": true
   }
   ```

4. Confirmar que la misma fila vuelve a `PENDING`, con intentos en cero y claim/error limpios; no debe aparecer una fila duplicada.
5. Ejecutar el sweeper normal y verificar delivery + ACK. Si la autoridad sigue inválida o la observación quedó obsoleta, el `409` es final
   para esa inspección: volver al paso 1.

## Prohibiciones

- No insertar, borrar, renumerar ni reescribir eventos del ledger.
- No cambiar checksums, snapshots, `dedupeKey`, `publicationId`, `previousPublicationId` o timestamps para “hacerlos coincidir”.
- No mover el puntero con `UPDATE` manual.
- No reactivar campañas v1 después de su corte a v2.
- No borrar filas de activación/rollback entregadas; son el ledger de procedencia de `PRODUCTION`.
- No exponer errores crudos, secretos, costos internos, payouts ni reglas de comisión.
- No usar Fly ni Windows Service en este release; ambos permanecen fuera del programa actual.

## Escalamiento y reparación real

Si la cadena no se puede probar, conservar evidencia y bloquear el release. Restaurar o reparar requiere un plan nuevo, revisión
independiente, aprobación del data owner y founder, ensayo de rollback y repetición del gate integrado completo. Nunca se fabrica una
revisión ni se elimina la fila que revela el incidente.
