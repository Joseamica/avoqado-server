---
title: Canjear los puntos de lealtad de un cliente en el POS Windows
description: Los puntos se canjean con «Recompensas» en una cuenta de Mesas o de «Pagar después» (en Pedidos); en Cobrar (mostrador) todavía no se canjean.
product: windows
category: lealtad
task: canjear-puntos
requiredPermissions:
  - tables:read
  - orders:update
  - loyalty:read
featureCode: LOYALTY_PROGRAM
gateKind: FEATURE
money: true
versionMin: 2.25.59
sourceRepo: avoqado-android
sourceRef: 98a114df07c2eb0a6a3e7d1c336e6c152de38a1b
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
---

## Antes de empezar

Los puntos se canjean en una cuenta de *Mesas* o en una cuenta de *Pagar después* (en *Pedidos*), con el cliente en la cuenta. En *Cobrar* (la venta de mostrador) todavía no se canjean: ahí sólo se ganan. Desde la versión 2.25.59 el menú *⋯* del carrito ya no trae *Canjear recompensa*; en versiones anteriores esa opción sólo cerraba el menú.

Para canjear en *Mesas* hace falta:
- el aparato en modo *Mesas* (*Más* › *Modo*; sin él no sale la pestaña *Mesas*) y el servicio de mesas en el plan (si falta, *Mesas* dice «Esta función es parte del plan PRO»);
- permiso para ver las mesas, cambiar cuentas y ver los puntos del cliente (y para buscar clientes, si hay que agregarlo a la cuenta);
- que la cuenta sea tuya o que puedas editarla: si sale «Mesa de … — solo lectura», no se entra a *Cliente* ni a *Acciones*;
- internet.

## Pasos

1. Abre la cuenta en *Mesas*. Con la ventana angosta, toca antes *Ver cheque*. En *Cliente*, toca *Asignar cliente* o *Cambiar cliente* (el que salga) y elige al cliente; si ya está el correcto, sigue.
2. En la pestaña *Acciones*, toca *Recompensas* (si no se ve, baja la lista).
3. Sale el nombre del cliente con sus puntos disponibles y cuánto valen. Elige cuántos con *−* y *+*: debajo dice cuánto baja la cuenta.
4. Toca *Canjear*. La cuenta ya trae el descuento «Recompensas — … puntos» y el botón de pagar baja.
5. Si el cliente se arrepiente antes de pagar, en *Acciones* › *Descuentos*, en *Aplicados*, toca *Quitar* en la recompensa: sus puntos regresan.

## En una cuenta de «Pagar después»

Desde la versión 2.25.60. Hace falta el permiso para cambiar cuentas y ver los puntos del cliente, el programa de lealtad prendido, y internet. Sale en las cuentas que se dejaron con *Pagar después*; no en las de mesa ni en las de tarjetas de regalo.

1. En *Más*, da clic en *Pedidos* y abre la cuenta de *Pagar después* del cliente.
2. Debajo de *Cobrar $…*, toca *Recompensas*.
3. Sale el nombre del cliente con sus puntos disponibles y cuánto valen. Elige cuántos con *−* y *+*: debajo dice cuánto baja la cuenta.
4. Toca *Canjear*. Sale «Recompensa aplicada — … puntos por $…» y el botón *Cobrar $…* ya trae el descuento. Cóbrala como siempre.

En *Pedidos* los puntos pueden cubrir toda la cuenta. Si la cuenta queda en $0.00, su botón dice *Cerrar cuenta ($0.00)*: da clic en él y la cuenta queda pagada, sin cobrar nada (igual que una cortesía en *Mesas*). Ahí no hay *Quitar* la recompensa: si se cancela la venta, los puntos regresan.

## Problemas frecuentes

