# ── Build stage ───────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY prisma ./prisma
RUN npx prisma generate

# ── Production stage ──────────────────────────────────────────
FROM node:20-alpine AS production

RUN addgroup -g 1001 -S nodejs && adduser -S mtos -u 1001 -G nodejs

WORKDIR /app
COPY --from=builder --chown=mtos:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=mtos:nodejs /app/prisma ./prisma
COPY --chown=mtos:nodejs src ./src

RUN mkdir -p uploads/employees uploads/compliance uploads/tender-docs uploads/temp \
    && chown -R mtos:nodejs uploads

USER mtos
EXPOSE 5000
ENV NODE_ENV=production

# Wait for DB then migrate and start
CMD ["sh", "-c", "npx prisma migrate deploy && node src/index.js"]
