.PHONY: run up down logs restart rebuild shell clean

URL := http://localhost
DIRECT_URL := http://localhost:3030

run: up
	@echo ""
	@echo "Harbour is running at $(URL)"
	@echo "Direct Next.js fallback: $(DIRECT_URL)"
	@echo "Data is persisted in ./data (DB, uploads, encryption key)"
	@echo ""
	@echo "  make logs     follow logs"
	@echo "  make down     stop the container"
	@echo "  make rebuild  rebuild image and restart (after code changes)"

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f harbour harbour-edge

restart:
	docker compose restart harbour

rebuild:
	docker compose up -d --build --force-recreate

shell:
	docker compose exec harbour sh

clean:
	docker compose down -v
	rm -rf data
