# -------- Builder Stage --------
FROM node:20-alpine AS builder

# Install system deps needed for Prisma engines
RUN apk add --no-cache openssl

WORKDIR /app

# Install all dependencies (including dev) first
COPY package*.json ./
COPY pnpm-lock.yaml* ./
RUN npm ci --legacy-peer-deps

# Copy the rest of the source code
COPY tsconfig*.json ./
COPY prisma ./prisma
# Include tests (for shared helpers referenced in src)
COPY tests ./tests
COPY src ./src
COPY ecosystem.config.js ./

# Generate Prisma Client & compile TS
RUN npx prisma generate
RUN npm run build

# -------- Production Stage --------
FROM node:20-alpine AS production

# Create app directory
WORKDIR /app

# Only install production dependencies
COPY package*.json ./
RUN npm ci --only=production --legacy-peer-deps

# Copy compiled app and Prisma engines from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
# PM2 is installed in node_modules as a prod dependency
COPY --from=builder /app/node_modules ./node_modules
# Include tests directory needed by some controllers
COPY --from=builder /app/tests ./tests
COPY ecosystem.config.js ./

ENV NODE_ENV=production
EXPOSE 3000

# Ensure prisma migrations run, then start app with PM2
CMD ["sh", "-c", "npx prisma migrate deploy && npx pm2-runtime ecosystem.config.js"]
