---
title: Canjear los puntos de lealtad de un cliente en el POS Windows
description: Los puntos se canjean en una cuenta de Mesas, con «Recompensas»; en Cobrar (venta de mostrador) todavía no se canjean.
product: windows
category: lealtad
task: canjear-puntos
requiredPermissions:
  - tables:read
  - orders:update
  - loyalty:read
  - customers:read
featureCode: LOYALTY_PROGRAM
gateKind: FEATURE
money: true
versionMin: 2.25.59
sourceRepo: avoqado-android
sourceRef: 06e8011534e2d36bd738d707e68c73b08f06b71e
keywords:
  - canjear puntos
  - canjear recompensa
  - canjear recompensa no hace nada
  - dónde canjeo los puntos
  - usar los puntos del cliente
  - descuento con puntos de lealtad
  - recompensas en gris
  - no puedo canjear puntos en mostrador
---

## Antes de empezar

Los puntos se canjean en una cuenta de *Mesas*, con el cliente en la cuenta. En *Cobrar* (la venta de mostrador) todavía no se canjean: ahí sólo se ganan. Desde la versión 2.25.59 el menú *⋯* del carrito ya no trae *Canjear recompensa*; en versiones anteriores esa opción sólo cerraba el menú.

Para canjear hace falta:
- el aparato en modo *Mesas* (*Más* › *Modo*; sin él no sale la pestaña *Mesas*) y el servicio de mesas en el plan (si falta, *Mesas* dice «Esta función es parte del plan PRO»);
- permiso para ver las mesas, cambiar cuentas, ver los puntos del cliente y buscar clientes;
- que la cuenta sea tuya o que puedas editarla: si sale «Mesa de … — solo lectura», no se entra a *Cliente* ni a *Acciones*;
- internet.

## Pasos

1. Abre la cuenta en *Mesas*. Con la ventana angosta, toca antes *Ver cheque*. En *Cliente*, toca *Asignar cliente* (o *Cambiar cliente* si tiene otro) y elige al cliente; si ya está el correcto, sigue.
2. En la pestaña *Acciones*, toca *Recompensas* (si no se ve, baja la lista).
3. Sale el nombre del cliente con sus puntos disponibles y cuánto valen. Elige cuántos con *−* y *+*: debajo dice cuánto baja la cuenta.
4. Toca *Canjear*. La cuenta ya trae el descuento «Recompensas — … puntos» y el botón de pagar baja.
5. Si el cliente se arrepiente antes de pagar, en *Acciones* › *Descuentos*, en *Aplicados*, toca *Quitar* en la recompensa: sus puntos regresan.

## Problemas frecuentes

- Si *Recompensas* está en gris, tócalo: dice por qué. Por ejemplo «Esta cuenta no tiene puntos para canjear. Agrega el cliente en la pestaña «Cliente».», que no llega al mínimo de puntos, que el programa de lealtad está apagado (se prende desde el panel web) o que la cuenta ya tiene un pago registrado.
- Si al canjear sale «La cuenta cambió: revisa los puntos.», no se canjeó nada: cambió la cuenta, el programa o el saldo del cliente (por ejemplo, gastó puntos en otra cuenta). La app vuelve a leer la cuenta y los puntos: espera la oferta nueva y, si *Canjear* se prende, revísala y tócalo; si sale en gris, el diálogo dice por qué.
- *Quitar* la recompensa ya no se puede si la cuenta tiene un pago registrado («No se puede modificar una orden ya pagada»): los puntos se quedan canjeados.
- Si en *Cobrar* buscas cómo canjear: ahí no se puede todavía. Para usar los puntos, la venta tiene que ser una cuenta de *Mesas*.

## Sin internet

- Sin conexión, *Recompensas* sale en gris con «Sin conexión: canjear puntos necesita internet. Se puede en cuanto vuelva la red.». No se canjea nada: vuelve a tocarlo cuando regrese la red.
- Quitar la recompensa también necesita internet.
