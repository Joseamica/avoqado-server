# Salida olvidada en todos los checadores (hz:f0a89d19:D3 · encargo 14e182 · founder 20-nov: «A»)

## Promesa (5 líneas)

- **Qué va a pasar:** en TODOS los negocios (prendido de fábrica, se apaga en Equipo → Asistencia), un turno sin salida se
  cierra solo al terminar su día (corte de las 04:00 de la sucursal, nunca antes de 12 h) o en cuanto la persona vuelve a
  checar; queda «Salida olvidada · revisar» con la salida de su horario o en 0 horas, y el gerente la corrige en Asistencia.
  Al día siguiente la persona entra sin «ya tienes una entrada» en el celular, la PAX y el POS; una salida del celular que
  llega con hora de OTRO día ya no estira el turno (se anota con su foto); la salida sin red del MISMO día sí cuenta.
- **No entra:** iOS (va su ficha); el GPS del celular con un turno local olvidado (sigue como hoy hasta la siguiente
  entrada: deuda anotada); cerrar los turnos abiertos de producción el día de publicar sin medirlos antes con el founder
  (punto 5: se mide antes del «publica»); pago o nómina de esas horas.
- **Se prueba así:** pruebas del SERVIDOR (regla, job, las 3 puertas, corrección), del DASHBOARD y de `:campo`; y en el
  banco: entrada de ayer abierta → entrada de hoy por la PAX y por el celular (SAMSUNG) sin 409, la de ayer en «Salida
  olvidada · revisar», corregirla en el DASHBOARD; salida tardía de otro día anotada sin estirar.
- **Depende de:** el job de cierre automático que ya corre cada 15 min, `resolveExpectedDay` (horario, excepciones y turnos
  rotativos) y el reemplazo del cierre automático por la salida real del celular (`registrarSalidaDeCampo`).
- **Responsable:** la conversación de la nube «Salida olvidada en todos los checadores (A)» (encargo 14e182), que le
  reporta a «Tarea de Asana» (mac:f0a89d19).

## Mapa de entradas (quién escribe `TimeEntry.clockOutTime` y la marca)

| Camino | Qué hace ahora | Reintento / carrera | Prueba |
|---|---|---|---|
| Job `auto-clockout` (cada 15 min) | Después de hora fija y máximo de horas, `cerrarSalidasOlvidadasPendientes`: hasta 500 abiertas de > 12 h, sólo negocios con la regla prendida (o sin fila), cada una en su transacción | `updateMany` con `clockOutTime: null`: una salida real que gana no se pisa | `salidaOlvidada.test.ts` (job) |
| Celular · entrada (`registrarEntradaDeCampo`) | Dentro del candado de la persona cierra lo olvidado y crea la entrada; un turno del MISMO día sigue en 409 | Mismo candado `checada:<staff>`; CAS | `checadaDeCampo.service.test.ts` (D3) |
| Celular · salida (`registrarSalidaDeCampo`) | Cierra lo olvidado; si la entrada nombrada tiene cierre automático y la hora de la salida pasa su límite → se anota (llave, foto, nota), no se estira; si no, reemplaza como hoy y quita la marca | La misma llave devuelve lo mismo; otra salida tardía sobre una ya anotada → YA_TIENE_SALIDA | idem |
| PAX · identificar / entrada / salida (`time-entry.tpv.service`) | Cierra lo olvidado antes (transacción propia sólo si hay algo viejo); la salida de un turno recién olvidado dice de qué día era (`SALIDA_OLVIDADA`) | CAS; la entrada sigue bajo `conCandadoDeEntrada` | pruebas vecinas en verde; banco con la PAX |
| POS · identificar / entrada / salida (`time-entry.mobile.service`) | Igual que la PAX | idem | `time-entry.mobile.fotoDeEntrada.test.ts`; banco |
| DASHBOARD · `PUT …/time-entries/:id/salida-olvidada` | Sólo una checada marcada; salida > entrada, ≤ ahora, ≤ límite, sin encimarse con la siguiente; nadie la suya; `attendance:manage`; recalcula horas y descansos; quita la marca; bitácora | CAS sobre `salidaOlvidada` + `clockOutTime` | `salidaOlvidada.test.ts` (corrección), `SalidaOlvidada.test.tsx` |
| Celular local (`:campo`) | Un turno local pasado su límite no cuenta como abierto (Checar, Encolador, Inicio); «Usar esa entrada» sólo para una entrada del mismo día | — | `ChecadaViewModelTest`, `PendientesViewModelTest` (D3) |
