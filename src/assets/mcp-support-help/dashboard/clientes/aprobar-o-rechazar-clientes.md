---
title: Aprobar o rechazar a los clientes que esperan aprobación
description: Cuando el negocio aprueba a mano cada cuenta nueva, aprueba o rechaza desde Clientes a quien creó su cuenta para reservar o comprar paquetes en línea.
product: dashboard
category: clientes
dashboardRoutes:
  - customers
  - reservations/settings
roles:
  - OWNER
  - ADMIN
lastVerified: 2026-11-25
sourceRepo: avoqado-web-dashboard
sourceRef: 501e37072a13f5ed8f22e3d650f2598d3d8820b6
relatedArticles:
  - gestionar-clientes
  - configurar-reservaciones-avanzadas
keywords:
  - aprobar cliente
  - rechazar cliente
  - cliente en espera de aprobación
  - el cliente no puede reservar
  - cuenta pendiente de aprobar
  - aprobar cuenta nueva
---

## Antes de empezar

La sección **En espera de aprobación** sale arriba de **Clientes > Todos los Clientes** sólo cuando hay alguien esperando y tienes el permiso de aprobar clientes (de fábrica, el administrador y el dueño). Es un aviso que pide acción: si nadie espera, no sale.

Para que las cuentas nuevas esperen aprobación, el negocio prende en **Reservaciones > Ajustes > General** (Configuración de Reservaciones), en la pestaña **General**, sección **Reservaciones Online**, la opción **Aprobar manualmente a cada cliente nuevo**. Esa opción necesita antes **Requerir cuenta para reservar**: sin cuenta no hay a quién aprobar. Las cuentas que ya existían no se ven afectadas.

Mientras espera, la persona no puede reservar ni comprar paquetes en línea.

## Pasos

1. Abre **Clientes > Todos los Clientes**.
2. En **En espera de aprobación**, ubica a la persona.
3. Para dejarla reservar, toca **Aprobar**. Sale «Cliente aprobado. Ya puede reservar.».
4. Para no aceptarla, toca **Rechazar**. Si quieres, escribe el **Motivo (opcional)**: si tiene correo, se lo mandamos por correo.
5. Toca **Rechazar** otra vez para confirmar. Sale «Cliente rechazado.».

## Problemas frecuentes

- **Rechazar no se puede deshacer desde el panel:** la persona deja de poder reservar y comprar paquetes en línea. Revisa bien antes de confirmar.
- **«Esta persona se registró por WhatsApp y no tiene correo…»:** no recibirá aviso de la decisión. Escribe el motivo si quieres dejarlo registrado.
- **«Alguien más ya decidió»:** otra persona aprobó o rechazó a ese cliente mientras lo revisabas. La lista ya se actualizó.
- **No veo la sección:** no hay nadie esperando, te falta el permiso de aprobar clientes, o el negocio no tiene prendida la aprobación manual.
- **Un cliente dice que no puede reservar:** revisa si está en **En espera de aprobación**.
