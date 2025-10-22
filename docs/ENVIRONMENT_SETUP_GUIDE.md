# Environment Setup Guide

## Environment Configuration Files Created

### 📁 Files Created:

- `.env.staging` - Staging environment variables
- `.env.production` - Production environment variables

## 🗃️ Database Configuration

### Staging Database (Neon Dev Branch)

- **Branch**: `dev`
- **Endpoint**: `ep-winter-night-afehcg83.c-2.us-west-2.aws.neon.tech`
- **Database**: `neondb`
- **Connection**: Ready for staging deployments

### Production Database (Neon Main Branch)

- **Branch**: `main`
- **Endpoint**: `ep-cold-math-aforhbky.c-2.us-west-2.aws.neon.tech`
- **Database**: `neondb`
- **Connection**: Ready for production deployments

## 🚀 Render Service Setup

### For Staging Service (avoqado-server-staging):

1. Go to your staging service dashboard
2. Environment → Environment Variables
3. Copy all variables from `.env.staging`
4. **Important**: Use `sync: false` for all secret values in `render.yaml`

### For Production Service (avoqado-server):

1. Go to your production service dashboard
2. Environment → Environment Variables
3. Copy all variables from `.env.production`
4. **Important**: Use `sync: false` for all secret values in `render.yaml`

## 🔐 Security Notes

### ⚠️ CRITICAL: Generate New Secrets for Production

The current secrets are development keys. For production, generate new values for:

- `ACCESS_TOKEN_SECRET`
- `REFRESH_TOKEN_SECRET`
- `COOKIE_SECRET`
- `SESSION_SECRET`

### 🔒 Secret Generation Commands:

```bash
# Generate random 64-character secrets
openssl rand -base64 64
# Or use Node.js
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

## 🌐 Frontend URLs

### Staging: `https://develop.avoqado-web-dashboard.pages.dev`

- CORS configured for staging API
- Connected to dev database branch
- Safe for testing and development

### Production: `https://dashboard.avoqado.io`

- CORS configured for production API
- Connected to main database branch
- Live customer environment

## 📊 Database Migration Strategy

### Staging Deployments:

1. Code pushed to `develop` branch
2. GitHub Actions runs migrations on dev database branch
3. Safe testing environment with isolated data

### Production Deployments:

1. Code pushed to `main` branch
2. GitHub Actions runs migrations on main database branch
3. Live environment with customer data

## 🔧 GitHub Secrets Required

Ensure these secrets are set in your GitHub repository:

```bash
# Already set:
gh secret set RENDER_API_KEY --body "rnd_LnaLuhWvxKQnABGfpthnViBWVKmn"
gh secret set RENDER_PRODUCTION_SERVICE_ID --body "srv-d2oe3gggjchc73elk460"
gh secret set NEON_API_KEY --body "your-neon-api-key"

# Still needed after creating staging service:
gh secret set RENDER_STAGING_SERVICE_ID --body "srv-xxxxx" # Get from Render dashboard
```

## ✅ Next Steps

1. **Create staging service** using Blueprint with `develop` branch
2. **Get staging service ID** and add as GitHub secret
3. **Configure environment variables** in both Render services
4. **Test deployment pipeline** by pushing to `develop` branch
5. **Generate new production secrets** before going live

## 🎯 Environment Summary

| Environment | Branch    | Database Branch | Frontend URL                                    | API URL                                     |
| ----------- | --------- | --------------- | ----------------------------------------------- | ------------------------------------------- |
| Staging     | `develop` | `dev`           | https://develop.avoqado-web-dashboard.pages.dev | https://avoqado-server-staging.onrender.com |
| Production  | `main`    | `main`          | https://dashboard.avoqado.io                    | https://avoqado-server.onrender.com         |
