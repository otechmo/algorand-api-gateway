FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY src ./src
COPY openapi.yaml README.md ./

USER node
EXPOSE 8443
CMD ["node", "src/index.js"]
