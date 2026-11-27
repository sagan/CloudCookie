FROM rust:1-alpine AS builder

RUN apk add --no-cache musl-dev

WORKDIR /app
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src

RUN cargo build --release

FROM alpine:3.24

RUN apk add --no-cache ca-certificates \
    && mkdir -p /var/lib/cloudcookie

COPY --from=builder /app/target/release/cloudcookie-server /usr/local/bin/cloudcookie-server

ENV CLOUDCOOKIE_LISTEN=0.0.0.0:6767 \
    CLOUDCOOKIE_DATA_DIR=/var/lib/cloudcookie

EXPOSE 6767
VOLUME ["/var/lib/cloudcookie"]

ENTRYPOINT ["/usr/local/bin/cloudcookie-server"]
