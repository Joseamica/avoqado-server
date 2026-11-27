---
title: Canjear los puntos de lealtad de un cliente en el POS Android
description: Los puntos se canjean con «Recompensas» en una cuenta de Mesas o de «Pagar después»; en Cobrar, «Usar puntos» deja la venta para después y la abre.
product: android
category: lealtad
task: canjear-puntos
requiredPermissions:
  - orders:update
  - loyalty:read
featureCode: LOYALTY_PROGRAM
gateKind: FEATURE
money: true
versionMin: 2.25.59
sourceRepo: avoqado-android
sourceRef: a8dc4b6f2b14a982fc3cc6b82f6fdc11d93fd295
deviceTested: 2026-11-26
keywords:
  - canjear puntos
  - canjear recompensa
  - canjear recompensa no hace nada
  - dónde canjeo los puntos
  - usar los puntos del cliente
  - descuento con puntos de lealtad
  - recompensas en gris
  - no puedo canjear puntos en mostrador
  - canjear puntos en pagar después
  - recompensas en pedidos
  - cuenta con puntos canjeados sin internet
  - cuenta de pagar después con puntos
  - cuenta en cero con puntos
  - cerrar cuenta en 0
  - reintentar el canje
  - reintentar el canje no responde
  - cuenta pagada de más con puntos
  - no se sabe si el pago entró
  - usar puntos
  - usar puntos en cobrar
  - usar puntos en gris
  - canjear puntos desde cobrar
  - cancelar cuenta con puntos canjeados
---

## Antes de empezar

Los puntos se canjean en una cuenta de *Mesas* o en una cuenta de *Pagar después* (en *Pedidos*), con el cliente en la cuenta. En *Cobrar* (la venta de mostrador), *Usar puntos* deja la venta como cuenta de *Pagar después* y la abre en *Pedidos* para canjear (desde la versión 2.25.61; antes, en *Cobrar* sólo se ganaban). Desde la versión 2.25.59 el menú *⋯* del carrito ya no trae *Canjear recompensa*; en versiones anteriores esa opción sólo cerraba el menú.

Para canjear en *Mesas* hace falta:
- el aparato en modo *Mesas* (*Más* › *Modo*; sin él no sale la pestaña *Mesas*) y el servicio de mesas en el plan (si falta, *Mesas* dice «Esta función es parte del plan PRO»);
- permiso para ver las mesas, cambiar cuentas y ver los puntos del cliente (y para buscar clientes, si hay que agregarlo a la cuenta);
- que la cuenta sea tuya o que puedas editarla: si sale «Mesa de … — solo lectura», no se entra a *Cliente* ni a *Acciones*;
- internet.

## Pasos

1. Abre la cuenta en *Mesas*. En el teléfono, toca antes *Ver cheque*. En *Cliente*, toca *Asignar cliente* o *Cambiar cliente* (el que salga) y elige al cliente; si ya está el correcto, sigue.
2. En la pestaña *Acciones*, toca *Recompensas* (en la tableta, desliza un poco hacia arriba para verlo).
3. Sale el nombre del cliente con sus puntos disponibles y cuánto valen. Elige cuántos con *−* y *+*: debajo dice cuánto baja la cuenta.
4. Toca *Canjear*. La cuenta ya trae el descuento «Recompensas — … puntos» y el botón de pagar baja.
5. Si el cliente se arrepiente antes de pagar, en *Acciones* › *Descuentos*, en *Aplicados*, toca *Quitar* en la recompensa: sus puntos regresan.

## En una cuenta de «Pagar después»

Desde la versión 2.25.60. Hace falta el permiso para cambiar cuentas y ver los puntos del cliente, el programa de lealtad prendido, y internet. Sale en las cuentas que se dejaron con *Pagar después*; no en las de mesa ni en las de tarjetas de regalo.

