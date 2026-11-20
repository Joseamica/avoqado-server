---
title: Cobrar la cuenta de una mesa en la terminal
description: Cobra la cuenta de una mesa completa o dividida en partes iguales, por monto o por artículo, en efectivo o con tarjeta, desde la terminal.
product: tpv
category: mesas
task: cobrar-cuenta-de-mesa
requiredPermissions:
  - payments:create
featureCode: TABLE_SERVICE
gateKind: FEATURE
money: true
versionMin: 2.13.2
sourceRepo: avoqado-tpv
sourceRef: 4c92a98fab1256782524e72748f44bfe99e2052d
deviceTested: 2026-11-18
keywords:
  - cobrar mesa
  - pagar la cuenta
  - dividir la cuenta
  - partes iguales
  - pagar por separado
  - cuenta de la mesa
  - no me deja quitar el descuento
  - quitar en gris
  - rebaja fija
---

## Antes de empezar

En la cuenta de la mesa, *Pagar* sale cuando ya se envió algo a cocina, y se prende cuando no queda nada por enviar.

## Pasos

1. En la cuenta de la mesa, toca *Pagar*.
2. En *Cómo dividir el cobro*, deja *Cuenta completa* o elige *Monto personalizado*, *Partes iguales* o *Por artículo*.
3. Monto personalizado: escribe el *Monto a cobrar*. Partes iguales: ajusta *Dividir entre* y *Cobrando*. Por artículo: marca los productos.
4. Si pagan en efectivo y dejan propina, escríbela en pesos en *Propina (opcional)*.
5. Toca *Efectivo* o *Tarjeta*. Con efectivo sale *Cobro registrado*: toca *Cerrar*. Con tarjeta, cobra como en cualquier cobro con tarjeta.
6. Si queda algo por cobrar: después del efectivo se ve en *Restante*; después de la tarjeta, toca *Continuar pagando* y luego *Pagar* otra vez.

## Problemas frecuentes

- En versiones anteriores a la 2.21, con *Tarjeta* no se cobra lo escrito en *Propina (opcional)*: esa casilla es para el efectivo.
- En versiones anteriores a la 2.21, al cobrar la cuenta en partes, lo escrito en *Propina (opcional)* se queda después de un cobro en efectivo y el siguiente cobro en efectivo lo vuelve a sumar: antes de cobrar la siguiente parte, revisa que la propina esté como debe.
- *Por artículo* sólo se cobra con tarjeta: el botón de efectivo dice *Efectivo no disponible*.
- Si la mesa la atiende otro mesero y el negocio sólo deja cambiar su cuenta a quien la atiende, *Pagar* sólo sale a quien tiene permiso para cobrar cualquier mesa.
- En la Nexgo, si la división no es *Cuenta completa*, sale «División no disponible en este equipo — cobra el total o usa efectivo».
- Si un descuento dice «Fija: viene del cobro de vales» y su botón de quitar (−) sale en gris, al tocar el renglón aparece «Rebaja fija»: «Esta rebaja quedó fija al cobrar los vales y no se quita desde la caja. Si hay que cambiarla, avisa a un encargado.». Toca *Entendido*: esa rebaja no se quita desde la terminal. En versiones anteriores a la 2.22.1, el botón se ve activo y al tocarlo sale «Este descuento quedó fijo al cobrar los vales y no se quita desde la caja…».

## Sin internet

- Sin conexión, el botón dice *Tarjeta no disponible* y la cuenta se queda abierta: cobra en *Efectivo*.
- Si el efectivo se cobró sin conexión, sale *Cobro guardado*: el cobro quedó guardado en la terminal. Cuando vuelva el internet, regresa al inicio y abre *Mesas* para que se envíe.