- Si *Recompensas* está en gris, tócalo: dice por qué. Por ejemplo «Esta cuenta no tiene puntos para canjear. Agrega el cliente en la pestaña «Cliente».», que no llega al mínimo de puntos, que el programa de lealtad está apagado (se prende desde el panel web) o que la cuenta ya tiene un pago registrado.
- Si al canjear sale «La cuenta cambió: revisa los puntos.», no se canjeó nada: cambió la cuenta, el programa o el saldo del cliente (por ejemplo, gastó puntos en otra cuenta). La app vuelve a leer la cuenta y los puntos: espera la oferta nueva y, si *Canjear* se prende, revísala y tócalo. Si sigue en gris, revisa que elegiste al menos el mínimo de puntos (y al menos 1) y lo que diga el diálogo.
- *Quitar* la recompensa ya no se puede si la cuenta tiene un pago registrado («No se puede modificar una orden ya pagada»): los puntos se quedan canjeados.
- Si en *Cobrar* buscas cómo canjear: ahí no se puede todavía. Para usar los puntos, la venta tiene que ser una cuenta de *Mesas* o de *Pagar después*.
- En *Pedidos*, si *Recompensas* está en gris, el texto de abajo dice por qué: sin internet, sin permiso («No tienes permiso para canjear puntos. Pídeselo a tu gerente.»), la cuenta sin cliente, un cobro de esta caja que todavía no sube, la cuenta en el carrito o pocos puntos.
- Si sale «Hay un cobro con tarjeta en curso en la terminal para esta cuenta: espera a que termine para canjear puntos.», no se canjeó nada: termina o cancela ese cobro y vuelve a intentarlo.
- Si al cobrar con terminal sale «La cuenta … tiene puntos canjeados: falta $…», la pantalla de cobro tenía el importe de antes del canje: sal del cobro, vuelve a abrir la cuenta y cobra lo que falta.
- Si el canje se quedó sin respuesta (se fue la red o tardó), sale «No se sabe si el canje entró…» y el botón cambia a *Reintentar el canje*: da clic en ese botón. Manda lo mismo y nunca canjea dos veces: si el primero ya había entrado, sale «Recompensa aplicada…» con ese mismo canje. En una versión anterior del POS puede salir «No se volvió a canjear: la cuenta ya cambió…»: revisa que la cuenta traiga el descuento «Recompensas».
- Mientras se canjea, o si un canje se quedó sin respuesta, *Cobrar* no se abre en esa cuenta (sin internet sale «Hay un canje de puntos sin terminar en esta cuenta…»): reintenta el canje con red y después cóbrala.
- Si con internet *Reintentar el canje* sigue sin traer respuesta (por ejemplo, porque el programa de lealtad se apagó en el panel mientras tanto), cierra el POS y vuelve a abrirlo: la cuenta se vuelve a leer y dice si trae el descuento «Recompensas». Después cóbrala con red.
- En una cuenta con puntos canjeados, si al cobrar sale «No se sabe si el pago entró…» (se fue la red o el servidor tardó), toca *Reintentar* con conexión: si el pago ya había entrado, no se cobra otra vez. No la vuelvas a cobrar desde el principio.
- Si la app se cerró a media canje, al volver revisa que la cuenta traiga el descuento «Recompensas» antes de cobrarla. Si ya se cobró por el importe de antes (por ejemplo, con *Ya pagó de otra forma*) y el descuento entró después, la cuenta queda pagada de más: devuelve la diferencia con un reembolso.

## Sin internet

- Sin conexión, *Recompensas* sale en gris con «Sin conexión: canjear puntos necesita internet. Se puede en cuanto vuelva la red.», en *Mesas* y en *Pedidos*. No se canjea nada: vuelve a tocarlo cuando regrese la red.
- Quitar la recompensa también necesita internet.
- Una cuenta de *Pagar después* en la que esta caja canjeó (o intentó canjear) puntos no se cobra sin internet desde esta caja: en *Pedidos* sale «Esta cuenta tiene puntos canjeados: se cobra con conexión. Espera a que vuelva la red.». Sin red la caja no puede saber si la cuenta ya trae el descuento. Cóbrala cuando regrese la red.
