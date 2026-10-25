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

### Где получить токены VK

Для переписки и отправки фото используй два пользовательских токена **одного аккаунта VK**. Получить их можно на [vkhost.github.io](https://vkhost.github.io/).

| Переменная в `.env` | Что выбрать на сайте | Для чего |
| --- | --- | --- |
| `VK_ACCESS_TOKEN` | **Маруся**, ID `6463690` | Диалоги, получение и отправка сообщений, Long Poll. |
| `VK_PHOTO_ACCESS_TOKEN` | **VFeed**, ID `4083558` | Загрузка фотографий. |

1. Открой сайт и выбери **Маруся**. Подтверди доступ на странице VK.
2. В адресе после авторизации скопируй только значение между `access_token=` и следующим `&`. Запиши его в `VK_ACCESS_TOKEN`.
3. Вернись на сайт, выбери **VFeed** и авторизуйся под тем же аккаунтом. Полученный токен запиши в `VK_PHOTO_ACCESS_TOKEN`.

При получении токена через кнопки приложений вручную выбирать права не нужно: VK выдаёт набор, доступный выбранному приложению. Поэтому здесь используются два разных приложения.

В `.env` должно получиться так — вместо заглушек подставь свои токены:

```dotenv
VK_ACCESS_TOKEN=token_from_marusia
VK_PHOTO_ACCESS_TOKEN=token_from_vfeed
```

В проверенной конфигурации токен «Маруси» работает с сообщениями, но не имеет права `photos`. У токена VFeed есть доступ к загрузке фото, но нет доступа к диалогам и Long Poll, поэтому ставить его основным не нужно. Фактические права зависят от приложения и выданного токена; доступность обоих методов проверена в октябре 2026 года.

Мост использует дополнительный токен только для `photos.getMessagesUploadServer` и `photos.saveMessagesPhoto`, а отправляет сообщение с полученным фото через основной токен. Если `VK_PHOTO_ACCESS_TOKEN` не указан, фотографии загружаются основным токеном — у него тогда тоже должно быть право `photos`. Фото отправляются именно фотографиями; при отказе VK они не подменяются документами. Права на остальные типы медиа нужны основному токену отдельно.

Если Telegram не может скачать фото или аватар из VK по ссылке (`failed to get HTTP URL content`), мост скачивает изображение сам и отправляет файлом. При ошибке обновления старый закреп сохраняется.

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
| `VK_ACCESS_TOKEN` | Основной пользовательский токен VK для переписки («Маруся»). |
| `VK_PHOTO_ACCESS_TOKEN` | Необязательный токен VFeed того же аккаунта для загрузки фото. |
| `TELEGRAM_REACTION_USER_ID` | Необязательный ID владельца, чьи реакции надо зеркалить в VK. |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_USER_SESSION` | Необязательны, но нужны для синхронизации удалений Telegram → VK через MTProto. |
| `STICKER_MAPPING_PATH` | Путь к `sticker-mapping.json`, если карта находится не в корне проекта. |
| `VK_API_MIN_INTERVAL_MS` | Минимальный интервал между запросами VK API; по умолчанию `350` мс. |
| `VK_FLOOD_RETRY_BASE_MS`, `VK_FLOOD_RETRY_MAX_MS` | Начальная и максимальная пауза после VK `error 9`; по умолчанию 15 минут и 2 часа. |
| `LOG_REPEAT_WINDOW_MS` | Интервал агрегации одинаковых сообщений в Telegram Logs; по умолчанию 5 минут. |

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

Для экземпляра Дмитрия используй имя Compose-проекта `vk-telegram-bridge-dmitrii`: `docker compose -p vk-telegram-bridge-dmitrii up -d --build`.

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

### Getting VK tokens

Use two user tokens for **the same VK account** to support messaging and photo uploads. Obtain them at [vkhost.github.io](https://vkhost.github.io/).

| `.env` variable | Application on the website | Purpose |
| --- | --- | --- |
| `VK_ACCESS_TOKEN` | **Маруся** (Marusia), ID `6463690` | Conversations, incoming and outgoing messages, and Long Poll. |
| `VK_PHOTO_ACCESS_TOKEN` | **VFeed**, ID `4083558` | Photo uploads. |

1. Open the website, select **Маруся**, and approve access on the VK authorization page.
2. Copy only the token value between `access_token=` and the next `&` in the resulting address. Save it as `VK_ACCESS_TOKEN`.
3. Return to the website, select **VFeed**, and authorize the same account. Save this token as `VK_PHOTO_ACCESS_TOKEN`.

Using the application buttons does not require manual permission selection: VK grants the permissions available to the selected application. This is why the setup uses two different applications.

Replace the placeholders in `.env` with your tokens:

```dotenv
VK_ACCESS_TOKEN=token_from_marusia
VK_PHOTO_ACCESS_TOKEN=token_from_vfeed
```

In the verified configuration, the Marusia token supports messaging but lacks `photos`. The VFeed token supports photo uploads but cannot access conversations or Long Poll, so it should not replace the primary token. Actual permissions depend on the application and issued token; access to both methods was checked in October 2026.

The secondary token is used only for `photos.getMessagesUploadServer` and `photos.saveMessagesPhoto`. The primary token sends the resulting photo attachment. Without `VK_PHOTO_ACCESS_TOKEN`, photo uploads use the primary token, which must then have `photos` permission too. Photos remain photo attachments; a VK rejection does not trigger a document fallback. Other media types require their own permissions on the primary token.

If Telegram cannot fetch a VK photo or avatar URL (`failed to get HTTP URL content`), the bridge downloads the image and uploads the file itself. A failed profile update preserves the previous pin.

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
| `VK_ACCESS_TOKEN` | Primary VK user token for messaging (Marusia). |
| `VK_PHOTO_ACCESS_TOKEN` | Optional VFeed token for the same account, used for photo uploads. |
| `TELEGRAM_REACTION_USER_ID` | Optional ID of the owner whose reactions are mirrored to VK. |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_USER_SESSION` | Optional, but required for Telegram → VK deletion sync through MTProto. |
| `STICKER_MAPPING_PATH` | Path to `sticker-mapping.json` when it is not in the project root. |
| `VK_API_MIN_INTERVAL_MS` | Minimum interval between VK API requests; defaults to `350` ms. |
| `VK_FLOOD_RETRY_BASE_MS`, `VK_FLOOD_RETRY_MAX_MS` | Initial and maximum cooldown after VK `error 9`; defaults to 15 minutes and 2 hours. |
| `LOG_REPEAT_WINDOW_MS` | Coalescing window for identical Telegram Logs messages; defaults to 5 minutes. |

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

For Dmitrii’s instance, use the Compose project name `vk-telegram-bridge-dmitrii`: `docker compose -p vk-telegram-bridge-dmitrii up -d --build`.

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
