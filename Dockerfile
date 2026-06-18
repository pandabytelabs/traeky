# syntax=docker/dockerfile:1.7
# Default local image: Dashboard only. CI publishes two images via
# Dockerfile.dashboard and Dockerfile.cloud.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TRAEKY_VERSION
ARG TRAEKY_COMMIT=dev
RUN VERSION="${TRAEKY_VERSION:-$(cat internal/buildinfo/version.txt)}"; \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w -X main.version=${VERSION} -X main.commit=${TRAEKY_COMMIT}" -o /out/traeky ./cmd/traeky

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /
COPY --from=build /out/traeky /usr/local/bin/traeky
EXPOSE 8080
ENV TRAEKY_ADDR=:8080 \
    TRAEKY_MODE=dashboard
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/traeky"]
