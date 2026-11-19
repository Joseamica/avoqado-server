---
title: Abrir una mesa y enviar la orden a cocina en la terminal
description: Abre una mesa en Mesas, agrega productos a su cuenta y envía la ronda a cocina desde la terminal.
product: tpv
category: mesas
task: abrir-mesa-y-enviar-ronda
requiredPermissions:
  - tables:update
  - orders:create
featureCode: TABLE_SERVICE
gateKind: FEATURE
versionMin: 2.9.1
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
keywords:
  - abrir mesa
  - tomar orden
  - mandar a cocina
  - enviar comanda
  - agregar productos a la mesa
  - ronda
---

## Antes de empezar

El botón *Mesas* sale en el inicio cuando la terminal tiene encendido el *Modo Restaurante*. Si dice *Plan Pro*, el plan del negocio no incluye mesas.

## Pasos

1. En el inicio, toca *Mesas*.
2. Toca una mesa libre, ajusta los *Comensales* y toca *Abrir mesa y ordenar*. Si la mesa ya está ocupada, toca *Ver cuenta*.
3. Toca *Agregar productos* y toca cada producto. Si el producto pide opciones, elígelas y toca *Agregar*.
4. Toca *Listo*: lo que agregaste sale en *Por enviar*.
5. Toca *Enviar ronda*: sale «Ronda enviada a cocina».

## Problemas frecuentes

- «Mesa de … — solo lectura»: la mesa la atiende otro mesero y el negocio sólo deja cambiar su cuenta a quien la atiende.
- «La cuenta cambió en otro dispositivo — se actualizó, revisa antes de reenviar»: revisa la cuenta y vuelve a tocar *Enviar ronda*.
- «No se pudo cargar la cuenta — puede que ya tenga productos.»: toca *Reintentar* antes de agregar productos.

## Sin internet

- Sin conexión, *Agregar productos* no carga el menú: sale «Sin conexión. Verifica tu red e intenta de nuevo.».
- Si la conexión se cae al enviar, sale «Sin conexión — ronda guardada; se sincronizará sola» y esos productos dicen *Por sincronizar*: la ronda quedó guardada en la terminal.