1. En *Más*, toca *Pedidos* y abre la cuenta de *Pagar después* del cliente.
2. Debajo de *Cobrar $…*, toca *Recompensas*.
3. Sale el nombre del cliente con sus puntos disponibles y cuánto valen. Elige cuántos con *−* y *+*: debajo dice cuánto baja la cuenta.
4. Toca *Canjear*. Sale «Recompensa aplicada — … puntos por $…» y el botón *Cobrar $…* ya trae el descuento. Cóbrala como siempre.

En *Pedidos* los puntos pueden cubrir toda la cuenta. Si la cuenta queda en $0.00, su botón dice *Cerrar cuenta ($0.00)*: tócalo y la cuenta queda pagada, sin cobrar nada (igual que una cortesía en *Mesas*). Ahí no hay *Quitar* la recompensa: si se cancela la venta, los puntos regresan.

## Desde Cobrar: «Usar puntos»

Desde la versión 2.25.61. Hace falta lo mismo que en *Pagar después*, más el permiso para dejar cuentas por cobrar, productos del catálogo en la venta y el cliente en la venta.

1. En *Cobrar*, agrega los productos y el cliente (*Agregar cliente*).
2. En el menú *⋯* del carrito, toca *Usar puntos*.
3. Sale el cliente, el total de la venta y sus puntos disponibles, con el aviso «Se guardará una cuenta por cobrar a nombre de … y se abrirá en Pedidos para canjear…». Toca *Continuar*. Si un descuento de la venta pide su motivo, sale primero esa ventana.
4. La venta queda como cuenta de *Pagar después* y se abre sola en *Más* › *Pedidos*, con *Recompensas* abierto. Sigue desde el paso 3 de «En una cuenta de «Pagar después»»: elige los puntos, toca *Canjear* y cóbrala.

*Continuar* no gasta puntos: se descuentan al tocar *Canjear*. Si el cliente ya no quiere pagar, la cuenta sigue en *Pedidos*: se cobra normal (sin canjear) o se cancela en el panel web, en *Cuentas por cobrar*, con *Cancelar orden* en el menú de la cuenta (hace falta el permiso para cancelar cuentas sin cobrar y que no tenga nada pagado). Si ya se canjearon puntos, al cancelarla regresan. En el POS no se cancela.

## Problemas frecuentes

