.PHONY: fmt test vet build docker-dashboard docker-cloud docker run compose-up compose-down

fmt:
	gofmt -w ./cmd ./internal

test:
	go test ./...

vet:
	go vet ./...

build:
	go build -trimpath -o bin/traeky ./cmd/traeky

docker-dashboard:
	docker build -f Dockerfile.dashboard -t traeky-dashboard:local .

docker-cloud:
	docker build -f Dockerfile.cloud -t traeky-cloud:local .

# Builds both production image variants.
docker: docker-dashboard docker-cloud

compose-up:
	docker compose up --build

compose-down:
	docker compose down

run:
	TRAEKY_MODE=all TRAEKY_ADDR=:8080 TRAEKY_DATA_DIR=./data go run ./cmd/traeky
