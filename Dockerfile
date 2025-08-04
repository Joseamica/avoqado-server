# Use Node.js LTS version
FROM node:20-alpine AS base

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma.config.ts ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Development stage
FROM base AS development
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

# Build stage
FROM base AS build
# Install all dependencies including devDependencies for building
RUN npm ci --include=dev
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user and logs directory
RUN addgroup -g 1001 -S nodejs && \
    adduser -S avoqado -u 1001 && \
    mkdir -p /app/logs && \
    chown -R avoqado:nodejs /app/logs

# Copy built application
COPY --from=build --chown=avoqado:nodejs /app/dist ./dist
COPY --from=build --chown=avoqado:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=avoqado:nodejs /app/package*.json ./
COPY --from=build --chown=avoqado:nodejs /app/prisma.config.ts ./
COPY --from=build --chown=avoqado:nodejs /app/prisma ./prisma

USER avoqado

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node --eval "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]