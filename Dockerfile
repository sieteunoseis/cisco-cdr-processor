FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY sql/ ./sql/
COPY src/ ./src/

RUN mkdir -p /data/incoming && chown node:node /data/incoming

USER node

EXPOSE 3000

ENV NODE_TLS_REJECT_UNAUTHORIZED=0

CMD ["node", "src/index.js"]
