---
title: Asignar el cliente o cambiar los comensales de una mesa en el POS Windows
description: En la cuenta de una mesa, liga un cliente desde la pestaña Cliente, cámbialo o quítalo, y ajusta cuántos comensales son.
product: windows
category: mesas
task: cliente-y-comensales-de-la-mesa
requiredPermissions:
  - orders:update
featureCode: TABLE_SERVICE
gateKind: FEATURE
versionMin: 2.25.45
sourceRepo: avoqado-android
sourceRef: 78e5372f37ed7791d86fc1fe621d4a073e5a09ff
keywords:
  - asignar cliente a la mesa
  - cliente de la mesa
  - cambiar cliente de la cuenta
  - número de comensales
  - cuántas personas en la mesa
  - conteo de clientes
---

## Antes de empezar

Es en la cuenta de una mesa abierta desde *Mesas*. A la derecha están las pestañas *Cuenta*, *Acciones* y *Cliente*. Guardar el cliente o los comensales pide el permiso de editar órdenes y poder cambiar esa mesa; buscar al cliente pide además ver clientes. Desde aquí sólo se eligen clientes que ya existen.

## Pasos

1. En *Mesas*, toca la mesa para abrir su cuenta.
2. Para ligar un cliente, abre la pestaña *Cliente* y toca *Asignar cliente*.
3. Búscalo por su nombre, teléfono o correo y tócalo: queda como «Cliente de la cuenta» y sale «Cuenta actualizada».
4. Para cambiarlo, toca *Cambiar cliente*; para quitarlo, toca *Quitar*.
5. Para los comensales, en la pestaña *Acciones* toca *Conteo de clientes*, ajusta *Comensales* con − y + y toca *Guardar*.

## Problemas frecuentes

- Si el cliente no existe, créalo antes en *Más* › *Clientes* y vuelve a *Asignar cliente*.
- Si sale «No se pudo actualizar la cuenta» (o un aviso de permiso), no se guardó: puede faltarte el permiso o la mesa es de otro mesero y el negocio sólo deja cambiarla a quien la atiende. Si se repite, revisa que la cuenta siga abierta.
- *Comensales* va de 1 a 200.
