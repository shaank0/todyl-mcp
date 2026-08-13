# The MCP Gateway deploys this from its catalog. It holds NO credentials at
# build time — TODYL_CLIENT_ID and TODYL_ACCESS_TOKEN are injected as
# container env by the gateway's Deploy flow, AES-encrypted at rest.
FROM node:22-alpine AS build

WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine

WORKDIR /app
COPY --from=build /build/package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /build/dist ./dist

RUN addgroup -S todyl && adduser -S todyl -G todyl
USER todyl

EXPOSE 8080
CMD ["node", "dist/index.js"]
