FROM node:26-alpine
RUN apk add --no-cache ffmpeg tzdata
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data HOST=0.0.0.0 PORT=3000 TZ=Europe/Amsterdam
# De datamap hoort bij de gebruiker node. Een Docker-volume neemt dat over; zie docker-compose.yml.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/state || exit 1
LABEL org.opencontainers.image.title="Kijkbox" \
      org.opencontainers.image.description="Eigen IPTV-website met accounts, voor telefoon, tablet, laptop en tv. Levert zelf geen inhoud." \
      org.opencontainers.image.source="https://github.com/sagten88/kijkbox" \
      org.opencontainers.image.url="https://agtenhosting.com/tools/kijkbox/" \
      org.opencontainers.image.vendor="Agten Hosting" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
CMD ["node", "server/index.js"]
