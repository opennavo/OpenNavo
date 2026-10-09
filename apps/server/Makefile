.PHONY: gen lint test run-api migrate seed build
gen:
	go tool oapi-codegen -config api/oapi-public.yaml api/public.openapi.yaml
	go tool oapi-codegen -config api/oapi-admin.yaml api/admin.openapi.yaml
lint:
	go tool golangci-lint run
test:
	go test -race ./...
run-api:
	$(MAKE) -C .. dev-api
migrate:
	$(MAKE) -C .. migrate
seed:
	$(MAKE) -C .. seed
build:
	go build ./...
