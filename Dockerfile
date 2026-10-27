FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8790
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/relay/package.json ./apps/relay/package.json
COPY apps/desktop-agent/package.json ./apps/desktop-agent/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace=apps/relay && npm cache clean --force
COPY apps/relay ./apps/relay
USER node
EXPOSE 8790
WORKDIR /app/apps/relay
CMD ["node", "server.mjs"]
