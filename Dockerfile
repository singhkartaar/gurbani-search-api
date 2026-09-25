# Gurbani search API.
#
# This image contains CODE ONLY. The data -- the scripture database, the vector
# indexes and the query model -- is ~85MB to ~270MB depending on which packs you
# want, is separately licensed (see NOTICE.md), and is mounted at runtime:
#
#   npm run fetch-data                       # into ./data
#   docker build -t gurbani-search-api .
#   docker run -p 8080:8080 -v "$PWD/data:/data:ro" gurbani-search-api
#
# Keeping data out of the image means the image is small, rebuilds are fast, and
# nobody accidentally publishes a container full of somebody else's translations.
FROM node:24-slim

# onnxruntime otherwise starts a telemetry uploader. query-encoder sets this
# itself too; this is the belt to that brace.
ENV NODE_ENV=production \
    PORT=8080 \
    ORT_DISABLE_TELEMETRY=1 \
    ARTIFACTS_DIR=/data/artifacts \
    MODELS_DIR=/data/models
WORKDIR /app

# Dependencies first, for layer caching.
COPY packages/search-core/package.json packages/search-core/package-lock.json packages/search-core/
COPY packages/query-encoder/package.json packages/query-encoder/package-lock.json packages/query-encoder/
# onnxruntime-node: --ignore-scripts skips its postinstall, which downloads a
# 230MB CUDA provider we can't use on a CPU-only machine. The CPU runtime is
# already bundled in the package. It also bundles every other OS/arch, so keep
# only this one -- together that takes the image from 1.3GB to ~550MB.
#
# If you bump onnxruntime-node and this layer breaks, the paths below are what
# changed. The `test -f` at the end is deliberate: without it a failed prune is
# silent and you get a 1.3GB image back.
RUN cd packages/search-core && npm ci --omit=dev --no-audit --no-fund \
 && cd ../query-encoder && npm ci --omit=dev --no-audit --no-fund --ignore-scripts \
 && ARCH="$(dpkg --print-architecture | sed 's/amd64/x64/')" \
 && BIN=node_modules/onnxruntime-node/bin/napi-v6 \
 && find "$BIN" -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} + \
 && find "$BIN/linux" -mindepth 1 -maxdepth 1 ! -name "$ARCH" -exec rm -rf {} + \
 && rm -f "$BIN/linux/$ARCH"/libonnxruntime_providers_cuda.so "$BIN/linux/$ARCH"/libonnxruntime_providers_tensorrt.so \
 && test -f "$BIN/linux/$ARCH/onnxruntime_binding.node" \
 && npm cache clean --force

COPY packages/search-core/src packages/search-core/src
COPY packages/query-encoder/src packages/query-encoder/src
COPY apps/web apps/web
COPY package.json package.json

# .dockerignore is a whitelist, so a file it does not name vanishes silently and
# the container dies at start -- after a push -- with MODULE_NOT_FOUND. Rather
# than assert a hardcoded list of filenames, which is the thing that goes stale,
# start the server for real and require it to reach its own first check. With no
# data in the image it exits saying so, and reaching that line proves every
# module in the require graph resolved.
RUN out="$(DB_PATH=/nonexistent node apps/web/server.js 2>&1 || true)"; \
    echo "$out" | grep -q 'database not found' \
      || { echo "server did not reach startup:"; echo "$out"; exit 1; }
# That check stops at the server's FIRST line of defence, though, and most of
# its modules are required after it: cluster.js, cors.js, limits.js, logging.js,
# accounts/*, bundle.js, and the lazily-required ask/* and query encoder. So the
# graph is walked as well -- every relative require() reachable from server.js
# must resolve to a file that is actually in this image. No module is run.
RUN node -e 'const fs=require("fs"),path=require("path");const seen=new Set();(function walk(f){if(seen.has(f))return;seen.add(f);if(!/\.[cm]?js$/.test(f))return;const src=fs.readFileSync(f,"utf8");for(const m of src.matchAll(/require\(\s*["\x27](\.{1,2}\/[^"\x27]+)["\x27]\s*\)/g))walk(require.resolve(path.resolve(path.dirname(f),m[1])));})(path.resolve("apps/web/server.js"));console.log("require graph: "+seen.size+" files resolve")'

USER node
EXPOSE 8080
# The health check the server is built for: /api/health is the one route that
# never requires credentials, exactly so this works.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
