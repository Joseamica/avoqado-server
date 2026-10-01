# TPV: correcciones de confiabilidad — 1 de octubre de 2026

Estado: verificación de software terminada; prueba física pendiente. No desplegado. Producción se consultó en modo lectura. El caso de la
TPV 2841548628 ya fue resuelto manualmente por el operador; su estado actual no demuestra la causa histórica.

La revisión `$full-testing` encontró entrega y confirmación por serial sin identidad verificada, confirmaciones finales que podían
sobrescribirse, cancelación y reversión sin transacción conjunta, solicitudes repetidas que generaban comandos duplicados, heartbeat vacío
con error 500 y códigos de versión interpretados parcialmente. La evidencia original está en `/tmp/full-testing-tpvs-zm66kqo2/report.md` de
la Mac.

## Contrato comprobado por software

- Las TPV actualizadas acreditan su identidad de dispositivo, independiente del PIN del empleado. El servidor conserva sólo el hash de la
  credencial.
- La app anuncia disponibilidad al abrirse, regresar a Inicio, recuperar conexión o recibir un aviso del socket. No se agrega un
  temporizador de consulta de comandos.
- Los comandos del protocolo nuevo permanecen pendientes sin vencimiento. Se entregan como máximo diez por consulta; una respuesta perdida
  se recupera en otro evento.
- Antes del efecto la app persiste el comando y pide permiso al servidor. La misma sesión puede recuperar una respuesta de permiso perdida.
  Un comando cancelado no obtiene permiso. Una ejecución incierta después de morir el proceso no se repite.
- Sólo Inicio o Activación en primer plano habilitan comandos. Cobros y devoluciones reservan la ventana antes de preparar el SDK. El PIN,
  el carrito y los formularios quedan fuera de la ventana. Los comandos que reinician o borran esperan también a que no haya registros
  financieros pendientes o inciertos.
- Los recibos persisten antes de cerrar el proceso y se confirman en el siguiente arranque. Una migración requiere recibo completado y un
  arranque autenticado distinto; un heartbeat o una consulta pública de activación no son prueba del borrado.
- El borrado conserva la base financiera, la identidad del dispositivo y sus recibos.
- Los comandos no implementados no anuncian éxito. Nexgo usa TMS para actualizarse; no debe recibir APK PAX ni ejecutables de escritorio.

## Compatibilidad y límites

Desplegar primero backend y su migración aditiva; después el APK y el frontend. Los APK anteriores conservan el vencimiento anterior y no
adquieren garantía durable. Nunca se reproducen automáticamente comandos históricos SENT: algunos pudieron haberse ejecutado sin
confirmación. Requieren comprobación manual en el aparato.

Las pruebas de desconexión, reinicio y migración en TPV física están pendientes por instrucción del usuario. Las pruebas de JVM/API no
sustituyen esa comprobación.

## Resultado del retest

- Backend: suite completa en Mac, 1,699 suites y 21,241 pruebas aprobadas; una suite y 14 pruebas omitidas por la suite existente. Tipos,
  build y lint aprobados.
- Superadmin: lint, tipos, 134 suites / 1,114 pruebas y build aprobados.
- APK: 198 suites, 2,609 pruebas aprobadas / ocho omitidas; APK sandbox PAX, compilación Nexgo y lint aprobados en Mac.
- PostgreSQL real: rollback después de insertar comando/historial, idempotencia concurrente, permiso recuperable, ACK inmutable, intención
  única de migración, cancelación tras entrega y confirmación mediante nuevo arranque autenticado.
- API y navegador locales: migración sin merchant explícito a destino compatible, estado Pendiente verdadero y cancelación, contrastados con
  DB, auditoría y logs. Destino sin configuración bloqueado; flota paginada sin otros dispositivos.
- El clon de QA se eliminó mediante PSQL; puertos/pestaña propios cerrados y cero marcadores del run en la base original. Producción no se
  modificó.

Reporte local: `/tmp/tpv-retest-QzaRFQ/report.md`. Status **WARN** por hardware pendiente y socket multinstancia sin probar (Redis no
disponible en el entorno de QA). No se otorgaron permisos reales en el wizard ni se ejecutaron cobros físicos.

Sin red el comando queda pendiente y el recibo cifrado conserva lo que ya empezó. Una ejecución incierta tras morir el proceso no se repite
a ciegas. La recuperación recorre páginas de diez mientras hay progreso; fallos o actividad sensible esperan otro evento. Antes de ejecutar
se revalidan destino y comercios. Estas reglas tienen regresiones automáticas; falta comprobar red/SDK y consumo en PAX/Nexgo físicos.
