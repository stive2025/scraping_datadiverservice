FROM node:18-alpine

# Instalar Chromium y dependencias necesarias
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-emoji

# Variables de entorno para Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    NODE_ENV=production

# Node.js: limitar heap a 768 MB para que Chromium tenga espacio suficiente
# en el contenedor de 2 GB (Node ~768 MB + Chromium 4-6 tabs ~800 MB + SO ~200 MB)
ENV NODE_OPTIONS="--max-old-space-size=768"

WORKDIR /app

# Crear directorio de logs
RUN mkdir -p logs

# Copiar solo package.json primero (para aprovechar cache de Docker)
COPY package*.json ./

# Instalar dependencias
RUN npm ci --only=production

# Copiar el resto del código
COPY . .

# Exponer puerto
EXPOSE 3030

# Comando de inicio
CMD ["node", "src/index.js"]
