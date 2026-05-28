---
paths:
  - 'src/services/email.service.ts'
  - 'src/services/resend.service.ts'
  - 'src/services/**/email*.ts'
  - 'src/services/**/*mail*.ts'
---

# Email Template Rules — Apply on every email template change

When you add a new email template or edit an existing one in these files, the output **must follow the Avoqado email design system**. Full
spec lives in [`docs/guides/EMAIL_STANDARDS.md`](../../docs/guides/EMAIL_STANDARDS.md) — read it before writing any HTML.

The canonical visual reference is `sendLowStockDigestEmail` in `email.service.ts`. New templates should copy its structure (header, title,
section H2 + table, black CTA, footer). Treat it as the design source of truth.

## Non-negotiables (the audit script will fail if you skip them)

1. **Header + footer Avoqado isotipo**: 32×32 in header, 24×24 in footer. Source: `https://avoqado.io/isotipo.svg`.
2. **White background, black text.** No gradients, no colored hero blocks, no card-on-card shadows.
3. **CTAs are ALWAYS black** (`background-color:#000000`, white text, `border-radius:6px`). Never blue, never gradient, never branded
   purple.
4. **No emoji in subject lines or H1.** Decorative emoji in section headers (`🆕 Negocio`, `👤 Dueño`) is also banned — use uppercase
   muted-gray H2 labels instead.
5. **Both `html` and `text` bodies.** Many clients block HTML by default.
6. **Footer must include** `Servicios Tecnologicos Avo S.A. de C.V.` and a "preferences" / "privacy" link.
7. **Inline styles only.** External CSS does not work in email clients.
8. **Section labels (H2)** are uppercase, weight 600, color `#666`, letter-spacing 0.5px — see `EMAIL_STANDARDS.md` for the exact snippet.
9. **Tables** use `border:1px solid #e5e7eb; border-radius:8px; overflow:hidden;`. Key/value rows: label cell 160px wide, color #666, 13px;
   value cell #000, 14px.

## Pre-merge checklist for any email change

- [ ] Open the rendered HTML in a browser and confirm it matches `sendLowStockDigestEmail` visually.
- [ ] Subject has no emoji and is under ~60 chars.
- [ ] CTA uses `background-color:#000000`.
- [ ] Logo appears twice (header + footer).
- [ ] Unit test asserts: no emoji in subject, logo URL appears ≥2 times, CTA uses `#000000`, plain-text body is non-empty.
- [ ] If the template is customer-visible (not internal admin digest), test via `scripts/test-all-emails.ts`.

## What to do with the legacy templates

`sendKycSubmissionNotification`, `sendKycDocumentsToBlumon`, `sendPurchaseOrderEmail`, and some TPV alerts still use purple/green gradient
heroes and decorative emoji. **Don't leave a partial migration:** if you touch one of those functions for any reason, rewrite its template
to the standard in the same commit. See the "Migration backlog" table in `docs/guides/EMAIL_STANDARDS.md`.