- Si *Recompensas* está en gris, tócalo: dice por qué. Por ejemplo «Esta cuenta no tiene puntos para canjear. Agrega el cliente en la pestaña «Cliente».», que no llega al mínimo de puntos, que el programa de lealtad está apagado (se prende desde el panel web) o que la cuenta ya tiene un pago registrado.
- Si al canjear sale «La cuenta cambió: revisa los puntos.», no se canjeó nada: cambió la cuenta, el programa o el saldo del cliente (por ejemplo, gastó puntos en otra cuenta). La app vuelve a leer la cuenta y los puntos: espera la oferta nueva y, si *Canjear* se prende, revísala y tócalo. Si sigue en gris, revisa que elegiste al menos el mínimo de puntos (y al menos 1) y lo que diga el diálogo.
- *Quitar* la recompensa ya no se puede si la cuenta tiene un pago registrado («No se puede modificar una orden ya pagada»): los puntos se quedan canjeados.
- En *Cobrar*, *Usar puntos* sale en gris con el carrito vacío. Con productos, su ventana dice por qué no se puede: «Agrega el cliente para usar sus puntos.», que no tienes permiso para canjear o para dejar cuentas por cobrar, o que no llega al mínimo de puntos.
- Si sale «Con cupón, premio de sellos o un descuento que pide aprobación, usa «Pagar después» y canjea los puntos en Más › Pedidos.», usa *Atajos* › *Pagar después* y después *Recompensas* en *Pedidos*.
- Si sale «Esta venta ya se mandó una vez a «Pagar después»…», termínala desde *Atajos* › *Pagar después* y canjea los puntos en *Más* › *Pedidos*.
- Si sale «El cliente cambió: vuelve a tocar «Usar puntos».», no se guardó nada: revisa el cliente de la venta y vuelve a intentarlo.
- Si sale «No hay productos válidos para crear la orden», la venta sólo trae importes tecleados: una cuenta para después necesita productos del catálogo.
- Si *Pedidos* se abre pero *Recompensas* no, abajo dice por qué con el folio (por ejemplo «La cuenta #… quedó en Pedidos: …» o «La cuenta #… ya no está abierta (pagada o cancelada): ya no admite puntos.»). Si saliste de *Pedidos* antes de que cargara, abre la cuenta a mano y toca *Recompensas*.
- En *Pedidos*, si *Recompensas* está en gris, el texto de abajo dice por qué: sin internet, sin permiso («No tienes permiso para canjear puntos. Pídeselo a tu gerente.»), la cuenta sin cliente, un cobro de esta caja que todavía no sube, la cuenta en el carrito o pocos puntos.
- Si sale «Hay un cobro con tarjeta en curso en la terminal para esta cuenta: espera a que termine para canjear puntos.», no se canjeó nada: termina o cancela ese cobro y vuelve a intentarlo.
- Si al cobrar con terminal sale «La cuenta … tiene puntos canjeados: falta $…», la pantalla de cobro tenía el importe de antes del canje: sal del cobro, vuelve a abrir la cuenta y cobra lo que falta.
- Si el canje se quedó sin respuesta (se fue la red o tardó), sale «No se sabe si el canje entró…» y el botón cambia a *Reintentar el canje*: toca ese botón. Manda lo mismo y nunca canjea dos veces: si el primero ya había entrado, sale «Recompensa aplicada…» con ese mismo canje. En una versión anterior del POS puede salir «No se volvió a canjear: la cuenta ya cambió…»: revisa que la cuenta traiga el descuento «Recompensas».
- Mientras se canjea, o si un canje se quedó sin respuesta, *Cobrar* no se abre en esa cuenta (sin internet sale «Hay un canje de puntos sin terminar en esta cuenta…»): reintenta el canje con red y después cóbrala.
- Si con internet *Reintentar el canje* sigue sin traer respuesta (por ejemplo, porque el programa de lealtad se apagó en el panel mientras tanto), cierra la app y vuelve a abrirla: la cuenta se vuelve a leer y dice si trae el descuento «Recompensas». Después cóbrala con red.
- En una cuenta con puntos canjeados, si al cobrar sale «No se sabe si el pago entró…» (se fue la red o el servidor tardó), toca *Reintentar* con conexión: si el pago ya había entrado, no se cobra otra vez. No la vuelvas a cobrar desde el principio.
- Si la app se cerró a media canje, al volver revisa que la cuenta traiga el descuento «Recompensas» antes de cobrarla. Si ya se cobró por el importe de antes (por ejemplo, con *Ya pagó de otra forma*) y el descuento entró después, la cuenta queda pagada de más: devuelve la diferencia con un reembolso.

## Sin internet

- Sin conexión, *Recompensas* sale en gris con «Sin conexión: canjear puntos necesita internet. Se puede en cuanto vuelva la red.», en *Mesas* y en *Pedidos*. No se canjea nada: vuelve a tocarlo cuando regrese la red.
- Quitar la recompensa también necesita internet.
- Sin conexión, la ventana de *Usar puntos* dice «Sin conexión: canjear puntos necesita internet. Se puede en cuanto vuelva la red.» y no sale *Continuar*; al volver la red vuelve a leer los puntos y sale *Continuar*.
- Si la red o el servidor fallan justo al tocar *Continuar*, sale «La cuenta de … quedó guardada en el aparato y se sube sola. Cuando suba, canjea los puntos en Más › Pedidos.». No la vuelvas a mandar: nunca se crea dos veces. Cuando suba, ábrela en *Pedidos* y canjea.
- Una cuenta de *Pagar después* en la que esta caja canjeó (o intentó canjear) puntos no se cobra sin internet desde esta caja: en *Pedidos* sale «Esta cuenta tiene puntos canjeados: se cobra con conexión. Espera a que vuelva la red.». Sin red la caja no puede saber si la cuenta ya trae el descuento. Cóbrala cuando regrese la red.
