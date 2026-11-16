FROM node:22-slim
ENV NODE_ENV=production TZ=America/Sao_Paulo
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY config.example.json ./
VOLUME ["/app/data"]
CMD ["node", "src/index.js"]
