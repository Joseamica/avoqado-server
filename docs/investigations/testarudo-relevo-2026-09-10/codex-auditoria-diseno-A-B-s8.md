# Texto para auditar con Codex — diseño A/B/§8/Nexgo (11-sep-2026)

Copia todo lo que está debajo de la línea y pégalo en Codex (modelo más fuerte, esfuerzo máximo, sólo lectura).

---

Audita un DISEÑO (todavía no programado) para el circuito de cobro remoto de Avoqado: tablet POS (Android/iOS) →
servidor (Node/Prisma/Postgres) → terminal de cobro (PAX con Blumon, Nexgo con AngelPay). No edites nada, no corras
builds, no toques git, no imprimas secretos. Cita archivo:línea del código real para cada afirmación.

Lee primero, completo:
- Diseño: /Users/amieva/Documents/Programming/Avoqado/avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/diseno-A-B-seccion8-2026-09-11.md
- Regla del circuito: /Users/amieva/Documents/Programming/Avoqado/avoqado-tpv/.claude/rules/cobro-remoto-pos-a-tpv.md
- Relevo (contexto e historia; §2-ter es lo vigente): /Users/amieva/Documents/Programming/Avoqado/avoqado-server/docs/investigations/testarudo-relevo-2026-09-10/README.md

Repos (el árbol de trabajo, con cambios sin commitear, es lo que cuenta):
- /Users/amieva/Documents/Programming/Avoqado/avoqado-server
- /Users/amieva/Documents/Programming/Avoqado/avoqado-tpv
- /Users/amieva/Documents/Programming/Avoqado/avoqado-android
- /Users/amieva/Documents/Programming/Avoqado/avoqado-ios

Decisión del founder que el diseño implementa: A (identidad de bandeja) como recuperación automática y B (liberación
manual con conciliación documentada) como respaldo; C descartada. Condiciones de A: el servidor guarda el identificador
de la bandeja antes de enviar; sobrevive reinicios; pérdida o restauración (incluida una copia antigua con el mismo id)
invalida la identidad; NOT_FOUND libera sólo con continuidad acreditada y con la lápida escrita antes de responder;
id cambiado, datos faltantes o solicitud histórica ⇒ no libera; A no es retroactivo para APK viejos. B: conciliación
documentada y prueba de que el intento ya no puede autorizar; la ausencia en el portal sola no basta.

Condición de dinero que domina todo: nunca un cobro doble ni uno perdido; timeout, cancel, desconexión o ausencia de
Payment NO prueban ausencia de cargo.

Lo que quiero que ataques, en este orden:
1. **A, dinero**: ¿existe CUALQUIER secuencia en la que el servidor libere por A una solicitud que la terminal ejecutó o
   todavía puede ejecutar? Restauraciones (Auto Backup, adb backup, copia con run-as, copia completa), corte de luz,
   rotación de identidad, fallos del espejo en noBackupFilesDir, dos variantes de la app en el mismo serial, carreras
   entre sonda, replay y handshake, ACK tardío, entregas duplicadas, lápida, APK 2.8.7 y 2.9.2.
2. **A, factibilidad en la TPV**: ¿es cierto que `RemotePaymentInbox` es el único escritor de `remote_payment_requests`?
   ¿Se puede garantizar «commit de Room → fsync del espejo → efecto visible» en cada efecto (ACK, sonda, disposición,
   resultado, SDK)? ¿La fila centinela dentro de la tabla rompe alguna consulta?
3. **B**: ¿alguna de sus bases (TERMINAL_FINAL_ANSWER, DEVICE_DECOMMISSIONED, DEVICE_INSPECTED, LEGACY_NO_RESUME)
   permite liberar un intento que aún puede autorizar? ¿El modo lote para las 375 filas históricas de producción es
   seguro?
4. **Contrato**: la lista blanca del desenlace canónico (`outcome`/`outcomeEvidence`) contra TODOS los escritores de
   `failureCode` del servidor; compatibilidad con las apps publicadas (Android 2.18.x, iOS 1.10.x) sin reabrir el cobro
   doble del 2026-08-10; el reordenamiento de C.3.
5. **Rutas que cancelan órdenes**: ciclos de candados; ¿falta alguna ruta?; ¿son correctas las decisiones G2 (bloquear
   cualquier anulación con cobro vivo) y G3 (no bloquear el destino de una fusión)?
6. **N3 y cancelación durable**: un «el POS canceló, no se cobró» que conviva con una autorización posible (chip,
   reintentos, efectivo, reentrega, resultado tardío); la semántica G1 de «Cancelar» y la barrera «borrar la orden sólo
   tras el desenlace».
7. **Nexgo (D)**: el reintento de autenticación en segundo plano (concurrencia, regla de Amaena, efectivo bloqueado) y
   la sospecha D.7 (un `_socketRequestId` de una solicitud pegado al contexto de pago de otra).
8. **Despliegue (F)**: ¿el orden «APK de TPV primero, luego servidor, luego POS» es seguro en cada combinación
   intermedia de versiones?

Formato de respuesta: veredicto global (APROBADO / APROBADO CON CAMBIOS / RECHAZADO) y una lista de hallazgos P1 (dinero
o terminal bloqueada sin salida), P2 y P3, cada uno con: sección del diseño, escenario concreto (estado inicial →
pasos → resultado equivocado), evidencia archivo:línea y el cambio exacto al diseño. Marca explícitamente lo que NO
pudiste verificar.
