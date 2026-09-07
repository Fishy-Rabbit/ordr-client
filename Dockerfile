# ordr-render: danser under Xvfb + Mesa llvmpipe, driven by the Node worker.
# Deliberately free of BuildKit-only syntax (no RUN --mount) so the classic,
# CPU-pinnable builder can build it.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ARG DANSER_VERSION=0.11.0
# sha256 of danser-0.11.0-linux.zip as published on GitHub releases (observed 2026-09-08).
ARG DANSER_SHA256=c3184ceb84b20e8e9c9a2709113efc29b8bdf2f866949834d7fb8e799618a67e
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb xauth xfonts-base x11-xserver-utils \
        libgl1 libgl1-mesa-dri libglx-mesa0 libegl1 \
        libx11-6 libxcursor1 libxrandr2 libxinerama1 libxi6 libxxf86vm1 libasound2 libgtk-3-0 \
        fonts-dejavu fonts-noto-cjk ca-certificates curl unzip ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# danser-go is fetched ONCE, here, and pinned by hash; the worker never downloads anything at runtime.
RUN curl -fsSL -o /tmp/danser.zip "https://github.com/Wieku/danser-go/releases/download/${DANSER_VERSION}/danser-${DANSER_VERSION}-linux.zip" \
    && echo "${DANSER_SHA256}  /tmp/danser.zip" | sha256sum -c - \
    && mkdir -p /app/bins/danser \
    && unzip -q /tmp/danser.zip -d /app/bins/danser \
    && rm /tmp/danser.zip \
    && chmod +x /app/bins/danser/danser-cli /app/bins/danser/danser /app/bins/danser/ffmpeg/ffmpeg /app/bins/danser/ffmpeg/ffprobe
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY docker/entrypoint.sh ./docker/entrypoint.sh
RUN groupadd -g 1001 render && useradd -r -u 1001 -g render -d /home/render -m render \
    && mkdir -p /data/videos /data/songs /data/skins /data/state /work /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix \
    && chmod +x /app/docker/entrypoint.sh \
    && chown -R render:render /data /work /app/bins
ENV PORT=3002 \
    VIDEOS_DIR=/data/videos \
    SONGS_DIR=/data/songs \
    SKINS_DIR=/data/skins \
    STATE_DIR=/data/state \
    WORK_DIR=/work \
    DANSER_DIR=/app/bins/danser \
    DANSER_VERSION=${DANSER_VERSION} \
    NODE_ENV=production
USER 1001
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s CMD curl -fsS http://127.0.0.1:3002/health || exit 1
ENTRYPOINT ["/app/docker/entrypoint.sh"]
