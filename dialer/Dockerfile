# syntax=docker/dockerfile:1.7
# Multi-stage Dockerfile for the dialer Go service.
# Targets: dev (air hot reload), builder (compile), prod (distroless).

# ----- builder ---------------------------------------------------------------
FROM golang:1.22-bookworm AS builder
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/dialer ./cmd/dialer

# ----- dev (with air hot reload) --------------------------------------------
FROM golang:1.22-bookworm AS dev
WORKDIR /app
RUN go install github.com/air-verse/air@v1.52.3
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
EXPOSE 9102 7000
CMD ["air", "-c", ".air.toml"]

# ----- prod (distroless) -----------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot AS prod
WORKDIR /
COPY --from=builder /out/dialer /dialer
EXPOSE 9102 7000
USER nonroot:nonroot
ENTRYPOINT ["/dialer"]
