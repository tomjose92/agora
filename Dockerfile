# Headless agora-server image (used by Railway; see railway.json).
#
# The server keeps everything — config.json (owner token), agora.db, uploaded
# files — under /data, so mount a persistent volume there or state is lost on
# every deploy.

FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release -p agora-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/agora-server /usr/local/bin/agora-server
COPY ui /app/ui

# Accept connections from the platform's proxy; Railway injects PORT itself.
ENV AGORA_BIND=0.0.0.0
EXPOSE 4470
# No VOLUME directive: Railway rejects it ("use Railway Volumes"). Attach a
# Railway volume mounted at /data instead so state survives redeploys.

CMD ["agora-server", "--data-dir", "/data", "--ui-dir", "/app/ui"]
