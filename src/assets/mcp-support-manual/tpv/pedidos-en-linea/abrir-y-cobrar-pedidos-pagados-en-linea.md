---
title: Abrir y cobrar los pedidos pagados en línea en la terminal
description: Abre con Abrir y cobrar el pedido en línea pagado con tarjeta por el que suena la terminal, entrégalo y qué hacer si no lo recogen o sale pendiente en el banco.
product: tpv
category: pedidos-en-linea
task: abrir-y-cobrar-pedidos-pagados-en-linea
requiredPermissions:
  - orders:update
money: true
versionMin: 2.23.0
sourceRepo: avoqado-tpv
sourceRef: f659760ee224d71b54f4abf3d2ede18d73f7cc91
deviceTested: 2026-11-21
keywords:
  - pedido pagado en línea
  - abrir y cobrar
  - la terminal suena
  - no deja de sonar
  - pedidos por pagar
  - pagados en línea
  - la comanda no salió
  - me cobraron y no recogí
  - no lo recogió
  - no me deja pagar en línea
  - me salió pendiente en el banco
---

## Antes de empezar

Esto pasa cuando en el panel el negocio eligió «No, entran solos» y prendió «Pagar en línea»: la clienta pagó con tarjeta al pedir y su dinero quedó apartado. Se cobra cuando una caja abre el pedido con *Abrir y cobrar*; si nadie lo abre en 10 minutos (o antes, si cierra la tienda), se libera y no se le cobra.

Mientras haya uno por abrir, la terminal suena cada 4 segundos (con el volumen de notificaciones), arriba sale «Pedido pagado en línea · ábrelo para cobrar» con *Ver* (con varios, «… (2 por abrir)») y el recuadro *Pedidos por pagar* del inicio dice «1 pagado en línea». En medio de un cobro con tarjeta la banda no sale, pero sigue sonando.

Abrirlo pide el permiso de actualizar pedidos; sin él, el pedido dice «Pide a quien pueda atender pedidos que lo abra.». Si el negocio pide registrar la entrada o abrir turno, la banda dice «Registra tu entrada para abrir el pedido pagado» o «Abre tu turno para abrir el pedido pagado» hasta que lo hagas.

## Pasos

1. Toca *Ver* en la banda, o *Pedidos por pagar* en el inicio.
2. En «Pagados en línea · ábrelo para cobrar», toca *Abrir y cobrar* en ese pedido. No se pasa tarjeta: se cobra la tarjeta con la que la clienta pagó.
3. Sale «El pedido … ya está en «Por entregar».»: ya se cobró, deja de sonar y su comanda sale sola.
4. Cuando llegue la clienta, búscala con *Folio o nombre* (manda lo que dice la terminal, no la pantalla de su celular). En «Por entregar», toca *Listo* cuando esté preparado y *Entregado* cuando se lo lleve.

## Problemas frecuentes

- «Cobrándose en otra caja…» en el botón: otra caja lo está abriendo; espera.
- «Este pedido ya se abrió» con «El pedido … ya está en «Por entregar».»: otra caja ya lo cobró. Toca *Ver en «Por entregar»* y entrégalo desde ahí.
- «Este pedido ya se cerró» con «El pedido … ya está cerrado: no hay nada que abrir.»: ya se entregó, se cerró como «No lo recogió» o se devolvió.
- «Ese pedido ya no está disponible» con «Se liberó sin cobrarse o venció. No se cobró nada.»: nadie lo abrió a tiempo o su cobro falló; no se le cobró.
- «Confirmando el pago con el banco. Espera unos segundos.»: espera; no lo cobres de otra forma.
- «No se pudo confirmar» con «La lista se está actualizando y dirá dónde quedó el pedido; nunca se cobra dos veces.»: espera a que la lista se actualice y revisa si está en «Por entregar».
- «No se abrió el pedido» con otro texto: ese texto dice por qué.
- La comanda sale sola, una vez, en una terminal o POS con impresora. Si la de un pedido que abrió esta terminal no salió aquí (por ejemplo, una terminal sin impresora), arriba sale «La comanda del pedido … no salió en esta terminal: avísale a cocina» (con varias, «2 comandas no salieron en esta terminal: avísale a cocina»): avisa a cocina y toca *Entendido*.
- Si una comanda trae arriba «*** POSIBLE REPETIDA *** revisa si ya salió», pregunta en cocina si ya la tenían antes de prepararla otra vez.
- Si en «Por entregar» un pedido dice «Devolviendo…», ya no se entrega: no salen *Listo* ni *Entregado*. Un pedido devuelto, entregado o que nadie recogió al terminar el día sale de «Por entregar».
- Si la clienta dice «me cobraron y no recogí» o cambió de opinión: no se le devuelve solo. Lo decide el negocio, y se devuelve desde el panel, a su tarjeta o como saldo a favor; la terminal no devuelve estos pedidos.
- Si la clienta dice que no le deja pagar en línea: la tienda sólo ofrece «Pagar ahora con tarjeta» mientras una caja actualizada esté avisando los pedidos pagados (esta terminal con la app al frente, con sesión e internet, u otra caja actualizada) y la tienda esté abierta. Si no, sólo se ofrece pagar en caja. En el panel, *Configuración* de *Pedidos en línea* dice si hoy se ofrece.
- Si la clienta dice que le salió un cargo pendiente en su banco: si el pedido sigue en «Pagados en línea · ábrelo para cobrar», su dinero está apartado y se cobra al tocar *Abrir y cobrar*. Si nadie lo abrió a tiempo, se liberó y no se le cobró; quitar el pendiente depende de su banco.
- Si no suena, revisa el volumen de notificaciones de la terminal.

## Sin internet

- Si la lista ya estaba abierta cuando se fue la red, el botón dice «Abrir y cobrar necesita conexión»: no se abre, no se cobra y nada queda guardado para después. Con una lista vieja la terminal no suena.
- Si abres *Pedidos por pagar* ya sin red, los pagados en línea no aparecen. Arriba sale «Pedidos por pagar · Sin conexión: los pedidos nuevos no se ven. Cobra en "Cobrar" como venta normal. Si ya pagó en línea, no lo cobres: ábrelo cuando vuelva la conexión.». Si la clienta dice que ya pagó en línea, no la cobres en caja.
- Si la conexión se cae al tocarlo y sale «Sin conexión: no se pudo confirmar. Al volver la conexión la lista dice dónde quedó; nunca se cobra dos veces.», no hagas nada más: al volver la red, revisa si está en «Por entregar».
- Si la red vuelve antes de los 10 minutos, el pedido vuelve a sonar y se abre normal; si no, se libera y no se cobra. Mientras ninguna caja tenga internet, la tienda deja de ofrecer «Pagar ahora con tarjeta» y sólo se puede pagar en caja.
