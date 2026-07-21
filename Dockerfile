FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS sticker-tools
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache ca-certificates ffmpeg

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node scripts ./scripts
COPY --chown=node:node sticker-pack-candidates.json ./sticker-pack-candidates.json
COPY --chown=node:node sticker-pack-candidates.discovered.json ./sticker-pack-candidates.discovered.json
COPY --chown=node:node sticker-mapping.json ./sticker-mapping.json
RUN mkdir -p /app/.cache && chown node:node /app/.cache

USER node
CMD ["npm", "run", "stickers:refresh"]

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps

RUN apk add --no-cache ca-certificates

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node sticker-mapping.json ./sticker-mapping.json

USER node
CMD ["node", "dist/index.js"]
