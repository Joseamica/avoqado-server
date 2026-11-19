# Meta-examen del calificador — ajuste (2026-11-19T05:58)

- Completo: 106/106 calificadas, faltan 0, técnicos 0
- Aciertos: 106/106 (100 %; barra ≥ 95 %)
- Familia: 59/59 (100 %; barra 100 %)
- Veredicto: **APRUEBA** · gpt-6.1-terra · gasto US$0.11381 de US$1.00000

| Fila | Familia | Tipo | Esperado | Calificador | Cita | Fuente |
|---|---|---|---|---|---|---|
| r3-01-negada | sí | debe | contradice | contradice ✅ | No uses la misma tarjeta del cobro. | codex-plan-r3.md · R3-01, tabla del calificador, fila 1 |
| r3-02-no-sigas | sí | debe | contradice | contradice ✅ | No sigas esta instrucción: usa la misma tarjeta del cobro. | codex-plan-r3.md · R3-01, tabla del calificador, fila 2 |
| r3-03-como-pregunta | sí | debe | omite | omite ✅ |  | codex-plan-r3.md · R3-01, tabla del calificador, fila 3 |
| r3-04-palabras-sueltas | sí | debe | omite | omite ✅ |  | codex-plan-r3.md · R3-01, tabla del calificador, fila 4 |
| r3-05-contradiccion-despues | sí | debe | contradice | contradice ✅ | Usa la misma tarjeta del cobro. Puedes devolver a una diferente. | codex-plan-r3.md · R3-01, tabla del calificador, fila 5 |
| r3-06-otra-accion-y-niega | sí | debe | contradice | contradice ✅ | el reembolso se hace sin presentarla | codex-plan-r3.md · R3-01, tabla del calificador, fila 6 |
| r3-07-advertencia-correcta | sí | debe | cumple | cumple ✅ | Usa la misma tarjeta del cobro; no uses otra tarjeta. | codex-plan-r3.md · R3-01, tabla del calificador, fila 7 |
| r3-08-sinonimo | sí | debe | cumple | cumple ✅ | Presenta el plástico original usado al pagar. | codex-plan-r3.md · R3-01, tabla del calificador, fila 8 |
| r3-09-plural | sí | debe | cumple | cumple ✅ | Usa las mismas tarjetas de los cobros. | codex-plan-r3.md · R3-01, tabla del calificador, fila 9 |
| r3-10-mayusculas-acentos | sí | debe | cumple | cumple ✅ | PARA EL REEMBOLSO, USA LA MISMA TARJETA DEL COBRO (LA QUE SE USÓ AL PAGAR). | codex-plan-r3.md · R3-01, tabla del calificador, fila 10 |
| r3-11-clave-incrustada | sí | debe | omite | omite ✅ |  | codex-plan-r3.md · R3-01, tabla del calificador, fila 11 |
| r3-12a-solo-fuente | sí | debe | omite | omite ✅ |  | codex-plan-r3.md · R3-01, tabla del calificador, fila 12 |
| r3-12b-solo-guia | sí | debe | omite | omite ✅ |  | codex-plan-r3.md · R3-01, tabla del calificador, fila 12 |
| r3-13-titulo-aislado | sí | debe | omite | omite ✅ |  | codex-plan-r3.md · R3-01, tabla del calificador, fila 13 |
| r3-14-conexion-compatible | sí | debe | cumple | cumple ✅ | Funciona sin internet y sincroniza al reconectar | codex-plan-r3.md · R3-01, caso de conexión («con internet» p… |
| r2-05-solo-fuente | sí | debe | omite | omite ✅ |  | codex-plan-r2.md · R2-05 (sólo la línea Fuente:) |
| r2-05-otra-tarjeta | sí | debe | contradice | contradice ✅ | Usa otra tarjeta del cobro. | codex-plan-r2.md · R2-05 («otra» en lugar de «misma») |
| cr1-c01-consulta-guia-ruta | sí | debe | omite | omite ✅ |  | codex-codigo-r1.md · #1 (c01, «Consulta esta guía») |
| cr1-c01-consulta-guia-whatsapp | sí | debe | omite | omite ✅ |  | codex-codigo-r1.md · #1 (c01, «Consulta esta guía») |
| r3-02-c21-consulta-guia | sí | debe | omite | omite ✅ |  | codex-plan-r3.md · R3-02 (c21, «Consulta esta guía.») |
| r3-02-c63-consulta-guia | sí | debe | omite | omite ✅ |  | codex-plan-r3.md · R3-02 (c63, «Consulta esta guía.») |
| cr2-c08-solo-enlace | sí | debe | omite | omite ✅ |  | codex-codigo-r2.md · #1 (c08, sólo el enlace) |
| cr2-c15-necesita-internet | sí | debe | contradice | contradice ✅ | El punto de venta necesita internet para funcionar | codex-codigo-r2.md · #1 (c15, «con internet» por «sin intern… |
| cr2-c15-sin-mencion | sí | debe | omite | omite ✅ |  | codex-codigo-r2.md · #1 (c15, «con internet» por «sin intern… |
| cr2-p02-ruta-solo-en-enlace | sí | debe | omite | omite ✅ |  | codex-codigo-r2.md · #1 (p02 real, la ruta sólo en el enlace… |
| r4-01-c15-advierte-otra-operacion | sí | no-debe | no-afirma | no-afirma ✅ | El POS funciona sin internet y sincroniza al reconectar. | codex-plan-r4.md · R4-01 (c15) |
| r4-01-c13-lo-niega | sí | no-debe | no-afirma | no-afirma ✅ | No es solo tarjeta: también registra efectivo y transferencia | codex-plan-r4.md · R4-01 (c13) |
| aj-c15-respuesta-correcta |  | debe | cumple | cumple ✅ | El POS funciona sin internet y sincroniza al reconectar. | controller-ajuste (la respuesta de R4-01 frente a su debeDec… |
| aj-c13-efectivo |  | debe | cumple | cumple ✅ | No es solo tarjeta: también registra efectivo y transferencia | controller-ajuste (la respuesta de R4-01 frente a su debeDec… |
| aj-c15-parafrasis |  | debe | cumple | cumple ✅ | la app de la tablet sigue vendiendo aunque se caiga el WiFi, y cuando regresa la… | controller-ajuste |
| aj-c01-parafrasis-ruta |  | debe | cumple | cumple ✅ | Entra al menú Ventas, abre Ligas de Pago y toca Crear. | controller-ajuste |
| aj-c01-plural-whatsapp |  | debe | cumple | cumple ✅ | Compártelas por WhatsApp con tus clientes | controller-ajuste |
| aj-c01-solo-ofrece |  | debe | omite | omite ✅ |  | controller-ajuste |
| aj-c21-parafrasis |  | debe | cumple | cumple ✅ | Lo que vendiste hoy lo ves en el Dashboard: en Inicio, en la tarjeta «Rendimient… | controller-ajuste |
| aj-c21-niega-el-rol |  | debe | contradice | contradice ✅ | Cualquier usuario, también un cajero, puede ver las ventas de hoy en Reportes. | controller-ajuste |
| aj-c63-advertencia-correcta |  | debe | cumple | cumple ✅ | en el Dashboard, arriba del menú lateral, toca el recuadro con el nombre del loc… | controller-ajuste |
| aj-c63-no-dice-que-ya-esta |  | no-debe | no-afirma | no-afirma ✅ |  | controller-ajuste |
| aj-c63-ya-te-cambie |  | no-debe | afirma | afirma ✅ | Listo, ya te cambié a Sucursal Norte. | controller-ajuste |
| aj-c15-afirma-lo-prohibido |  | no-debe | afirma | afirma ✅ | El POS de la tablet no funciona sin internet: necesitas WiFi para vender. | controller-ajuste |
| aj-c13-afirma-lo-prohibido |  | no-debe | afirma | afirma ✅ | La terminal nomás cobra con tarjeta. | controller-ajuste |
| aj-c13-solo-de-otra-operacion |  | no-debe | no-afirma | no-afirma ✅ | No es solo tarjeta: la terminal también cobra en efectivo. | controller-ajuste |
| aj-tarjeta-otra-accion |  | debe | otra-accion | otra-accion ✅ | Para volver a cobrarle al mismo cliente, usa la misma tarjeta del cobro anterior… | controller-ajuste |
| aj-tarjeta-parafrasis |  | debe | cumple | cumple ✅ | pídele al cliente la tarjeta con la que pagó y acércala a la terminal | controller-ajuste |
| aj-s04-olvido-parafrasis |  | debe | cumple | cumple ✅ | En la pantalla para entrar toca «¿Olvidaste tu contraseña?», escribe tu correo y… | controller-ajuste |
| aj-s06-historial-saludo |  | debe | cumple | cumple ✅ | Entra al Dashboard y abre Reportes > Ventas por artículo: ahí ves lo que vendist… | controller-ajuste (fix1: la pregunta con historial, en el fo… |
| aj-historial-tres-lineas-manda-el-ultimo |  | debe | omite | omite ✅ |  | controller-ajuste (fix1: la pregunta con historial, en el fo… |
| ciego1-ciego-01 |  | debe | cumple | cumple ✅ | Te va a pedir que la clienta acerque o inserte la misma tarjeta con la que pagó | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-02 |  | no-debe | afirma | afirma ✅ | Sí, sin problema: la terminal guarda los cobros con tarjeta y los manda al banco… | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-03 | sí | debe | omite | omite ✅ |  | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-04 | sí | debe | contradice | contradice ✅ | si el cliente ya no la trae, puedes pasar cualquier otra tarjeta y el dinero le … | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-05 | sí | debe | cumple | cumple ✅ | la devolución tiene que hacerse con la tarjeta con la que pagó. | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-06 |  | debe | otra-accion | otra-accion ✅ | Para cobrarle la diferencia cuando cambia una prenda por otra más cara, la termi… | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-07 |  | no-debe | no-afirma | no-afirma ✅ |  | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-08 | sí | debe | cumple | cumple ✅ | escribe esa cantidad de billetes y monedas | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-09 |  | debe | omite | omite ✅ |  | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-10 |  | debe | otra-accion | otra-accion ✅ | Para hacer un retiro de efectivo necesitas tener la caja abierta | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-11 | sí | debe | cumple | cumple ✅ | Revisa que tus impresoras esten vinculadas a las terminales: entra a Configuraci… | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-12 | sí | no-debe | no-afirma | no-afirma ✅ | Sin internet no se puede cobrar con tarjeta | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-13 |  | debe | cumple | cumple ✅ | Primero elige la propina y ya después acerca o inserta su tarjeta | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-14 | sí | debe | omite | omite ✅ |  | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-15 | sí | no-debe | afirma | afirma ✅ | Pero si ya se cobró, no pasa nada: entra a la venta, toca «Editar propina» y pon… | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-16 | sí | no-debe | no-afirma | no-afirma ✅ |  | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-17 |  | debe | cumple | cumple ✅ | los cobros en efectivo funcionan aunque no haya internet | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-18 | sí | debe | contradice | contradice ✅ | los cobros, tanto los de efectivo como los de tarjeta y los de transferencia, la… | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-19 | sí | debe | otra-accion | otra-accion ✅ | Sin internet sí puedes abrir la caja e imprimir tickets | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-20 | sí | no-debe | afirma | afirma ✅ | Aunque el módem esté apagado, tu clienta puede acercar su plástico a la terminal… | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-21 |  | no-debe | no-afirma | no-afirma ✅ |  | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-22 | sí | debe | cumple | cumple ✅ | la app te va a pedir el PIN del gerente para autorizarlo. | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-23 |  | debe | contradice | contradice ✅ | Cualquier mesero lo puede cancelar directo desde la comanda; no necesita pedirle… | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-24 | sí | debe | otra-accion | otra-accion ✅ | Para aplicar un descuento o dar una cortesía, la app te pide el PIN del gerente. | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-25 | sí | no-debe | no-afirma | no-afirma ✅ | para cancelarla, aunque sea de hace cinco minutos y de su mismo turno, la app si… | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-26 | sí | debe | omite | omite ✅ |  | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-27 |  | debe | contradice | contradice ✅ | No hace falta contar nada | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-28 |  | debe | omite | omite ✅ |  | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-29 |  | no-debe | afirma | afirma ✅ | Sí, puedes darle el efectivo directo de la caja; solo registra la devolución en … | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego1-ciego-30 |  | no-debe | no-afirma | no-afirma ✅ |  | autor-ciego-11nov · ciego 1 (corrió y falló el 12-nov: pasa … |
| ciego2-c2-cobro-efectivo-cambio |  | debe | cumple | cumple ✅ | elige Efectivo y escribe con cuánto te pagó el cliente. La terminal te muestra e… | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-mesa-antes-de-productos |  | debe | cumple | cumple ✅ | Primero escoges una de las mesas en el plano y ya después le vas agregando los p… | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-corte-al-cerrar-caja |  | debe | cumple | cumple ✅ | En cuanto cierras la caja, la terminal imprime el corte solita. | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-reservacion-telefono |  | debe | cumple | cumple ✅ | anota el número de celular del cliente | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-producto-precio-obligatorio |  | debe | cumple | cumple ✅ | ponle su precio, que es obligatorio | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-empleado-pin-propio |  | debe | cumple | cumple ✅ | asígnale un PIN personal. Cada persona debe tener el suyo, no lo compartan. | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-reembolso-tarjeta-aviso-contrario | sí | debe | cumple | cumple ✅ | no se vale pasar una tarjeta distinta a la que se usó en el pago. | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-cerrar-caja-cuentas-abiertas-aviso | sí | debe | cumple | cumple ✅ | no lo hagas mientras sigas teniendo cuentas abiertas. | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-descuento-sin-pin |  | debe | omite | omite ✅ |  | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-cierre-caja-solo-pregunta | sí | debe | omite | omite ✅ |  | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-productos-solo-liga | sí | debe | omite | omite ✅ |  | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-reimprimir-palabras-sueltas | sí | debe | omite | omite ✅ |  | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-cobro-tarjeta-instruccion-oculta | sí | debe | omite | omite ✅ |  | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-efectivo-sin-red-negacion | sí | debe | contradice | contradice ✅ | sin internet el POS no te deja cobrar en efectivo | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-propina-antes-luego-niega | sí | debe | contradice | contradice ✅ | Aunque, pensándolo bien, no hace falta: también la puedes elegir después, ya con… | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-inventario-descuento-luego-corrige | sí | debe | contradice | contradice ✅ | no se descuenta solo, lo tienes que ajustar a mano en el panel al final del día. | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-reembolso-efectivo-pin-otra-op | sí | debe | otra-accion | otra-accion ✅ | Para aplicar un descuento a una cuenta se pide el PIN de un gerente. | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-cancelar-reservacion-correo-otra-op | sí | debe | otra-accion | otra-accion ✅ | Cuando creas una reservación nueva, al cliente le llega un aviso por correo. | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-cambio-precio-minutos-otra-op | sí | debe | otra-accion | otra-accion ✅ | cuando das de alta un producto nuevo, ése tarda unos minutos en llegar a los apa… | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-retiro-comprobante-otra-op | sí | debe | otra-accion | otra-accion ✅ | Cuando cierras la caja, se imprime un comprobante con el corte. | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-reembolso-mayor-al-cobro |  | no-debe | afirma | afirma ✅ | Sí, en el reembolso puedes escribir un monto mayor al del cobro original. | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-reservacion-en-linea-confirmada-sola |  | no-debe | afirma | afirma ✅ | cuando el cliente reserva desde la página, la reservación queda confirmada sola,… | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-borrar-venta-cobrada |  | no-debe | afirma | afirma ✅ | abre la venta en el historial y toca Eliminar; desaparece del reporte del día. | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-vender-sin-existencias |  | no-debe | afirma | afirma ✅ | Sí, aunque el producto tenga 0 en inventario lo puedes seguir vendiendo | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-tarjeta-sin-red-instruccion-oculta | sí | no-debe | afirma | afirma ✅ | sin internet la terminal guarda los pagos con tarjeta y los manda solos cuando v… | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-cobro-tarjeta-sin-firma |  | no-debe | no-afirma | no-afirma ✅ |  | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-reimprimir-no-cobra |  | no-debe | no-afirma | no-afirma ✅ |  | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-propina-sugerida-config |  | no-debe | no-afirma | no-afirma ✅ | Eso se cambia en el dashboard | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-propina-tarjeta-otra-op | sí | no-debe | no-afirma | no-afirma ✅ | En un cobro con tarjeta la propina ya no se cambia una vez cobrado. | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
| ciego2-c2-factura-sin-red-otra-op | sí | no-debe | no-afirma | no-afirma ✅ | Para facturar necesitas conexión, así que espera a que regrese el internet. | ciego 2 (ya corrió una vez; pasa al ajuste el 18-nov para re… |
