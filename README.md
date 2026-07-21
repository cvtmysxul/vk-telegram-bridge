# VK ↔ Telegram Topic Bridge

[Русский](#russian) · [English](#english)

<a id="russian"></a>

## Русский

Самостоятельно разворачиваемый мост между диалогами VK и топиками Telegram Forum. Для каждого VK peer создаётся отдельный Telegram-топик; мост хранит соответствия в PostgreSQL и синхронизирует события в обе стороны.

Проект рассчитан на один выделенный Telegram forum-чат на инстанс. Для нескольких чатов используй отдельные `DATABASE_SCHEMA`.

### Возможности

- VK → Telegram: текст, фото, документы, голосовые, аудио, видео, стикеры, кнопки, пересланные сообщения, ссылки, опросы и системные события чата.
- Telegram → VK: текст и подписи, фото, документы, голосовые, аудио, видео, поддерживаемые стикеры и действия кнопок.
- Ответы, закрепы, редактирования, удаления, история версий и маппинг сообщений.
- Реакции владельца Telegram-чата в VK и компактные сводки реакций VK в Telegram.
- Обновление имени, аватара и списка участников VK-чата в служебных закрепах топика.

### Требования

- Node.js 20.11 или новее;
- PostgreSQL;
- Telegram supergroup с включёнными forum-топиками;
- Telegram-бот с правами администратора на создание и управление топиками;
- VK user access token с правами на сообщения и нужные типы медиа.

### Быстрый старт

```bash
npm ci
cp .env.example .env
```

Заполни `.env`, затем примени миграции и запусти мост:

```bash
npm run db:migrate
npm run dev
```

Для production-запуска без Docker:

```bash
npm run build
npm run start
```

### Конфигурация

Полный список с безопасными примерами находится в [`.env.example`](.env.example).

| Переменная | Назначение |
| --- | --- |
| `DATABASE_URL` | Строка подключения PostgreSQL. По умолчанию мост требует проверку TLS-сертификата. |
| `DATABASE_SCHEMA` | Изолированная схема БД для одного Telegram-чата. |
| `TELEGRAM_BOT_TOKEN` | Токен бота Telegram. |
| `TELEGRAM_CHAT_ID` | ID целевого forum-чата. |
| `VK_ACCESS_TOKEN` | Пользовательский токен VK. |
| `TELEGRAM_REACTION_USER_ID` | Необязательный ID владельца, чьи реакции надо зеркалить в VK. |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_USER_SESSION` | Необязательны, но нужны для синхронизации удалений Telegram → VK через MTProto. |
| `STICKER_MAPPING_PATH` | Путь к `sticker-mapping.json`, если карта находится не в корне проекта. |

Для локальной доверенной PostgreSQL без TLS укажи `sslmode=disable` в `DATABASE_URL` явно. Не отключай проверку TLS на внешней БД без необходимости.

Создать MTProto-сессию для синхронизации удалений можно так:

```bash
npm run telegram:login
```

Скрипт сохраняет её в `.telegram-user-session` с правами `0600`. Перенеси значение в `TELEGRAM_USER_SESSION` и удали временный файл.

### Docker

После настройки `.env`:

```bash
docker compose up -d --build
docker compose logs -f bot
```

PostgreSQL запускается отдельно. Для БД на Docker-хосте используй `host.docker.internal` вместо `localhost`.

Для нескольких экземпляров на одном Docker-хосте используй разные имена Compose-проектов, например `docker compose -p vk-telegram-bridge-dmitrii up -d --build` и `docker compose -p vk-telegram-bridge-adilya up -d --build`.

### Стикеры

`sticker-mapping.json` — готовая двусторонняя карта VK `sticker_id` и Telegram `set_name + file_unique_id`, которую мост читает в рантайме. Для обновления карты нужны токены VK и Telegram из `.env`:

```bash
npm run stickers:discover
npm run stickers:sync
```

Первый скрипт обновляет автоматический каталог кандидатов, второй пересобирает карту. Для визуальной сверки отдельного пака нужен `ffmpeg`:

```bash
npm run stickers:sync -- --product 1379 --visual --dry-run
```

В Docker для этого есть отдельный профиль:

```bash
docker compose --profile tools run --rm sticker-sync
```

### Разработка и проверка

```bash
npm test
npm audit --omit=dev --audit-level=high
```

CI запускает те же проверки при push и pull request. Структура проекта:

- `src/` — приложение;
- `migrations/` — SQL-миграции;
- `scripts/` — обслуживание карты стикеров;
- `test/` — регрессионные проверки.

### Безопасность

Не добавляй `.env` или `.env.*`, MTProto-сессию, сертификаты или ключи в репозиторий. О проблемах безопасности сообщай по правилам из [SECURITY.md](SECURITY.md), не через публичный issue с секретами или рабочим эксплойтом.

### Лицензия

Проект распространяется по лицензии [MIT](LICENSE).

<a id="english"></a>

## English

A self-hosted bridge between VK conversations and Telegram Forum topics. Each VK peer gets its own Telegram topic; the bridge stores mappings in PostgreSQL and synchronizes events in both directions.

One instance is intended for one dedicated Telegram Forum chat. Use a separate `DATABASE_SCHEMA` for each additional chat.

### Features

- VK → Telegram: text, photos, documents, voice messages, audio, video, stickers, buttons, forwarded messages, links, polls, and chat service events.
- Telegram → VK: text and captions, photos, documents, voice messages, audio, video, supported stickers, and button actions.
- Replies, pins, edits, deletions, version history, and message mapping.
- Mirroring of the configured Telegram owner's reactions to VK and compact VK reaction summaries in Telegram.
- Updates to the VK chat name, avatar, and member list in the topic's service pins.

### Requirements

- Node.js 20.11 or later;
- PostgreSQL;
- a Telegram supergroup with Forum topics enabled;
- a Telegram bot with administrator rights to create and manage topics;
- a VK user access token with access to messages and the required media types.

### Quick start

```bash
npm ci
cp .env.example .env
```

Fill in `.env`, then run the migrations and start the bridge:

```bash
npm run db:migrate
npm run dev
```

For a production launch without Docker:

```bash
npm run build
npm run start
```

### Configuration

See [`.env.example`](.env.example) for the complete list of safe example values.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. Certificate verification is required by default. |
| `DATABASE_SCHEMA` | An isolated database schema for one Telegram chat. |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token. |
| `TELEGRAM_CHAT_ID` | Target Forum chat ID. |
| `VK_ACCESS_TOKEN` | VK user access token. |
| `TELEGRAM_REACTION_USER_ID` | Optional ID of the owner whose reactions are mirrored to VK. |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_USER_SESSION` | Optional, but required for Telegram → VK deletion sync through MTProto. |
| `STICKER_MAPPING_PATH` | Path to `sticker-mapping.json` when it is not in the project root. |

For trusted local PostgreSQL without TLS, set `sslmode=disable` in `DATABASE_URL` explicitly. Do not disable TLS verification for an external database unless it is necessary.

Create an MTProto session for deletion synchronization with:

```bash
npm run telegram:login
```

The command writes a mode-`0600` `.telegram-user-session` file. Copy its value to `TELEGRAM_USER_SESSION`, then remove the temporary file.

### Docker

After configuring `.env`:

```bash
docker compose up -d --build
docker compose logs -f bot
```

PostgreSQL runs separately. Use `host.docker.internal` rather than `localhost` for a database running on the Docker host.

For multiple instances on one Docker host, use distinct Compose project names, for example `docker compose -p vk-telegram-bridge-dmitrii up -d --build` and `docker compose -p vk-telegram-bridge-adilya up -d --build`.

### Stickers

`sticker-mapping.json` is the runtime bidirectional map between VK `sticker_id` values and Telegram `set_name + file_unique_id` pairs. Updating it requires VK and Telegram tokens in `.env`:

```bash
npm run stickers:discover
npm run stickers:sync
```

The first command updates the automatic candidate catalogue; the second rebuilds the map. Visual verification of an individual pack requires `ffmpeg`:

```bash
npm run stickers:sync -- --product 1379 --visual --dry-run
```

Docker provides a dedicated profile for this task:

```bash
docker compose --profile tools run --rm sticker-sync
```

### Development and validation

```bash
npm test
npm audit --omit=dev --audit-level=high
```

CI runs the same checks for pushes and pull requests. Repository layout:

- `src/` — application source;
- `migrations/` — SQL migrations;
- `scripts/` — sticker map maintenance tools;
- `test/` — regression tests.

### Security

Do not commit `.env` or `.env.*`, MTProto sessions, certificates, or keys. Report vulnerabilities according to [SECURITY.md](SECURITY.md), not in a public issue containing secrets or a working exploit.

### License

This project is licensed under the [MIT License](LICENSE).
