FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src/ src/
COPY public/ public/
USER node
EXPOSE 3164
CMD ["node","src/server.js"]
