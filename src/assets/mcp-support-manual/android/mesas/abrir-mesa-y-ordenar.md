---
title: Abrir una mesa y mandar la orden a cocina en el POS Android
description: Abre una mesa libre, agrega los productos y envía la ronda a cocina desde Mesas en el POS Android.
product: android
category: mesas
task: abrir-mesa-y-ordenar
requiredPermissions:
  - tables:read
  - menu:read
  - orders:create
featureCode: TABLE_SERVICE
gateKind: FEATURE
sourceRepo: avoqado-android
sourceRef: 843c15ae06bf68dd0d9c755525a9971e701052b7
keywords:
  - abrir mesa
  - tomar la orden
  - mandar a cocina
  - enviar comanda
  - agregar productos a la mesa
  - ronda
---

## Antes de empezar

*Mesas* sale cuando el aparato está en el modo *Mesas*; si el plan no incluye el servicio de mesas, al entrar dice «Esta función es parte del plan …». Abrir una mesa libre pide además el permiso de editar mesas.

## Pasos

1. En *Mesas*, toca una mesa libre.
2. Ajusta los *Comensales* con − y + y toca *Abrir mesa y ordenar*, o toca *Sin comensales*.
3. Toca los productos para agregarlos; si un producto tiene opciones, elígelas y toca *Agregar al carrito*.
4. Toca *Enviar* para mandar la ronda a cocina. En el teléfono, toca antes *Ver cheque*.
5. Toca *Guardar* para regresar a *Mesas*.
6. Para otra ronda, toca la mesa ocupada, agrega los productos y vuelve a tocar *Enviar*.

## Problemas frecuentes

- *Pagar* no responde mientras haya productos sin enviar: toca primero *Enviar*.
- Si al salir aparece «Artículos sin enviar», *Descartar y salir* borra lo que no enviaste; para conservarlo, cierra el aviso y toca *Enviar*.
- Una mesa reservada no se abre aquí: se abre desde el check-in de su reservación.
- Si aparece «… está atendiendo esta mesa en otro dispositivo», otro aparato ya tiene esa mesa: aquí no se abre.
- Si aparece «Mesa de … — solo lectura», la mesa es de otro mesero: pídele a él que agregue los productos.

## Sin internet

- Sin conexión la mesa se abre igual en el aparato, salvo que otro aparato ya la tenga (el aviso de «otro dispositivo» de arriba).
- Si aparece «Sin conexión — ronda guardada; se sincronizará sola» o «No se pudo confirmar la ronda — se guardó; se reintentará sola», la ronda quedó guardada en el aparato y se manda sola: no la vuelvas a capturar.
