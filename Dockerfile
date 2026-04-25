FROM node:20-slim

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src/ ./src/
RUN npx tsc && cp -r src/dashboard dist/

RUN mkdir -p /opt/windsurf/data/default/db /tmp/windsurf-workspace /app/data

ENV PORT=4000
ENV DATA_DIR=/app/data
ENV LS_BINARY_PATH=/opt/windsurf/language_server_linux_x64

EXPOSE 4000

CMD ["node", "dist/index.js", "start"]
