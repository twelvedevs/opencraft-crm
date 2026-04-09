FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY templates/ ./templates/

CMD ["node", "dist/index.js"]
