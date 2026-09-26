# Capital Control production image.
#
# Deliberately NOT a `output: "standalone"` build. The owner of a deployment has
# to be able to run migrations, load the seed and take a backup from inside the
# container, and a standalone bundle ships none of those tools. The image is a
# few hundred megabytes larger; the operator keeps the commands that let them
# recover their own data.

FROM node:24-alpine AS deps
WORKDIR /app
# Prisma's engines need this on musl.
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
# --ignore-scripts: postinstall generates the Prisma client, and the schema is
# not in this stage yet. The build stage generates it explicitly.
RUN npm ci --ignore-scripts

FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# prisma7.config.ts refuses to load without a DATABASE_URL, and .dockerignore
# keeps the real .env out of the image on purpose. This placeholder exists only
# to satisfy that check while generating the client and compiling: nothing here
# connects to a database, and the real URL arrives from the environment at run
# time. It must never be used as a fallback at run time.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"

# The client is generated into src/generated/prisma, so it must exist before tsc.
RUN npx prisma generate --config prisma7.config.ts
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl postgresql17-client tzdata

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/src/generated ./src/generated
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma7.config.ts ./prisma7.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json

# Never run the application as root.
RUN addgroup -g 1001 -S capital && adduser -u 1001 -S capital -G capital \
  && chown -R capital:capital /app
USER capital

EXPOSE 3000
CMD ["npm", "run", "start"]
