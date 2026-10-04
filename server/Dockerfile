FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts
COPY migrations ./migrations
COPY public ./public
# Final guard: the server image must never contain a mining component (see the mining directive's "NO VPS MINING" rule).
# The endpoint miner is packaged exclusively with the Windows agent build, never copied in here.
RUN node scripts/check-no-miner-in-image.mjs dist && node scripts/check-no-miner-in-image.mjs public
RUN mkdir -p /data/releases && chown -R node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
