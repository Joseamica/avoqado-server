Eres auditor. Intenta REFUTAR la promesa de este trabajo (no lo «autorices»). Puedes responder «sin hallazgos».

Promesa y mapa de entradas: /home/nube/Avoqado/wt/e92879/avoqado-server/docs/auditorias/2026-11-20-salida-olvidada/promesa.md

Código (léelo; los diffs son contra la base de cada repo):
- SERVIDOR: /home/nube/Avoqado/wt/e92879/avoqado-server — `git diff origin/develop...HEAD` (src/services/shared/salidaOlvidada.ts es el corazón; checadaDeCampo.service.ts, time-entry.tpv.service.ts, time-entry.mobile.service.ts, auto-clockout.job.ts, la ruta PUT .../salida-olvidada, migración 20261120200000).
- DASHBOARD: /home/nube/Avoqado/wt/e92879/avoqado-web-dashboard — `git diff origin/develop...HEAD`.
- TPV (app de campo `:campo`): /home/nube/Avoqado/wt/e92879/avoqado-tpv — `git diff origin/main...HEAD`.

Contexto: el checador dejaba abierto para siempre un turno sin salida; al día siguiente la entrada daba 409 YA_TIENE_ENTRADA y la siguiente salida cerraba el turno viejo con cientos de horas (267 h reales). El founder decidió: regla para todos, prendida de fábrica, apagable por negocio; horas = salida de su horario o 0 h; la salida que llega con hora de OTRO día no reemplaza el cierre automático; la sin red del MISMO día sí. El POS (ANDROID) y la PAX preguntan al SERVIDOR cada vez; sólo el celular guarda turno local. iOS va después (no es hallazgo).

Busca sobre todo: casos alcanzables donde (a) se cierre un turno que la persona sigue trabajando (nocturnos, zonas, DST, relojes del celular), (b) se pierdan horas reales o evidencia (fotos, depósito), (c) se dupliquen o estiren horas, (d) carreras entre el job, la PAX, el POS, el celular y el gerente, (e) apps viejas ya publicadas (celular 0.4/0.5, PAX, POS) que reaccionen mal a respuestas nuevas (salidaNoUsada, SALIDA_OLVIDADA, el 409 que ya no llega), (f) carga: lecturas sin tope, N+1, el job con muchas filas, (g) permisos/tenant en la ruta nueva, (h) la cola sin red del celular (orden, barreras, RETRY vs REJECTED).

Cada hallazgo: caso alcanzable (quién y cómo), consecuencia, antes vs ahora, certeza, y UNA etiqueta: ROMPE-LA-PROMESA | LA-PROMESA-LO-NECESITA | AJENO.
Termina con UNA línea: RESUMEN: bloqueantes=N regresiones=N ajenos=N veredicto=SIN-HALLAZGOS|CON-HALLAZGOS
No modifiques archivos.

RONDA 2. La ronda 1 está en docs/auditorias/2026-11-20-salida-olvidada/codex-r1.md y lo que se hizo con cada hallazgo al final de promesa.md. Revisa sobre todo los arreglos (commits nuevos en los tres repos) y si rompieron algo (regresiones). No repitas lo declarado en «No entra» salvo que esté mal declarado.
