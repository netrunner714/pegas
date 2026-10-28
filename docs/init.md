# Команда `pegas init`

Инициализирует окружение. Поведение зависит от контекста выполнения.

---

## 1. Сценарий: В проекте (есть `package.json`)

Выполняется разработчиком на этапе локальной разработки в корне репозитория проекта.

```bash
pegas init
```

### Фактические действия:
1. Читает `package.json`.
2. Записывает `"pegas": "^0.1.0"` в секцию `devDependencies`.
3. Создаёт папку `docs/` (если отсутствует) и файл `docs/pegas.md`.
4. Проверяет наличие `docker-compose.yml` (или `compose.yaml`).
5. Выводит в консоль результат:
   * добавлен ли пакет в `devDependencies`;
   * создан ли `docs/pegas.md`;
   * найден или не найден compose-файл.

---

## 2. Сценарий: На сервере (нет `package.json` или передан `--server`)

Выполняется на VPS для развёртывания базовой инфраструктуры шлюза.

```bash
pegas init --server
# или просто `pegas init` в директории без package.json
```

### Фактические действия:
1. Проверяет доступность Docker демона и Docker Compose.
2. Создаёт внешнюю Docker-сеть `pegas-network` (если отсутствует).
3. Создаёт директорию `~/gateway` (или путь из `--gateway-dir`) с подпапкой `conf.d/`.
4. Создаёт файл `~/gateway/Caddyfile` с директивой `import /etc/caddy/conf.d/*.caddy`.
5. Создаёт файл `~/gateway/docker-compose.yml` (контейнер `gateway-caddy`, образ `caddy:2-alpine`, порты 80, 443, 443/udp).
6. Запускает контейнер Caddy: `docker compose up -d`.
