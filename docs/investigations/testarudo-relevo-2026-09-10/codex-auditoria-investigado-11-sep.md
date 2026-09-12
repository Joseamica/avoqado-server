# Texto para Codex — auditar lo investigado el 11-sep (continúa la auditoría que se quedó sin créditos)

Copia todo lo que está debajo de la línea.

---

Continúa una auditoría que se cortó por créditos. Sólo lectura: no edites, no corras builds, no toques git, no imprimas
secretos. Cita archivo:línea del código real.

Lee primero:
- Recopilación de lo ya investigado (hallazgos con escenario, evidencia, arreglo y veredicto de un escéptico):
  /Users/amieva/Documents/Programming/Avoqado/avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/investigado-11-sep-diseno-A-B-s8.md
  (empieza por su sección 1, la tabla resumen)
- Diseño v2 (la sección H ya incorpora tus puntos V1–V5 de la corrida anterior):
  /Users/amieva/Documents/Programming/Avoqado/avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/diseno-A-B-seccion8-2026-09-11.md
- Regla del circuito: /Users/amieva/Documents/Programming/Avoqado/avoqado-tpv/.claude/rules/cobro-remoto-pos-a-tpv.md
Repos (el árbol de trabajo cuenta, no HEAD): avoqado-server, avoqado-tpv, avoqado-android, avoqado-ios bajo
/Users/amieva/Documents/Programming/Avoqado/.

NO repitas lo que ya está CONFIRMADO en la recopilación salvo que lo contradigas con evidencia. Gasta tu esfuerzo en:

1. Los 7 hallazgos P1 que quedaron SIN TERMINAR (sección 1 de la recopilación): la recuperación de fondo de AngelPay que
   autentica la cuenta primaria (regla de Amaena); una TPV 2.9.2 bloqueada al primer rechazo con el servidor nuevo y las
   llaves irresolubles de las apps POS publicadas; la libreta SHADOW de 2.9.2 que bloquea la terminal al instalar el APK
   del árbol; `cancelDisposition` en null que deja sin salida la llave de Android 2.18.3 y del iOS del árbol; C.3 que no
   arregla el P1-3 en la app que lo produce; filas PROCESSING que contestan ACTIVE para siempre frente a B; el modo lote
   de B para las 375 filas históricas. Para cada uno: ¿se sostiene? severidad y arreglo.
2. Los hallazgos REFUTADOS: ¿la refutación es correcta?
3. La investigación D.7 (sección 3): los dos caminos por los que un id de solicitud remota queda pegado al contexto de
   pago de otra (re-etiquetado de la pantalla que sale, con un «cancelled + PRE_AUTHORIZATION» falso; y botón atrás del
   sistema que deja los argumentos y convierte el siguiente cobro LOCAL en remoto). ¿Se sostienen? ¿El arreglo propuesto
   basta? El camino 2 también aplicaría a la PAX (Blumon).
4. Con todo lo confirmado: ¿el enfoque de A (identidad de bandeja con contador y espejo) sigue siendo viable, o hay que
   cambiar de mecanismo? Da un veredicto sobre A, sobre B y sobre C.1/C.3, y el orden de despliegue que sí funciona.

Formato: veredicto global (APROBADO / APROBADO CON CAMBIOS / RECHAZADO) por sección (A, B, C, D, F), y la lista de
hallazgos P1/P2/P3 con escenario concreto, evidencia archivo:línea y el cambio exacto al diseño. Marca lo que no pudiste
verificar.
