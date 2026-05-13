# vici2 — Valkey 8 image with valkey-bloom module (F04 PLAN §1, D05 PLAN §1.5).
#
# Two-stage build:
#   1. `bloom-builder` clones and builds valkey-bloom (Rust) → produces
#      libvalkey_bloom.so.
#   2. Final stage layers the .so onto the official `valkey/valkey:8.0-alpine`
#      image and copies our `valkey.conf` to /etc/valkey/.
#
# Build:  docker build -t vici2/valkey:8.0 infra/valkey/
# Run:    handled by docker-compose.dev.yml `valkey` service.
#
# If `valkey-bloom` upstream changes location, update the git URL below.
# D05's IsDnc helper detects module-load via `MODULE LIST` and falls back
# to in-process Bloom on absence — i.e. this image can be replaced with
# stock `valkey/valkey:8.0-alpine` without breaking anything (D05 PLAN §1.5).

# ---- Stage 1: build valkey-bloom from source -------------------------------
FROM rust:1.82-alpine AS bloom-builder

RUN apk add --no-cache build-base git clang-dev llvm-dev linux-headers cmake

WORKDIR /src
# Pin a known-good commit/tag once upstream is GA; for now track main.
ARG VALKEY_BLOOM_REF=main
RUN git clone --depth=1 --branch ${VALKEY_BLOOM_REF} https://github.com/valkey-io/valkey-bloom.git \
    || (echo "valkey-bloom clone failed; image will boot without Bloom module"; mkdir -p /src/valkey-bloom)

WORKDIR /src/valkey-bloom
RUN if [ -f Cargo.toml ]; then \
      cargo build --release || (echo "valkey-bloom build failed; producing stub"; mkdir -p target/release && : > target/release/libvalkey_bloom.so) ; \
    else \
      mkdir -p target/release && : > target/release/libvalkey_bloom.so ; \
    fi

# ---- Stage 2: final Valkey image -------------------------------------------
FROM valkey/valkey:8.0-alpine

USER root
RUN mkdir -p /opt/valkey-modules /etc/valkey

COPY --from=bloom-builder /src/valkey-bloom/target/release/libvalkey_bloom.so /opt/valkey-modules/valkey-bloom.so
COPY valkey.conf /etc/valkey/valkey.conf

# If the bloom .so is non-empty, uncomment `loadmodule` line in the conf;
# otherwise leave it commented. This `sed` is idempotent.
RUN if [ -s /opt/valkey-modules/valkey-bloom.so ]; then \
      sed -i 's|^# loadmodule /opt/valkey-modules/valkey-bloom.so|loadmodule /opt/valkey-modules/valkey-bloom.so|' /etc/valkey/valkey.conf ; \
    fi

USER valkey
CMD ["valkey-server", "/etc/valkey/valkey.conf"]
