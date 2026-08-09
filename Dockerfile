FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OPENWORKER_MODE=embedded \
    OPENWORKER_EXECUTABLE=/opt/openworker/bin/openworker-server

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv git build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/openworker \
    && /opt/openworker/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /opt/openworker/bin/pip install --no-cache-dir "coworker @ git+https://github.com/andrewyng/openworker.git@01b6f83b3927e02912dda84bb392942c13ca70d1"

WORKDIR /app
COPY package.json package-lock.json ./
COPY teamflow-lite/package.json ./teamflow-lite/
RUN npm ci --omit=dev && npm --prefix teamflow-lite install --omit=dev

COPY . .
RUN mkdir -p /var/data/openworker/state /var/data/openworker/workspace

EXPOSE 7357
CMD ["npm", "start"]
