// Actualizador del POS: la pregunta pública que hacen las apps («¿debo actualizarme?»).
// GET /api/v1/public/pos-app-version?platform=ANDROID&versionCode=95
import { NextFunction, Request, Response } from 'express'
import { decide, VersionThreshold } from '../../services/posAppVersion/decide'
import { getPublicPolicy } from '../../services/posAppVersion/policy.service'

/** En iOS el número de versión no decide nada: siempre sale `null` para que la app no lo confunda con otro. */
const nivel = (platform: string, t: VersionThreshold | null | undefined) =>
  t ? { versionCode: platform === 'IOS' ? null : t.versionCode, versionName: t.versionName } : null

export async function getPosAppVersion(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Nunca se cachea: la app debe ver el cambio de política en su siguiente pregunta.
    res.setHeader('Cache-Control', 'no-store')
    // `validateRequest` ya dejó en `req.query` la forma limpia (platform + versionCode o versionName).
    const q = req.query as unknown as { platform: 'ANDROID' | 'IOS' | 'DESKTOP'; versionCode?: number; versionName?: string }
    const { platform } = q

    // El POS de escritorio no tiene política: se contesta OK sin tocar la base.
    const policy = platform === 'DESKTOP' ? null : await getPublicPolicy(platform)
    const status = decide(platform, { versionCode: q.versionCode, versionName: q.versionName }, policy?.levels ?? null)

    res.json({
      success: true,
      data: {
        status,
        required: nivel(platform, policy?.levels.required),
        recommended: nivel(platform, policy?.levels.recommended),
        message: policy?.message ?? null,
        checkedAt: new Date().toISOString(),
      },
    })
  } catch (error) {
    next(error)
  }
}
