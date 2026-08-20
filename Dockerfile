FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0

# Next standalone expects server.js, its traced node_modules, and .next/static
# to share this runtime root. Copying all of .next beside standalone/server.js
# makes HTML render but leaves every CSS/JS asset at a path the server cannot see.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/db/schema.sql ./db/schema.sql
EXPOSE 3000
CMD ["sh", "-c", "node scripts/migrate.mjs && node server.js"]
