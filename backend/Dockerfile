FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY sql ./sql
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5000
USER bun
EXPOSE 5000
CMD ["bun", "run", "start"]
