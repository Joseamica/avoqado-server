# GitHub Environments and CI/CD Setup

This document explains how to set up GitHub environments and secrets for the CI/CD pipeline.

## 🌍 GitHub Environments

You need to create **two environments** in your GitHub repository:

### 1. Staging Environment
- **Name**: `staging`
- **Branch Protection**: `develop` branch
- **Auto-deploy**: Enabled

### 2. Production Environment  
- **Name**: `production`
- **Branch Protection**: `main` branch
- **Approval Required**: Recommended
- **Auto-deploy**: Enabled

## 🔐 Repository Secrets

Go to **Settings → Secrets and Variables → Actions** and add:

### Required Secrets

```bash
# Render API Configuration
RENDER_API_KEY=your_render_api_key_here
RENDER_STAGING_SERVICE_ID=srv-xxxxxxxxx     # From staging service
RENDER_PRODUCTION_SERVICE_ID=srv-yyyyyyyyy  # From production service

# Neon Database (for branching workflow)
NEON_API_KEY=your_neon_api_key
NEON_PROJECT_ID=muddy-band-82943019         # Your development project ID
```

### Environment Variables (per environment)

#### Staging Environment Variables
```bash
STAGING_API_URL=https://staging-avoqado-server.onrender.com
```

#### Production Environment Variables
```bash
PRODUCTION_API_URL=https://production-avoqado-server.onrender.com
```

## 🚀 Deployment Workflow

### Branch Strategy
```
develop → staging environment
main    → production environment
```

### Automatic Triggers
- **Pull Request**: Runs tests, creates PR preview comment
- **Push to develop**: Deploys to staging automatically  
- **Push to main**: Deploys to production automatically
- **Version bump**: Creates GitHub release automatically

### Manual Deployment
You can manually trigger deployments from GitHub Actions:
1. Go to **Actions** tab
2. Select **"Deploy to Render"** workflow
3. Click **"Run workflow"**
4. Choose environment (staging/production)

## 📋 Setup Checklist

### 1. Create GitHub Environments
- [ ] Create `staging` environment
- [ ] Create `production` environment
- [ ] Set branch protection rules

### 2. Add Repository Secrets
- [ ] `RENDER_API_KEY`
- [ ] `RENDER_STAGING_SERVICE_ID`
- [ ] `RENDER_PRODUCTION_SERVICE_ID`
- [ ] `NEON_API_KEY`
- [ ] `NEON_PROJECT_ID`

### 3. Add Environment Variables
- [ ] `STAGING_API_URL` in staging environment
- [ ] `PRODUCTION_API_URL` in production environment

### 4. Create Render Services
- [ ] Deploy staging server using `render.staging.yaml`
- [ ] Deploy production server using `render.yaml`
- [ ] Copy service IDs to GitHub secrets

### 5. Test Pipeline
- [ ] Create test PR to verify CI
- [ ] Push to develop to test staging deployment
- [ ] Push to main to test production deployment
- [ ] Bump version to test auto-release

## 🔍 How to Get Service IDs

### Render Service IDs
1. Go to your [Render Dashboard](https://dashboard.render.com)
2. Open your service
3. Copy the service ID from the URL: `srv-xxxxx`

### Render API Key
1. Go to [Account Settings](https://dashboard.render.com/user/settings)
2. Create new API key
3. Copy the key (starts with `rnd_`)

### Neon API Key
1. Go to [Neon Console](https://console.neon.tech)
2. Account Settings → API Keys
3. Create new API key

## 🏗️ Workflow Overview

### CI/CD Pipeline (`ci-cd.yml`)
- Runs on all PRs and pushes
- Includes: lint, test, build, typecheck
- Deploys staging/production based on branch
- Creates PR preview comments

### Deployment (`deploy.yml`)
- Direct Render API integration
- Health checks after deployment
- Manual workflow dispatch option
- Notification system

### Auto-Release (`release.yml`)
- Triggers on `package.json` version changes
- Auto-creates GitHub releases
- Generates detailed changelog
- Includes database migration notes

### Neon Branching (`neon_workflow.yml`)
- Creates database branch per PR
- Runs migrations automatically
- Seeds test data
- Cleans up on PR close

## 🔧 Environment Configuration

Each Render service needs these environment variables:

### Staging Server
```bash
NODE_ENV=staging
DATABASE_URL=postgresql://neondb_owner:npg_rzaM3Pyt4Tgf@ep-cold-math-aforhbky.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require
FRONTEND_URL=https://develop.avoqado-web-dashboard.pages.dev
# ... other secrets from your .env file
```

### Production Server
```bash
NODE_ENV=production
DATABASE_URL=postgresql://neondb_owner:npg_Feb5NKx3RzBW@ep-rough-cake-admwvkl6.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require
FRONTEND_URL=https://dashboard.avoqado.io
# ... other secrets from your .env file
```