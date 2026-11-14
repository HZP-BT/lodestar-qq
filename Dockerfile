FROM node:26-bookworm-slim AS build

WORKDIR /app
RUN npm install -g pnpm@10.18.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:26-bookworm-slim

WORKDIR /app
COPY --from=build /app /app

ENV NODE_ENV=production
EXPOSE 18080 18081 18090

CMD ["node", "scripts/dev-mock.mjs"]
