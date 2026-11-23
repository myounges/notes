# Build context is the repo root; run: docker build -f backend/Dockerfile -t notes-app .

# ---------- frontend ----------
FROM node:24-alpine AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- backend ----------
FROM node:24-alpine AS backend-build
RUN apk add --no-cache python3 make g++
WORKDIR /build/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# ---------- runtime ----------
FROM node:24-alpine
RUN apk update \
    && apk upgrade --no-cache \
    && apk add --no-cache tzdata \
    && cp /usr/share/zoneinfo/Europe/Madrid /etc/localtime \
    && echo "Europe/Madrid" > /etc/timezone

ENV TZ=Europe/Madrid \
    NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8082
WORKDIR /app
COPY --from=backend-build /build/backend/dist ./backend/dist
COPY --from=backend-build /build/backend/node_modules ./backend/node_modules
COPY --from=frontend-build /build/frontend/dist ./frontend/dist
VOLUME /data
EXPOSE 8082
WORKDIR /app/backend
CMD ["node", "dist/server.js"]
