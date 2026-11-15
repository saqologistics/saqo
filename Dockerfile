FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_MAPBOX_TOKEN
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_PHOTON_URL
ARG VITE_OSRM_URL
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 SAQO_DB_PATH=/data/saqo.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir /data /backups && chown node:node /data /backups
COPY --from=build /app/dist ./dist
COPY server.ts tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "server.ts"]
