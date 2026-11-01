# syntax=docker/dockerfile:1
ARG RUST_IMAGE=rust:1-bookworm@sha256:9181b56c2a21ab1d5e73cffe04fc762426d30aa7fac3c91141dd033f49a7fc8b
FROM ${RUST_IMAGE} AS build
WORKDIR /src
COPY services/zerror/Cargo.toml services/zerror/Cargo.lock ./
COPY services/zerror/src/ src/
RUN cargo build --release --locked

FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3 AS runtime
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates libgcc-s1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 zerror \
    && useradd --uid 1000 --gid 1000 --no-create-home zerror \
    && mkdir /data /credentials \
    && chown zerror:zerror /data /credentials \
    && chmod 700 /data /credentials
COPY --from=build /src/target/release/zerror-headless /usr/local/bin/zerror-headless
COPY services/zerror/LICENSE services/zerror/UPSTREAM.md /usr/share/doc/zerror-headless/
ENV ZERROR_HOST=0.0.0.0 ZERROR_PORT=3002 ZERROR_DATA_DIR=/data ZERROR_ADMIN_TOKEN_FILE=/credentials/admin.token
USER zerror
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["zerror-headless", "--healthcheck"]
ENTRYPOINT ["zerror-headless"]
