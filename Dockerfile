FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY server.mjs ./server.mjs
COPY src ./src
COPY public ./public

RUN mkdir -p /app/.cache && chown node:node /app/.cache
USER node

EXPOSE 4173
CMD ["npm", "start"]
