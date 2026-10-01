# TPV: correcciones de confiabilidad — 1 de octubre de 2026

Estado: implementación local y verificación en curso. No desplegado.
Producción se consultó en modo lectura. El caso de la TPV 2841548628 ya fue resuelto
manualmente por el operador; su estado actual no demuestra la causa histórica.

La revisión `$full-testing` encontró entrega y confirmación por serial sin identidad
verificada, confirmaciones finales que podían sobrescribirse, cancelación y reversión
sin transacción conjunta, solicitudes repetidas que generaban comandos duplicados,
heartbeat vacío con error 500 y códigos de versión interpretados parcialmente.
La evidencia original está en `/tmp/full-testing-tpvs-zm66kqo2/report.md` de la Mac.

## Contrato que se está verificando

- Las TPV actualizadas acreditan su identidad de dispositivo, independiente del PIN
  del empleado. El servidor conserva sólo el hash de la credencial.
- La app anuncia disponibilidad al abrirse, regresar a Inicio, recuperar conexión o
  recibir un aviso del socket. No se agrega un temporizador de consulta de comandos.
- Los comandos del protocolo nuevo permanecen pendientes sin vencimiento. Se entregan
  como máximo diez por consulta; una respuesta perdida se recupera en otro evento.
- Antes del efecto la app persiste el comando y pide permiso al servidor. La misma
  sesión puede recuperar una respuesta de permiso perdida. Un comando cancelado no
  obtiene permiso. Una ejecución incierta después de morir el proceso no se repite.
- Sólo Inicio o Activación en primer plano habilitan comandos. Cobros y devoluciones
  reservan la ventana antes de preparar el SDK. El PIN, el carrito y los formularios
  quedan fuera de la ventana. Los comandos que reinician o borran esperan también
  a que no haya registros financieros pendientes o inciertos.
- Los recibos persisten antes de cerrar el proceso y se confirman en el siguiente
  arranque. Una migración requiere recibo completado y un arranque autenticado distinto;
  un heartbeat o una consulta pública de activación no son prueba del borrado.
- El borrado conserva la base financiera, la identidad del dispositivo y sus recibos.
- Los comandos no implementados no anuncian éxito. Nexgo usa TMS para actualizarse;
  no debe recibir APK PAX ni ejecutables de escritorio.

## Compatibilidad y límites

Desplegar primero backend y su migración aditiva; después el APK y el frontend.
Los APK anteriores conservan el vencimiento anterior y no adquieren garantía durable.
Nunca se reproducen automáticamente comandos históricos SENT: algunos pudieron
haberse ejecutado sin confirmación. Requieren comprobación manual en el aparato.

Las pruebas de desconexión, reinicio y migración en TPV física están pendientes por
instrucción del usuario. Las pruebas de JVM/API no sustituyen esa comprobación.
El resultado final de las verificaciones se registrará aquí antes de entregar el cambio.
