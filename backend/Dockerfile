# Multi-stage build for the App service (API + Gateway, see docs/deployment-plan.md).
# node:20-alpine both stages — matches the "node >=20" engines constraint and keeps
# the final image small. NOT used for the Tally connector (dist-exe/tally-backend.exe),
# which stays a native Windows exe — see docker-compose.yml's own note on why Tally
# itself is never containerized.

FROM node:20-alpine AS builder
WORKDIR /app

# Dummy value so `prisma generate` (runs via postinstall) can resolve
# env("DATABASE_URL") at build time — never a real connection, just needs to be
# present. The real value is injected at container runtime, not baked into the image.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"

COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package.json ./

EXPOSE 3000
CMD ["node", "dist/main.js"]
