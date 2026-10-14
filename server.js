const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
// Публикация в Telegram-канал: токен бота, канал (@имя или числовой -100...) и список Telegram ID, которым разрешено публиковать
// Пробелы и переводы строки по краям токена убираем: URL к Telegram их «прощает» (getMe отвечает),
// а подпись initData считается по токену как есть и тогда не сходится
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim() || undefined;
const TELEGRAM_CHANNEL_ID = normalizeChannelId(process.env.TELEGRAM_CHANNEL_ID);
const TELEGRAM_ALLOWED_USER_IDS = (process.env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INIT_DATA_MAX_AGE_SEC = 24 * 60 * 60;
// Очередь запланированных постов живёт в базе Notion «PostBot: расписание публикаций» (Railway стирает файлы при деплое).
// Идентификаторы можно переопределить переменными окружения. Версия API Notion 2025-09-03: страницы и запросы идут через data source.
const NOTION_SCHEDULE_DB_ID = process.env.NOTION_SCHEDULE_DB_ID || '9774b7e9-9511-41d4-b563-978931704e5d';
const NOTION_SCHEDULE_DS_ID = process.env.NOTION_SCHEDULE_DS_ID || 'b818813e-8172-4dc4-8893-e5ea30c6a726';
const ASK_BUTTON_URL = (process.env.ASK_BUTTON_URL || '').trim() || 'https://t.me/ask_skakunov_bot?start=post';
const ASK_BUTTON_TEXT = (process.env.ASK_BUTTON_TEXT || '').trim() || 'Задать вопрос';
const SCHEDULER_INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS) || 30 * 1000;
// Пост, который просрочен больше чем на это время (сервер был недоступен), не публикуется сам: пользователь решает
const SCHEDULE_STALE_MS = (Number(process.env.SCHEDULE_STALE_MINUTES) || 30) * 60 * 1000;
const SCHEDULE_TZ = 'Europe/Warsaw';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Модель и адрес вынесены в переменные окружения: у Google они менялись, и подстроить их можно без правки кода
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1';
const GEMINI_API_URL = process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_LEGACY_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// Проба моделей картинок (/api/cover-diag?probe=1): дешёвый запрос и пауза между запусками
const PROBE_PROMPT = 'A single small gold circle centered on a plain black background. No text, no letters, no numbers.';
const PROBE_COOLDOWN_MS = 60 * 1000;
let probeRunning = false;
let lastProbeAt = 0;
const NOTION_DATABASE_ID = 'a81c0118449d47388b3fb612a509cd38';
const DRAFT_LAB_DATA_SOURCE_ID = '14814719-85c5-4819-a07e-3d1b773d6bdb';
const CAREER_CASES_DATA_SOURCE_ID = 'a81c0118-449d-4738-8b3f-b612a509cd38';

const MODEL = 'claude-sonnet-4-6';

// Буква «ё» запрещена во всех текстах Дмитрия. Модели её пропускают (особенно последний проход-критик),
// поэтому финальный текст чистим кодом, а не просьбой в промпте
// Домены известных изданий в тексте поста заменяем названием: ссылки и домены в тексте роняют охваты. Разметку [текст](url) не трогаем
const OUTLETS = { 'igamingbusiness.com': 'iGaming Business', 'next.io': 'Next.io', 'sbcnews.co.uk': 'SBC News', 'gamblinginsider.com': 'Gambling Insider', 'yogonet.com': 'Yogonet', 'egr.global': 'EGR' };
const nameOutlets = t => Object.entries(OUTLETS).reduce((acc, [dom, name]) =>
  acc.replace(new RegExp('(?<![/.\\w-])(?:https?://)?(?:www\\.)?' + dom.replace(/\./g, '\\.') + '(?![\\w/-])', 'gi'), name), String(t || ''));

const noYo = t => String(t || '').replace(/ё/g, 'е').replace(/Ё/g, 'Е')
  // Тире и дефис с пробелами как пунктуация («X - Y», «X — Y», «X – Y») модель возвращает даже после запрета: ставим двоеточие
  .replace(/\s+[\u2014\u2013-]\s+/g, ': ');

// Рубрика «100 голосов»: оформление не должно менять слова героя. Если после оформления текст без разметки
// отличается от исходного, берём исходный и добавляем лейбл, хэштег и подпись кодом.
const VOICE_HASHTAG = '#100_голосов';
const VOICE_LABEL = '🎙 100 ГОЛОСОВ iGAMING';
const VOICE_SIGNATURE = '// D.S. //';
function strictVoiceFormat(formatted, original, label) {
  const lab = (label || VOICE_LABEL).trim();
  const plain = s => noYo(s).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  const service = new Set([lab, VOICE_HASHTAG, VOICE_SIGNATURE]);
  const body = String(formatted).split('\n').filter(l => !service.has(l.replace(/\*\*/g, '').trim())).join('\n');
  if (plain(body) === plain(original)) return formatted;
  console.error('rubric-format: оформление изменило слова героя, использую исходный текст');
  return `${lab}\n\n${String(original).trim()}\n\n${VOICE_HASHTAG}\n\n\n${VOICE_SIGNATURE}`;
}

// Пост по новости из дайджеста: фактов во входе мало, и модель растягивает их выдумкой. Лечим причину: короткий пост только из фактов входа.
// Правило стоит в конце system prompt и перекрывает «длина свободная» и «150-300 слов»
const DIGEST_RULE = `

---

РЕЖИМ ПОСТА ПО НОВОСТИ (перекрывает все правила о длине и структуре выше):
Пост строится ТОЛЬКО на фактах из входа (Что произошло, Цифра / факт, Источник) и на позиции автора. Во входе мало фактов, поэтому пост короткий: 90-150 слов, это жесткий потолок. Растягивать факты выдумкой нельзя, лучше короче.
Структура: самый сильный факт из входа, одна общая механика, которая объясняет оператору, почему это важно (без новых чисел и без утверждений о конкретных людях, компаниях и рынках), позиция автора одной-двумя фразами с оговоркой («я бы», «похоже», «стоит проверить»).
Каждое предложение поста должно быть либо фактом из входа, либо явной позицией автора. Третьего не бывает.
Хук: самый сильный факт из входа, без метафор про смерть, войну и катастрофу.
Запрещено: описывать, что «видит регулятор», «думает рынок», «чувствуют люди»; писать про домены, контракты, SEO, долю рынка, сроки восстановления и «единственное, что нужно делать», если этого нет во входе; больше пяти чисел; приписывать цифру источнику, если во входе этого не сказано.
Если во входе указан источник, назови его одной короткой фразой по имени, без ссылки и домена.`;

// Англицизмы: латиницей остаются только аббревиатуры и имена собственные. Остальное по-русски.
const ANGLICISM_RULE = `АНГЛИЦИЗМЫ:
Пиши по-русски. Если у английского слова есть нормальный русский эквивалент, используй его. Не оставляй английские слова латиницей и не записывай их кириллицей («ретеншн», «ретеншен»).
Примеры замен: retention → удержание игроков; reactivation → возвращение игрока; live (ставки, реклама, коэффициенты) → «по ходу матча», «во время матча»; pre-match → «до матча»; second bet → вторая ставка; second deposit → второй депозит; user journey → путь игрока; acquisition → привлечение; cross-sell → перекрестные продажи; trigger → повод; touchpoint → точка контакта; sportsbook → спортбук; margin и hold → маржа; bonus → бонус.
Латиницей оставляй только: аббревиатуры (GGR, NGR, CRM, KPI, LTV, CPA, CAC, ROI), названия компаний, регуляторов и продуктов, коды валют. Базовые термины индустрии (GGR, NGR, маржа, прокрут) не расшифровывай.
Самопроверка: в тексте нет слов латиницей, кроме перечисленных выше.`;

// Личный якорь без выдумок: опыт Дмитрия только из входа, иначе якорь это его позиция в разных формах
const ANCHOR_RULE = `ЛИЧНЫЙ ОПЫТ И ЯКОРЬ:
Личный опыт Дмитрия используй ТОЛЬКО если он есть во входном тексте (тема, мысль, готовый текст). Ничего не додумывай: никаких «я видел», «я сталкивался», «я наблюдал», «изнутри», «на нескольких рынках», «в моей команде», «на одном запуске», «по нашим замерам». Если во входе этого нет, такого предложения в посте быть не должно.
Без личного кейса якорем служит позиция Дмитрия. Форму меняй от поста к посту, не повторяй одну и ту же:
- что он проверил бы первым и почему;
- решение, которое он принял бы на месте оператора, регулятора или провайдера;
- с чем в общепринятой трактовке он не согласен;
- его прогноз и условие, при котором прогноз не сбудется;
- какая цифра в этой истории главная и какую никто не называет;
- в чем он сам пока не уверен.
Не подпирай позицию стажем: без «по опыту», «как практик», «за 18 лет я понял». Позиция звучит как мнение человека с P&L, а не как ссылка на свою биографию.

ФАКТЫ:
Цифры, сроки, даты и утверждения о событиях бери только из входа. Свои сроки («от 3 до 6 месяцев»), проценты, причины и последствия, которых во входе нет, не добавляй: если это твоя оценка, подай ее как позицию Дмитрия («я бы закладывал…») без числа. Не придумывай относительные даты («месяц назад», «на прошлой неделе»), если во входе нет даты. Не сочиняй детали чужого рынка (кто что проверяет, платит, исполняет). Периоды в тексте не должны противоречить друг другу.
Чисел в посте не больше пяти или шести: оставь самые важные, остальные вырежи. Если во входе указан источник, назови его короткой фразой (издание или документ), без ссылки и домена.
Не приводи сравнения с другими рынками, странами, годами, компаниями и прошлыми событиями, если их нет во входе («как в Нидерландах в 2019»). Исторические параллели из памяти модели ненадежны и запрещены.
Тире и дефис как знак препинания не используй: вместо «X — Y» пиши «X: Y» или две фразы. Жирный и markdown не используй.`;

// ── Кэш образцов стиля из Career Cases ───────────────────────────────
let styleCache = { text: '', fetchedAt: 0 };
const STYLE_CACHE_TTL = 30 * 60 * 1000; // 30 минут

async function getStyleExamples() {
  const now = Date.now();
  if (styleCache.text && now - styleCache.fetchedAt < STYLE_CACHE_TTL) {
    return styleCache.text;
  }
  try {
    const resp = await fetch(
      `https://api.notion.com/v1/data_sources/${CAREER_CASES_DATA_SOURCE_ID}/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_API_KEY}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2025-09-03',
        },
        body: JSON.stringify({ page_size: 25 }),
      }
    );

    if (!resp.ok) {
      const respOld = await fetch(
        `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${NOTION_API_KEY}`,
            'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28',
          },
          body: JSON.stringify({ page_size: 25 }),
        }
      );
      if (!respOld.ok) throw new Error('Notion query failed');
      const dataOld = await respOld.json();
      const countOld = (dataOld.results || []).length;
      const textOld = buildStyleText(dataOld.results || []);
      console.log(`Career Cases: прочитано ${countOld} кейсов (старый API)`);
      styleCache = { text: textOld, fetchedAt: now };
      return textOld;
    }

    const data = await resp.json();
    const count = (data.results || []).length;
    const text = buildStyleText(data.results || []);
    console.log(`Career Cases: прочитано ${count} кейсов (новый API)`);
    styleCache = { text, fetchedAt: now };
    return text;
  } catch (err) {
    console.error('getStyleExamples failed, writing without examples:', err.message);
    return '';
  }
}

function buildStyleText(results) {
  const cases = [];
  for (const page of results) {
    const props = page.properties || {};
    const title = props['Title']?.title?.[0]?.plain_text || '';
    const full = (props['Full Answers']?.rich_text || [])
      .map(r => r.plain_text).join('');
    if (full && full.trim().length > 0) {
      cases.push(`### ${title}\n${full.trim()}`);
    }
  }
  if (cases.length === 0) return '';
  return cases.join('\n\n---\n\n');
}

function buildStyleBlock(styleText) {
  if (!styleText) return '';
  return `

---

ОБРАЗЦЫ РЕАЛЬНОГО СТИЛЯ ДМИТРИЯ (из его лучших постов):

Ниже — реальные посты Дмитрия. Это ОБРАЗЦЫ СТИЛЯ, не материал для копирования.
НЕ вставляй конкретные факты, цифры или истории отсюда в свой пост, если тема прямо им не соответствует.
Твоя задача — впитать МАНЕРУ: как он заходит в текст, разворачивает мысль, ставит личное наблюдение и цифру, как заканчивает. Ритм, голос, длина абзацев, тип крючка.
Затем напиши НОВЫЙ пост на свою тему в этой манере, с собственным содержанием.

${styleText}

---`;
}

// ── Stop-Slop: финальный проход перед выдачей ─────────────────────────
// Второй API-вызов после генерации. Убирает лексический и структурный AI-slop.
// Если Anthropic недоступен или что-то пошло не так — возвращает оригинал без изменений.
async function runStopSlop(postText) {
  const stopSlopSystem = `Ты финальный корректор LinkedIn-постов Дмитрия Скакунова, Head of Sportsbook в iGaming.
Получаешь готовый пост и убираешь из него AI-slop двух типов.

ЛЕКСИЧЕСКИЙ СЛОП — удалить всегда:
- «Вот как...» / «Вот что...» / «Вот почему...» / «И вот в чем проблема» / «Давайте разберёмся» / «Копнём глубже»
- «Дело не в X, а в Y» / «Это не просто X — это Y» / «Речь не о X, речь о Y»
- «Это не X. Это Y.» двумя соседними предложениями, «Не потому что X, а потому что Y», «не X, а Y» как главный ход абзаца: переписать как прямое утверждение про Y, без отрицания X
- «Результат?» / «Почему это важно?» / «Знакомо?» / «Звучит просто? Не совсем.»
- «Честно говоря...» / «Если быть откровенным...» / «Скажу как есть...» — если после нет реального спорного мнения
- «В заключение...» / «Подводя итог...» / «Итак...» как связка перед моралью
- «Фраза которая со мной осталась...»
- Generic CTA: «Что думаете?», «Согласны?», «Делитесь в комментариях» (предметный узкий вопрос — ок)
- «3 урока которые я вынес», «5 вещей которые я понял» — любые счётчики-заголовки
- «раскрыть потенциал», «вывести на новый уровень», «трансформировать», «game-changer», «прорывной»
- «синергия», «экосистема» (не буквально), «холистический подход»
- «важно отметить что...», «стоит сказать что...», «как показывает практика» без конкретики рядом
- «безусловно» / «несомненно» как филлер в начале предложения
- «CRM ликует», «Finance страдает» — ложная драматизация персонажей
- «я вот видел», «я вот знаю», «и вот тут начинается», «спойлер» как драматический приём

СТРУКТУРНЫЙ СЛОП — исправить:
- Тройной рефрен ради ритма: три фразы одной структуры, ноль нового смысла на 2-й и 3-й
- Открытие риторическим вопросом без реального напряжения
- Двойное проговаривание одной мысли разными словами (паддинг)
- Vague superlative без числа: «огромный рост», «колоссальный эффект» — либо цифра, либо вырезать
- Идеально ровный ритм каждого предложения (AI-ритм) — разбить, сделать рваным
- Тире и дефис как пунктуация: убрать все. «X — Y» переписать как «X: Y» или двумя фразами. Исключение только дефис внутри слова (по-другому, кто-то)
- Исторические сравнения с другими странами и годами, которых нет в посте от автора как факт на входе: вырезать. Если ты не уверен, что пример верный, вырезай

ЧТО НЕ ТРОГАТЬ (защищённые элементы):
- Короткие декларативные предложения — фирменный голос Дмитрия, не slop
- Цифры и метрики (GGR, NGR, hold%, margin, CAC, LTV, конкретные проценты)
- Личный якорь (момент или наблюдение из реального опыта) — не полируй, не вырезай
- Аббревиатуры: GGR, NGR, CRM, KPI, LTV, CPA, CAC (английские слова вроде retention, live, second bet НЕ защищены: заменить русскими)
- Тире там где грамматически обязательно: подлежащее без глагола-связки, неполное предложение

ПРАВИЛА ПЕРЕПИСИ:
- Сохраняй смысл и примерный объём — не сокращай в 2 раза «чтобы было чище»
- Не меняй один штамп на другой («Вот как» → «Смотри, как» — это тот же тик)
- Сомневаешься — вырезай, не заменяй. Тишина лучше филлера
- Если текст чистый — верни его без изменений
- Верни ТОЛЬКО текст поста. Никаких пояснений, заголовков, комментариев до или после.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: stopSlopSystem,
        messages: [{ role: 'user', content: postText }]
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('stop-slop API error:', data.error?.message);
      return postText; // fallback — оригинал
    }
    if (data.stop_reason === 'max_tokens') {
      // Обрезанная чистка хуже оригинала: концовка поста потерялась бы молча
      console.error('stop-slop: ответ обрезан по max_tokens, возвращаю оригинал');
      return postText;
    }
    const cleaned = data.content?.[0]?.text || postText;
    console.log('stop-slop: проход выполнен');
    return cleaned;
  } catch (err) {
    console.error('stop-slop failed, returning original:', err.message);
    return postText; // fallback — всегда возвращаем что-то
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Параметры в адресе (например, ?reschedule=<id> из кнопки бота) не должны давать 404
  const pagePath = req.url.split('?')[0];
  if (req.method === 'GET' && (pagePath === '/' || pagePath === '/index.html')) {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading page');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/generate') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { prompt, tone, mode } = JSON.parse(body);

        const isTg = tone === 'telegram';
        const styleText = isTg ? '' : await getStyleExamples();
        const digestMode = /Что произошло:/.test(String(prompt || ''));
        const systemPrompt = (isTg ? getTelegramSystemPrompt() : getSystemPrompt() + buildStyleBlock(styleText)) + (digestMode ? DIGEST_RULE : '');

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: buildUserPrompt(prompt, tone, mode) }]
          })
        });

        const data = await response.json();

        if (!response.ok) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: data.error?.message || 'API error' }));
          return;
        }

        // Обрезанный черновик нельзя отдавать и пропускать через чистку: концовка поста потерялась бы молча
        if (data.stop_reason === 'max_tokens') {
          console.error('generate: ответ обрезан по max_tokens, тон', tone);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Ответ модели обрезан по лимиту длины. Попробуй сузить тему или написать ещё раз.' }));
          return;
        }

        const rawText = data.content?.[0]?.text || '';
        let text;
        if (isTg) {
          // Три прохода для Telegram: stop-slop специфичный → critic
          const afterSlop = await runTelegramStopSlop(rawText);
          text = await runTelegramCritic(afterSlop);
        } else {
          text = await runStopSlop(rawText);
        }
        // Пост из дайджеста (во входе есть «Что произошло:»): сверяем с входом и режем выдумки
        if (/Что произошло:/.test(String(prompt || ''))) text = await runFactTrim(prompt, text);
        // Последним: ловим «не X, а Y» кодом (после всех проходов, которые могли его вернуть)
        text = await runNegContrastFix(text);
        // И последним англицизмы: ловим кодом, правим один раз
        text = await runAnglicismFix(text);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: noYo(nameOutlets(text)) }));

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/format-post') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { postText } = JSON.parse(body);

        if (!postText || !postText.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Пустой текст' }));
          return;
        }

        const systemPrompt = getFormatSystemPrompt();

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: postText }]
          })
        });

        const data = await response.json();

        if (!response.ok) {
          console.error('format-post error:', JSON.stringify(data));
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: data.error?.message || 'API error' }));
          return;
        }

        if (data.stop_reason === 'max_tokens') {
          console.error('format-post: ответ обрезан по max_tokens, длина входа', postText.length);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Ответ модели обрезан по лимиту длины. Пост слишком длинный для оформления.' }));
          return;
        }

        const text = data.content?.[0]?.text || postText;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: noYo(nameOutlets(text)) }));

      } catch (err) {
        console.error('format-post catch error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/comments') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { postText } = JSON.parse(body);

        const detectedLang = detectLanguage(postText);
        const langInstruction = detectedLang === 'uk' ? 'Всі 7 коментарів пиши ВИКЛЮЧНО українською мовою.'
          : detectedLang === 'en' ? 'Write ALL 7 comments EXCLUSIVELY in English.'
          : 'Все 7 комментариев пиши ИСКЛЮЧИТЕЛЬНО на русском языке.';

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 1200,
            system: getCommentsSystemPrompt(),
            messages: [{ role: 'user', content: `${langInstruction}\n\nВот пост:\n\n"${postText}"` }]
          })
        });

        const data = await response.json();

        if (!response.ok) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: data.error?.message || 'API error' }));
          return;
        }

        const raw = data.content?.[0]?.text || '';
        const comments = parseComments(raw);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ comments }));

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/save-draft') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { postText, topic } = JSON.parse(body);

        const ideaTitle = topic && topic.length > 0
          ? topic.slice(0, 80)
          : postText.split('\n')[0].slice(0, 80);

        // Career Cases — та же база что и save-case, тот же data_source_id
        const notionResponse = await fetch('https://api.notion.com/v1/pages', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${NOTION_API_KEY}`,
            'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28',
          },
          body: JSON.stringify({
            parent: { data_source_id: CAREER_CASES_DATA_SOURCE_ID },
            properties: {
              'Title': { title: [{ text: { content: ideaTitle } }] },
              'Full Answers': { rich_text: [{ text: { content: postText.slice(0, 2000) } }] },
            }
          })
        });

        const notionData = await notionResponse.json();

        if (!notionResponse.ok) {
          console.error('save-draft Notion error:', JSON.stringify(notionData));
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: notionData.message || 'Notion API error' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));

      } catch (err) {
        console.error('save-draft catch error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/rubric-format') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { postText, forcedLabel, forcedHashtag } = JSON.parse(body);

        if (!postText || !postText.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Пустой текст поста' }));
          return;
        }

        let systemPrompt = getRubricFormatSystemPrompt();
        if (forcedLabel && forcedHashtag) {
          systemPrompt += `\n\nВАЖНО, ПЕРЕКРЫВАЕТ ШАГ 1: пользователь уже выбрал рубрику вручную. Не пытайся определять рубрику самостоятельно, шаг 1 полностью пропускается. Используй ровно эти значения: визуальный лейбл "${forcedLabel}", хэштег "${forcedHashtag}". Дальше следуй шагу 2 как обычно.`;
          if (forcedHashtag === VOICE_HASHTAG) systemPrompt += `\n\nСТРОГИЙ РЕЖИМ ДЛЯ ЭТОЙ РУБРИКИ: это прямая речь героя. Не меняй ни одного слова, не переставляй, не удаляй и не добавляй слов, не правь абзацы и строки (в том числе строки в квадратных скобках). Разрешено только: лейбл рубрики сверху, жирные акценты **...** вокруг уже существующих фраз, хэштег и подпись.`;
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: postText }]
          })
        });

        const data = await response.json();

        if (!response.ok) {
          console.error('rubric-format API error:', JSON.stringify(data));
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: data.error?.message || 'API error' }));
          return;
        }

        // Подпись и хэштег стоят в самом конце ответа: при обрезке по лимиту они пропали бы первыми.
        // Лучше показать ошибку, чем молча отдать обрезанный пост.
        if (data.stop_reason === 'max_tokens') {
          console.error('rubric-format: ответ обрезан по max_tokens, длина входа', postText.length);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Ответ модели обрезан по лимиту длины. Пост слишком длинный для оформления.' }));
          return;
        }

        const text = data.content?.[0]?.text || postText;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: forcedHashtag === VOICE_HASHTAG ? strictVoiceFormat(noYo(nameOutlets(text)), postText, forcedLabel) : noYo(nameOutlets(text)) }));

      } catch (err) {
        console.error('rubric-format catch error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── Публикация в Telegram-канал: состояние настройки без пробных постов. Токен в ответ не попадает ──
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/publish-diag') {
    const out = { tokenPresent: !!TELEGRAM_BOT_TOKEN, channel: TELEGRAM_CHANNEL_ID || null, allowedUsers: TELEGRAM_ALLOWED_USER_IDS.length };
    try {
      if (TELEGRAM_BOT_TOKEN) {
        try {
          const me = await tgApi('getMe', {});
          out.bot = '@' + me.username;
          out.botId = me.id;
        } catch (e) { out.botError = friendlyTelegramError(e.message); }
        // Привязано ли Mini App к этому боту: кнопка меню бота должна вести на адрес этого сервиса.
        // Если у бота кнопка меню другая, приложение, открытое через него, подписано его токеном, а не нашим.
        try {
          const mb = await tgApi('getChatMenuButton', {});
          out.menuButton = { type: mb.type, text: mb.text || null, url: (mb.web_app && mb.web_app.url) || null };
        } catch (e) { out.menuButtonError = friendlyTelegramError(e.message); }
      }
      if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHANNEL_ID && out.botId) {
        try {
          const chat = await tgApi('getChat', { chat_id: TELEGRAM_CHANNEL_ID });
          out.chat = { title: chat.title || null, type: chat.type, username: chat.username || null };
        } catch (e) { out.chatError = friendlyTelegramError(e.message); }
        try {
          const m = await tgApi('getChatMember', { chat_id: TELEGRAM_CHANNEL_ID, user_id: out.botId });
          out.botStatus = m.status;
          out.canPostMessages = m.status === 'creator' || (m.status === 'administrator' && m.can_post_messages !== false);
        } catch (e) { out.memberError = friendlyTelegramError(e.message); }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: scrubToken(err.message) }));
    }
    return;
  }

  // ── Публикация в Telegram-канал. Только из Telegram Mini App и только для разрешённых Telegram ID ──
  if (req.method === 'POST' && req.url === '/api/publish') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 15 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      try {
        if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
          return send(503, { error: 'Публикация не настроена: задай TELEGRAM_BOT_TOKEN и TELEGRAM_CHANNEL_ID в переменных Railway' });
        }
        const auth = await authorizeUser(req);
        if (!auth.ok) return send(auth.status, { error: auth.error });
        const { text, imageDataUrl, askButton } = JSON.parse(body);
        send(200, await publishToChannel(text, imageDataUrl, askButton === true));
      } catch (err) {
        console.error('publish error:', scrubToken(err.message));
        send(err.httpStatus || 500, { error: scrubToken(err.message) });
      }
    });
    return;
  }

  // ── Планирование: поставить пост в очередь (из Mini App). Публикует планировщик на сервере ──
  if (req.method === 'POST' && req.url === '/api/schedule') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      try {
        if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
          return send(503, { error: 'Публикация не настроена: задай TELEGRAM_BOT_TOKEN и TELEGRAM_CHANNEL_ID в переменных Railway' });
        }
        if (!scheduleConfigured()) return send(503, { error: 'Расписание не настроено: нужен NOTION_API_KEY в переменных Railway' });
        const auth = await authorizeUser(req);
        if (!auth.ok) return send(auth.status, { error: auth.error });
        const { text, when, askButton } = JSON.parse(body);
        assertPostText(text);
        const parsed = parseWarsawDateTime(when);
        if (!parsed.ok) return send(400, { error: parsed.error });
        const row = await schedCreate(text, parsed.iso, Number(auth.userId), askButton === true);
        send(200, { ok: true, id: row.id, publishAt: parsed.iso, local: formatWarsaw(parsed.iso) });
      } catch (err) {
        console.error('schedule error:', scrubToken(err.message));
        send(err.httpStatus || 500, { error: scrubToken(err.message) });
      }
    });
    return;
  }

  // ── Перенос: данные поста для экрана переноса (открывается кнопкой бота) ──
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/scheduled-post') {
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      if (!scheduleConfigured()) return send(503, { error: 'Расписание не настроено: нужен NOTION_API_KEY в переменных Railway' });
      const auth = await authorizeUser(req);
      if (!auth.ok) return send(auth.status, { error: auth.error });
      const id = new URL(req.url, 'http://localhost').searchParams.get('id') || '';
      if (!/^[0-9a-f-]{32,40}$/i.test(id)) return send(400, { error: 'Некорректный id поста' });
      let row;
      try { row = await schedGet(id); } catch { return send(404, { error: 'Пост не найден или очередь недоступна' }); }
      if (String(row.owner) !== auth.userId) return send(403, { error: 'Это не твой пост' });
      send(200, { id: row.id, text: row.text, status: row.status, publishAt: row.publishAt, local: formatWarsaw(row.publishAt) });
    } catch (err) {
      console.error('scheduled-post error:', scrubToken(err.message));
      send(err.httpStatus || 500, { error: scrubToken(err.message) });
    }
    return;
  }

  // ── Перенос: новое время уже запланированного поста (статус остаётся scheduled) ──
  if (req.method === 'POST' && req.url === '/api/reschedule') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', async () => {
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      try {
        if (!scheduleConfigured()) return send(503, { error: 'Расписание не настроено: нужен NOTION_API_KEY в переменных Railway' });
        const auth = await authorizeUser(req);
        if (!auth.ok) return send(auth.status, { error: auth.error });
        const { id, when, messageId } = JSON.parse(body);
        if (!/^[0-9a-f-]{32,40}$/i.test(String(id || ''))) return send(400, { error: 'Некорректный id поста' });
        const parsed = parseWarsawDateTime(when);
        if (!parsed.ok) return send(400, { error: parsed.error });
        let row;
        try { row = await schedGet(id); } catch { return send(404, { error: 'Пост не найден или очередь недоступна' }); }
        if (String(row.owner) !== auth.userId) return send(403, { error: 'Это не твой пост' });
        if (row.status !== 'scheduled') return send(409, { error: `Пост уже не в очереди: ${row.status}` });
        const updated = await rescheduleRow(row, parsed.iso);
        // Карточка в чате с ботом обновляется на новое время. Правим только сообщение в личном чате самого пользователя
        // (chat_id = его Telegram ID), чужие чаты и произвольные сообщения этим путём не затронуть.
        if (Number.isInteger(messageId) && messageId > 0) {
          tgApi('editMessageText', { chat_id: Number(auth.userId), message_id: messageId, text: `✅ Перенесено\n\n${cardText(updated)}`, reply_markup: botKeyboard(row.id) })
            .catch(e => console.error('карточка в чате не обновлена:', scrubToken(e.message)));
        }
        send(200, { ok: true, id: row.id, publishAt: updated.publishAt, local: formatWarsaw(updated.publishAt) });
      } catch (err) {
        console.error('reschedule error:', scrubToken(err.message));
        send(err.httpStatus || 500, { error: scrubToken(err.message) });
      }
    });
    return;
  }

  // ── Очередь в Mini App: список запланированных постов (вкладка «Очередь») ──
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/scheduled-list') {
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      if (!scheduleConfigured()) return send(503, { error: 'Расписание не настроено: нужен NOTION_API_KEY в переменных Railway' });
      const auth = await authorizeUser(req);
      if (!auth.ok) return send(auth.status, { error: auth.error });
      const rows = await schedQuery({ and: [
        { property: 'Owner', number: { equals: Number(auth.userId) } },
        { or: [statusIs('scheduled'), statusIs('missed'), statusIs('failed')] }
      ] }, 100);
      // Сорвавшиеся посты (missed, failed) показываем две недели, чтобы они не копились в списке вечно
      const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
      const items = rows
        .filter(r => r.status === 'scheduled' || (r.publishAt && Date.parse(r.publishAt) >= cutoff))
        .map(r => ({ id: r.id, text: r.text, status: r.status, publishAt: r.publishAt, local: r.publishAt ? formatWarsaw(r.publishAt) : '', error: r.error || '', askButton: r.askButton }));
      send(200, { items });
    } catch (err) {
      console.error('scheduled-list error:', scrubToken(err.message));
      send(err.httpStatus || 500, { error: scrubToken(err.message) });
    }
    return;
  }

  // ── Очередь в Mini App: отмена и публикация сразу (перенос идет через /api/reschedule) ──
  if (req.method === 'POST' && req.url === '/api/scheduled-action') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', async () => {
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      try {
        if (!scheduleConfigured()) return send(503, { error: 'Расписание не настроено: нужен NOTION_API_KEY в переменных Railway' });
        const auth = await authorizeUser(req);
        if (!auth.ok) return send(auth.status, { error: auth.error });
        const { id, action, value } = JSON.parse(body);
        if (!/^[0-9a-f-]{32,40}$/i.test(String(id || ''))) return send(400, { error: 'Некорректный id поста' });
        if (action !== 'cancel' && action !== 'publish' && action !== 'ask-button') return send(400, { error: 'Неизвестное действие' });
        let row;
        try { row = await schedGet(id); } catch { return send(404, { error: 'Пост не найден или очередь недоступна' }); }
        if (String(row.owner) !== auth.userId) return send(403, { error: 'Это не твой пост' });
        if (row.status !== 'scheduled') return send(409, { error: `Пост уже не в очереди: ${row.status}` });
        if (action === 'ask-button') {
          if (schedInFlight.has(row.id)) return send(409, { error: 'Пост публикуется прямо сейчас' });
          try { await schedUpdate(row.id, { askButton: value === true }); }
          catch (e) { return send(502, { error: 'Не удалось сохранить кнопку. Проверь, что в базе расписания есть свойство-checkbox «Кнопка вопроса»' }); }
          return send(200, { ok: true, askButton: value === true });
        }
        if (action === 'cancel') {
          if (schedInFlight.has(row.id)) return send(409, { error: 'Пост публикуется прямо сейчас' });
          await schedUpdate(row.id, { status: 'cancelled' });
          return send(200, { ok: true, status: 'cancelled' });
        }
        const r = await runScheduledPost(row, { checkStale: false, notify: false });
        if (r.status === 'published') return send(200, { ok: true, status: 'published', link: r.link || null });
        if (r.status === 'busy') return send(409, { error: 'Пост уже публикуется' });
        return send(502, { error: `Не удалось опубликовать: ${r.error}` });
      } catch (err) {
        console.error('scheduled-action error:', scrubToken(err.message));
        send(err.httpStatus || 500, { error: scrubToken(err.message) });
      }
    });
    return;
  }

  // ── Голоса: список и карточки во вкладке «Голос» ──
  if (voiceApiRoute(req, res)) return;
  if (voiceRoute(req, res)) return;

  // ── Threads: генерация, очередь, действия ──
  if (threadsRoute(req, res)) return;

  // ── Вебхук бота: команда /scheduled и кнопки «Отменить» / «Опубликовать сейчас» ──
  if (req.method === 'POST' && req.url === '/api/telegram-webhook') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      const given = String(req.headers['x-telegram-bot-api-secret-token'] || '');
      if (!TELEGRAM_BOT_TOKEN || !safeEqual(given, webhookSecret())) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      // Telegram ждёт быстрый ответ 200, иначе повторяет доставку: обрабатываем после ответа
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      let update;
      try { update = JSON.parse(body); } catch { return; }
      handleBotUpdate(update).catch(e => console.error('bot update error:', scrubToken(e.message)));
    });
    return;
  }

  // ── Состояние планирования: Notion, планировщик, вебхук бота ──
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/schedule-diag') {
    const out = {
      notionTokenPresent: !!NOTION_API_KEY,
      databaseId: NOTION_SCHEDULE_DB_ID,
      dataSourceId: NOTION_SCHEDULE_DS_ID,
      intervalMs: SCHEDULER_INTERVAL_MS,
      staleMinutes: SCHEDULE_STALE_MS / 60000,
      scheduler: schedulerState,
      webhook: { ...webhookState }
    };
    try {
      if (NOTION_API_KEY) {
        try {
          const ds = await notionReq('GET', `/v1/data_sources/${NOTION_SCHEDULE_DS_ID}`);
          const need = ['Name', 'Text', 'Publish At', 'Status', 'Owner', 'Link', 'Error'];
          out.notion = { reachable: true, title: (ds.title && ds.title[0] && ds.title[0].plain_text) || null, missingProperties: need.filter(k => !(ds.properties && ds.properties[k])) };
          out.notion.scheduledNow = (await schedQuery(statusIs('scheduled'), 100)).length;
        } catch (e) {
          out.notion = { reachable: false, error: scrubToken(e.message) };
        }
      }
      if (TELEGRAM_BOT_TOKEN) {
        try {
          const wi = await tgApi('getWebhookInfo', {});
          out.webhook.current = { url: wi.url || null, pendingUpdates: wi.pending_update_count, lastError: wi.last_error_message || null };
        } catch (e) { out.webhook.currentError = scrubToken(e.message); }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: scrubToken(err.message) }));
    }
    return;
  }

  // ── Проверка Gemini: принимает ли Google ключ и какие модели картинок доступны. Ключ в ответ не попадает ──
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/cover-diag') {
    try {
      const wantProbe = new URL(req.url, 'http://localhost').searchParams.get('probe') === '1';
      const out = { keyPresent: !!GEMINI_API_KEY, configuredModel: GEMINI_IMAGE_MODEL, endpoint: GEMINI_API_URL };
      // Что сервер реально видит в окружении (только имена и длины, значения не показываются).
      // Нестандартные символы в имени (пробел, кириллица, похожая на латиницу) выводятся escape-кодами.
      out.envNamesLikeGemini = Object.keys(process.env)
        .filter(k => /gem|goog|banana|imagen|mini|key|api/i.test(k) || /[^\x21-\x7e]/.test(k))
        .map(k => ({
          name: k.replace(/[^\x21-\x7e]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')),
          nameLength: k.length,
          valueLength: String(process.env[k]).length
        }));
      // Какое развёртывание отвечает: Railway сам задаёт эти переменные
      out.railway = {
        environment: process.env.RAILWAY_ENVIRONMENT_NAME || null,
        service: process.env.RAILWAY_SERVICE_NAME || null,
        commit: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || null
      };
      if (GEMINI_API_KEY) {
        const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
          headers: { 'x-goog-api-key': GEMINI_API_KEY }
        });
        const raw = await resp.text();
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        out.listStatus = resp.status;
        if (resp.ok) {
          const names = (data?.models || []).map(m => String(m.name || '').replace(/^models\//, ''));
          out.keyAccepted = true;
          out.configuredModelAvailable = names.includes(GEMINI_IMAGE_MODEL);
          out.imageModels = names.filter(n => /image|banana|imagen/i.test(n)).slice(0, 40);

          // ?probe=1: пробуем сгенерировать минимальную картинку каждой моделью и смотрим, у кого есть квота.
          // Imagen пропускаем (другой интерфейс). Успешная проба тратит одну картинку на модель,
          // поэтому между пробами пауза.
          if (wantProbe) {
            const wait = PROBE_COOLDOWN_MS - (Date.now() - lastProbeAt);
            if (probeRunning || wait > 0) {
              out.probe = { skipped: true, reason: `Проба уже недавно запускалась, подожди ${Math.ceil(Math.max(wait, 1000) / 1000)} с` };
            } else {
              probeRunning = true;
              try {
                const models = out.imageModels.filter(n => !/imagen/i.test(n));
                const results = await Promise.all(models.map(async (m) => {
                  try {
                    const img = await geminiGenerateImage(PROBE_PROMPT, m);
                    return { model: m, ok: true, mime: img.mime, sizeKB: Math.round(img.data.length * 0.75 / 1024) };
                  } catch (e) {
                    const msg = String(e.message);
                    return { model: m, ok: false, freeTierBlocked: /Free Tier|limit: 0/i.test(msg), error: msg.slice(0, 220) };
                  }
                }));
                out.probe = {
                  works: results.filter(r => r.ok).map(r => r.model),
                  blockedByFreeTier: results.filter(r => r.freeTierBlocked).map(r => r.model),
                  results
                };
              } finally {
                probeRunning = false;
                lastProbeAt = Date.now();
              }
            }
          }
        } else {
          out.keyAccepted = false;
          out.error = geminiError(data, raw).message;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Обложка, шаг 1: Claude выбирает из поста цифру, титул, код темы и описание арта ──
  if (req.method === 'POST' && req.url === '/api/cover-plan') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { postText } = JSON.parse(body);
        if (!postText || !postText.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Пустой текст поста' }));
          return;
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 1024,
            system: getCoverPlanSystemPrompt(),
            messages: [{ role: 'user', content: postText }]
          })
        });
        const data = await response.json();

        if (!response.ok) {
          console.error('cover-plan API error:', JSON.stringify(data));
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: data.error?.message || 'API error' }));
          return;
        }
        if (data.stop_reason === 'max_tokens') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Ответ модели обрезан по лимиту длины.' }));
          return;
        }

        const plan = parseCoverPlan(data.content?.[0]?.text || '');
        if (!plan) {
          console.error('cover-plan: не удалось разобрать JSON:', (data.content?.[0]?.text || '').slice(0, 300));
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Не удалось разобрать план обложки, попробуй ещё раз' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ plan }));

      } catch (err) {
        console.error('cover-plan catch error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── Обложка, шаг 2: Gemini рисует 1-3 варианта арта (без текста; рамку и надписи накладывает приложение) ──
  if (req.method === 'POST' && req.url === '/api/cover-image') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        if (!GEMINI_API_KEY) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'GEMINI_API_KEY не задан в переменных Railway' }));
          return;
        }

        const { artPrompt, count } = JSON.parse(body);
        if (!artPrompt || !artPrompt.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Нет описания арта' }));
          return;
        }

        const n = Math.min(Math.max(parseInt(count, 10) || 3, 1), 3);
        const results = await Promise.allSettled(
          Array.from({ length: n }, (_, i) => geminiGenerateImage(buildCoverImagePrompt(artPrompt, i)))
        );

        const images = results.filter(r => r.status === 'fulfilled').map(r => ({ dataUrl: `data:${r.value.mime};base64,${r.value.data}` }));
        const errors = results.filter(r => r.status === 'rejected').map(r => r.reason.message);

        if (!images.length) {
          console.error('cover-image: все варианты не удались:', errors);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: errors[0] || 'Не удалось сгенерировать картинку' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ images, errors }));

      } catch (err) {
        console.error('cover-image catch error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── Обложка: вспомогательные функции ─────────────────────────────────

function getCoverPlanSystemPrompt() {
  return `Ты готовишь обложку для поста Дмитрия Скакунова (iGaming, спортбук) в виде игровой карточки, как карточка игрока в FIFA Ultimate Team: большая цифра рейтинга, короткий код темы, титул внизу и арт в центре.

Прочитай пост и верни ТОЛЬКО JSON без пояснений и без обрамления кодом:
{"number": "...", "label": "...", "caption": "...", "art_prompt": "..."}

number: главная цифра поста, которая должна бросаться в глаза, максимум 5 символов, например "+40%", "8%", "3x", "18", "2.5x". Бери цифру, которая реально есть в посте и несёт его смысл. Если в посте нет значимой цифры, верни пустую строку. Цифры не выдумывай.
label: код темы, от 2 до 5 заглавных латинских букв, как позиция игрока: GGR, NGR, HOLD, CRM, KPI, LIVE, RISK, GEO, PNL, BONUS. Выбери самый точный.
caption: титул карточки по-русски, от 2 до 4 слов, суть поста, без точки. Не используй букву «ё» (только «е»). Не используй тире и дефисы.
art_prompt: описание центрального арта на английском, одно или два предложения. Силуэт или символический объект по теме поста (например, силуэт игрока в движении, мяч, график, щит, весы), в тёмной палитре с золотыми акцентами. В арте не должно быть текста, букв, цифр, логотипов, брендов и узнаваемых реальных людей.`;
}

function parseCoverPlan(raw) {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (typeof obj.art_prompt !== 'string' || !obj.art_prompt.trim()) return null;
  // Форма карточки жёсткая: страхуемся от слишком длинных значений и запрещённых символов в титуле
  const clean = (s, max) => String(s || '').replace(/ё/g, 'е').replace(/Ё/g, 'Е').slice(0, max).trim();
  return {
    number: clean(obj.number, 6),
    label: clean(obj.label, 6).toUpperCase(),
    caption: clean(obj.caption, 40).replace(/[-–—]/g, ' ').replace(/\s+/g, ' '),
    art_prompt: obj.art_prompt.trim()
  };
}

const COVER_ART_STYLE = 'Premium collectible football trading card artwork, dark near-black background, subtle gold accents and light rays, one centered subject, cinematic lighting, portrait composition. Absolutely no text, no letters, no numbers, no logos, no watermarks, no frame or border.';
const COVER_VARIATIONS = ['', ' Variation: a different camera angle and composition.', ' Variation: more abstract and geometric treatment.'];

function buildCoverImagePrompt(artPrompt, index) {
  return `${artPrompt.trim()} ${COVER_ART_STYLE}${COVER_VARIATIONS[index] || ''}`;
}

// Достаёт base64-картинку из ответа Gemini, не привязываясь к точной форме JSON:
// формат ответа у Google менялся (steps/outputs/candidates, inlineData/inline_data)
function findImage(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'image' && typeof node.data === 'string' && node.data.length > 100) {
    return { data: node.data, mime: node.mime_type || node.mimeType || 'image/png' };
  }
  const inline = node.inlineData || node.inline_data;
  if (inline && typeof inline.data === 'string') {
    return { data: inline.data, mime: inline.mimeType || inline.mime_type || 'image/png' };
  }
  for (const v of Object.values(node)) {
    const found = findImage(v);
    if (found) return found;
  }
  return null;
}

// Google отдаёт ошибки то объектом {error}, то массивом [{error}]
function geminiError(data, raw) {
  const e = Array.isArray(data) ? data[0]?.error : data?.error;
  return {
    message: e?.message || raw.replace(/\s+/g, ' ').slice(0, 200),
    keyInvalid: /API key|API_KEY/i.test(JSON.stringify(e || ''))
  };
}

async function geminiPost(url, reqBody) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify(reqBody)
  });
  const raw = await resp.text();
  let data = null;
  try { data = JSON.parse(raw); } catch {}
  return { resp, data, raw };
}

async function geminiGenerateImage(prompt, model = GEMINI_IMAGE_MODEL) {
  const interactionBody = (withFormat) => {
    const b = { model, input: [{ type: 'text', text: prompt }] };
    if (withFormat) b.response_format = { type: 'image', aspect_ratio: '3:4' };
    return b;
  };

  let r = await geminiPost(GEMINI_API_URL, interactionBody(true));
  let err = r.resp.ok ? null : geminiError(r.data, r.raw);

  // Google не принял параметры формата: пробуем без них (картинка будет в размере по умолчанию).
  // При неверном ключе повтор бессмыслен.
  if (err && r.resp.status === 400 && !err.keyInvalid) {
    r = await geminiPost(GEMINI_API_URL, interactionBody(false));
    err = r.resp.ok ? null : geminiError(r.data, r.raw);
  }

  // Запасной путь: прежний формат generateContent, если новый не знает модель или не принимает запрос
  if (err && !err.keyInvalid && (r.resp.status === 400 || r.resp.status === 404)) {
    const lr = await geminiPost(`${GEMINI_LEGACY_BASE}/${model}:generateContent`, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:4' } }
    });
    if (lr.resp.ok) {
      r = lr;
      err = null;
    } else {
      err.message += ` | запасной путь generateContent ${lr.resp.status}: ${geminiError(lr.data, lr.raw).message}`;
    }
  }

  if (err) throw new Error(`Gemini ${r.resp.status}: ${err.message}`);
  const img = findImage(r.data);
  if (!img) {
    console.error('Gemini: в ответе нет картинки; поля ответа:', Object.keys(r.data || {}), 'status:', r.data?.status);
    throw new Error('Gemini не вернул картинку (возможно, сработал фильтр безопасности)');
  }
  return img;
}

function detectLanguage(text) {
  const sample = text.slice(0, 500);
  const ukChars = (sample.match(/[іїєґІЇЄҐ]/g) || []).length;
  const cyrillicChars = (sample.match(/[а-яёА-ЯЁ]/g) || []).length;
  const latinChars = (sample.match(/[a-zA-Z]/g) || []).length;

  if (ukChars >= 2) return 'uk';
  if (cyrillicChars > latinChars) return 'ru';
  if (latinChars > cyrillicChars * 2) return 'en';
  return 'ru';
}

function parseComments(raw) {
  const blocks = raw.split(/\n(?=\[)/).map(b => b.trim()).filter(Boolean);
  return blocks.map(block => {
    const match = block.match(/^\[(.+?)\]\s*([\s\S]*)$/);
    if (match) {
      return { label: match[1].trim(), text: match[2].trim() };
    }
    return { label: '', text: block };
  });
}

function getCommentsSystemPrompt() {
  return `ГЛАВНОЕ ПРАВИЛО, ВАЖНЕЕ ВСЕХ ОСТАЛЬНЫХ: определи язык исходного поста и пиши ВСЕ 7 комментариев именно на этом языке. Украинский пост, значит украинские комментарии. Английский пост, значит английские комментарии. Русский пост, значит русские комментарии. Это правило не имеет исключений.

Ты пишешь LinkedIn комментарии от имени Дмитрия Скакунова, Head of Sportsbook в iGaming индустрии. Украинец, живёт на Кипре, 18+ лет в sportsbook operations, продукте, трейдинге и риск менеджменте.

Дмитрий говорит прямо, понимает бизнес логику и не любит пустые корпоративные формулировки. Комментарий должен звучать как мнение опытного руководителя написанное за одну минуту, не как мини статья.

Тебе дают пост другого человека. Напиши 7 разных вариантов комментария к этому посту, каждый с своим углом.

ТИПЫ КОММЕНТАРИЕВ (используй все 7, в этом порядке):
[Спокойный] — взвешенное профессиональное мнение, без эмоций
[Практический] — конкретное наблюдение или пример из операционной практики
[С иронией] — лёгкая ирония или подсветка нелогичности, без злости
[С несогласием] — аккуратно споришь с автором, указываешь на слабое место в логике
[С вопросом] — короткий вопрос автору который заставляет копнуть глубже
[Короткий] — максимум 15 слов, одна мысль
[Лучший] — самый сильный и точный вариант для публикации

ЧТО ДОЛЖЕН ДЕЛАТЬ КОММЕНТАРИЙ (хотя бы одно):
Добавлять новую мысль, показывать практический опыт, подчёркивать скрытую проблему, задавать уместный вопрос, мягко спорить, добавлять иронию, развивать дискуссию.

ЗАПРЕЩЕНО НАЧИНАТЬ СО СЛОВ:
Полностью согласен, Отличный пост, Спасибо что поделились, Очень важная тема, Абсолютно верно, Интересная мысль, Хорошо сказано, Это действительно важно.

ЗАПРЕЩЕННЫЕ ВЫРАЖЕНИЯ:
В современном мире, Сто процентов, Именно так, Безусловно, Ключевой инсайт, Ценный контент, Откликается, Есть над чем задуматься, В точку.

ПРАВИЛА:
- ОБЯЗАТЕЛЬНО отвечай на том же языке на котором написан исходный пост. Если пост на украинском, все комментарии на украинском. Если на английском, на английском. Если на русском, на русском.
- Подстраивайся под тон поста. Если в посте юмор или личная история, твой комментарий может содержать уместный юмор или личное наблюдение в тему, а не абстрактную бизнес мысль не в контексте
- Не придумывай свои истории и цифры которых не было. Если для практического или личного комментария нет достаточного контекста в посте, сделай его про наблюдение или мысль, а не про выдуманный случай из практики Дмитрия
- 1 до 3 предложения, от 10 до 45 слов на комментарий, кроме варианта Короткий
- Простой разговорный язык поста. НИКАКИХ тире, только запятые и союзы
- Без скобок
- Без англицизмов если есть нормальный русский аналог. Профессиональные термины (GGR, NGR, hold%, retention) только если пост реально про iGaming, и не перегружай
- Не пересказывай пост другими словами
- Не пиши комплименты ради комплиментов
- Не придумывай цифры, компании, проекты, личный опыт Дмитрия которого не было в посте
- Если пост слабый или банальный, не хвали его. Можно осторожно указать на нелогичность
- Не звучи как ИИ. Лёгкая разговорность и неидеальность это нормально

Перед выдачей проверь каждый комментарий: нет тире, нет скобок, нет лишнего английского, не повторяет пост, не похож на ИИ, есть самостоятельная мысль, можно сразу копировать и публиковать.

ФОРМАТ ОТВЕТА СТРОГО ТАКОЙ:
[Спокойный] текст комментария

[Практический] текст комментария

[С иронией] текст комментария

[С несогласием] текст комментария

[С вопросом] текст комментария

[Короткий] текст комментария

[Лучший] текст комментария

Никаких пояснений до или после, никакой рекомендации в конце. Только эти 7 блоков.`;
}

function buildUserPrompt(input, tone, mode) {
  // ── Telegram: system prompt содержит все правила, user prompt минимальный ──
  if (tone === 'telegram') {
    return mode === 'topic'
      ? `Напиши пост для канала на тему: "${input}". Пиши от первого лица.`
      : `Напиши пост для канала из этой мысли: "${input}". Пиши от первого лица.`;
  }

  if (mode === 'topic') {
    return `Напиши LinkedIn пост на тему: "${input}". Тон: ${tone}.

Опорная структура (адаптируй под тему, пиши потоком, швы не должны быть видны):
крючок-парадокс → позиция или наблюдение → конкретный кейс или цифра → поворот/ловушка → управленческая ошибка → твоя позиция → сильный финал.

Обязателен якорь: личный опыт только если он есть в теме или мысли выше, иначе позиция Дмитрия (что проверил бы, какое решение принял бы, с чем не согласен). Личный опыт не выдумывай.
Конкретная деталь вместо обобщённой эмоции (не «все довольны», а что именно произошло).
Не объясняй очевидное. Не учи. Пиши от первого лица.`;
  } else {
    return `Оформи в LinkedIn пост эту сырую мысль: "${input}". Тон: ${tone}.

Опорная структура (адаптируй, пиши потоком, швы не должны быть видны):
крючок-парадокс → позиция или наблюдение → конкретный кейс или цифра → поворот/ловушка → управленческая ошибка → твоя позиция → сильный финал.

Обязателен якорь: личный опыт только если он есть в теме или мысли выше, иначе позиция Дмитрия (что проверил бы, какое решение принял бы, с чем не согласен). Личный опыт не выдумывай.
Конкретная деталь вместо обобщённой эмоции.
Не объясняй очевидное. Не учи. Пиши от первого лица.`;
  }
}

function getSystemPrompt() {
  return `Ты ghostwriter для Дмитрия Скакунова — Head of Sportsbook в iGaming индустрии. Украинец, живёт на Кипре, 18 лет в индустрии. Пишешь LinkedIn посты строго в его стиле на русском языке.

ВАЖНО О КОНТЕКСТЕ:
- Дмитрий украинец. Никаких позитивных упоминаний России, российских компаний или российского рынка.
- Если тема касается СНГ — нейтральные формулировки: "рынок СНГ", "восточноевропейский рынок"
- НИКАКИХ иероглифов, НИКАКИХ слов на других языках кроме русского и отраслевых терминов

---

ПОЗИЦИОНИРОВАНИЕ ДМИТРИЯ:
Не сухой эксперт с цифрами. Не мотивационный спикер. Страстный практик — человек у которого профессиональные мысли приходят в обычные моменты жизни: за матчем, в разговоре с коллегой, после факапа на работе.
Его стиль: мудрый практик со своими интересами. С ним интересно обсудить и стратегию бизнеса, и спорт, и жизнь.

---

ОПОРНАЯ СТРУКТУРА ПОСТА (адаптируй под тему, не используй механически):
1. Крючок — контринтуитивное утверждение или парадокс в первой строке. Не вопрос. Останавливает скролл.
2. Якорь: личный момент, если он есть во входе, иначе позиция Дмитрия (см. блок ЛИЧНЫЙ ОПЫТ И ЯКОРЬ).
3. Конкретный кейс или сцена — деталь, цифра, ситуация. Не общая фраза. Конкретная деталь вместо обобщённой эмоции: НЕ "все довольны, дашборд зелёный" (картон), а что именно произошло, какая цифра загорелась, кто что сказал.
4. Поворот / ловушка — где красивые показатели обманывали, где скрыта реальная проблема. Здесь экспертиза.
5. Управленческая ошибка — что сделали не так или почему руководители так делают.
6. Позиция Дмитрия — острый вывод без смягчений.
7. Финал — одна сильная строка. Не мораль, не вопрос в пустоту.

Пиши ПОТОКОМ: мысль перетекает, а не идёт пронумерованными блоками. Швы структуры не должны быть видны. Это скелет под кожей, а не план на экране.

---

ФОРМУЛА СИЛЬНОГО КРЮЧКА:
1. Контринтуитивная теза: "GGR вырос на 40%. Бизнес стал слабее."
2. Цифра + неожиданный факт: "В понедельник GGR просел на 22%. Акция работала как задумано."
3. Разрыв шаблона: "Пришла беда откуда не ждали..." / "Сейчас будет неприятно."
4. Провокативная теза: "Большинство операторов не понимают что такое hold% на самом деле."
5. Аномалия: "Спортсбук с маржой 18% и очередью из игроков."

ПЛОХОЙ КРЮЧОК: начало как учебник, с определения, с "В современном мире", с вопроса.

---

ПРАВИЛА СТИЛЯ:
- Пиши ТОЛЬКО на русском. Английские слова латиницей допустимы только как аббревиатуры (GGR, NGR, CRM, KPI, LTV, CPA, CAC) и имена собственные

${ANGLICISM_RULE}
- Короткие абзацы — 1-3 предложения. Иногда одно слово — норма
- Личный голос, от первого лица
- Конкретика — цифры, кейсы, механики, конкретные сцены и детали вместо общих фраз
- Финал острый — позиция, не вопрос
- Никакого корпоратива, мотивации, "синергии"
- Длина: 150-300 слов
- Эмодзи — максимум 1, только если уместно
- Без звездочек и markdown-разметки: на LinkedIn они показываются буквально

${ANCHOR_RULE}

В каждом посте обязательно минимум одно из трёх:
- Личный кейс из реального опыта (только если он есть во входе)
- Конкретная цифра или метрика
- Нестандартная позиция или вывод к которому пришёл именно Дмитрий

ИЗБЕГАЙ ШАБЛОННЫХ ФРАЗ И AI-МАРКЕРОВ:
Никогда не использовать: "Вот как...", "Вот что...", "Дело не в X, а в Y", "Результат?", "Честно говоря...", "Фраза которая со мной осталась...", "В заключение...", структуры типа "3 урока" / "5 вещей которые я понял".
Также запрещено: противопоставления «не потому что X, а потому что Y» и «Это не X, это Y», "CRM ликует", "Finance страдает", "я вот видел", "я вот знаю", "и вот тут начинается", "спойлер", "синергия", "экосистема", "холистический подход".
Если формулировка похожа на штамп из тысячи бизнес постов или звучит как инфобизнесмен и LinkedIn-коуч, перепиши конкретнее и живее.

Голос: пост должен звучать как senior iGaming operator с реальным операционным опытом. Не как консультант. Не как инфобизнесмен. Не как LinkedIn-коуч.

САМОПРОВЕРКА перед выдачей (если хоть один ответ "нет" — перепиши):
- Узнает ли Head of Sportsbook эту проблему?
- Есть якорь, и в нем нет выдуманного личного опыта?
- Есть конкретная цифра, кейс или нестандартная позиция?
- Крючок останавливает скролл и это не вопрос?
- Нет ни одного запрещённого AI-маркера?
- Конкретная деталь вместо обобщённой эмоции?
- Звучит как живой operator, не как AI?
- Финал сильный, не мораль и не вопрос в пустоту?

Отвечай ТОЛЬКО текстом поста. Никаких пояснений, заголовков, вводных фраз.`;
}



// ── Оформление готового LinkedIn-поста: разбивка на абзацы, без переписывания сути ──
// Для Telegram оформление делает /api/rubric-format (рубрика, акценты, хэштег, подпись).
function getFormatSystemPrompt() {
  return `Ты оформляешь готовый LinkedIn-пост Дмитрия Скакунова, Head of Sportsbook в iGaming. Текст уже написан и одобрен по содержанию. Твоя задача не переписать, а улучшить читаемость.

LinkedIn не поддерживает жирный шрифт или цвет в постах напрямую. Работай только с версткой и, где уместно, юникод-символами.

ЧТО ДЕЛАТЬ:
1. Разбить на короткие абзацы, 1-3 предложения максимум, если сейчас есть плотные блоки по 5+ предложений.
2. Между смысловыми блоками пустая строка, чтобы текст дышал в ленте.
3. Не более одного эмодзи на весь пост и только если он усиливает мысль, не декоративно.
4. Если в тексте есть естественное перечисление 3+ пунктов, оформить с юникод-маркером (→ или •) на новой строке для каждого.

ЧЕГО НЕ ДЕЛАТЬ:
Не менять формулировки, не сокращать, не удлинять.
Не менять порядок мыслей.
Не добавлять новые тезисы или цифры.
Не использовать капслок или звездочки для псевдо-выделения — на LinkedIn они отображаются буквально, не как жирный.
Не превращать цельное рассуждение в список без необходимости.

Верни ТОЛЬКО оформленный текст. Никаких пояснений что изменено.`;
}

function getTelegramSystemPrompt() {
  return `Ты ghostwriter Telegram-канала t.me/skakunov_igaming Дмитрия Скакунова. Канал про iGaming: спортбук, продукт, CRM, риск, маржа. Автор — senior sportsbook operator, 18 лет в индустрии, отвечал за P&L, операции, трейдинг, запуски в нескольких GEO.

Язык — русский.

---

ЖЕСТКИЕ ПРАВИЛА — НОЛЬ ИСКЛЮЧЕНИЙ:

1. НИКОГДА не использовать букву «е» с двумя точками. Только «е»: «все», «еще», «черное». Правило важнее орфографии. Проверять посимвольно.

2. НИКОГДА не использовать тире и дефис как знак препинания. Ни длинное, ни короткое, ни дефис в паузе или противопоставлении. Даже там где тире грамматически обязательно — переформулируй так чтобы оно не требовалось.
   Числовые диапазоны словами: «от 3 до 8x» вместо «3-8x».
   Составные слова переформулируй: «casino-first» превращается в «казино как основа платформы».
   Противопоставление делай точкой: «Технически результат тот же. Для игрока другой.»

3. НИКАКИХ хэштегов. Ни одного.

Один пропущенный нарушитель — фейл.

---

СТРУКТУРА (читается потоком, швы не видны):

1. Первая фраза сообщает предмет или дает резкую оценку. Не пустая интрига, не вопрос.
2. Конкретная ситуация, цифра или деталь.
3. Почему обычно это читают неправильно.
4. Что из этого следует для того кто держит P&L.
5. Короткий финал с позицией.

---

ОБЯЗАТЕЛЬНО В КАЖДОМ ПОСТЕ — минимум одно из трех:
1. Личный кейс или момент из реального опыта.
2. Конкретная цифра или метрика.
3. Нестандартная позиция или вывод к которому автор пришел сам.

${ANCHOR_RULE}

${ANGLICISM_RULE}

---

ЧЕМ TELEGRAM ОТЛИЧАЕТСЯ ОТ LINKEDIN:

Длина свободная. Не растягивать ради объема и не рубить ради краткости.
Первая строка сообщает о чем речь. Не интригует пустотой.
Ближе и сырее. Допустимы незаконченные мысли, сомнения, «пока не понял что с этим делать».
Нет призыва подписаться, поставить реакцию, написать в комментариях.

---

ФОРМАТИРОВАНИЕ:
Жирный (**текст**) для одного-двух ключевых мест в посте.
Маркеры списков там где перечисление реально нужно.
Заголовки в тексте поста не используются.
Абзацы короткие, одна мысль. Между смысловыми блоками пустая строка.

---

ТОН: живой, спокойный, уверенный. Жесткий там где есть позиция. Легкая ирония уместна. Здоровая злость допустима.
Не звучать как: маркетолог, консультант, инфобизнесмен, AI-райтер.
Звучать как человек с реальным операционным опытом.

---

РЕДЛАЙНЫ:
Не выдумывать цифры. Только реальные или честно помеченные как оценка.
Не атаковать конкретных провайдеров по имени.
Не писать нарратив «герой-одиночка: все не поняли, а я один увидел».
Не пересказывать новость без собственной оценки.
Не давать общие советы про продуктивность и лидерство.
Никакой рекламы букмекеров.

---

ЗАПРЕЩЕННЫЕ ФРАЗЫ И МАРКЕРЫ:
«Вот как...», «Вот что...», «Вот почему...», «Дело не в X, а в Y», «Не потому что X, а потому что Y», «Это не X, это Y», «Результат?», «Честно говоря...», «В заключение...», «Подводя итог...», «Давайте разберемся», «Копнем глубже», «Знакомо?», «Почему это важно?», «Что это значит для вас?»
Структуры-счетчики: «3 урока которые я вынес», «5 вещей которые я понял».
Канцелярит: «является», «представляет собой», «таким образом», «более того», «в связи с этим», «данный», «в современном мире», «играет ключевую роль».
Громкие пустые слова: «раскрыть потенциал», «трансформировать», «прорывной», «синергия», «экосистема» не в буквальном смысле.
Структурные тики: тройной рефрен ради ритма, открытие риторическим вопросом без напряжения, двойное проговаривание одной мысли, идеально ровный ритм всех предложений.

---

ФИНАЛЬНАЯ ПРОВЕРКА (если хотя бы одно «нет» — перепиши):
Ноль букв с двумя точками в тексте, проверено посимвольно.
Ноль тире и дефисов как пунктуации.
Ноль хэштегов.
Есть якорь, и в нем нет личного опыта, которого не было во входе.
Есть цифра, кейс или своя позиция.
Первая фраза сообщает предмет, не интригует пустотой.
Ни одной запрещенной фразы.
Звучит как оператор, а не как бот.

Отвечай ТОЛЬКО текстом поста. Никаких пояснений, заголовков, рубрик, вводных фраз.`;
}

async function runTelegramStopSlop(postText) {
  const system = `Ты финальный корректор Telegram-поста для iGaming канала. Получаешь текст и исправляешь нарушения трех жестких правил.

ПРАВИЛО 1 — БУКВА С ДВУМЯ ТОЧКАМИ: заменить на обычную «е» везде без исключений.
Примеры: «все» вместо нарушения, «еще», «черное», «берет», «прочтет».
Проверяй посимвольно — ни одного нарушителя.

ПРАВИЛО 2 — ТИРЕ И ДЕФИС КАК ПУНКТУАЦИЯ: переформулировать так чтобы знак не нужен.
Длинное тире в противопоставлении: «X — Y» → «X. Y» или переделать предложение.
Дефис в диапазоне: «3-5x» → «от 3 до 5x».
Дефис в составном слове как пунктуация: переформулировать смысл.
ОСТАВИТЬ: только дефис в наречиях типа «по-другому» → нет, тоже убрать, переформулировать.

ПРАВИЛО 3 — ХЭШТЕГИ: удалить полностью включая пробел перед ними.

ДОПОЛНИТЕЛЬНО — англицизмы заменить русскими словами (retention → удержание игроков, live → по ходу матча, pre-match → до матча, second bet → вторая ставка и т.п.); латиницей оставить только аббревиатуры GGR, NGR, CRM, KPI, LTV, CPA, CAC и имена собственные.

ДОПОЛНИТЕЛЬНО — убрать если встречается:
«Вот как...», «Вот что...», «Результат?», «В заключение...», «Честно говоря...», «Знакомо?», «Что это значит для вас?»
«Это не X. Это Y.» двумя соседними предложениями, «Не потому что X, а потому что Y»: переписать как прямое утверждение про Y, без отрицания X
Канцелярит: «является», «представляет собой», «таким образом», «более того», «данный»

ЧТО НЕ ТРОГАТЬ:
Цифры и метрики (GGR, NGR, hold%, margin).
Личный якорь и конкретные детали из опыта.
Жирный текст (**текст**) и маркеры списков.
Голос и структуру текста.

Верни ТОЛЬКО исправленный текст. Никаких пояснений.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, messages: [{ role: 'user', content: postText }] })
    });
    const data = await response.json();
    if (!response.ok) return postText;
    if (data.stop_reason === 'max_tokens') {
      console.error('telegram-stop-slop: ответ обрезан по max_tokens, возвращаю оригинал');
      return postText;
    }
    console.log('telegram-stop-slop: проход выполнен');
    return data.content?.[0]?.text || postText;
  } catch (err) {
    console.error('telegram-stop-slop failed:', err.message);
    return postText;
  }
}

// Сверка черновика с входом в два шага (одним проходом модель выдумки пропускает).
// Шаг 1: модель разбирает каждое предложение и возвращает список тех, что НЕ подтверждены входом.
// Шаг 2: отдельный вызов вырезает или переписывает именно эти предложения. Только для постов из дайджеста.
async function claudeCall(system, user, maxTokens = 4096) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
  });
  const data = await response.json();
  if (!response.ok || data.stop_reason === 'max_tokens') return null;
  return data.content?.[0]?.text || null;
}

async function runFactTrim(inputText, postText) {
  try {
    const checkSystem = `Ты строгий фактчекер. Получаешь ИСХОДНЫЕ ДАННЫЕ и ЧЕРНОВИК поста. Разбери черновик по предложениям и найди те, которые содержат утверждение, НЕ подтвержденное исходными данными.

НЕ подтверждено, если в предложении есть хотя бы одно из:
1. Число, срок, год, страна, компания, которых нет в данных.
2. Причина, цель или намерение (например «регулятор хотел зачистить рынок», «из-за этого»), которых нет в данных.
3. Утверждение о том, что делают, чувствуют или получают люди, компании, регулятор, рынок, которого нет в данных (в том числе «исчезли», «больше не существуют», «накопленные за годы», «самые мобильные», «не успевает объяснить»).
4. Обобщение шире данных (данные про одну компанию, а текст про весь рынок; «первыми уходят X», если в данных про X ничего нет).
5. Приписывание цифры или вывода источнику («по данным X»), если в данных этого источника у этой цифры нет.
6. Абсолютизм: «единственное», «всегда», «точно», «никогда», «все».

ПОДТВЕРЖДЕНО или ОК: числа и факты из данных; явная позиция автора с оговоркой («я бы», «думаю», «возможно», «стоит проверить») без новых фактов; общая механика отрасли без конкретных чисел.

Верни ТОЛЬКО JSON-массив строк: дословные предложения черновика, которые НЕ подтверждены. Если таких нет, верни [].`;
    const raw = await claudeCall(checkSystem, `ИСХОДНЫЕ ДАННЫЕ:\n${inputText}\n\nЧЕРНОВИК:\n${postText}`, 2048);
    if (!raw) return postText;
    let bad = [];
    try { bad = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { return postText; }
    if (!Array.isArray(bad)) return postText;
    bad = bad.map(x => String(x || '').trim()).filter(x => x && postText.includes(x));

    const needSource = !/по данным|писал|сообщил|пишет|согласно/i.test(postText);
    if (!bad.length && !needSource) { console.log('fact-trim: чисто'); return postText; }

    const fixSystem = `Ты редактор. Получаешь ИСХОДНЫЕ ДАННЫЕ, ЧЕРНОВИК поста и список ПРЕДЛОЖЕНИЙ С НЕПОДТВЕРЖДЕННЫМИ УТВЕРЖДЕНИЯМИ.

Для каждого такого предложения: если без него мысль не теряется, вырежи его целиком. Если оно держит логику, перепиши так, чтобы осталось только подтвержденное данными, либо подай мысль как позицию автора с оговоркой («я бы предположил», «похоже», «стоит проверить») без новых фактов и чисел.
Остальной текст не трогай. Голос, абзацы и подтвержденные факты сохрани. Новых фактов, цифр, сроков и сравнений не добавляй.
Если в тексте больше шести чисел, оставь самые важные.
Если в исходных данных указан источник и в тексте нет короткой фразы, откуда цифры, добавь ее одним предложением (издание по имени, без ссылки и домена).
Без тире и дефиса как пунктуации, без буквы «ё».
Верни ПОЛНЫЙ текст поста, без пояснений.`;
    const fixed = await claudeCall(fixSystem, `ИСХОДНЫЕ ДАННЫЕ:\n${inputText}\n\nНЕПОДТВЕРЖДЕННЫЕ ПРЕДЛОЖЕНИЯ:\n${bad.length ? bad.map((x, i) => (i + 1) + '. ' + x).join('\n') : '(нет, только проверь источник и число чисел)'}\n\nЧЕРНОВИК:\n${postText}`);
    console.log('fact-trim: неподтвержденных предложений', bad.length);
    return fixed || postText;
  } catch (err) {
    console.error('fact-trim failed:', err.message);
    return postText;
  }
}

// Отрицательное противопоставление («не X, а Y», «Это не X. Это Y.», «Не потому что X. А потому что Y.») модель
// пропускает при любых инструкциях. Ловим предложения кодом и просим переписать только их
function findNegContrast(text) {
  const sentences = String(text || '').split(/(?<=[.!?])\s+/);
  const hits = [];
  for (let i = 0; i < sentences.length; i++) {
    const cur = sentences[i];
    const next = sentences[i + 1] || '';
    const oneSentence = /(^|[\s«"(])не\s[^.!?]{1,120},\s*а\s/i.test(cur) || /[^.!?]{3,120},\s*а не\s/i.test(cur) || /не потому,? что[^.!?]{1,120},\s*а потому/i.test(cur) || /(^|[\s«"(,])это не\s[^.!?]{1,80},\s*это\s/i.test(cur);
    const twoSentences = /(^|[\s«"(])не\s[^.!?]{1,100}[.!?]?$/i.test(cur.trim()) && /^(это|а|просто|именно|он|она|они)\s/i.test(next.trim());
    if (oneSentence) hits.push(cur.trim());
    else if (twoSentences) hits.push((cur.trim() + ' ' + next.trim()).trim());
  }
  return [...new Set(hits)];
}

async function runNegContrastFix(postText) {
  const hits = findNegContrast(postText);
  if (!hits.length) return postText;
  const system = `Ты редактор. В посте есть отрицательные противопоставления («не X, а Y», «Это не X. Это Y.», «Не потому что X. А потому что Y.»). Перепиши ТОЛЬКО указанные места так, чтобы осталось прямое утверждение про Y, без упоминания X и без слов «не», «а», «просто» как связки противопоставления. Не добавляй новых фактов, цифр и сроков, не меняй остальной текст. Без тире, без жирного, без буквы «ё». Верни ПОЛНЫЙ текст поста с исправленными местами, без пояснений.`;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, messages: [{ role: 'user', content: `МЕСТА ДЛЯ ПЕРЕПИСЫВАНИЯ:\n${hits.map((h, i) => (i + 1) + '. ' + h).join('\n')}\n\nПОСТ:\n${postText}` }] })
    });
    const data = await response.json();
    if (!response.ok || data.stop_reason === 'max_tokens') return postText;
    console.log('neg-contrast-fix: переписано мест', hits.length);
    return data.content?.[0]?.text || postText;
  } catch (err) {
    console.error('neg-contrast-fix failed:', err.message);
    return postText;
  }
}

// Англицизмы ловим кодом: слова латиницей с маленькой буквы (live, retention, pre-match) и кириллическая запись «ретеншн».
// Аббревиатуры (GGR, CRM), имена (Entain, iGaming) и коды валют (DKK) не трогаем: они пишутся заглавными или не проходят шаблон
function findAnglicisms(text) {
  const cleaned = String(text || '')
    .replace(/\]\([^)]*\)/g, ']')          // цели markdown-ссылок
    .replace(/https?:\/\/\S+/g, ' ')        // голые ссылки
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|io|net|org|co\.uk|global|bet)\b/gi, ' ') // домены: ими занимается nameOutlets
    .replace(/[#@][\w]+/g, ' ');            // хэштеги и упоминания
  const found = new Set();
  const re = /(?<![A-Za-z0-9_])([A-Za-z][A-Za-z]*(?:-[A-Za-z]+)*)(?![A-Za-z0-9_])/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const w = m[1];
    if (w.length < 3) continue;
    if (/^[A-Z]{2,}$/.test(w)) continue;                         // аббревиатуры
    if (/[A-Z]/.test(w.slice(1)) && /[a-z]/.test(w)) continue;   // iGaming, DraftKings, eSports: имена
    if (/^[A-Z][a-z]+$/.test(w) && !/(^|[.!?]\s+|\n)\s*$/.test(cleaned.slice(Math.max(0, m.index - 3), m.index))) continue; // имена в середине фразы
    if (/^[A-Z]/.test(w) && !/^(Live|Retention|Pre-match|Prematch|Sportsbook|Hold|Margin|Bonus|Cashout|Casino)$/i.test(w)) continue; // имена в начале фразы
    found.add(w);
  }
  (String(text || '').match(/ретенш[еэ]?н|ретеншн/gi) || []).forEach(w => found.add(w));
  return [...found];
}

async function runAnglicismFix(postText) {
  const words = findAnglicisms(postText);
  if (!words.length) return postText;
  const system = `Ты редактор. В посте остались английские слова или их кириллическая запись: ${words.join(', ')}.
Замени их нормальными русскими словами или оборотами, согласуй падежи и род. Примеры: retention/ретеншн → удержание игроков; live (реклама, коэффициенты, ставки) → «по ходу матча», «во время матча»; pre-match → до матча; second bet → вторая ставка; reactivation → возвращение игрока; sportsbook → спортбук; hold, margin → маржа.
Аббревиатуры (GGR, NGR, CRM, KPI, LTV, CPA, CAC), названия компаний и продуктов, коды валют, хэштеги и ссылки не трогай.
Остальной текст не меняй ни в одном слове. Не добавляй фактов и чисел. Без тире, без буквы «ё». Жирный (**…**) и разметку сохрани как есть.
Верни ПОЛНЫЙ текст поста, без пояснений.`;
  try {
    const out = await claudeCall(system, postText);
    if (!out) return postText;
    console.log('anglicism-fix: заменено слов', words.length, '(' + words.join(', ') + ')');
    return out;
  } catch (err) {
    console.error('anglicism-fix failed:', err.message);
    return postText;
  }
}

async function runTelegramCritic(postText) {
  const system = `Ты редактор Telegram-канала iGaming практика с 18 годами в спортбуке. Получаешь черновик поста и возвращаешь усиленную версию.

Проверь по четырем осям и улучши слабые места:

1. ПЕРВАЯ ФРАЗА — сообщает предмет сразу или интригует пустотой? Если пустая или вопросительная — перепиши.
2. ЯКОРЬ — есть своя позиция автора (что проверил бы, какое решение принял бы, с чем не согласен, прогноз)? Если нет, добавь одним предложением именно позицию. Личный опыт («я видел», «я сталкивался», «изнутри», «на нескольких рынках») НИКОГДА не добавляй. Если в черновике есть такая общая фраза без конкретики (без компании, рынка, цифры), замени ее позицией.
3. КОНКРЕТИКА — есть цифра, кейс или нестандартная позиция? Если все обобщения — усиль.
4. ФИНАЛ — есть позиция? Не вопрос в пустоту, не мораль, не призыв к действию. Если слабый — перепиши.

ЖЕСТКИЕ ОГРАНИЧЕНИЯ ПРИ РЕДАКТУРЕ:
Ноль букв с двумя точками в итоговом тексте.
Ноль тире и дефисов как пунктуации.
Ноль хэштегов.
Не переписывать полностью — только усилить слабые места. Голос оригинала сохранить.

Если пост по всем четырем осям сильный — верни без изменений.

Верни ТОЛЬКО итоговый текст поста. Никакого вердикта, пояснений, комментариев.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, messages: [{ role: 'user', content: postText }] })
    });
    const data = await response.json();
    if (!response.ok) return postText;
    if (data.stop_reason === 'max_tokens') {
      console.error('telegram-critic: ответ обрезан по max_tokens, возвращаю оригинал');
      return postText;
    }
    console.log('telegram-critic: проход выполнен');
    return data.content?.[0]?.text || postText;
  } catch (err) {
    console.error('telegram-critic failed:', err.message);
    return postText;
  }
}

function getRubricFormatSystemPrompt() {
  return `Ты оформляешь готовый Telegram пост Дмитрия Скакунова для канала t.me/skakunov_igaming. Пост уже написан и одобрен по содержанию слово в слово. Твоя задача НЕ переписывать текст, а определить рубрику, оформить структуру, расставить акценты, добавить хэштег рубрики и подпись.

ШАГ 1. ОПРЕДЕЛИ РУБРИКУ.
Сопоставь содержание поста с одной из рубрик ниже по смыслу, не по формальным ключевым словам. Выбери только одну, самую точную. Формат строки: номер, название рубрики, визуальный лейбл, хэштег.

1 Разбор механики — ⚙️ МЕХАНИКА СПОРТСБУКА — #механика_спортсбука
2 Провайдеры и контракты — 🤝 ПРОВАЙДЕРЫ И КОНТРАКТЫ — #провайдеры_контракты
3 Trading, risk, margin — 📊 ТРЕЙДИНГ И МАРЖА — #трейдинг_маржа
4 Запуск и GEO — 🌍 ЗАПУСК И GEO — #запуск_geo
5 Casino cross-sell — 🎰 КАЗИНО И СПОРТСБУК — #казино_спортсбук
6 CRM, бонусы, retention — 🎯 CRM И RETENTION — #crm_retention
7 KPI и метрики — 📈 МЕТРИКИ И P&L — #метрики_pnl
8 Роли и оргструктура — 👥 ЛЮДИ И РОЛИ — #люди_роли
9 Разбор чужих фич и релизов — 🔍 РАЗБОР РЕЛИЗОВ — #разбор_релизов
10 Комментарий новости — 🗞 НОВОСТИ ИЗНУТРИ — #новости_изнутри
11 Личные наблюдения и кейсы — 🧩 ИЗ ПРАКТИКИ — #из_практики
12 AI и автоматизация — 🤖 AI В ОПЕРАЦИЯХ — #ai_операции
13 Бот и топ-матчи — ⚽ БОТ И ТОП МАТЧИ — #бот_матчи
14 Инструменты и артефакты — 🧰 ИНСТРУМЕНТЫ — #инструменты

Если пост это личное воскресное наблюдение без операционной темы, вместо рубрики 11 используй лейбл 😏 ВОСКРЕСНОЕ и хэштег #воскресное.

РАЗГРАНИЧЕНИЕ ПОГРАНИЧНЫХ СЛУЧАЕВ, часто путают рубрику 3 и рубрику 7:
Рубрика 3 (Trading, risk, margin) — если пост в первую очередь разбирает саму механику маржи, hold%, GGR/NGR, коэффициентов, лимитов, liability как предмет анализа.
Рубрика 7 (KPI и метрики) — если пост в первую очередь про управленческую ловушку в отчетности: метрика выглядит хорошо, а бизнес по факту слабеет, и это не видно сразу без сопоставления нескольких цифр.
Если пост делает и то и то, приоритет у рубрики 3, если точка входа в текст это разбор конкретной механики или конкретных цифр маржи/hold, а не абстрактная управленческая ловушка.

ШАГ 2. СОБЕРИ ПОСТ СТРОГО В ЭТОМ ПОРЯДКЕ, БЕЗ ПЕРЕПИСЫВАНИЯ ФОРМУЛИРОВОК ОРИГИНАЛА:

1. Первая строка — визуальный лейбл рубрики из таблицы выше, дословно, эмодзи плюс название заглавными буквами. Обычный текст, не жирный.
2. Пустая строка.
3. Заголовок — первая содержательная фраза оригинала, дословно, обернутая в жирный (**текст**).
4. Остальной текст оригинала целиком, дословно, без изменения формулировок и порядка мыслей. Разбей его на короткие смысловые абзацы пустыми строками между ними, если в оригинале сейчас плотная простыня текста. Никаких символов ">" или других маркеров цитаты не использовать нигде, обычный связный текст.
5. В большинстве абзацев, где для этого есть материал, выдели жирным одно место: содержательную фразу с конкретной цифрой, поворот мысли, самую острую формулировку абзаца. Не нужно выделять в каждом абзаце через силу, если там нет ничего сильнее общего фона, но и не экономь искусственно: если в посте 5-7 абзацев с разными мыслями, акцент должен быть в большинстве из них.
6. Пустая строка.
7. Хэштег рубрики из таблицы выше, ровно один, точно как в таблице, отдельной строкой.
8. Две пустые строки подряд после хэштега, для визуального отступа.
9. Отдельной строкой подпись: // D.S. //

Итог по количеству выделений: ориентир 5-8 жирных акцентов на пост среднего размера, считая заголовок. Мало и бледно так же плохо, как и слишком плотно.

ЖЕСТКОЕ ПРАВИЛО ПРОТИВ ГОЛЫХ ЦИФР: никогда не выделяй жирным одиночную цифру саму по себе, без слов вокруг. "**875**" отдельно это плохо. Выделяй цифру только вместе со смысловой частью фразы, которая дает ей контекст: "**875 тысяч в месяц, минус 3% за год**" или похожее по объему. Если не можешь выделить фразу с контекстом длиннее одного голого числа — не выделяй вообще, пропусти этот акцент.

ЖЕСТКОЕ ПРАВИЛО ПРОТИВ ДУБЛЕЙ: если два места в разных абзацах говорят примерно одно и то же — выделяй только одно, самое сильное. Разные мысли в разных абзацах дублями не считаются, там выделять можно свободно.

ЧТО ЗАПРЕЩЕНО:
Перефразировать, сокращать, удлинять или менять порядок мыслей оригинала.
Добавлять новые тезисы, цифры, факты которых не было в оригинале.
Добавлять больше одного хэштега.
Использовать символ ">" где бы то ни было в тексте.
Выделять жирным голую цифру без контекста.
Оставлять хэштег и подпись слипшимися без отступа между ними.

ЖЕСТКИЕ ПРАВИЛА, ПРИМЕНЯЮТСЯ ТОЛЬКО ЕСЛИ НАРУШЕНЫ В ОРИГИНАЛЕ:
Ноль буквы «е» с двумя точками в теле поста, заменить на обычную «е».
Ноль тире и дефисов как пунктуации в теле поста, переформулировать вокруг них. Хэштег и подпись это исключение из этого правила, их не трогать.

Верни ТОЛЬКО готовый оформленный текст поста по этой структуре. Никаких пояснений, никаких вводных фраз.`;
}



// ── Публикация в Telegram-канал: вспомогательные функции ─────────────

// Bot API принимает канал только как @имя или числовой -100…, а в переменную часто кладут ссылку.
// Приводим t.me/имя, https://t.me/имя/, имя в кавычках и голое имя к @имя; числовой ID не трогаем.
// Инвайт-ссылки (t.me/+…) не превращаются в канал: их Bot API не принимает, диагностика покажет «chat not found».
function normalizeChannelId(raw) {
  if (!raw) return raw;
  let v = String(raw).trim().replace(/^["']|["']$/g, '').trim();
  if (/^-?\d+$/.test(v)) return v;
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/([^/?#\s]+)/i.exec(v);
  if (m) v = m[1];
  if (/^[A-Za-z][A-Za-z0-9_]{3,}$/.test(v)) return '@' + v;
  return v;
}

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

// Токен бота не должен попасть ни в логи, ни в ответы клиенту
function scrubToken(msg) {
  const s = String(msg);
  let r = TELEGRAM_BOT_TOKEN ? s.split(TELEGRAM_BOT_TOKEN).join('***') : s;
  const tt = process.env.THREADS_ACCESS_TOKEN;
  return tt ? r.split(tt).join('***') : r;
}

function friendlyTelegramError(msg) {
  const m = scrubToken(msg);
  if (/chat not found/i.test(m)) return `Telegram: канал не найден. Проверь TELEGRAM_CHANNEL_ID и что бот добавлен в канал (${m})`;
  if (/not enough rights|have no rights|CHAT_ADMIN_REQUIRED|not a member|Forbidden/i.test(m)) {
    return `Telegram: у бота нет прав публиковать в канале. Добавь бота администратором канала с правом публикации сообщений (${m})`;
  }
  if (/Unauthorized|token/i.test(m)) return `Telegram: токен бота не принят. Проверь TELEGRAM_BOT_TOKEN (${m})`;
  return 'Telegram: ' + m;
}

async function tgApi(method, payload, isForm = false) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const resp = await fetch(url, isForm
    ? { method: 'POST', body: payload }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await resp.json().catch(() => null);
  if (!data || !data.ok) throw new Error((data && data.description) || `HTTP ${resp.status}`);
  return data.result;
}

let botUsernameCache = null;
async function botHint() {
  try {
    if (!botUsernameCache) botUsernameCache = '@' + (await tgApi('getMe', {})).username;
    return `. Подпись проверяется токеном бота ${botUsernameCache}: открой приложение через этого бота (его кнопка меню или ссылка), а не через другого`;
  } catch {
    return '. Проверь, что приложение открыто через того бота, чей токен задан в TELEGRAM_BOT_TOKEN';
  }
}

// Проверка подписи initData по документации Telegram Mini Apps:
// secret = HMAC_SHA256(ключ "WebAppData", сообщение: токен бота), hash = HMAC_SHA256(ключ secret, строка проверки)
function verifyTelegramInitData(initData) {
  if (!initData) return { ok: false, status: 403, error: 'Публикация доступна только из Telegram Mini App: нет данных авторизации Telegram' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, status: 403, error: 'Данные авторизации Telegram без подписи' };
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest();
  let given;
  try { given = Buffer.from(hash, 'hex'); } catch { given = Buffer.alloc(0); }
  if (given.length !== calc.length || !crypto.timingSafeEqual(given, calc)) {
    return { ok: false, status: 403, signatureMismatch: true, error: 'Подпись данных Telegram не прошла проверку' };
  }
  const age = Math.floor(Date.now() / 1000) - Number(params.get('auth_date') || 0);
  if (!(age >= -60 && age <= INIT_DATA_MAX_AGE_SEC)) {
    return { ok: false, status: 403, error: 'Данные авторизации Telegram устарели: закрой и снова открой Mini App' };
  }
  let user = {};
  try { user = JSON.parse(params.get('user') || '{}'); } catch {}
  if (!user.id) return { ok: false, status: 403, error: 'В данных Telegram нет пользователя' };
  return { ok: true, userId: String(user.id) };
}

// Жирный из **текст** в HTML-теги Telegram; всё остальное экранируется, чтобы <, > и & в посте не ломали разметку
function toTelegramHtml(md) {
  const escaped = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>');
}

// Длина текста, которую считает Telegram (после разбора разметки)
function visibleLength(html) {
  return html.replace(/<\/?b>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').length;
}

function channelLink(messageId) {
  const id = String(TELEGRAM_CHANNEL_ID);
  if (id.startsWith('@')) return `https://t.me/${id.slice(1)}/${messageId}`;
  const m = /^-100(\d+)$/.exec(id);
  return m ? `https://t.me/c/${m[1]}/${messageId}` : null;
}

// Inline-кнопка «Задать вопрос» под постом канала (только если включена галочкой)
function askMarkup() {
  return { inline_keyboard: [[{ text: ASK_BUTTON_TEXT, url: ASK_BUTTON_URL }]] };
}

async function sendTextToChannel(text, askButton = false) {
  const extra = askButton ? { reply_markup: askMarkup() } : {};
  try {
    return await tgApi('sendMessage', { chat_id: TELEGRAM_CHANNEL_ID, text: toTelegramHtml(text), parse_mode: 'HTML', ...extra });
  } catch (e) {
    // Разметка не принята: публикуем обычным текстом без звёздочек (до этого ничего не отправлено)
    if (/can't parse entities/i.test(e.message)) {
      return tgApi('sendMessage', { chat_id: TELEGRAM_CHANNEL_ID, text: text.replace(/\*\*/g, ''), ...extra });
    }
    throw e;
  }
}

async function sendPhotoToChannel(photo, captionText, askButton = false) {
  const build = (caption, withHtml) => {
    const f = new FormData();
    f.append('chat_id', TELEGRAM_CHANNEL_ID);
    if (askButton) f.append('reply_markup', JSON.stringify(askMarkup()));
    f.append('photo', new Blob([photo.buf], { type: photo.mime }), `cover.${photo.ext}`);
    if (caption) {
      f.append('caption', caption);
      if (withHtml) f.append('parse_mode', 'HTML');
    }
    return f;
  };
  try {
    return await tgApi('sendPhoto', build(captionText ? toTelegramHtml(captionText) : null, true), true);
  } catch (e) {
    if (captionText && /can't parse entities/i.test(e.message)) {
      return tgApi('sendPhoto', build(captionText.replace(/\*\*/g, ''), false), true);
    }
    throw e;
  }
}

// Подпись к фото в Telegram не длиннее 1024 символов, обычное сообщение не длиннее 4096.
// Короткий пост с картинкой уходит одним сообщением, длинный: сначала картинка, потом текст.
function assertPostText(text) {
  if (typeof text !== 'string' || !text.trim()) throw httpError(400, 'Пустой текст поста');
  const len = visibleLength(toTelegramHtml(text));
  if (len > 4096) throw httpError(400, `Пост длиннее лимита Telegram: ${len} из 4096 символов`);
  return len;
}

async function publishToChannel(text, imageDataUrl, askButton = false) {
  const len = assertPostText(text);

  let photo = null;
  if (imageDataUrl) {
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(imageDataUrl);
    if (!m) throw httpError(400, 'Картинка должна быть PNG или JPEG в виде data URL');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 10 * 1024 * 1024) throw httpError(400, 'Картинка больше 10 МБ');
    photo = { buf, mime: `image/${m[1]}`, ext: m[1] === 'jpeg' ? 'jpg' : 'png' };
  }

  const captionFits = !!photo && len <= 1024;
  const ids = [];
  try {
    // Кнопка вешается на последнее сообщение: на фото, если текст в подписи, иначе на текст
    if (photo) ids.push((await sendPhotoToChannel(photo, captionFits ? text : null, askButton && captionFits)).message_id);
    if (!captionFits) ids.push((await sendTextToChannel(text, askButton)).message_id);
  } catch (e) {
    const msg = friendlyTelegramError(e.message);
    throw httpError(502, ids.length ? `Картинка опубликована, а текст нет. Не публикуй её повторно. ${msg}` : msg);
  }
  return { ok: true, messageIds: ids, link: channelLink(ids[0]), withImage: !!photo, parts: ids.length };
}

// ── Планирование публикаций ──────────────────────────────────────────

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Общая проверка пользователя: подпись Telegram и список разрешённых ID (одинаково для публикации и планирования)
async function authorizeUser(req) {
  if (!TELEGRAM_BOT_TOKEN) return { ok: false, status: 503, error: 'Не задан TELEGRAM_BOT_TOKEN в переменных Railway' };
  const auth = verifyTelegramInitData(req.headers['x-telegram-init-data']);
  if (!auth.ok) {
    // Самая частая причина «подпись не прошла»: Mini App открыто через другого бота, не через того,
    // чей токен лежит в TELEGRAM_BOT_TOKEN. Называем нужного бота, чтобы не гадать.
    const hint = auth.signatureMismatch ? await botHint() : '';
    return { ok: false, status: auth.status, error: auth.error + hint };
  }
  if (!TELEGRAM_ALLOWED_USER_IDS.includes(auth.userId)) {
    return { ok: false, status: 403, error: `Твой Telegram ID ${auth.userId} не в списке разрешённых. Добавь его в переменную TELEGRAM_ALLOWED_USER_IDS в Railway.` };
  }
  return { ok: true, userId: auth.userId };
}

// --- Дата и время по Варшаве (ДД.ММ ЧЧ:ММ) ---

function warsawParts(ms) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: SCHEDULE_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}

// Момент времени (мс UTC), при котором в Варшаве на часах заданные дата и время; null, если такого времени нет
// (например, час, пропущенный при переходе на летнее время)
function warsawToUtcMs(y, mo, d, h, mi) {
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = warsawParts(guess);
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    const diff = target - shown;
    if (diff === 0) break;
    guess += diff;
  }
  const p = warsawParts(guess);
  return (p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi) ? guess : null;
}

function parseWarsawDateTime(input, nowMs = Date.now()) {
  const m = /^\s*(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2}):(\d{2})\s*$/.exec(String(input || ''));
  if (!m) return { ok: false, error: 'Неверный формат. Нужно ДД.ММ ЧЧ:ММ, например 15.10 09:30 (время по Варшаве)' };
  const d = +m[1], mo = +m[2], h = +m[4], mi = +m[5];
  let y = m[3] ? +m[3] : null;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59) return { ok: false, error: 'Такой даты или времени не бывает' };
  const now = warsawParts(nowMs);
  if (y === null) {
    y = now.y;
    // Без года берём ближайшую будущую дату: если день в этом году уже прошёл, то в следующем
    if (Date.UTC(y, mo - 1, d) < Date.UTC(now.y, now.mo - 1, now.d)) y += 1;
  }
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return { ok: false, error: 'Такой даты не бывает' };
  const ms = warsawToUtcMs(y, mo, d, h, mi);
  if (ms === null) return { ok: false, error: 'В этот момент в Варшаве такого времени нет (переход на летнее время). Выбери другое' };
  if (ms < nowMs + 60 * 1000) return { ok: false, error: 'Это время уже прошло или наступит меньше чем через минуту' };
  if (ms > nowMs + 366 * 24 * 3600 * 1000) return { ok: false, error: 'Можно планировать не дальше чем на год вперёд' };
  return { ok: true, iso: new Date(ms).toISOString(), ms };
}

function formatWarsaw(iso) {
  const f = new Intl.DateTimeFormat('ru-RU', { timeZone: SCHEDULE_TZ, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  const year = Number(p.year) !== warsawParts(Date.now()).y ? `.${p.year}` : '';
  return `${p.weekday}, ${p.day}.${p.month}${year} ${p.hour}:${p.minute}`;
}

// --- Очередь в Notion ---

function scheduleConfigured() {
  return !!(NOTION_API_KEY && NOTION_SCHEDULE_DS_ID);
}

async function notionReq(method, apiPath, body) {
  const resp = await fetch('https://api.notion.com' + apiPath, {
    method,
    headers: { 'Authorization': `Bearer ${NOTION_API_KEY}`, 'Content-Type': 'application/json', 'Notion-Version': '2025-09-03' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(`Notion ${resp.status}: ${(data && (data.message || data.code)) || 'ошибка'}`);
  return data;
}

// Один блок rich_text в Notion не длиннее 2000 символов: длинный текст режем на несколько блоков
function toRichText(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 2000) out.push({ type: 'text', text: { content: text.slice(i, i + 2000) } });
  return out;
}
const fromRichText = arr => (arr || []).map(x => (x.plain_text !== undefined ? x.plain_text : (x.text && x.text.content) || '')).join('');

function shortPreview(text, max = 300) {
  const t = String(text || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function pageToRow(p) {
  const pr = p.properties || {};
  return {
    id: p.id,
    parentOk: !p.parent || p.parent.data_source_id === NOTION_SCHEDULE_DS_ID || p.parent.database_id === NOTION_SCHEDULE_DB_ID,
    text: fromRichText(pr.Text && pr.Text.rich_text),
    publishAt: (pr['Publish At'] && pr['Publish At'].date && pr['Publish At'].date.start) || null,
    status: (pr.Status && pr.Status.select && pr.Status.select.name) || null,
    owner: pr.Owner && pr.Owner.number !== undefined ? pr.Owner.number : null,
    link: (pr.Link && pr.Link.url) || null,
    error: fromRichText(pr.Error && pr.Error.rich_text),
    type: (pr.Type && pr.Type.select && pr.Type.select.name) || null,
    company: fromRichText(pr.Company && pr.Company.rich_text),
    angle: fromRichText(pr.Angle && pr.Angle.rich_text),
    goal: (pr.Goal && pr.Goal.select && pr.Goal.select.name) || null,
    // Старые посты без свойства «Кнопка вопроса» читаются как false
    askButton: !!(pr['Кнопка вопроса'] && pr['Кнопка вопроса'].checkbox === true),
    rubric: (pr['Рубрика'] && pr['Рубрика'].select && pr['Рубрика'].select.name) || null,
    threadsId: fromRichText(pr['Threads ID'] && pr['Threads ID'].rich_text),
    mod: fromRichText(pr['Модерация'] && pr['Модерация'].rich_text),
    draft: fromRichText(pr['Черновик'] && pr['Черновик'].rich_text),
    src: fromRichText(pr['Источник'] && pr['Источник'].rich_text),
    views: pr['Просмотры'] && typeof pr['Просмотры'].number === 'number' ? pr['Просмотры'].number : null,
    likes: pr['Лайки'] && typeof pr['Лайки'].number === 'number' ? pr['Лайки'].number : null,
    replies: pr['Ответы'] && typeof pr['Ответы'].number === 'number' ? pr['Ответы'].number : null,
    reposts: pr['Репосты'] && typeof pr['Репосты'].number === 'number' ? pr['Репосты'].number : null,
    views48: pr['Просмотры 48ч'] && typeof pr['Просмотры 48ч'].number === 'number' ? pr['Просмотры 48ч'].number : null,
    react48: pr['Реакции 48ч'] && typeof pr['Реакции 48ч'].number === 'number' ? pr['Реакции 48ч'].number : null
  };
}

const statusIs = s => ({ property: 'Status', select: { equals: s } });

async function schedQuery(filter, pageSize = 50) {
  const data = await notionReq('POST', `/v1/data_sources/${NOTION_SCHEDULE_DS_ID}/query`, {
    filter, sorts: [{ property: 'Publish At', direction: 'ascending' }], page_size: pageSize
  });
  return (data.results || []).map(pageToRow);
}

async function schedCreate(text, iso, owner, askButton = false) {
  const properties = {
    Name: { title: [{ type: 'text', text: { content: shortPreview(text, 80) || 'Пост' } }] },
    Text: { rich_text: toRichText(text) },
    'Publish At': { date: { start: iso } },
    Status: { select: { name: 'scheduled' } },
    Owner: { number: owner }
  };
  // Без галочки свойство не пишем: пост создаётся, даже если checkbox «Кнопка вопроса» в базе ещё не заведён
  if (askButton) properties['Кнопка вопроса'] = { checkbox: true };
  const page = await notionReq('POST', '/v1/pages', {
    parent: { type: 'data_source_id', data_source_id: NOTION_SCHEDULE_DS_ID },
    properties
  });
  return pageToRow(page);
}

async function schedGet(id) {
  const row = pageToRow(await notionReq('GET', `/v1/pages/${encodeURIComponent(id)}`));
  if (!row.parentOk) throw new Error('Страница не из базы расписания');
  return row;
}

async function schedUpdate(id, { status, link, error, publishAt, askButton }) {
  const properties = {};
  if (askButton !== undefined) properties['Кнопка вопроса'] = { checkbox: !!askButton };
  if (publishAt) properties['Publish At'] = { date: { start: publishAt } };
  if (status) properties.Status = { select: { name: status } };
  if (link !== undefined) properties.Link = { url: link || null };
  if (error !== undefined) properties.Error = { rich_text: error ? toRichText(String(error).slice(0, 1800)) : [] };
  return notionReq('PATCH', `/v1/pages/${encodeURIComponent(id)}`, { properties });
}

// --- Публикация по расписанию ---

const schedInFlight = new Set();
const schedulerState = { started: false, lastTickAt: null, lastError: null, lastPublishedId: null };

async function notifyOwner(row, text) {
  if (!row.owner) return;
  try { await tgApi('sendMessage', { chat_id: row.owner, text }); }
  catch (e) { console.error('уведомление владельцу не доставлено:', scrubToken(e.message)); }
}

// Публикует запланированный пост. checkStale: просроченный больше чем на SCHEDULE_STALE_MS не публикуется сам.
// notify: прислать владельцу итог в личку (из чата с ботом итог показывается на самой карточке).
async function runScheduledPost(row, { checkStale = true, notify = true } = {}) {
  if (schedInFlight.has(row.id)) return { status: 'busy' };
  schedInFlight.add(row.id);
  try {
    const late = Date.now() - Date.parse(row.publishAt);
    if (checkStale && late > SCHEDULE_STALE_MS) {
      const err = `Просрочен на ${Math.round(late / 60000)} мин (сервер был недоступен). Автоматически не опубликован`;
      await schedUpdate(row.id, { status: 'missed', error: err });
      if (notify) await notifyOwner(row, `⚠️ Пост не вышел вовремя: ${err}.\n\n${shortPreview(row.text)}\n\nОпубликуй вручную или запланируй заново.`);
      return { status: 'missed', error: err };
    }

    // Сначала метка «публикуется»: если дальше что-то оборвётся, пост не уйдёт в канал повторно
    await schedUpdate(row.id, { status: 'publishing' });
    let result;
    try {
      result = await publishToChannel(row.text, null, row.askButton);
    } catch (e) {
      const msg = scrubToken(e.message);
      await schedUpdate(row.id, { status: 'failed', error: msg }).catch(() => {});
      if (notify) await notifyOwner(row, `❌ Не удалось опубликовать запланированный пост:\n${msg}\n\n${shortPreview(row.text)}`);
      return { status: 'failed', error: msg };
    }
    // Пост уже в канале: сбой записи статуса не должен выглядеть как неудачная публикация
    await schedUpdate(row.id, { status: 'published', link: result.link }).catch(e => console.error('статус published не записан:', scrubToken(e.message)));
    schedulerState.lastPublishedId = row.id;
    if (notify) await notifyOwner(row, `✅ Опубликовано в канале${result.link ? '\n' + result.link : ''}\n\n${shortPreview(row.text)}`);
    return { status: 'published', link: result.link };
  } finally {
    schedInFlight.delete(row.id);
  }
}

let schedTickRunning = false;
async function schedulerTick() {
  if (schedTickRunning || !scheduleConfigured() || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) return;
  schedTickRunning = true;
  schedulerState.lastTickAt = new Date().toISOString();
  try {
    const due = await schedQuery({ and: [statusIs('scheduled'), { property: 'Publish At', date: { on_or_before: new Date().toISOString() } }] }, 25);
    schedulerState.lastError = null;
    for (const row of due) await runScheduledPost(row, { checkStale: true, notify: true });
  } catch (e) {
    schedulerState.lastError = scrubToken(e.message);
    console.error('ошибка планировщика:', schedulerState.lastError);
  } finally {
    schedTickRunning = false;
  }
}

// После перезапуска сервера пост со статусом «publishing» мог выйти, а мог нет: автоматически не повторяем
async function recoverStuckPublishing() {
  const rows = await schedQuery(statusIs('publishing'), 25);
  for (const row of rows) {
    if (Date.now() - Date.parse(row.publishAt) < 5 * 60 * 1000 || schedInFlight.has(row.id)) continue;
    const err = 'Публикация оборвалась при перезапуске сервера. Проверь канал: пост мог выйти. Автоматически не повторяется';
    await schedUpdate(row.id, { status: 'failed', error: err });
    await notifyOwner(row, `⚠️ ${err}.\n\n${shortPreview(row.text)}`);
  }
}

// --- Бот: вебхук, /scheduled, кнопки ---

const webhookState = { status: 'not-started', desired: null, foreignUrl: null, error: null };

function webhookSecret() {
  return crypto.createHmac('sha256', TELEGRAM_BOT_TOKEN).update('postbot-webhook').digest('hex');
}

function publicBaseUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN;
  return null;
}

// Если у бота уже есть чужой вебхук, не затираем его: им может пользоваться другой сервис
async function setupTelegramBot() {
  const base = publicBaseUrl();
  if (!base) { webhookState.status = 'no-public-url'; return; }
  const desired = base + '/api/telegram-webhook';
  webhookState.desired = desired;
  const info = await tgApi('getWebhookInfo', {});
  if (info.url && info.url !== desired && process.env.TELEGRAM_FORCE_WEBHOOK !== '1') {
    webhookState.status = 'foreign';
    webhookState.foreignUrl = info.url;
    console.log('У бота уже есть другой вебхук, не трогаю:', info.url);
    return;
  }
  await tgApi('setWebhook', { url: desired, secret_token: webhookSecret(), allowed_updates: ['message', 'callback_query', 'chat_member'] });
  await tgApi('setMyCommands', { commands: [
    { command: 'scheduled', description: 'Запланированные посты' },
    { command: 'draft', description: 'Черновики Threads (автопилот)' },
    { command: 'replies', description: 'Ответы в Threads за N часов' },
    { command: 'stats', description: 'Отчет за 7 дней' },
    { command: 'rubrics', description: 'Рубрики Threads за N дней' },
    { command: 'help', description: 'Что умеет бот' }
  ] });
  webhookState.status = 'active';
}

function startScheduling() {
  if (!scheduleConfigured() || !TELEGRAM_BOT_TOKEN) {
    console.log('Планирование выключено: нужны NOTION_API_KEY и TELEGRAM_BOT_TOKEN');
    return;
  }
  schedulerState.started = true;
  setTimeout(() => recoverStuckPublishing().catch(e => console.error('восстановление очереди:', scrubToken(e.message))), 3000);
  setTimeout(() => schedulerTick(), 4000);
  setInterval(() => schedulerTick(), SCHEDULER_INTERVAL_MS);
  if (threadsConfigured()) {
    setTimeout(() => recoverThreadsPublishing().catch(e => console.error('threads: восстановление очереди:', scrubToken(e.message))), 3500);
    setTimeout(() => threadsTick(), 5000);
    setInterval(() => threadsTick(), SCHEDULER_INTERVAL_MS);
    setTimeout(() => threadsRepliesTick(), 15000);
    setInterval(() => threadsRepliesTick(), THREADS_REPLIES_EVERY_MS);
    threadsReplyState.started = true;
    setTimeout(() => snapshot48Tick(), 40000);
    setInterval(() => snapshot48Tick(), 60 * 60 * 1000);
    if (AP_ON()) {
      setTimeout(() => apTick(), 60000);
      setInterval(() => apTick(), 60 * 60 * 1000);
    }
  }
  setTimeout(() => statsTick().catch(e => console.error('stats:', scrubToken(e.message))), 25000);
  setInterval(() => statsTick().catch(e => console.error('stats:', scrubToken(e.message))), 10 * 60 * 1000);
  setupTelegramBot().catch(e => { webhookState.status = 'error'; webhookState.error = scrubToken(e.message); console.error('настройка бота:', webhookState.error); });
}

const botKeyboard = id => ({ inline_keyboard: [
  [{ text: 'Отменить', callback_data: 'c:' + id }, { text: 'Опубликовать сейчас', callback_data: 'p:' + id }],
  [{ text: '🕒 Перенести', callback_data: 'r:' + id }]
] });

// Меню переноса: быстрые сдвиги и кнопка, которая открывает Mini App с нативным выбором даты и времени
function rescheduleKeyboard(id, messageId) {
  const rows = [
    [{ text: '+1 час', callback_data: 's1:' + id }, { text: '+3 часа', callback_data: 's3:' + id }, { text: '+1 день', callback_data: 'sd:' + id }],
    [{ text: 'Завтра 09:00', callback_data: 'sn:' + id }]
  ];
  const base = publicBaseUrl();
  // m: номер этой карточки в чате, чтобы после переноса в Mini App сервер обновил её на новое время
  if (base) rows.push([{ text: '📅 Выбрать дату и время', web_app: { url: `${base}/?reschedule=${id}${messageId ? '&m=' + messageId : ''}` } }]);
  rows.push([{ text: 'Назад', callback_data: 'b:' + id }]);
  return { inline_keyboard: rows };
}

// Новое время для быстрых сдвигов: «+1 час», «+3 часа» от запланированного времени, «+1 день» по календарю Варшавы
// (в день перехода на летнее время это не ровно 24 часа), «Завтра 09:00» от текущего момента
function shiftedIso(row, kind, nowMs = Date.now()) {
  const old = Date.parse(row.publishAt);
  if (kind === 's1') return new Date(old + 3600000).toISOString();
  if (kind === 's3') return new Date(old + 3 * 3600000).toISOString();
  const nextDay = (ms, hour, minute) => {
    const p = warsawParts(ms);
    const d = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1, hour ?? p.h, minute ?? p.mi));
    return warsawToUtcMs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
  };
  if (kind === 'sd') return new Date(nextDay(old) ?? old + 86400000).toISOString();
  if (kind === 'sn') return new Date(nextDay(nowMs, 9, 0) ?? nowMs + 86400000).toISOString();
  throw new Error('Неизвестный сдвиг');
}

// Меняет только время публикации; статус остаётся scheduled, текст и владелец те же
async function rescheduleRow(row, newIso) {
  const ms = Date.parse(newIso);
  const now = Date.now();
  if (!(ms >= now + 60 * 1000)) throw httpError(400, 'Это время уже прошло или наступит меньше чем через минуту');
  if (ms > now + 366 * 24 * 3600 * 1000) throw httpError(400, 'Можно планировать не дальше чем на год вперёд');
  if (schedInFlight.has(row.id)) throw httpError(409, 'Пост публикуется прямо сейчас');
  await schedUpdate(row.id, { publishAt: newIso });
  return { ...row, publishAt: newIso };
}
const cardText = row => `🕒 ${formatWarsaw(row.publishAt)} (Варшава)\n\n${shortPreview(row.text, 500)}`;
const botSend = (chatId, text, extra = {}) => tgApi('sendMessage', { chat_id: chatId, text, ...extra });

async function sendScheduledList(chatId, userId) {
  const rows = await schedQuery({ and: [statusIs('scheduled'), { property: 'Owner', number: { equals: Number(userId) } }] }, 50);
  if (!rows.length) return botSend(chatId, 'Запланированных постов нет.');
  await botSend(chatId, `Запланировано постов: ${rows.length}. Время по Варшаве.`);
  for (const row of rows.slice(0, 15)) await botSend(chatId, cardText(row), { reply_markup: botKeyboard(row.id) });
  if (rows.length > 15) await botSend(chatId, `…и ещё ${rows.length - 15}. Показаны ближайшие 15.`);
}

// ── Threads: генерация партии постов, очередь и автопубликация ──
// Очередь лежит в той же базе Notion, что и телеграм-очередь, но с отдельными статусами (t_scheduled и т.д.):
// телеграм-планировщик, вкладка «Очередь» и команда /scheduled их не видят, схему базы менять не нужно.
// Нужны переменные Railway: THREADS_ACCESS_TOKEN (долгоживущий токен Threads API), THREADS_USER_ID (необязательно, иначе берется через /me).
const THREADS_TOKEN = process.env.THREADS_ACCESS_TOKEN || '';
const THREADS_API = 'https://graph.threads.net/v1.0';
const THREADS_MAX = 500;
const THREADS_SAFE = 470;                 // генерируем с запасом: эмодзи в лимите считаются по байтам
const TS = { scheduled: 't_scheduled', publishing: 't_publishing', published: 't_published', failed: 't_failed', missed: 't_missed', cancelled: 't_cancelled' };
const THREADS_SLOTS = ['12:30', '19:30'];  // время Варшавы для автоподстановки
let threadsUserIdCache = process.env.THREADS_USER_ID || '';
const tSleep = ms => new Promise(r => setTimeout(r, ms));
const threadsConfigured = () => !!THREADS_TOKEN;

function threadsLength(text) {
  let n = 0;
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0);
    n += c > 0xFFFF ? 4 : (c >= 0x2190 && c <= 0x2BFF ? 3 : 1);
  }
  return n;
}

async function threadsReq(method, p, params = {}) {
  const body = new URLSearchParams({ ...params, access_token: THREADS_TOKEN });
  let resp;
  if (method === 'GET') {
    const u = new URL(THREADS_API + p);
    body.forEach((v, k) => u.searchParams.set(k, v));
    resp = await fetch(u);
  } else {
    resp = await fetch(THREADS_API + p, { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const m = (data.error && data.error.message) || ('HTTP ' + resp.status);
    const e = new Error('Threads: ' + String(m).split(THREADS_TOKEN).join('***'));
    e.httpStatus = 502;
    throw e;
  }
  return data;
}

async function threadsUserId() {
  if (threadsUserIdCache) return threadsUserIdCache;
  const me = await threadsReq('GET', '/me', { fields: 'id,username' });
  threadsUserIdCache = me.id;
  return threadsUserIdCache;
}

async function publishToThreads(text, replyToId) {
  if (!threadsConfigured()) throw httpError(503, 'Threads не настроен: задай THREADS_ACCESS_TOKEN в переменных Railway');
  if (!String(text || '').trim()) throw httpError(400, 'Пустой текст поста');
  const len = threadsLength(text);
  if (len > THREADS_MAX) throw httpError(400, `Пост длиннее лимита Threads: ${len} из ${THREADS_MAX}`);
  const uid = await threadsUserId();
  const container = await threadsReq('POST', `/${uid}/threads`, { media_type: 'TEXT', text, ...(replyToId ? { reply_to_id: replyToId } : {}) });
  let pub = null, lastErr = null;
  for (let i = 0; i < 4 && !pub; i++) {
    await tSleep(i === 0 ? 4000 : 8000);   // контейнеру нужно время; для текста обычно хватает пары секунд
    try { pub = await threadsReq('POST', `/${uid}/threads_publish`, { creation_id: container.id }); }
    catch (e) { lastErr = e; }
  }
  if (!pub) throw lastErr || new Error('Threads не опубликовал пост');
  let link = null;
  try { link = (await threadsReq('GET', `/${pub.id}`, { fields: 'permalink' })).permalink || null; } catch { /* ссылка не критична */ }
  return { id: pub.id, link };
}

async function tCreate(text, iso, owner, meta) {
  const page = await notionReq('POST', '/v1/pages', {
    parent: { type: 'data_source_id', data_source_id: NOTION_SCHEDULE_DS_ID },
    properties: {
      Name: { title: [{ type: 'text', text: { content: '🧵 ' + (shortPreview(text, 70) || 'Threads') } }] },
      Text: { rich_text: toRichText(text) },
      'Publish At': { date: { start: iso } },
      Status: { select: { name: TS.scheduled } },
      Owner: { number: owner },
      ...(meta && meta.type ? { Type: { select: { name: meta.type } } } : {}),
      ...(meta && meta.goal ? { Goal: { select: { name: meta.goal } } } : {}),
      ...(meta && meta.company ? { Company: { rich_text: toRichText(meta.company) } } : {}),
      ...(meta && meta.angle ? { Angle: { rich_text: toRichText(meta.angle) } } : {})
    }
  });
  autoRubric(page.id, text);   // не ждем: очередь не должна тормозить из-за классификации
  return pageToRow(page);
}

async function runThreadsPost(row, { checkStale = true, notify = true } = {}) {
  if (schedInFlight.has(row.id)) return { status: 'busy' };
  schedInFlight.add(row.id);
  try {
    const late = Date.now() - Date.parse(row.publishAt);
    if (checkStale && late > SCHEDULE_STALE_MS) {
      const err = `Просрочен на ${Math.round(late / 60000)} мин (сервер был недоступен). Автоматически не опубликован`;
      await schedUpdate(row.id, { status: TS.missed, error: err });
      if (notify) await notifyOwner(row, `⚠️ Пост в Threads не вышел вовремя: ${err}.\n\n${shortPreview(row.text)}`);
      return { status: 'missed', error: err };
    }
    await schedUpdate(row.id, { status: TS.publishing });
    let result;
    try {
      result = await publishToThreads(row.text);
    } catch (e) {
      const msg = scrubToken(e.message);
      await schedUpdate(row.id, { status: TS.failed, error: msg }).catch(() => {});
      if (notify) await notifyOwner(row, `❌ Не удалось опубликовать в Threads:\n${msg}\n\n${shortPreview(row.text)}`);
      return { status: 'failed', error: msg };
    }
    await schedUpdate(row.id, { status: TS.published, link: result.link }).catch(e => console.error('threads: статус published не записан:', scrubToken(e.message)));
    // Фиксируем фактическое время выхода (при «опубликовать сейчас» оно отличается от планового): от него считаются 48 часов
    notionReq('PATCH', `/v1/pages/${encodeURIComponent(row.id)}`, { properties: { 'Threads ID': { rich_text: toRichText(String(result.id)) }, 'Publish At': { date: { start: new Date().toISOString() } } } })
      .catch(e => console.error('threads: ID поста не записан:', scrubToken(e.message)));
    if (notify) await notifyOwner(row, `✅ Опубликовано в Threads${result.link ? '\n' + result.link : ''}\n\n${shortPreview(row.text)}`);
    return { status: 'published', link: result.link };
  } finally {
    schedInFlight.delete(row.id);
  }
}

let threadsTickRunning = false;
async function threadsTick() {
  if (threadsTickRunning || !threadsConfigured() || !scheduleConfigured() || !TELEGRAM_BOT_TOKEN) return;
  threadsTickRunning = true;
  try {
    const due = await schedQuery({ and: [{ property: 'Status', select: { equals: TS.scheduled } }, { property: 'Publish At', date: { on_or_before: new Date().toISOString() } }] }, 25);
    for (const row of due) await runThreadsPost(row, { checkStale: true, notify: true });
  } catch (e) {
    console.error('threads: ошибка планировщика:', scrubToken(e.message));
  } finally {
    threadsTickRunning = false;
  }
}

async function recoverThreadsPublishing() {
  const rows = await schedQuery({ property: 'Status', select: { equals: TS.publishing } }, 25);
  for (const row of rows) {
    if (Date.now() - Date.parse(row.publishAt) < 5 * 60 * 1000 || schedInFlight.has(row.id)) continue;
    const err = 'Публикация оборвалась при перезапуске сервера. Проверь Threads: пост мог выйти. Автоматически не повторяется';
    await schedUpdate(row.id, { status: TS.failed, error: err });
    await notifyOwner(row, `⚠️ ${err}.\n\n${shortPreview(row.text)}`);
  }
}

// Ближайшие свободные слоты (Варшава) в формате «ДД.ММ ЧЧ:ММ»; taken: множество уже занятых моментов (мс, округленные до минуты)
function nextThreadsSlots(n, taken = new Set()) {
  const out = [];
  const now = Date.now();
  const base = warsawParts(now);
  for (let off = 0; off < 120 && out.length < n; off++) {
    const dt = new Date(Date.UTC(base.y, base.mo - 1, base.d + off));
    const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1, d = dt.getUTCDate();
    for (const slot of THREADS_SLOTS) {
      if (out.length >= n) break;
      const [h, mi] = slot.split(':').map(Number);
      const ms = warsawToUtcMs(y, mo, d, h, mi);
      if (ms === null || ms < now + 10 * 60 * 1000) continue;
      if (taken.has(Math.floor(ms / 60000))) continue;
      out.push(`${String(d).padStart(2, '0')}.${String(mo).padStart(2, '0')}.${y} ${slot}`);
    }
  }
  return out;
}

const THREADS_FORMATS = {
  mechanics: 'МЕХАНИКА ДЕНЕГ И ВЕРОЯТНОСТИ простым языком, с одним конкретным расчетом или наглядным сравнением: например, сколько из каждых 100 поставленных остается у букмекера и почему игрок этого не чувствует, почему экспресс из четырех «почти верных» ставок проигрывает чаще, чем кажется, почему «почти выиграл» ничего не значит. Читатель должен унести одну проверяемую мысль или цифру, которую он не знал. Только общеизвестная математика, любой факт можно проверить.',
  humor: 'СУХОЙ САРКАЗМ про индустрию, риск и жизнь рядом со ставками: одна наблюдательная мысль в одну-три строки, без смайлов, без объяснения шутки. Серьезным тоном, как будто это обычное наблюдение.',
  decisions: 'РЕШЕНИЯ В УСЛОВИЯХ НЕОПРЕДЕЛЕННОСТИ: покер, шахматы, трейдинг линии, ставки на ожидание. Короткие тезисы про разницу между хорошим решением и хорошим результатом, про цену ошибки, про терпение. Без коучинга и без «ты сможешь».',
  question: 'ВОПРОС К АУДИТОРИИ: одна-две строки контекста и один конкретный вопрос, на который хочется ответить своим мнением (про ставки, риск, покер, спорт, деньги). Не опрос из двух вариантов.',
  people: 'ЛЮДИ, ЛИДЕРСТВО, МОТИВАЦИЯ И ИНСТРУМЕНТЫ: как устроена работа людей рядом со ставками (трейдер, риск-менеджер, аналитик, саппорт, руководитель команды), что делает хорошего лидера в тяжелый момент, как держаться после проигрыша или ошибки, какие инструменты и ИИ реально помогают, а какие только создают видимость. Допустим мотивирующий тон, если он держится на конкретной мысли или механике, которую читатель может применить сегодня. Без выдуманных историй, компаний и цифр.',
  mix: 'МИКС: примерно 40% механика денег и вероятности, 30% сухой сарказм, 20% решения в условиях неопределенности, 10% вопрос к аудитории'
};

function threadsSystemPrompt(format) {
  return `Ты пишешь короткие посты для Threads от имени Дмитрия Скакунова: 18 лет в гемблинге, руководитель направления спортбука. Аудитория очень широкая: не только индустрия, а любой взрослый читатель, которому интересны деньги, риск, вероятность, спорт и покер. Язык русский.

ФОРМАТ ПОСТОВ: ${THREADS_FORMATS[format] || THREADS_FORMATS.mix}

ГЛАВНАЯ ПРОВЕРКА ДЛЯ КАЖДОГО ПОСТА. Перед тем как написать пост, ответь себе: что именно читатель унесет отсюда нового или полезного? Это должна быть одна конкретная мысль, цифра, способ или неочевидное объяснение, а не афоризм и не общая мудрость. Если пост можно свести к пословице («решение остается за человеком», «терпение важнее скорости», «рынок не слепой»), он не годится: перепиши с конкретным примером, расчетом или неожиданным углом, либо выбери другую мысль. Темы: гейминг и ставки, лидерство, решения под давлением, мотивация, люди индустрии, инструменты и ИИ.

КАК ПИСАТЬ. Живая связная речь, как будто ты рассказываешь это знакомому за столом. Полные предложения, которые вытекают одно из другого: ситуация, что произошло или как это устроено, почему это важно, и посыл в конце, ради которого читатель дочитал. Запрещен рубленый телеграфный стиль: никаких обрывков из одного-трех слов подряд («Взяли.», «7 из 8.», «Без опыта.»), никаких тезисов списком через точки. Короткая фраза допустима одна и только как акцент. Если это история, у нее есть начало, поворот и вывод, а не набор фактов.

ТРЕБОВАНИЯ:
- Одна мысль на пост. Помни, что Threads формат короткий, пост должен помещаться целиком в лимит платформы и читаться за несколько секунд. Длина до 400 символов, чаще 150-300, но не короче, чем нужно, чтобы мысль была полной и понятной. Первая строка цепляет сама, без вступлений.
- Голос человека, который видел это изнутри индустрии, но без выдуманных историй: никаких «я видел», «у нас был случай», «в моей практике», «однажды». Только общеизвестная механика и логика, которые можно проверить.
- Никаких выдуманных цифр, компаний, исследований. Числа только общеизвестные (например, в европейской рулетке 37 ячеек), не больше двух на пост. Проценты знаком %.
- Мотивация допустима, но только на конкретике. Запрещены пустые призывы и клише: «верь в себя», «ты сможешь», «никогда не сдавайся», «успех приходит к тем, кто». Мысль должна быть такой, чтобы читатель мог проверить ее на своем опыте.
- Запрещено: «не X, а Y» и «это не X, это Y» в любом виде, «Вот как», «Вот что», «Результат?», «Честно говоря», вопрос-приманка в конце (кроме формата вопроса), хэштеги, ссылки, названия сайтов, эмодзи, буква ё, тире (только запятые и двоеточия), скобки.
- Не писать про американский рынок гемблинга. Не использовать слово «книга» в значении линии букмекера.
- Минимум англицизмов: если есть нормальное русское слово, использовать его. Термины индустрии (GGR, маржа, прокрут) не расшифровывать.
- Посты не повторяют друг друга ни темой, ни первой строкой, ни ритмом.

ФОРМАТ ОТВЕТА: только тексты постов, между постами строка из трех решеток ### . Без нумерации, заголовков и пояснений.${apPromptExtra()}`;
}

const THREADS_BAD = [
  [/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|ru|net|io|bet|org)\b/i, 'ссылка или домен'],
  [/(^|\s)#\S/, 'хэштег'],
  [/(^|[^а-яё])я (видел|помню|наблюдал|работал)|в моей практике|у нас (был|была|было|были)([^а-яё]|$)|однажды|как-то раз/i, 'выдуманный личный опыт'],
  [/(^|[^а-яё])книг[аиуе]([^а-яё]|$)/i, 'слово «книга»'],
  [/(^|[^а-яё])вот (как|что)([^а-яё]|$)|честно говоря|^результат\?/im, 'шаблонная фраза']
];

function validateThreadsPost(t) {
  if (threadsLength(t) > THREADS_SAFE) return 'слишком длинный';
  for (const [re, why] of THREADS_BAD) if (re.test(t)) return why;
  if (findNegContrast(t).length) return 'конструкция «не X, а Y»';
  return null;
}

async function generateThreadsBatch(format, count) {
  if (!ANTHROPIC_API_KEY) throw httpError(503, 'Не задан ANTHROPIC_API_KEY');
  const want = Math.min(Math.max(Number(count) || 7, 1), 14);
  const raw = await claudeCall(threadsSystemPrompt(format), `Напиши ${want + 3} разных постов.`, 3500);
  if (!raw) throw httpError(502, 'Модель не ответила');
  const posts = [];
  let dropped = 0;
  for (const part of raw.split(/\n\s*#{3}\s*\n?/)) {
    const t = noYo(part.replace(/^\s*\d+[.)]\s+/, '').trim());
    if (!t) continue;
    if (validateThreadsPost(t)) { dropped++; continue; }
    if (posts.length < want) posts.push(t);
  }
  if (!posts.length) throw httpError(502, 'Все черновики не прошли проверку, нажми еще раз');
  return { posts, dropped };
}

function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > limit) { req.destroy(); reject(httpError(413, 'Слишком большой запрос')); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(httpError(400, 'Некорректный JSON')); } });
    req.on('error', reject);
  });
}

// Все маршруты /api/threads-*; возвращает true, если маршрут обработан
function threadsRoute(req, res) {
  const url = req.url.split('?')[0];
  if (!url.startsWith('/api/threads-')) return false;
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  (async () => {
    try {
      if (url === '/api/threads-diag') {
        const out = { tokenPresent: threadsConfigured(), scheduleConfigured: scheduleConfigured() };
        if (threadsConfigured()) {
          try { const me = await threadsReq('GET', '/me', { fields: 'id,username' }); out.tokenOk = !!me.id; out.replies = threadsReplyState; }
          catch (e) { out.tokenOk = false; out.error = scrubToken(e.message); }
        }
        return send(200, out);
      }
      const auth = await authorizeUser(req);
      if (!auth.ok) return send(auth.status, { error: auth.error });
      if (!scheduleConfigured()) return send(503, { error: 'Расписание не настроено: нужен NOTION_API_KEY в переменных Railway' });

      if (req.method === 'GET' && url === '/api/threads-status') {
        const out = { tokenPresent: threadsConfigured(), autoreply: THREADS_AUTOREPLY(), replies: threadsReplyState, stats: statsState, statsHour: STATS_HOUR };
        if (threadsConfigured()) {
          try { const me = await threadsReq('GET', '/me', { fields: 'id,username' }); out.tokenOk = !!me.id; out.username = me.username || ''; }
          catch (e) { out.tokenOk = false; out.error = scrubToken(e.message); }
        }
        return send(200, out);
      }

      if (req.method === 'POST' && url === '/api/threads-tools') {
        const { action, hours } = await readJsonBody(req);
        if (action === 'stats') {
          const r = await statsRun({ manual: true });
          return send(200, { ok: !!r, message: r ? 'Отчет отправлен в чат с ботом' : 'Отчет уже собирается, подожди минуту' });
        }
        if (action === 'replies') {
          const r = await threadsRepliesTick({ manual: true, hours: Math.min(168, Math.max(1, Number(hours) || 24)) });
          if (!r) return send(200, { ok: false, message: 'Проверка уже идет, подожди минуту' });
          if (r.error) return send(200, { ok: false, message: 'Ошибка: ' + r.error.slice(0, 300) });
          return send(200, { ok: true, message: r.found ? `Нашел ответов: ${r.found}. Карточки в чате с ботом` : 'За этот период чужих ответов нет' });
        }
        return send(400, { error: 'Неизвестное действие' });
      }

      if (req.method === 'GET' && url === '/api/threads-queue') {
        const rows = await schedQuery({ and: [
          { property: 'Owner', number: { equals: Number(auth.userId) } },
          { or: [{ property: 'Status', select: { equals: TS.scheduled } }, { property: 'Status', select: { equals: TS.missed } }, { property: 'Status', select: { equals: TS.failed } }] }
        ] }, 100);
        const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
        const items = rows
          .filter(r => r.status === TS.scheduled || (r.publishAt && Date.parse(r.publishAt) >= cutoff))
          .map(r => ({ id: r.id, text: r.text, status: r.status.replace(/^t_/, ''), publishAt: r.publishAt, local: r.publishAt ? formatWarsaw(r.publishAt) : '', error: r.error || '' }));
        return send(200, { items, configured: threadsConfigured() });
      }

      if (req.method === 'POST' && url === '/api/threads-generate') {
        const { format, count } = await readJsonBody(req);
        const batch = await generateThreadsBatch(format, count);
        const rows = await schedQuery({ and: [{ property: 'Status', select: { equals: TS.scheduled } }, { property: 'Owner', number: { equals: Number(auth.userId) } }] }, 100);
        const taken = new Set(rows.filter(r => r.publishAt).map(r => Math.floor(Date.parse(r.publishAt) / 60000)));
        const slots = nextThreadsSlots(batch.posts.length, taken);
        return send(200, { posts: batch.posts.map((text, i) => ({ text, when: slots[i] || '' })), dropped: batch.dropped });
      }

      if (req.method === 'POST' && url === '/api/threads-angles') {
        const body = await readJsonBody(req, 512 * 1024);
        const out = await generateAngles(body.candidate || {});
        const rows = await schedQuery({ and: [{ property: 'Status', select: { equals: TS.scheduled } }, { property: 'Owner', number: { equals: Number(auth.userId) } }] }, 100);
        const taken = new Set(rows.filter(r => r.publishAt).map(r => Math.floor(Date.parse(r.publishAt) / 60000)));
        const slots = nextThreadsSlots(out.posts.length, taken);
        return send(200, { posts: out.posts.map((x, i) => ({ ...x, when: slots[i] || '' })), dropped: out.dropped });
      }

      if (req.method === 'POST' && url === '/api/threads-editor') {
        const body = await readJsonBody(req, 512 * 1024);
        const out = await runEditor(body.candidate || {}, body.telegram_asset || {});
        return send(200, out);
      }

      if (req.method === 'POST' && url === '/api/threads-schedule') {
        if (!threadsConfigured()) return send(503, { error: 'Threads не настроен: задай THREADS_ACCESS_TOKEN в переменных Railway' });
        const { items } = await readJsonBody(req, 1024 * 1024);
        if (!Array.isArray(items) || !items.length) return send(400, { error: 'Нет постов для очереди' });
        if (items.length > 30) return send(400, { error: 'За раз можно поставить не больше 30 постов' });
        // Сначала проверяем все, чтобы не поставить в очередь половину партии
        const prepared = items.map((it, i) => {
          const text = noYo(String(it.text || '').trim());
          if (!text) throw httpError(400, `Пост ${i + 1}: пустой текст`);
          const len = threadsLength(text);
          if (len > THREADS_MAX) throw httpError(400, `Пост ${i + 1}: ${len} символов, лимит ${THREADS_MAX}`);
          const parsed = parseWarsawDateTime(it.when);
          if (!parsed.ok) throw httpError(400, `Пост ${i + 1}: ${parsed.error}`);
          const mt = it.meta && typeof it.meta === 'object' ? it.meta : null;
          const meta = mt ? {
            type: EDITOR_TYPES.concat(['personal']).includes(mt.type) ? mt.type : null,
            goal: ['reach', 'telegram_bridge'].includes(mt.goal) ? mt.goal : null,
            company: String(mt.company || '').slice(0, 100),
            angle: String(mt.angle || '').slice(0, 300)
          } : null;
          return { text, iso: parsed.iso, meta };
        });
        for (const p of prepared) await tCreate(p.text, p.iso, Number(auth.userId), p.meta);
        return send(200, { ok: true, count: prepared.length });
      }

      if (req.method === 'POST' && url === '/api/threads-action') {
        const { id, action, when } = await readJsonBody(req, 64 * 1024);
        if (!/^[0-9a-f-]{32,40}$/i.test(String(id || ''))) return send(400, { error: 'Некорректный id поста' });
        if (!['cancel', 'publish', 'reschedule'].includes(action)) return send(400, { error: 'Неизвестное действие' });
        let row;
        try { row = await schedGet(id); } catch { return send(404, { error: 'Пост не найден или очередь недоступна' }); }
        if (String(row.owner) !== auth.userId) return send(403, { error: 'Это не твой пост' });
        if (!String(row.status || '').startsWith('t_')) return send(403, { error: 'Это не пост Threads' });
        if (action === 'reschedule') {
          // Переносить можно и сорвавшийся пост: он снова становится запланированным
          if (![TS.scheduled, TS.missed, TS.failed].includes(row.status)) return send(409, { error: `Пост уже не в очереди: ${row.status}` });
          const parsed = parseWarsawDateTime(when);
          if (!parsed.ok) return send(400, { error: parsed.error });
          if (schedInFlight.has(row.id)) return send(409, { error: 'Пост публикуется прямо сейчас' });
          await schedUpdate(row.id, { publishAt: parsed.iso, status: TS.scheduled, error: '' });
          return send(200, { ok: true, local: formatWarsaw(parsed.iso) });
        }
        if (row.status !== TS.scheduled && !((action === 'publish' || action === 'cancel') && (row.status === TS.missed || row.status === TS.failed))) {
          return send(409, { error: `Пост уже не в очереди: ${row.status}` });
        }
        if (action === 'cancel') {
          if (schedInFlight.has(row.id)) return send(409, { error: 'Пост публикуется прямо сейчас' });
          await schedUpdate(row.id, { status: TS.cancelled });
          return send(200, { ok: true, status: 'cancelled' });
        }
        // Повторная публикация сорвавшегося поста: failed мог частично выйти, поэтому только по явному нажатию
        const r = await runThreadsPost({ ...row, publishAt: row.publishAt || new Date().toISOString() }, { checkStale: false, notify: false });
        if (r.status === 'published') return send(200, { ok: true, status: 'published', link: r.link || null });
        if (r.status === 'busy') return send(409, { error: 'Пост уже публикуется' });
        return send(502, { error: `Не удалось опубликовать: ${r.error}` });
      }

      return send(404, { error: 'Нет такого маршрута' });
    } catch (err) {
      console.error('threads route error:', scrubToken(err.message));
      send(err.httpStatus || 500, { error: scrubToken(err.message) });
    }
  })();
  return true;
}
// ── Редакционный алгоритм Threads (версия 1.0 от 10.10.2026): кандидат → проверка → JSON → статус ──
const EDITOR_TYPES = ['news', 'feature', 'mechanic', 'opinion'];

function editorSystemPrompt() {
  return `Ты редактор русскоязычного Threads-медиа Дмитрия об iGaming и sportsbook. Твоя задача: создавать охватный, понятный человеку вне индустрии контент с операторской глубиной. Threads набирает массовый тематический охват, Telegram хранит более глубокие материалы и со временем становится рекламной B2B-площадкой.

Пиши как опытный sportsbook-оператор, а не как журналист, affiliate, маркетолог, мотиватор или AI-копирайтер. Главная оптика каждого поста: что увидит клиент, какое его поведение хочет изменить компания, как это связано с экономикой и где ограничение решения.

Пропорция последних 20 постов: NEWS 30%, FEATURE 30%, MECHANIC 30%, OPINION 10%. Минимум 60% постов напрямую связаны со sportsbook или betting. Не публикуй общую бизнес-мудрость без индустриального объекта. Не публикуй слабую новость ради квоты.

NEWS: факт, клиентский эффект, операторская оптика, вывод, первичный URL отдельной последней строкой. FEATURE: одна функция, одно клиентское изменение, одна бизнес-цель, одно условие успеха или ограничение, первичный URL для реального релиза отдельной последней строкой. MECHANIC: знакомое наблюдение, скрытая механика, экономика, вывод. OPINION: конкретное индустриальное наблюдение, причина, последствие, позиция.

Операторский вывод в NEWS и FEATURE автор не диктует, ты выводишь его сам из фактов источника и общеизвестной механики индустрии: что у оператора дешевеет или дорожает, кто несет риск, что остается ограничением или условием успеха. Подай его как интерпретацию, не как факт и не как личный опыт, без выдуманных цифр. Это и есть author_angle: если такой вывод не следует из фактов, ставь 0. Вывод стоит в конце текста перед ссылкой. Запрещены довески после факта вроде даты запуска или «если пройдут регуляторы», не связанные с выводом. Пересказ новости без такого вывода не публикуй.

Не пытайся разобрать всю функцию в 500 символов. Выбери один угол: проблема клиента, изменение поведения, бизнес-метрика, компромисс, риск или условие успеха. Если нельзя объяснить, что изменится для клиента прямо или косвенно, FEATURE не публикуется.

Режимы: 80% постов полностью раскрывают мысль в Threads (goal=reach). Не более 20% ведут в Telegram (goal=telegram_bridge), и только если telegram_asset.available=true и там есть конкретная дополнительная ценность. В таком посте последняя строка это URL из telegram_asset, а текст перед ним называет, что именно читатель получит в Telegram. Запрещены «подробнее в канале» и «продолжение по ссылке». Не скрывай основной ответ ради перехода. Новостной пост со ссылкой на источник не получает второй внешний CTA, мост в Telegram не делается для NEWS.

Финальный post_text вместе с URL не длиннее 500 символов Unicode. Рабочий ориентир без ссылки 300-480. Один пост, одна мысль, не больше одной внешней ссылки. Русский язык простой, разговорный, буква е без точек, без эмодзи, хэштегов, Markdown, канцелярита и рекламных эпитетов. Цифры по-человечески, не больше пяти-шести на пост, проценты знаком %. Незнакомый термин раскрой в той же фразе, базовые термины индустрии (GGR, NGR, маржа) не расшифровывай. Слово «книга» в значении линии букмекера не используй. Не пиши про американский гемблинг (рынок США, штаты, американские операторы), исключение: prediction markets.

Запрещены: «Вот почему», «Вот что», «Давайте разберемся», «Дело не в X, а в Y», «Это не просто X, это Y», «Почему это важно?», «Результат?», «Что думаете?», «Согласны?», «Делитесь в комментариях», «В современном мире», «играет ключевую роль», «выводит на новый уровень», заголовки «3 урока», «5 вещей», три симметричные короткие фразы ради ритма, повтор мысли разными словами, драматические тире. Предметный вопрос допустим не чаще чем в 20% постов и только с ограниченным предметом ответа.

Не придумывай цифры, цитаты, кейсы, мотивы компании и личный опыт автора. Для NEWS и FEATURE используй первичный источник. Отделяй подтвержденные факты от обещаний компании и своей интерпретации: заявление компании маркируй как заявление. Новость старше 72 часов допустима только с новым углом, тогда это уже FEATURE или MECHANIC. Если source_text недоступен, факта не хватает или утверждение нельзя подтвердить, верни needs_input или skip, никогда не заполняй пробел догадкой.

Перед текстом внутренне оцени кандидата по шести критериям 0-2: interest, novelty, customer_face, business_mechanism, author_angle, evidence. Порог 8 из 12. Для NEWS и FEATURE evidence должна быть 2, для FEATURE customer_face минимум 1, для любого типа author_angle минимум 1. Сначала внутренне ответь на пять вопросов клиентского лица: что клиент увидит, какое действие станет проще, дороже или вероятнее, какого поведения хочет компания, на какой показатель это влияет, какой риск или ограничение. Выбери один главный конфликт. Если suggested_type не auto, используй его, если он не противоречит материалу.

Статусы: ready (пройдены пороги, факты подтверждены, ссылка там где нужна, длина не больше 500, нет дубля и запрещенного), needs_input (не хватает источника, даты, числа, контекста или содержания Telegram-материала), skip (нет клиентского лица и механики, чистый пресс-релиз, факт не подтвердить, тема недавно выходила с тем же выводом, нужно выдумывать, не про iGaming, устарело, реклама букмекера). Для skip и needs_input post_text оставь пустым.

${apPromptExtra()}

Тебе приходит JSON с полями current_date, candidate (title, source_url, source_text, published_at, suggested_type), recent_posts, mix_last_20, telegram_asset. Верни ТОЛЬКО валидный JSON без Markdown:
{"status":"ready|needs_input|skip","content_type":"news|feature|mechanic|opinion","goal":"reach|telegram_bridge","company":"","angle":"","customer_face":"","business_mechanism":"","source_url":"","source_quality":"primary|secondary|not_required|insufficient","suggested_topic":"","post_text":"","character_count":0,"score":{"interest":0,"novelty":0,"customer_face":0,"business_mechanism":0,"author_angle":0,"evidence":0,"total":0},"internal_fact_check":[{"claim":"","support":""}],"reason":""}`;
}

async function tRecent(limit = 20) {
  const data = await notionReq('POST', `/v1/data_sources/${NOTION_SCHEDULE_DS_ID}/query`, {
    filter: { or: [{ property: 'Status', select: { equals: TS.published } }, { property: 'Status', select: { equals: TS.scheduled } }] },
    sorts: [{ property: 'Publish At', direction: 'descending' }], page_size: limit
  });
  return (data.results || []).map(pageToRow);
}

function parseEditorJson(raw) {
  const m = String(raw || '').replace(/^```(?:json)?\s*|\s*```$/g, '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const EDITOR_BAD = [
  [/вот почему|вот что|давайте разберемся/i, 'шаблонная фраза («Вот почему», «Вот что», «Давайте разберемся»)'],
  [/это не просто|почему это важно|(^|\n)результат\?/i, 'шаблонная конструкция'],
  [/что думаете|согласны\?|делитесь в комментариях/i, 'призыв к комментариям'],
  [/в современном мире|играет ключевую роль|выводит на новый уровень/i, 'штамп'],
  [/подробнее в канале|продолжение по ссылке|подробнее по ссылке/i, 'пустой призыв перейти'],
  [/(^|[\s(])#\S/, 'хэштег'],
  [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'эмодзи'],
  [/\*\*|^#{1,3}\s|`/m, 'Markdown'],
  [/(^|[^а-яё])книг[аиуе]([^а-яё]|$)/i, 'слово «книга»'],
  [/(^|\s)\d+\s+(урок|вещ|причин)/i, 'заголовок-счетчик'],
  [/(^|[^а-яё])я (видел|помню|наблюдал)|в моей практике|у нас (был|была|было|были)([^а-яё]|$)/i, 'выдуманный личный опыт']
];
const US_GAMBLING = /(draftkings|fanduel|betmgm|caesars sportsbook|espn bet|fanatics sportsbook|hard rock bet|сша|американск|штат[аоы]?(?![а-я]))/i;
const PRED_MARKET = /kalshi|polymarket|prediction market|предикшн|рынк[а-я]* предсказани/i;

// Проверки сверху модели: возвращает { fix: [...], skip: [...] }
function validateEditorResult(res, input, recent) {
  const fix = [], skip = [];
  const text = String(res.post_text || '');
  const type = res.content_type;
  const url = (res.source_url || input.candidate.source_url || '').trim();
  const urls = text.match(/https?:\/\/\S+/g) || [];
  if (!EDITOR_TYPES.includes(type)) skip.push('неизвестный тип поста');
  if (!text.trim()) fix.push('пустой текст поста');
  const len = threadsLength(text);
  if (len > THREADS_MAX) fix.push(`длина ${len} из ${THREADS_MAX}`);
  if (/ё/i.test(text)) fix.push('буква ё');
  for (const [re, why] of EDITOR_BAD) if (re.test(text)) fix.push(why);
  if (findNegContrast(text).length) fix.push('конструкция «не X, а Y»');
  if (/[—–]/.test(text) || /\s-\s/.test(text)) fix.push('тире');
  if (urls.length > 1) fix.push('больше одной ссылки');
  const lastLine = text.trim().split('\n').pop().trim();
  if ((type === 'news' || type === 'feature') && url && res.goal !== 'telegram_bridge') {
    if (lastLine !== url) fix.push('ссылка на источник должна стоять отдельной последней строкой');
  }
  if (res.goal === 'telegram_bridge') {
    const asset = input.telegram_asset || {};
    if (!asset.available || !asset.url) skip.push('нет материала в Telegram для перехода');
    else if (lastLine !== asset.url) fix.push('ссылка на Telegram должна стоять отдельной последней строкой');
    if (type === 'news') skip.push('для NEWS мост в Telegram не делается');
  }
  if (US_GAMBLING.test(text) && !PRED_MARKET.test(text)) skip.push('американский гемблинг');
  // Пороги по шкале
  const sc = res.score || {};
  const total = ['interest', 'novelty', 'customer_face', 'business_mechanism', 'author_angle', 'evidence'].reduce((a, k) => a + (Number(sc[k]) || 0), 0);
  res.score = { ...sc, total };
  if (total < 8) skip.push(`оценка ${total} из 12, порог 8`);
  if ((type === 'news' || type === 'feature') && Number(sc.evidence) !== 2) skip.push('для NEWS и FEATURE доказательность должна быть 2');
  if (type === 'feature' && Number(sc.customer_face) < 1) skip.push('у FEATURE нет лица клиента');
  if (Number(sc.author_angle) < 1) skip.push('нет авторского угла');
  // Свежесть новости
  const pub = Date.parse(input.candidate.published_at || '');
  if (type === 'news' && pub && Date.now() - pub > 72 * 3600 * 1000) skip.push('новости больше 72 часов, нового угла нет');
  // Лента: дубли, серии, квоты
  const last20 = recent.slice(0, 20), last10 = recent.slice(0, 10);
  const co = String(res.company || '').trim().toLowerCase();
  if (co && last10.filter(r => String(r.company || '').trim().toLowerCase() === co).length >= 2) skip.push('эта компания уже в двух из последних десяти постов');
  const t2 = recent.slice(0, 2).map(r => r.type);
  if (t2.length === 2 && t2[0] && t2[0] === t2[1] && t2[0] === type) skip.push('третий пост подряд одного типа');
  if (type === 'news' && last20.filter(r => r.type === 'news').length >= 8) skip.push('лимит NEWS 40% в последних 20 постах');
  if (res.goal === 'telegram_bridge' && last20.filter(r => r.goal === 'telegram_bridge').length >= 4) skip.push('лимит 20% постов с переходом в Telegram');
  return { fix, skip };
}

function editorMix(recent) {
  const mix = { news: 0, feature: 0, mechanic: 0, opinion: 0 };
  recent.slice(0, 20).forEach(r => { if (mix[r.type] !== undefined) mix[r.type]++; });
  return mix;
}

// ── Личный пост (PERSONAL): пишется только из того, что сказал сам Дмитрий ──
function personalSystemPrompt() {
  return `Ты редактор русскоязычного Threads Дмитрия, оператора sportsbook. Задача: превратить его личный материал (заметки, мысли, история) в короткий пост, после которого читатель ему доверяет и сопереживает. Это личный пост, индустриальный объект и бизнес-механика не нужны.

Главное правило: используй только факты, события, чувства и числа из source_text. Не придумывай сцены, диалоги, цифры, людей, даты и обстоятельства. Если материала не хватает для честного поста, верни needs_input и в reason напиши одним вопросом, чего не хватает.

Пост: одна история или одно решение, одно настоящее чувство, один вывод, который следует из самого материала. Первое лицо, живая речь, без пафоса, без мотивационного тона, без поучений и без «жизненных уроков». Не объясняй читателю, что он должен почувствовать. Длина до 480 символов. Русский простой разговорный, буква е без точек, без эмодзи, хэштегов, Markdown, тире (только дефис внутри слов), без «Вот почему», «Вот что», «Дело не в X, а в Y», «Это не просто X, это Y», «Результат?», «Что думаете?», «Согласны?», без призывов к комментариям и без трех симметричных коротких фраз. Не называй людей и компании, если их нет в материале, и не нападай на них по имени. Не пиши про американский гемблинг.

Верни ТОЛЬКО JSON без Markdown: {"status":"ready|needs_input","post_text":"","facts_used":[{"quote":"дословная цитата из source_text, на которую опирается пост"}],"reason":""}`;
}
async function runPersonal(cand) {
  const src = String(cand.source_text || '').slice(0, 12000);
  if (src.trim().length < 80) return { result: { status: 'needs_input', content_type: 'personal', reason: 'Для личного поста вставь свой материал: что произошло, что ты почувствовал, к чему пришел. Придумывать за тебя бот не будет.', post_text: '' } };
  const raw = await claudeCall(personalSystemPrompt(), JSON.stringify({ title: String(cand.title || '').slice(0, 300), source_text: src }), 2000);
  const res = parseEditorJson(raw);
  if (!res) throw httpError(502, 'Модель вернула не JSON, попробуй еще раз');
  res.content_type = 'personal'; res.goal = 'reach';
  res.post_text = noYo(String(res.post_text || '').trim());
  if (res.status !== 'ready' || !res.post_text) { res.status = 'needs_input'; res.post_text = ''; return { result: res }; }
  const norm = t => String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[\s ]+/g, ' ').replace(/[«»"“”„'’.,!?;:()\-–—]/g, '').trim();
  const nsrc = norm(src);
  const facts = Array.isArray(res.facts_used) ? res.facts_used : [];
  const bad = [];
  if (!facts.length) bad.push('нет опоры на твой текст');
  facts.forEach(f => { const q = norm(f && f.quote); if (!q || !nsrc.includes(q)) bad.push('цитата не найдена в твоем тексте: «' + String((f && f.quote) || '').slice(0, 80) + '»'); });
  if (threadsLength(res.post_text) > THREADS_MAX) bad.push('длина больше ' + THREADS_MAX);
  for (const [re, why] of EDITOR_BAD) if (why !== 'выдуманный личный опыт' && re.test(res.post_text)) bad.push(why);
  if (findNegContrast(res.post_text).length) bad.push('конструкция «не X, а Y»');
  if (/[—–]/.test(res.post_text) || /\s-\s/.test(res.post_text)) bad.push('тире');
  if (US_GAMBLING.test(res.post_text) && !PRED_MARKET.test(res.post_text)) bad.push('американский гемблинг');
  res.internal_fact_check = facts.map(f => ({ claim: String((f && f.quote) || '').slice(0, 200), support: 'твой текст' }));
  if (bad.length) { res.status = 'needs_input'; res.reason = 'Пост не прошел проверку: ' + bad.join('; ') + '. Нажми еще раз.'; }
  const rowsT = await tRecent(30).catch(() => []);
  const taken = new Set(rowsT.filter(r => r.status === TS.scheduled && r.publishAt).map(r => Math.floor(Date.parse(r.publishAt) / 60000)));
  return { result: res, slot: nextThreadsSlots(1, taken)[0] || '' };
}
// ── конец личных постов ──

async function runEditor(cand, tg) {
  if (cand && cand.suggested_type === 'personal') return runPersonal(cand);
  const input0 = {
    current_date: new Date().toISOString().slice(0, 10),
    candidate: {
      title: String(cand.title || '').slice(0, 300),
      source_url: String(cand.source_url || '').trim().slice(0, 600),
      source_text: String(cand.source_text || '').slice(0, 12000),
      published_at: String(cand.published_at || '').slice(0, 40),
      suggested_type: EDITOR_TYPES.concat(['auto']).includes(cand.suggested_type) ? cand.suggested_type : 'auto'
    },
    telegram_asset: { available: !!(tg && tg.available && tg.url), url: String((tg && tg.url) || '').trim(), extra_value: String((tg && tg.extra_value) || '').slice(0, 500) }
  };
  const needsSource = input0.candidate.suggested_type === 'news' || input0.candidate.suggested_type === 'feature';
  if (needsSource && !input0.candidate.source_text.trim()) {
    return { result: { status: 'needs_input', reason: 'Для NEWS и FEATURE нужен текст источника: вставь его, угадывать содержание по ссылке нельзя.', post_text: '' } };
  }
  if (!input0.candidate.source_text.trim() && !input0.candidate.title.trim()) {
    return { result: { status: 'needs_input', reason: 'Нужна тема или текст источника.', post_text: '' } };
  }
  const recentRows = await tRecent(20);
  const recent = recentRows.map(r => ({ published_at: r.publishAt, type: r.type || '', company: r.company || '', angle: r.angle || '', goal: r.goal || '', post_text: r.text }));
  const input = { ...input0, recent_posts: recent.map(r => ({ published_at: r.published_at, content_type: r.type, company: r.company, angle: r.angle, post_text: r.post_text })), mix_last_20: editorMix(recent) };
  const raw = await claudeCall(editorSystemPrompt(), JSON.stringify(input), 3000);
  let res = parseEditorJson(raw);
  if (!res) throw httpError(502, 'Модель вернула не JSON, попробуй еще раз');
  res.post_text = noYo(String(res.post_text || '').trim());
  res.character_count = threadsLength(res.post_text);
  if (res.status !== 'ready') {
    return { result: res, mix: input.mix_last_20 };
  }
  let v = validateEditorResult(res, input, recent);
  // Одна попытка починить оформление, если нарушены только форматные правила
  if (v.fix.length && !v.skip.length) {
    const fixed = await claudeCall(editorSystemPrompt(),
      `Исправь post_text, не меняя смысла и фактов. Нарушения: ${v.fix.join('; ')}. Верни тот же JSON целиком, status оставь ready.\n\n` + JSON.stringify({ input, previous: res }), 3000);
    const res2 = parseEditorJson(fixed);
    if (res2) {
      res2.post_text = noYo(String(res2.post_text || '').trim());
      res2.character_count = threadsLength(res2.post_text);
      res = res2;
      v = validateEditorResult(res, input, recent);
    }
  }
  if (v.skip.length) { res.status = 'skip'; res.reason = v.skip.join('; '); res.post_text = res.post_text; }
  else if (v.fix.length) { res.status = 'needs_input'; res.reason = 'Не прошел проверку оформления: ' + v.fix.join('; '); }
  const taken = new Set(recentRows.filter(r => r.status === TS.scheduled && r.publishAt).map(r => Math.floor(Date.parse(r.publishAt) / 60000)));
  return { result: res, mix: input.mix_last_20, slot: nextThreadsSlots(1, taken)[0] || '' };
}


// ── Несколько углов из одной новости ──
const ANGLE_LENSES = [
  'кто платит: чьи деньги и чей риск стоят за этой новостью',
  'что дорожает или дешевеет для оператора и что остается ограничением',
  'неудобный вопрос индустрии, который эта новость ставит',
  'спорная позиция: с чем в этой новости можно не согласиться',
  'глазами игрока: что он увидит и как изменится его поведение',
  'что в заявлении компании пока только обещание и чем это проверить'
];
function anglesSystemPrompt(maxBody, hasUrl) {
  return `Ты редактор русскоязычного Threads Дмитрия об iGaming и sportsbook. По одной новости или посту напиши 6 разных постов, каждый под своим углом. Углы: ${ANGLE_LENSES.map((a, i) => (i + 1) + ') ' + a).join('; ')}. Можно заменить угол более острым, но все шесть должны отличаться по мысли, а не по формулировке. Провокация должна быть в мысли или вопросе к индустрии, не в обвинении компании и не в нападках на нее по имени.

Правила. Только факты из source_text, заявление компании маркируй как заявление, свои выводы подавай как интерпретацию. Не придумывай цифры, цитаты, кейсы и личный опыт автора («я видел», «в моей практике», «у нас был»). Каждый пост: факт, вывод оператора, позиция. Длина текста поста не больше ${maxBody} символов${hasUrl ? ', ссылку не пиши, ее добавит система' : ', ссылок и адресов сайтов в тексте нет'}. Русский простой разговорный, буква е без точек, без эмодзи, хэштегов, Markdown, тире (только дефис внутри слов), без «Вот почему», «Вот что», «Дело не в X, а в Y», «Это не просто X, это Y», «Результат?», «Что думаете?», «Согласны?», без призывов к комментариям, без трех симметричных коротких фраз. Цифр не больше трех-четырех на пост, проценты знаком %. Слово «книга» в значении линии букмекера не используй. Не пиши про американский гемблинг (рынок США, штаты), кроме prediction markets. Базовые термины (GGR, NGR, маржа) не расшифровывай.

Верни ТОЛЬКО JSON без Markdown: {"posts":[{"angle":"название угла 2-5 слов","text":"текст поста"}]}`;
}
const PERSONAL_LENSES = ['начать с момента или детали', 'начать с решения, которое было принято', 'начать с честного чувства', 'начать с вопроса к себе', 'самая короткая версия, одна мысль'];
function personalVariantsPrompt() {
  return `Ты редактор русскоязычного Threads Дмитрия, оператора sportsbook. Из его личного материала напиши 6 разных коротких постов, после которых читатель ему доверяет и сопереживает. Заходы: ${PERSONAL_LENSES.map((a, i) => (i + 1) + ') ' + a).join('; ')}. Все варианты должны различаться заходом и мыслью.

Главное правило: только факты, события, чувства и числа из source_text. Не придумывай сцены, диалоги, цифры, людей, даты и обстоятельства. Каждый пост даем с дословной цитатой из source_text, на которую он опирается. Первое лицо, живая речь, без пафоса, без мотивационного тона, без поучений и «жизненных уроков», не объясняй читателю, что он должен почувствовать. Длина до 480 символов, ссылок в тексте нет. Русский простой разговорный, буква е без точек, без эмодзи, хэштегов, Markdown, тире (только дефис внутри слов), без «Вот почему», «Вот что», «Дело не в X, а в Y», «Это не просто X, это Y», «Результат?», «Что думаете?», «Согласны?», без призывов к комментариям, без трех симметричных коротких фраз. Не называй людей и компании, которых нет в материале. Не пиши про американский гемблинг.

Верни ТОЛЬКО JSON без Markdown: {"posts":[{"angle":"название захода 2-4 слова","text":"текст поста","quote":"дословная цитата из source_text"}]}`;
}
async function generateAngles(cand) {
  const title = String(cand.title || '').slice(0, 300);
  const urlSrc = String(cand.source_url || '').trim().slice(0, 600);
  const srcText = String(cand.source_text || '').slice(0, 12000);
  const personal = cand.suggested_type === 'personal';
  if (!srcText.trim()) throw httpError(400, 'Нужен текст: вставь его в поле источника');
  if (urlSrc && !/^https?:\/\/\S+$/.test(urlSrc)) throw httpError(400, 'Ссылка выглядит неверно: она должна начинаться с http');
  const hasUrl = !!urlSrc && !personal;
  const maxBody = personal ? 480 : THREADS_MAX - (hasUrl ? threadsLength(urlSrc) + 1 : 0) - 10;
  if (maxBody < 150) throw httpError(400, 'Ссылка слишком длинная, на текст остается меньше 150 символов');
  if (personal && srcText.trim().length < 80) throw httpError(400, 'Для личных постов вставь свой материал подробнее: что произошло и что ты почувствовал. Придумывать за тебя бот не будет.');
  const raw = await claudeCall(personal ? personalVariantsPrompt() : anglesSystemPrompt(maxBody, hasUrl), JSON.stringify({ title, source_url: hasUrl ? urlSrc : '', source_text: srcText }), 4000);
  const parsed = parseEditorJson(raw);
  if (!parsed || !Array.isArray(parsed.posts)) throw httpError(502, 'Модель вернула не JSON, попробуй еще раз');
  const norm = t => String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[\s ]+/g, ' ').replace(/[«»"“”„'’.,!?;:()\-–—]/g, '').trim();
  const nsrc = norm(srcText);
  const posts = [], dropped = [];
  for (const it of parsed.posts) {
    const body = noYo(String((it && it.text) || '').trim()).replace(/https?:\/\/\S+/g, '').trim();
    const angle = String((it && it.angle) || '').trim().slice(0, 60);
    const why = [];
    if (!body) why.push('пусто');
    if (threadsLength(body) > maxBody) why.push('длинно');
    for (const [re, w] of EDITOR_BAD) { if (personal && w === 'выдуманный личный опыт') continue; if (re.test(body)) { why.push('шаблонная фраза'); break; } }
    if (findNegContrast(body).length) why.push('не X, а Y');
    if (/[—–]/.test(body) || /\s-\s/.test(body)) why.push('тире');
    if (US_GAMBLING.test(body) && !PRED_MARKET.test(body)) why.push('США');
    if (personal) { const q = norm(it && it.quote); if (!q || !nsrc.includes(q)) why.push('цитата не найдена в твоем тексте'); }
    if (why.length) { dropped.push(`${angle || 'вариант'}: ${why.join(', ')}`); continue; }
    posts.push({ angle, text: hasUrl ? body + '\n' + urlSrc : body });
  }
  return { posts: posts.slice(0, 5), dropped, personal };
}
// ── конец блока углов ──
// ── конец блока Threads ──

// ── Автопилот Threads: бот сам готовит черновики по сетке рубрик, владелец модерирует в Telegram ──
// Включается THREADS_AUTOPILOT=on. Раз в час бот проверяет ближайшие THREADS_AUTOPILOT_DAYS дней (по умолчанию 3):
// если на день нет ни одного поста, готовит черновик под рубрику этого дня и присылает карточку с кнопками.
// Черновик лежит в Notion со статусом t_draft и не публикуется. Одобрил или поправил: он становится t_scheduled и уходит по расписанию.
// Убрал: статус t_cancelled и причина. Причины и правки уходят обратно в промпты генерации (apPromptExtra).
// Нужны свойства Notion «Модерация» и «Черновик» (текст): бот создает их сам при первом запуске.
const AP_ON = () => process.env.THREADS_AUTOPILOT === 'on';
const AP_DAYS = Math.min(14, Math.max(1, Number(process.env.THREADS_AUTOPILOT_DAYS) || 3));
const AP_SLOT = /^\d{1,2}:\d{2}$/.test(process.env.THREADS_AUTOPILOT_SLOT || '') ? process.env.THREADS_AUTOPILOT_SLOT : '19:30';
const AP_FEEDS = (process.env.THREADS_FEEDS || 'https://www.igamingbusiness.com/feed/,https://sbcnews.co.uk/feed/').split(',').map(s => s.trim()).filter(Boolean);
const AP_DRAFT = 't_draft';
// День недели (0 = воскресенье) -> тип черновика; сетка из стратегии: пн новость, вт механика, ср новость, чт люди и инструменты, пт новость, сб механика, вс сарказм
const AP_GRID = { 1: 'news', 2: 'mechanics', 3: 'news', 4: 'people', 5: 'news', 6: 'mechanics', 0: 'sarcasm' };
const AP_KIND = {
  news: { rubric: 'Новость + оценка', type: 'news' },
  mechanics: { rubric: 'Механика денег', type: 'mechanic', format: 'mechanics' },
  people: { rubric: 'Люди и инструменты', type: 'opinion', format: 'people' },
  sarcasm: { rubric: 'Сарказм и личное', type: 'opinion', format: 'humor' }
};
const AP_REASONS = ['Слишком общо', 'Пересказ без вывода', 'Выдумка', 'Скучно', 'Тон не мой', 'Тема не подходит'];

let apRunning = false, apPropsOk = false, apContext = '';
let apLearn = { at: 0, text: '' };
const apTried = new Set();
const apState = { lastRunAt: null, lastError: null, lastNote: '' };

// Блок в промпты генераторов: что владелец убирал и как правил + недавние посты, чтобы не повторяться
function apPromptExtra() {
  const parts = [];
  if (apLearn.text) parts.push(apLearn.text);
  if (apContext) parts.push(apContext);
  return parts.length ? '\n\n' + parts.join('\n\n') : '';
}

async function apEnsureProps() {
  if (apPropsOk) return true;
  try {
    await notionReq('PATCH', `/v1/data_sources/${NOTION_SCHEDULE_DS_ID}`, { properties: { 'Модерация': { rich_text: {} }, 'Черновик': { rich_text: {} }, 'Источник': { rich_text: {} } } });
    apPropsOk = true;
  } catch (e) { console.error('autopilot: свойства Notion не созданы:', scrubToken(e.message)); }
  return apPropsOk;
}

async function apModRows(limit, afterMs) {
  const filter = { and: [{ property: 'Модерация', rich_text: { is_not_empty: true } }, ...(afterMs ? [{ property: 'Publish At', date: { on_or_after: new Date(afterMs).toISOString() } }] : [])] };
  const data = await notionReq('POST', `/v1/data_sources/${NOTION_SCHEDULE_DS_ID}/query`, { filter, sorts: [{ property: 'Publish At', direction: 'descending' }], page_size: limit });
  return (data.results || []).map(pageToRow);
}

async function apRefreshLearning() {
  if (Date.now() - apLearn.at < 20 * 60 * 1000) return;
  apLearn.at = Date.now();
  try {
    const rows = await apModRows(60);
    const kills = rows.filter(r => /^kill:/.test(r.mod)).slice(0, 8);
    const edits = rows.filter(r => r.mod === 'edit' && r.draft && r.draft !== r.text).slice(0, 5);
    const out = [];
    if (kills.length) out.push('ЧТО ВЛАДЕЛЕЦ УБРАЛ ИЗ ЧЕРНОВИКОВ (не пиши такое, причина указана):\n' + kills.map(r => `- [${r.mod.slice(5)}] ${shortPreview(r.text, 160)}`).join('\n'));
    if (edits.length) out.push('КАК ВЛАДЕЛЕЦ ПРАВИТ ЧЕРНОВИКИ (было, стало). Бери разницу в подаче как правило:\n' + edits.map(r => `- БЫЛО: ${shortPreview(r.draft, 220)}\n  СТАЛО: ${shortPreview(r.text, 220)}`).join('\n'));
    apLearn.text = out.join('\n\n');
  } catch (e) { console.error('autopilot: обучение по правкам не собралось:', scrubToken(e.message)); }
}

// ── RSS ──
const apDecode = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#8217;/g, '’').replace(/&#8211;/g, '-');
const apStripTags = x => x.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
const apStrip = s => apStripTags(apDecode(apStripTags(String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')))).replace(/\s+/g, ' ').trim();
function apTag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}
async function apFetchFeed(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (PostBot)' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();
  const blocks = xml.split(/<item[\s>]|<entry[\s>]/i).slice(1);
  return blocks.map(b => {
    const link = apStrip(apTag(b, 'link')) || ((b.match(/<link[^>]+href="([^"]+)"/i) || [])[1] || '');
    return {
      title: apStrip(apTag(b, 'title')),
      url: link.trim(),
      published: apStrip(apTag(b, 'pubDate') || apTag(b, 'published') || apTag(b, 'updated')),
      text: apStrip(apTag(b, 'content:encoded') || apTag(b, 'content') || apTag(b, 'description') || apTag(b, 'summary'))
    };
  }).filter(x => x.title && /^https?:\/\//.test(x.url));
}
async function apFetchArticle(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (PostBot)' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return '';
    return apStrip(await r.text()).slice(0, 8000);
  } catch { return ''; }
}

async function apNewsCandidates(used) {
  const all = [];
  for (const f of AP_FEEDS) {
    try { all.push(...(await apFetchFeed(f))); }
    catch (e) { console.error('autopilot: лента', f, scrubToken(e.message)); }
  }
  const seen = new Set();
  return all
    .map(x => ({ ...x, ts: Date.parse(x.published) || 0 }))
    .filter(x => x.ts && Date.now() - x.ts < 72 * 3600 * 1000)
    .filter(x => !used.has(x.url) && !apTried.has(x.url) && !seen.has(x.url) && seen.add(x.url))
    .filter(x => !(US_GAMBLING.test(x.title + ' ' + x.text.slice(0, 600)) && !PRED_MARKET.test(x.title + ' ' + x.text)))
    .sort((a, b) => b.ts - a.ts);
}

async function apMakeNews(recentRows) {
  const used = new Set(recentRows.map(r => (r.text.match(/https?:\/\/\S+/) || [''])[0]).filter(Boolean));
  const cands = await apNewsCandidates(used);
  let tries = 0;
  for (const c of cands) {
    if (tries >= 4) break;
    tries++;
    apTried.add(c.url); if (apTried.size > 400) apTried.delete(apTried.values().next().value);
    let src = c.text;
    if (src.length < 500) { const full = await apFetchArticle(c.url); if (full.length > src.length) src = full; }
    if (src.length < 200) continue;
    try {
      const { result } = await runEditor({ title: c.title, source_url: c.url, source_text: src, published_at: new Date(c.ts).toISOString(), suggested_type: 'news' }, {});
      if (result && result.status === 'ready' && result.post_text) return { text: result.post_text, type: result.content_type || 'news', goal: 'reach', company: result.company || '', angle: result.angle || '' };
    } catch (e) { console.error('autopilot: редактор новостей', scrubToken(e.message)); }
  }
  return null;
}

async function apMakeBatch(format, recentRows) {
  apContext = recentRows.length ? 'НЕ ПОВТОРЯЙ темы и первые строки недавних постов:\n' + recentRows.slice(0, 12).map(r => '- ' + shortPreview(r.text, 90)).join('\n') : '';
  try {
    const b = await generateThreadsBatch(format, 1);
    return b.posts.find(t => !AP_TG_MENTION.test(t)) || null;
  } finally { apContext = ''; }
}

// ── Темы из постов Дмитрия: Content Engine в Notion (посты LinkedIn) и опубликованные посты Telegram ──
// Каждый источник берется один раз (свойство «Источник» в базе расписания), мысль адаптируется для широкого читателя Threads.
const AP_CE_DS = process.env.CONTENT_ENGINE_DS_ID || '14814719-85c5-4819-a07e-3d1b773d6bdb';
let apCeWarned = false;
const AP_TG_MENTION = /телеграм|telegram|t\.me\/|в профил|ссылк[аеуи] в шапке/i;
const apNorm = t => String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').replace(/[«»"“”„'’.,!?;:()\-–—]/g, '').trim();

async function apPageText(pageId, limit = 6000) {
  let out = '', cursor;
  for (let i = 0; i < 3 && out.length < limit; i++) {
    const data = await notionReq('GET', `/v1/blocks/${encodeURIComponent(pageId)}/children?page_size=100${cursor ? '&start_cursor=' + encodeURIComponent(cursor) : ''}`);
    for (const b of data.results || []) {
      const rt = b[b.type] && b[b.type].rich_text;
      if (Array.isArray(rt)) { const t = fromRichText(rt).trim(); if (t) out += t + '\n'; }
    }
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return out.slice(0, limit);
}

async function apUsedSources() {
  const used = new Set();
  let cursor;
  for (let i = 0; i < 5; i++) {
    const data = await notionReq('POST', `/v1/data_sources/${NOTION_SCHEDULE_DS_ID}/query`, { filter: { property: 'Источник', rich_text: { is_not_empty: true } }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const r of (data.results || []).map(pageToRow)) if (r.src) used.add(r.src.split('|')[0]);
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return used;
}

async function apSourcePool() {
  const pool = [];
  try {
    const data = await notionReq('POST', `/v1/data_sources/${AP_CE_DS}/query`, { filter: { property: 'Status', select: { equals: 'Published' } }, sorts: [{ property: 'Publish Date', direction: 'descending' }], page_size: 100 });
    for (const p of data.results || []) {
      const pr = p.properties || {};
      const title = fromRichText(pr.Post && pr.Post.title).trim();
      if (!title) continue;
      const hint = [fromRichText(pr.Hook && pr.Hook.rich_text), fromRichText(pr['Core Point'] && pr['Core Point'].rich_text)].map(x => x.trim()).filter(Boolean).join('\n');
      pool.push({ key: 'ce:' + p.id, id: p.id, origin: 'LinkedIn', title, hint });
    }
  } catch (e) {
    console.error('autopilot: Content Engine недоступен:', scrubToken(e.message));
    if (!apCeWarned) {
      apCeWarned = true;
      for (const u of TELEGRAM_ALLOWED_USER_IDS) await botSend(Number(u), 'Автопилот не видит базу Content Engine в Notion. Открой ее для интеграции бота (меню базы «…» → Connections), иначе темы берутся только из постов Telegram.').catch(() => {});
    }
  }
  try {
    const data = await notionReq('POST', `/v1/data_sources/${NOTION_SCHEDULE_DS_ID}/query`, { filter: statusIs('published'), sorts: [{ property: 'Publish At', direction: 'descending' }], page_size: 100 });
    for (const r of (data.results || []).map(pageToRow)) {
      if (r.text && r.text.length > 200) pool.push({ key: 'tg:' + r.id, id: r.id, origin: 'Telegram', title: shortPreview(r.text, 80), text: r.text });
    }
  } catch (e) { console.error('autopilot: посты Telegram:', scrubToken(e.message)); }
  return pool;
}

function apSourcePrompt(kind) {
  const k = AP_KIND[kind];
  return `Ты редактор Threads Дмитрия Скакунова: 18 лет в гемблинге, руководил спортбуком. Тебе дают несколько его собственных опубликованных постов из LinkedIn и Telegram. Они написаны для людей из индустрии. Аудитория Threads широкая: любой взрослый, кому интересны игры, ставки, деньги, риск, лидерство и мотивация.

Задача: выбери ОДИН пост, в котором есть мысль для рубрики «${k.rubric}» (${THREADS_FORMATS[k.format] || ''}). Вытащи из него ОДНУ мысль и напиши пост для Threads, понятный человеку вне индустрии. Это не сокращение исходного поста, а одна его мысль, пересказанная для нового читателя с объяснением причины и арифметики там, где это нужно.

Перед выбором ответь себе: что читатель Threads унесет отсюда нового или полезного? Если ответ сводится к общей мудрости или пословице, бери другой пост или другую мысль. Не повторяй мысли, которые уже есть в recent_posts, даже другими словами и с другим заходом. Если ни один пост не дает новой мысли для этой рубрики, верни status skip.

Факты, цифры, случаи и личный опыт бери только из выбранного поста, ничего не добавляй и не усиливай. Пост всегда пишется от первого лица самого Дмитрия: «я», «мы с командой». Никогда не упоминай его в третьем лице, по имени или фамилии и не пересказывай его как героя. Личный опыт подавай от первого лица, только если он есть в посте. Обязательно приложи дословную цитату из поста (quote), на которой держится мысль.

КАК ПИСАТЬ. Живая связная речь, как будто ты рассказываешь это знакомому за столом. Полные предложения, которые вытекают одно из другого: ситуация, что произошло или как это устроено, почему это важно, и посыл в конце, ради которого читатель дочитал. Запрещен рубленый телеграфный стиль: никаких обрывков из одного-трех слов подряд («Взяли.», «7 из 8.», «Без опыта.»), никаких тезисов списком через точки. Короткая фраза допустима одна и только как акцент. Если это история, у нее есть начало, поворот и вывод, а не набор фактов.

Формат: одна мысль с ясным посылом. Threads формат короткий, пост должен помещаться целиком, обычно 250-450 символов, но не короче, чем нужно, чтобы мысль была рассказана полностью. Первая строка цепляет сама. Русский язык, буква е без точек, без эмодзи, хэштегов, ссылок и доменов (кроме telegram_url по правилу ниже), без тире (только запятые и двоеточия), без конструкций «не X, а Y», без «Вот как», «Вот что», «Результат?», «Честно говоря», «В заключение», без слова «книга» в значении линии букмекера, без американского гемблинга (кроме prediction markets). Базовые термины индустрии не расшифровывай. Мотивация допустима только на конкретике, без «верь в себя» и «ты сможешь».

ССЫЛКА НА TELEGRAM. Смотри поле direct_link_due во входных данных.
Если direct_link_due=false, в post_text нет ссылки, упоминания Telegram и призыва открыть профиль.
Если direct_link_due=true, можно добавить одну короткую фразу с конкретной причиной перейти в Telegram (что именно читатель там найдет по этой теме) и использовать только переданный telegram_url, отдельной последней строкой. Ссылка вместе с текстом должна помещаться в лимит ${THREADS_MAX} символов. Если конкретной причины нет, ссылку не добавляй.${apPromptExtra()}

Верни ТОЛЬКО JSON без Markdown: {"status":"ready|skip","source":номер поста,"thought":"мысль одной фразой","quote":"дословная цитата из поста","post_text":"текст поста","takeaway":"что читатель вынесет, одной фразой","reason":""}`;
}

// Рубленый стиль: несколько предложений по 1-3 слова подряд читаются как телеграмма, а не как речь
function apChoppy(t) {
  const sents = String(t || '').split(/[.!?…]+/).map(x => x.trim()).filter(Boolean);
  if (!sents.length) return false;
  const words = sents.map(x => x.split(/\s+/).length);
  const avg = words.reduce((a, b) => a + b, 0) / words.length;
  return words.filter(n => n <= 3).length >= 2 || (sents.length >= 3 && avg < 9);
}
async function apSmooth(text, srcText) {
  const system = `Ты редактор. Перепиши пост для Threads живой связной речью: полные предложения, которые вытекают одно из другого, с ясным посылом в конце. Убери рубленые обрывки из одного-трех слов. Сохрани все факты и смысл, ничего не добавляй сверх исходного поста автора. Русский, буква е без точек, без тире, без «не X, а Y», без эмодзи и хэштегов, до 450 символов. Верни только текст поста.`;
  const out = await claudeCall(system, `ИСХОДНЫЙ ПОСТ АВТОРА (только для сверки фактов):\n${String(srcText || '').slice(0, 3000)}\n\nЧЕРНОВИК:\n${text}`, 1500);
  return out ? noYo(out.trim()).replace(/\s*[—–]\s*/g, ', ') : text;
}

async function apRepair(text, issues, srcText, linkDue) {
  const limit = THREADS_MAX - 40;
  const len = threadsLength(text);
  const lenNote = len > limit ? ` Сейчас в черновике ${len} символов, нужно не больше ${limit}: сократи примерно на ${len - limit + 20} символов, убрав второстепенные слова и детали, но сохранив историю и посыл.` : '';
  const system = `Ты редактор постов для Threads. Исправь черновик, сохранив его мысль, факты и посыл. Ничего не добавляй сверх исходного поста автора. Пост от первого лица автора («я»), без его имени и третьего лица. Что нужно исправить: ${issues.join('; ')}.${lenNote}
Правила: не длиннее ${limit} символов вместе со ссылкой, если она есть; живая связная речь, полные предложения, без обрывков из одного-трех слов; без противопоставлений «не X, а Y», «это не X, это Y», «не потому что X, а потому что Y»: говори прямо, что есть, без того, чего нет; без тире (только запятые и двоеточия); буква е без точек; без эмодзи и хэштегов.${linkDue ? ` Если в черновике есть ссылка ${THREADS_INVITE_LINK}, оставь ее отдельной последней строкой, других ссылок нет.` : ' Без ссылок и без упоминания Telegram.'}
Верни только исправленный текст поста.`;
  const out = await claudeCall(system, `ИСХОДНЫЙ ПОСТ АВТОРА (для сверки фактов):\n${String(srcText || '').slice(0, 3000)}\n\nЧЕРНОВИК:\n${text}`, 1500);
  return out ? noYo(out.trim()).replace(/\s*[—–]\s*/g, ', ').replace(/\s+-\s+/g, ', ') : null;
}

async function apMakeFromSources(kind, recentRows, linkDue = false) {
  const pool = await apSourcePool();
  if (!pool.length) return null;
  const used = await apUsedSources().catch(() => new Set());
  const fresh = pool.filter(x => !used.has(x.key));
  if (!fresh.length) return null;
  for (let i = fresh.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [fresh[i], fresh[j]] = [fresh[j], fresh[i]]; }
  const cands = fresh.slice(0, 6);
  for (const c of cands) if (!c.text) c.text = ((c.hint ? c.hint + '\n' : '') + await apPageText(c.id).catch(() => '')).trim();
  const usable = cands.filter(c => c.text && c.text.length > 150);
  if (!usable.length) return null;
  const input = {
    candidates: usable.map((c, i) => ({ n: i + 1, origin: c.origin, title: c.title, text: c.text.slice(0, 3500) })),
    recent_posts: recentRows.slice(0, 30).map(r => shortPreview(r.text, 200)),
    direct_link_due: !!linkDue,
    ...(linkDue ? { telegram_url: THREADS_INVITE_LINK } : {})
  };
  const raw = await claudeCall(apSourcePrompt(kind), JSON.stringify(input), 3000);
  const res = parseEditorJson(raw);
  if (!res || res.status !== 'ready') { console.log('autopilot: из постов не получилось:', res && res.reason); return null; }
  const src = usable[Number(res.source) - 1];
  if (!src) return null;
  let text = noYo(String(res.post_text || '').trim()).replace(/\s*[—–]\s*/g, ', ').replace(/\s+-\s+/g, ', ');
  if (apChoppy(text)) text = await apSmooth(text, src.text);
  if (findNegContrast(text).length) text = noYo(await runNegContrastFix(text));
  const check = t => {
    const why = [];
    if (!t) why.push('пусто');
    if (apChoppy(t)) why.push('рубленый стиль');
    if (threadsLength(t) > THREADS_MAX - 5) why.push('длинно');
    const urls = t.match(/https?:\/\/\S+/g) || [];
    const body = t.split(THREADS_INVITE_LINK).join(' ');
    if (!linkDue && (urls.length || AP_TG_MENTION.test(t))) why.push('ссылка или упоминание Telegram не по очереди');
    if (linkDue && (urls.length > 1 || urls.some(u => u !== THREADS_INVITE_LINK))) why.push('чужая ссылка');
    for (const [re, w] of THREADS_BAD) if (w !== 'выдуманный личный опыт' && re.test(body)) why.push(w);
    if (findNegContrast(t).length) why.push('конструкция «не X, а Y» или «это не X, это Y»');
    if (/[—–]/.test(t) || /\s-\s/.test(t)) why.push('тире');
    if (US_GAMBLING.test(t) && !PRED_MARKET.test(t)) why.push('США');
    if (/Дмитри|Скакунов|Dmitry|Skakunov/i.test(t)) why.push('пост в третьем лице о Дмитрии: перепиши от первого лица «я»');
    return why;
  };
  const q = apNorm(res.quote);
  if (!q || !apNorm(src.text).includes(q)) { console.log('autopilot: черновик из поста отброшен: цитата не найдена в исходном посте'); return null; }
  const head = apNorm(text).slice(0, 60);
  if (recentRows.some(r => apNorm(r.text).slice(0, 60) === head)) { console.log('autopilot: черновик из поста отброшен: повтор'); return null; }
  // До двух попыток починить оформление: длину, противопоставления, рубленый стиль. Смысл и факты не трогаем
  let why = check(text);
  for (let attempt = 0; why.length && attempt < 2; attempt++) {
    const fixed = await apRepair(text, why, src.text, linkDue);
    console.log('autopilot: правка черновика', attempt + 1, why.join(', '), '→', fixed ? threadsLength(fixed) + ' симв.' : 'нет ответа');
    if (!fixed) break;
    text = fixed;
    why = check(text);
  }
  if (why.length) { console.log('autopilot: черновик из поста отброшен:', why.join(', ')); return null; }
  const urls = text.match(/https?:\/\/\S+/g) || [];
  return {
    text, type: AP_KIND[kind].type, goal: urls.length ? 'telegram_bridge' : 'reach',
    src: `${src.key}|${src.title}`.slice(0, 300),
    sourceTitle: `${src.origin}: ${src.title}`,
    takeaway: String(res.takeaway || '').trim().slice(0, 300)
  };
}

async function apCreateDraft(text, iso, owner, rubric, meta) {
  const props = {
    Name: { title: [{ type: 'text', text: { content: '🧵 ' + (shortPreview(text, 70) || 'Threads') } }] },
    Text: { rich_text: toRichText(text) },
    'Publish At': { date: { start: iso } },
    Status: { select: { name: AP_DRAFT } },
    Owner: { number: owner },
    'Рубрика': { select: { name: rubric } },
    ...(meta && meta.type ? { Type: { select: { name: meta.type } } } : {}),
    ...(meta && meta.goal ? { Goal: { select: { name: meta.goal } } } : {}),
    ...(meta && meta.company ? { Company: { rich_text: toRichText(meta.company) } } : {}),
    ...(meta && meta.angle ? { Angle: { rich_text: toRichText(meta.angle) } } : {}),
    ...(meta && meta.src && apPropsOk ? { 'Источник': { rich_text: toRichText(meta.src) } } : {})
  };
  return pageToRow(await notionReq('POST', '/v1/pages', { parent: { type: 'data_source_id', data_source_id: NOTION_SCHEDULE_DS_ID }, properties: props }));
}

const apShortId = id => String(id).replace(/-/g, '').slice(0, 8);

function apCard(row, rubric, note) {
  const text = `🧵 Черновик на ${formatWarsaw(row.publishAt)} · ${rubric}${note ? '\n' + note : ''}\n\n${row.text}\n\n#${apShortId(row.id)}`;
  return {
    text,
    reply_markup: { inline_keyboard: [[{ text: '✅ Одобрить', callback_data: `ap:ok:${row.id}` }, { text: '✏️ Править', callback_data: `ap:ed:${row.id}` }, { text: '🗑 Убрать', callback_data: `ap:no:${row.id}` }]] }
  };
}

async function apTick({ force = false } = {}) {
  if ((!AP_ON() && !force) || apRunning || !threadsConfigured() || !scheduleConfigured() || !TELEGRAM_BOT_TOKEN || !ANTHROPIC_API_KEY || !TELEGRAM_ALLOWED_USER_IDS.length) return null;
  apRunning = true; apState.lastRunAt = new Date().toISOString();
  let created = 0;
  try {
    await apEnsureProps();
    await apRefreshLearning();
    const now = Date.now();
    const owner = Number(TELEGRAM_ALLOWED_USER_IDS[0]);
    // Просроченные черновики: слот прошел, пока не одобрены. Снимаем, чтобы не висели
    const drafts = await schedQuery(statusIs(AP_DRAFT), 50);
    for (const d of drafts) {
      if (d.publishAt && Date.parse(d.publishAt) < now) {
        await notionReq('PATCH', `/v1/pages/${encodeURIComponent(d.id)}`, { properties: { Status: { select: { name: TS.cancelled } }, ...(apPropsOk ? { 'Модерация': { rich_text: toRichText('stale') } } : {}) } }).catch(() => {});
        for (const u of TELEGRAM_ALLOWED_USER_IDS) await botSend(Number(u), `Черновик на ${formatWarsaw(d.publishAt)} не дождался модерации, снял.\n\n${shortPreview(d.text, 200)}`).catch(() => {});
      }
    }
    // Что уже занимает дни: черновики, очередь, опубликованное за последние дни
    const since = new Date(now - 4 * 24 * 3600 * 1000).toISOString();
    const rows = await schedQuery({ and: [{ or: [statusIs(AP_DRAFT), statusIs(TS.scheduled), statusIs(TS.publishing), statusIs(TS.published)] }, { property: 'Publish At', date: { on_or_after: since } }] }, 100);
    const dayKey = ms => { const p = warsawParts(ms); return `${p.y}-${p.mo}-${p.d}`; };
    const busy = new Set(rows.filter(r => r.publishAt).map(r => dayKey(Date.parse(r.publishAt))));
    const recentRows = rows.slice().sort((a, b) => Date.parse(b.publishAt || 0) - Date.parse(a.publishAt || 0));
    const histRows = [...recentRows, ...(await tRecent(30).catch(() => []))];
    const base = warsawParts(now);
    const [sh, sm] = AP_SLOT.split(':').map(Number);
    for (let off = 0; off < AP_DAYS; off++) {
      const dt = new Date(Date.UTC(base.y, base.mo - 1, base.d + off));
      const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1, d = dt.getUTCDate();
      const ms = warsawToUtcMs(y, mo, d, sh, sm);
      if (ms === null || ms < now + 30 * 60 * 1000) continue;
      if (busy.has(dayKey(ms))) continue;
      let kind = AP_GRID[dt.getUTCDay()], note = '';
      let made = null;
      if (kind === 'news') {
        made = await apMakeNews(recentRows).catch(e => { console.error('autopilot: новости', scrubToken(e.message)); return null; });
        if (!made) { kind = 'mechanics'; note = 'Подходящей новости не нашлось, вместо нее механика.'; }
      }
      const lastSix = histRows.slice().sort((a, b) => Date.parse(b.publishAt || 0) - Date.parse(a.publishAt || 0)).slice(0, 6);
      const linkDue = kind === 'mechanics' && !lastSix.some(r => /t\.me\//i.test(r.text || ''));
      for (let tryN = 0; !made && tryN < 2; tryN++) made = await apMakeFromSources(kind, histRows, linkDue).catch(e => { console.error('autopilot: темы из постов', scrubToken(e.message)); return null; });
      if (!made) {
        const text = await apMakeBatch(AP_KIND[kind].format, histRows).catch(e => { console.error('autopilot: генерация', scrubToken(e.message)); return null; });
        if (text) { made = { text, type: AP_KIND[kind].type, goal: 'reach' }; note = (note ? note + '\n' : '') + 'В твоих постах свежей темы не нашлось, тема от бота.'; }
      }
      if (!made) { apState.lastNote = `на ${d}.${mo} черновик не получился`; continue; }
      const iso = new Date(ms).toISOString();
      const row = await apCreateDraft(made.text, iso, owner, AP_KIND[kind].rubric, made);
      recentRows.unshift(row); histRows.unshift(row); busy.add(dayKey(ms)); created++;
      const card = apCard(row, AP_KIND[kind].rubric, [note, made.sourceTitle ? 'Тема из: ' + made.sourceTitle : '', made.takeaway ? 'Читатель вынесет: ' + made.takeaway : ''].filter(Boolean).join('\n'));
      for (const u of TELEGRAM_ALLOWED_USER_IDS) await botSend(Number(u), card.text, { reply_markup: card.reply_markup, disable_web_page_preview: true }).catch(e => console.error('autopilot: карточка', scrubToken(e.message)));
    }
    apState.lastError = null;
    return { created };
  } catch (e) {
    apState.lastError = scrubToken(e.message);
    console.error('autopilot:', apState.lastError);
    return { created, error: apState.lastError };
  } finally { apRunning = false; }
}

async function apSetModeration(id, patch, mod) {
  const properties = {};
  if (patch.status) properties.Status = { select: { name: patch.status } };
  if (patch.text !== undefined) {
    properties.Text = { rich_text: toRichText(patch.text) };
    properties.Name = { title: [{ type: 'text', text: { content: '🧵 ' + (shortPreview(patch.text, 70) || 'Threads') } }] };
  }
  if (patch.draft !== undefined && apPropsOk) properties['Черновик'] = { rich_text: toRichText(patch.draft) };
  if (apPropsOk) properties['Модерация'] = { rich_text: toRichText(mod) };
  await notionReq('PATCH', `/v1/pages/${encodeURIComponent(id)}`, { properties });
}

// Кнопки карточки: ap:ok:<id> одобрить, ap:no:<id> убрать (покажет причины), ap:r<N>:<id> причина N
async function handleApCallback(cb) {
  const answer = (text, alert = false) => tgApi('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert }).catch(() => {});
  if (!TELEGRAM_ALLOWED_USER_IDS.includes(String(cb.from.id))) return answer('Нет доступа', true);
  const m = String(cb.data).match(/^ap:(ok|no|bk|ed|r(\d)):([0-9a-f-]{32,40})$/i);
  if (!m) return answer('Непонятная кнопка', true);
  const [, kind, ri, id] = m;
  const chat = cb.message.chat.id, mid = cb.message.message_id;
  const editText = (text, kb) => tgApi('editMessageText', { chat_id: chat, message_id: mid, text, ...(kb ? { reply_markup: kb } : { reply_markup: { inline_keyboard: [] } }), disable_web_page_preview: true });
  let row;
  try { row = await schedGet(id); } catch { return answer('Пост не найден', true); }
  if (row.status !== AP_DRAFT) return answer(`Уже обработан: ${String(row.status || '').replace(/^t_/, '')}`, true);
  await apEnsureProps();
  if (kind === 'ok') {
    if (row.publishAt && Date.parse(row.publishAt) < Date.now() + 60 * 1000) return answer('Слот уже прошел, черновик не опубликовать. Нажми /draft, бот подготовит новый.', true);
    await apSetModeration(id, { status: TS.scheduled }, 'ok');
    await answer('В очереди');
    return editText(`✅ В очереди на ${formatWarsaw(row.publishAt)}\n\n${row.text}`);
  }
  if (kind === 'ed') {
    await answer('Пришли новый текст');
    return botSend(chat, `Пришли свой текст поста ответом на это сообщение, он заменит черновик на ${formatWarsaw(row.publishAt)} и сразу встанет в очередь.\n#${apShortId(row.id)}`, { reply_markup: { force_reply: true, input_field_placeholder: 'Текст поста для Threads' } });
  }
  if (kind === 'no') {
    await answer('Выбери причину');
    const kb = AP_REASONS.map((r, i) => [{ text: r, callback_data: `ap:r${i}:${id}` }]);
    kb.push([{ text: '↩️ Назад', callback_data: `ap:bk:${id}` }]);
    return tgApi('editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: kb } });
  }
  if (kind === 'bk') {
    await answer('');
    return tgApi('editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: apCard(row, row.rubric || '').reply_markup });
  }
  const reason = AP_REASONS[Number(ri)];
  if (!reason) return answer('Причина не найдена', true);
  await apSetModeration(id, { status: TS.cancelled }, 'kill:' + reason);
  await answer('Убрано');
  await editText(`🗑 Убрано (${reason}): ${shortPreview(row.text, 160)}`);
  apLearn.at = 0;
  apTick({ force: AP_ON() }).catch(() => {});   // сразу готовим замену на освободившийся день
}

// Ответ (Reply) на карточку: текст владельца заменяет черновик и сразу идет в очередь
async function apHandleEditReply(msg) {
  const src = msg.reply_to_message && msg.reply_to_message.text;
  const m = src && src.match(/#([0-9a-f]{8})\s*$/);
  if (!m) return false;
  const drafts = await schedQuery(statusIs(AP_DRAFT), 50);
  const row = drafts.find(d => apShortId(d.id) === m[1]);
  if (!row) { await botSend(msg.chat.id, 'Этот черновик уже обработан или снят.'); return true; }
  const text = noYo(String(msg.text || '').trim());
  const len = threadsLength(text);
  if (!text) return true;
  if (len > THREADS_MAX) { await botSend(msg.chat.id, `Текст длиннее лимита Threads: ${len} из ${THREADS_MAX}. Сократи и ответь на карточку еще раз.`); return true; }
  if (row.publishAt && Date.parse(row.publishAt) < Date.now() + 60 * 1000) { await botSend(msg.chat.id, 'Слот уже прошел. Нажми /draft, бот подготовит новый.'); return true; }
  await apEnsureProps();
  await apSetModeration(row.id, { status: TS.scheduled, text, draft: row.text }, 'edit');
  apLearn.at = 0;
  await botSend(msg.chat.id, `✅ Твой текст в очереди на ${formatWarsaw(row.publishAt)}. Разницу с черновиком учту в следующих.`);
  return true;
}

async function apModerationReport(days = 7) {
  if (!scheduleConfigured()) return null;
  const rows = await apModRows(100, Date.now() - days * 24 * 3600 * 1000);
  if (!rows.length) return null;
  const ok = rows.filter(r => r.mod === 'ok').length, edit = rows.filter(r => r.mod === 'edit').length;
  const stale = rows.filter(r => r.mod === 'stale').length;
  const kills = rows.filter(r => /^kill:/.test(r.mod));
  const byReason = {};
  kills.forEach(r => { const k = r.mod.slice(5); byReason[k] = (byReason[k] || 0) + 1; });
  const lines = [`Модерация автопилота за ${days} дн.: одобрено без правок ${ok}, исправлено ${edit}, убрано ${kills.length}${stale ? `, не успел проверить ${stale}` : ''}.`];
  const top = Object.entries(byReason).sort((a, b) => b[1] - a[1]);
  if (top.length) lines.push('Чаще всего убираешь: ' + top.map(([k, n]) => `${k} (${n})`).join(', ') + '.');
  return lines.join('\n');
}
// ── конец автопилота ──

// ── Ответы на комментарии под постами канала ──
// Бот должен быть админом в группе обсуждений (или у него выключен режим приватности). Он видит новый комментарий,
// готовит 3 варианта ответа и присылает владельцу карточку. Публикует ответ сам владелец: кнопка копирует вариант
// в буфер (copy_text), вторая кнопка открывает именно этот комментарий в группе. Ответ уходит с его аккаунта, не от бота.
const commentCtx = new Map();      // номер карточки -> контекст для «Другие варианты»
let commentCtxSeq = 0;
const postRoots = new Map();       // id автопересылки поста в группе -> текст поста
const seenComments = new Set();
let commentTimes = [];             // времена обработанных комментариев: потолок против спама
let linkedChatCache = { id: null, at: 0 };
const COMMENT_HOURLY_LIMIT = 30;
const COMMENT_COPY_MAX = 250;      // copy_text в Telegram принимает до 256 символов

function trimMap(map, max) { while (map.size > max) map.delete(map.keys().next().value); }

async function linkedChatId() {
  if (linkedChatCache.id && Date.now() - linkedChatCache.at < 3600000) return linkedChatCache.id;
  const chat = await tgApi('getChat', { chat_id: TELEGRAM_CHANNEL_ID });
  linkedChatCache = { id: chat.linked_chat_id || null, at: Date.now() };
  return linkedChatCache.id;
}

// Ответы коротко и без запретных знаков: без тире, без «ё», не длиннее лимита кнопки копирования
function cleanReply(t) {
  let x = String(t || '').replace(/\s*[—–]\s*/g, ', ').replace(/\s+-\s+/g, ', ').replace(/ё/g, 'е').replace(/Ё/g, 'Е').replace(/\s+/g, ' ').trim();
  if (x.length > COMMENT_COPY_MAX) {
    const cut = x.slice(0, COMMENT_COPY_MAX);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    x = end > 60 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
  }
  return x;
}

// Стили и правила те же, что во вкладке «Коммент» (getCommentsSystemPrompt): промпт строится из него подменой нескольких фраз,
// чтобы правки правил в одном месте попадали и в ответы на комментарии. Если фраза в исходном промпте изменится, замена не сработает,
// и в логе появится предупреждение (тогда подправить список ниже)
const REPLY_SWAPS = [
  ['определи язык исходного поста и пиши ВСЕ 7 комментариев', 'определи язык комментария читателя и пиши ВСЕ 7 ответов'],
  ['Ты пишешь LinkedIn комментарии от имени Дмитрия Скакунова', 'Ты пишешь ответы на комментарии читателей под постом Telegram-канала от имени Дмитрия Скакунова'],
  ['Тебе дают пост другого человека. Напиши 7 разных вариантов комментария к этому посту, каждый с своим углом.',
   'Тебе дают пост канала Дмитрия и комментарий читателя под ним (иногда и комментарий, на который тот отвечает). Напиши 7 разных вариантов ОТВЕТА Дмитрия на этот комментарий, каждый с своим углом. Отвечай комментатору по сути, не пересказывай пост. Ответ короче 230 символов.'],
  ['аккуратно споришь с автором, указываешь на слабое место в логике', 'аккуратно споришь с комментатором, указываешь на слабое место в его логике'],
  ['короткий вопрос автору который заставляет копнуть глубже', 'короткий встречный вопрос комментатору который заставляет копнуть глубже'],
  ['ТИПЫ КОММЕНТАРИЕВ', 'ТИПЫ ОТВЕТОВ'],
  ['ФОРМАТ ОТВЕТА СТРОГО ТАКОЙ:', 'ФОРМАТ ОТВЕТА СТРОГО ТАКОЙ (текст ответа Дмитрия на комментарий читателя):'],
  ['Если пост слабый или банальный, не хвали его. Можно осторожно указать на нелогичность', 'Если комментарий слабый или банальный, не хвали его. Можно осторожно указать на нелогичность. Не благодари формально'],
];
function getReplySystemPrompt(platform) {
  let p = getCommentsSystemPrompt();
  for (const [from, to] of REPLY_SWAPS) {
    if (!p.includes(from)) console.warn('comments: фраза для замены не найдена в промпте комментариев:', from.slice(0, 50));
    p = p.split(from).join(to);
  }
  if (platform === 'threads') p = p.split('под постом Telegram-канала').join('под постом в Threads').split('Ответ короче 230 символов').join('Ответ короче 230 символов, это комментарий в Threads');
  return p;
}

const REPLY_LABEL_SHORT = { 'Спокойный': 'Спокойный', 'Практический': 'Практичный', 'С иронией': 'С иронией', 'С несогласием': 'Несогласие', 'С вопросом': 'С вопросом', 'Короткий': 'Короткий', 'Лучший': 'Лучший' };

async function generateReplyVariants(c, avoid = []) {
  const lang = detectLanguage(c.commentText);
  const langInstruction = lang === 'uk' ? 'Всі 7 відповідей пиши ВИКЛЮЧНО українською мовою.'
    : lang === 'en' ? 'Write ALL 7 replies EXCLUSIVELY in English.'
    : 'Все 7 ответов пиши ИСКЛЮЧИТЕЛЬНО на русском языке.';
  const parts = [langInstruction];
  if (c.postText) parts.push('ПОСТ КАНАЛА (автор Дмитрий):\n' + c.postText.slice(0, 3000));
  if (c.parentText) parts.push('КОММЕНТАРИЙ, НА КОТОРЫЙ ОТВЕЧАЕТ ЧИТАТЕЛЬ НИЖЕ:\n' + c.parentText.slice(0, 800));
  parts.push(`КОММЕНТАРИЙ${c.author ? ' ОТ ' + c.author : ''}, НА КОТОРЫЙ НУЖЕН ОТВЕТ ДМИТРИЯ:\n` + c.commentText.slice(0, 1200));
  if (avoid.length) parts.push('ЭТИ ОТВЕТЫ УЖЕ БЫЛИ, ДАЙ ДРУГИЕ ФОРМУЛИРОВКИ И УГЛЫ:\n' + avoid.map((v, i) => `${i + 1}. ${v}`).join('\n'));
  const raw = await claudeCall(getReplySystemPrompt(c.platform), parts.join('\n\n'), 1600);
  if (!raw) throw new Error('Модель не ответила');
  let items = parseComments(raw)
    .map(x => ({ label: REPLY_LABEL_SHORT[x.label] || x.label || 'Вариант', text: cleanReply(x.text) }))
    .filter(x => x.text);
  if (!items.length) throw new Error('Пустой ответ модели');
  // «Лучший» первым: его чаще всего и берут
  items.sort((p, q) => (q.label === 'Лучший') - (p.label === 'Лучший'));
  return items.slice(0, 7);
}

function commentCard(c, variants) {
  const lines = [`💬 Комментарий${c.author ? ' от ' + c.author : ''}:`, `«${c.commentText.slice(0, 500)}»`];
  if (c.postText) lines.push('', 'Под постом: «' + c.postText.replace(/\*\*/g, '').replace(/\s+/g, ' ').slice(0, 90) + '…»');
  lines.push('', 'Варианты ответа:');
  variants.forEach(v => lines.push(`[${v.label}] ${v.text}`, ''));
  lines.push('Нажми 📋 нужного стиля, затем «Открыть комментарий», «Ответить» и вставь.');
  const buttons = variants.map(v => ({ text: `📋 ${v.label}`, copy_text: { text: v.text } }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  if (c.link) rows.push([{ text: '↗️ Открыть комментарий', url: c.link }]);
  rows.push([{ text: '🔄 Другие варианты', callback_data: 'cx:' + c.id }]);
  return { text: lines.join('\n').slice(0, 4000), reply_markup: { inline_keyboard: rows } };
}

async function handleGroupMessage(msg) {
  if (process.env.TELEGRAM_COMMENTS === 'off' || !TELEGRAM_CHANNEL_ID || !ANTHROPIC_API_KEY) return;
  let linked;
  try { linked = await linkedChatId(); } catch (e) { console.error('comments: не получил группу обсуждений:', scrubToken(e.message)); return; }
  if (!linked || msg.chat.id !== linked) return;

  // Автопересылка поста канала в группу: запоминаем текст, чтобы отвечать на комментарии в ветке (на них Telegram текст поста не присылает)
  if (msg.is_automatic_forward) {
    postRoots.set(msg.message_id, msg.text || msg.caption || '');
    trimMap(postRoots, 100);
    return;
  }
  if ((msg.from && msg.from.is_bot) || msg.sender_chat) return;                                  // боты, сам канал, анонимные админы
  if (msg.from && TELEGRAM_ALLOWED_USER_IDS.includes(String(msg.from.id))) return;               // свои сообщения
  const text = String(msg.text || msg.caption || '').trim();
  if (text.length < 4 || !/[A-Za-zА-Яа-яЁёІіЇїЄєҐґ]{3}/.test(text)) return;                       // пусто, эмодзи, цифры
  if (/https?:\/\/|t\.me\/|www\.|@\w{4,}/i.test(text)) return;                                    // реклама и ссылки: не тратим на них ответ
  const key = msg.chat.id + ':' + msg.message_id;
  if (seenComments.has(key)) return;
  seenComments.add(key); trimMap(seenComments, 500);
  const now = Date.now();
  commentTimes = commentTimes.filter(t => now - t < 3600000);
  if (commentTimes.length >= COMMENT_HOURLY_LIMIT) { console.log('comments: лимит в час, пропускаю'); return; }
  commentTimes.push(now);

  const reply = msg.reply_to_message;
  const thread = msg.message_thread_id || (reply && reply.message_id) || msg.message_id;
  const rootText = postRoots.get(thread) || (reply && reply.is_automatic_forward ? (reply.text || reply.caption || '') : '');
  const parentText = reply && !reply.is_automatic_forward ? (reply.text || reply.caption || '') : '';
  const link = msg.chat.username
    ? `https://t.me/${msg.chat.username}/${msg.message_id}?thread=${thread}`
    : `https://t.me/c/${String(msg.chat.id).replace(/^-100/, '')}/${msg.message_id}?thread=${thread}`;
  const author = msg.from ? [msg.from.first_name, msg.from.username ? '@' + msg.from.username : ''].filter(Boolean).join(' ') : '';
  const c = { id: ++commentCtxSeq, postText: rootText, parentText, commentText: text, author, link, variants: [] };

  let variants;
  try { variants = await generateReplyVariants(c); }
  catch (e) { console.error('comments: не удалось сгенерировать ответы:', scrubToken(e.message)); return; }
  c.variants = variants;
  commentCtx.set(c.id, c); trimMap(commentCtx, 200);
  const card = commentCard(c, variants);
  for (const uid of TELEGRAM_ALLOWED_USER_IDS) {
    await botSend(Number(uid), card.text, { reply_markup: card.reply_markup, disable_web_page_preview: true })
      .catch(e => console.error('comments: карточка не доставлена:', scrubToken(e.message)));
  }
  console.log('comments: карточка отправлена, комментарий', key);
}

// «Другие варианты» на карточке комментария
async function handleCommentCallback(cb) {
  const answer = (text, alert = false) => tgApi('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert }).catch(() => {});
  if (!TELEGRAM_ALLOWED_USER_IDS.includes(String(cb.from.id))) return answer('Нет доступа', true);
  const c = commentCtx.get(Number(String(cb.data).split(':')[1]));
  if (!c) return answer('Карточка устарела (бот перезапускался). Дождись следующего комментария.', true);
  await answer('Пишу другие варианты…');
  try {
    const variants = await generateReplyVariants(c, (c.variants || []).map(v => v.text));
    c.variants = variants;
    const card = commentCard(c, variants);
    await tgApi('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: card.text, reply_markup: card.reply_markup, disable_web_page_preview: true });
  } catch (e) {
    console.error('comments: другие варианты не вышли:', scrubToken(e.message));
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Не получилось: ' + scrubToken(e.message).slice(0, 150), show_alert: true }).catch(() => {});
  }
}
// ── конец блока ответов на комментарии ──

// ── Ответы на комментарии в Threads ──
// Раз в несколько минут бот смотрит новые ответы под последними постами аккаунта, присылает владельцу карточку
// с вариантами ответа в 7 стилях. Каждый вариант можно скопировать (и править сам) или отправить в Threads одной кнопкой:
// ответ уходит с аккаунта владельца через API (reply_to_id).
// Нужны права threads_read_replies и threads_manage_replies у токена THREADS_ACCESS_TOKEN.
// Бот проверяет время раз в несколько минут, но ответы собирает раз в час: в начале каждого часа берет все ответы за предыдущий полный час
// (в 13:00 приходят ответы с 12:00 до 13:00). Памяти о показанных ответах не нужно: окна не пересекаются.
const THREADS_REPLIES_EVERY_MS = 5 * 60 * 1000;
const THREADS_POSTS_LOOKBACK = 8;                      // сколько последних постов проверять
const threadsReplyState = { started: false, doneHour: 0, lastTickAt: null, lastWindow: null, lastError: null, lastCards: 0 };
let threadsMe = null;
let threadsPermWarned = false;
let threadsRepliesRunning = false;

async function threadsMyUsername() {
  if (threadsMe) return threadsMe;
  const me = await threadsReq('GET', '/me', { fields: 'id,username' });
  threadsMe = me.username || '';
  return threadsMe;
}

// Все ответы под постом (с вложенными). Если API не знает часть полей, повторяем с минимальным набором
async function threadsConversation(postId) {
  const fields = 'id,text,username,permalink,timestamp,replied_to,is_reply_owned_by_me';
  let data;
  try { data = await threadsReq('GET', `/${postId}/conversation`, { fields, limit: '50' }); }
  catch (e) {
    if (/permission|scope|OAuth|access/i.test(e.message)) throw e;
    data = await threadsReq('GET', `/${postId}/conversation`, { fields: 'id,text,username,permalink,timestamp', limit: '50' });
  }
  return data.data || [];
}

function threadsReplyCard(c, variants, sentIdx = -1) {
  const lines = [`🧵 Ответ в Threads${c.author ? ' от @' + c.author : ''}:`, `«${c.commentText.slice(0, 500)}»`];
  if (c.postText) lines.push('', 'Под постом: «' + c.postText.replace(/\s+/g, ' ').slice(0, 90) + '…»');
  lines.push('', 'Варианты ответа:');
  variants.forEach(v => lines.push(`[${v.label}] ${v.text}`, ''));
  if (sentIdx >= 0) lines.push(`✅ Отправлено в Threads: ${variants[sentIdx] ? variants[sentIdx].text : ''}`);
  else lines.push('📋 копирует текст (можно поправить и отправить самому), 📤 отправляет в Threads сразу.');
  const rows = [];
  if (sentIdx < 0) {
    variants.forEach((v, i) => rows.push([
      { text: `📋 ${v.label}`, copy_text: { text: v.text } },
      { text: `📤 ${v.label}`, callback_data: `tp:${c.id}:${i}` }
    ]));
  }
  const last = [];
  if (c.link) last.push({ text: '↗️ Открыть в Threads', url: c.link });
  if (sentIdx < 0) last.push({ text: '🔄 Другие варианты', callback_data: `tm:${c.id}` });
  if (last.length) rows.push(last);
  return { text: lines.join('\n').slice(0, 4000), reply_markup: { inline_keyboard: rows } };
}

async function threadsRepliesTick(opts = {}) {
  if (threadsRepliesRunning || !threadsConfigured() || !ANTHROPIC_API_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_ALLOWED_USER_IDS.length) return;
  if (process.env.THREADS_REPLIES === 'off') return;
  const hourStart = Math.floor(Date.now() / 3600000) * 3600000;
  if (!opts.manual && threadsReplyState.doneHour >= hourStart) return;       // этот час уже обработан
  const winFrom = opts.manual ? Date.now() - (Number(opts.hours) || 24) * 3600000 : hourStart - 3600000;
  const winTo = opts.manual ? Date.now() : hourStart;
  const result = { found: 0, error: '' };
  threadsRepliesRunning = true;
  threadsReplyState.lastTickAt = new Date().toISOString();
  try {
    const uid = await threadsUserId();
    const mine = await threadsMyUsername();
    const posts = (await threadsReq('GET', `/${uid}/threads`, { fields: 'id,text,timestamp', limit: String(THREADS_POSTS_LOOKBACK) })).data || [];
    const fresh = [];
    for (const post of posts) {
      let items;
      try { items = await threadsConversation(post.id); }
      catch (e) {
        if (/permission|scope|OAuth|access/i.test(e.message) && !threadsPermWarned) {
          threadsPermWarned = true;
          for (const u of TELEGRAM_ALLOWED_USER_IDS) await botSend(Number(u), '⚠️ Threads: нет доступа к ответам под постами. Добавь в приложении Meta права threads_read_replies и threads_manage_replies, сгенерируй токен заново и обнови THREADS_ACCESS_TOKEN в Railway.').catch(() => {});
        }
        throw e;
      }
      const byId = new Map(items.map(x => [x.id, x]));
      for (const it of items) {
        const text = String(it.text || '').trim();
        if (!text || it.is_reply_owned_by_me === true || (it.username && it.username === mine)) continue;
        const ts = Date.parse(it.timestamp || 0);
        if (!(ts >= winFrom && ts < winTo)) continue;       // только окно предыдущего часа
        const parent = it.replied_to && it.replied_to.id && byId.get(it.replied_to.id);
        fresh.push({ post, it, text, parentText: parent ? String(parent.text || '') : '' });
      }
    }
    if (!opts.manual) threadsReplyState.doneHour = hourStart;
    threadsReplyState.lastWindow = new Date(winFrom).toISOString() + ' – ' + new Date(winTo).toISOString();
    result.found = fresh.length;
    threadsReplyState.lastError = null;
    let autoSent = 0;
    for (const f of fresh.slice(0, 20)) {
      const c = { id: ++commentCtxSeq, platform: 'threads', replyId: f.it.id, postText: f.post.text || '', parentText: f.parentText, commentText: f.text, author: f.it.username || '', link: f.it.permalink || '', variants: [], sentIdx: -1 };
      let variants;
      try { variants = await generateReplyVariants(c); }
      catch (e) { console.error('threads replies: не удалось сгенерировать ответы:', scrubToken(e.message)); continue; }
      c.variants = variants;
      commentCtx.set(c.id, c); trimMap(commentCtx, 200);
      if (THREADS_AUTOREPLY() && autoSent < THREADS_AUTOREPLY_MAX()) {
        try {
          if (await threadsAutoDecision(c)) {
            const idx = Math.max(0, variants.findIndex(v => v.label === THREADS_AUTOREPLY_STYLE()));
            await publishToThreads(variants[idx].text, c.replyId);
            c.sentIdx = idx; autoSent++; statsLogReply('auto');
            for (const u of TELEGRAM_ALLOWED_USER_IDS) {
              await botSend(Number(u), `🤖 Ответил автоматически${c.author ? ' @' + c.author : ''}\n\n«${c.commentText.slice(0, 300)}»\n\nМой ответ: ${variants[idx].text}`, { disable_web_page_preview: true }).catch(() => {});
            }
            threadsReplyState.lastCards++;
            continue;
          }
        } catch (e) { console.error('threads autoreply:', scrubToken(e.message)); }   // не вышло, отдаем на ручное решение
      }
      const card = threadsReplyCard(c, variants);
      for (const u of TELEGRAM_ALLOWED_USER_IDS) {
        await botSend(Number(u), card.text, { reply_markup: card.reply_markup, disable_web_page_preview: true })
          .catch(e => console.error('threads replies: карточка не доставлена:', scrubToken(e.message)));
      }
      threadsReplyState.lastCards++;
    }
  } catch (e) {
    threadsReplyState.lastError = scrubToken(e.message);
    result.error = threadsReplyState.lastError;
    console.error('threads replies:', threadsReplyState.lastError);
  } finally {
    threadsRepliesRunning = false;
  }
  return result;
}

// ── Автоответы на комментарии в Threads (режим THREADS_AUTOREPLY=on) ──
// Бот сам отвечает на безопасные комментарии вариантом выбранного стиля и присылает короткое уведомление.
// Сомнительные комментарии (оскорбления, спам, ссылки, политика, провокации, просьбы о советах по ставкам) идут обычной карточкой на ручное решение.
const THREADS_AUTOREPLY = () => process.env.THREADS_AUTOREPLY === 'on';
const THREADS_AUTOREPLY_STYLE = () => process.env.THREADS_AUTOREPLY_STYLE || 'Лучший';
const THREADS_AUTOREPLY_MAX = () => Number(process.env.THREADS_AUTOREPLY_MAX) || 8;   // в час
async function threadsAutoDecision(c) {
  const sys = 'Ты фильтр комментариев под постами iGaming-эксперта в Threads. Реши, можно ли ответить на комментарий автоматически без проверки человеком. Отвечать можно: по делу, вопрос, согласие, спокойное несогласие, шутка, благодарность. Нельзя (auto=false): оскорбления, агрессия, спам и реклама, ссылки, политика, провокация или троллинг, просьбы дать ставку, прогноз или совет, где играть, вопросы про личное, жалобы на конкретного оператора, всё, где ответ может навредить репутации. Верни ТОЛЬКО JSON: {"auto":true|false,"reason":"коротко"}';
  const raw = await claudeCall(sys, `ПОСТ:\n${String(c.postText || '').slice(0, 800)}\n\nКОММЕНТАРИЙ:\n${String(c.commentText).slice(0, 800)}`, 300);
  const j = parseEditorJson(raw);
  return !!(j && j.auto === true);
}
// ── конец автоответов ──

// Кнопки карточки: tp:<id>:<номер варианта> отправить ответ, tm:<id> другие варианты
async function handleThreadsReplyCallback(cb) {
  const answer = (text, alert = false) => tgApi('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert }).catch(() => {});
  if (!TELEGRAM_ALLOWED_USER_IDS.includes(String(cb.from.id))) return answer('Нет доступа', true);
  const [kind, idStr, idxStr] = String(cb.data).split(':');
  const c = commentCtx.get(Number(idStr));
  if (!c || c.platform !== 'threads') return answer('Карточка устарела (бот перезапускался). Дождись следующего ответа.', true);
  const edit = card => tgApi('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: card.text, reply_markup: card.reply_markup, disable_web_page_preview: true });

  if (kind === 'tm') {
    await answer('Пишу другие варианты…');
    try {
      const variants = await generateReplyVariants(c, (c.variants || []).map(v => v.text));
      c.variants = variants;
      await edit(threadsReplyCard(c, variants));
    } catch (e) {
      await answer('Не получилось: ' + scrubToken(e.message).slice(0, 150), true);
    }
    return;
  }

  // Отправка ответа
  const idx = Number(idxStr);
  const v = c.variants && c.variants[idx];
  if (!v) return answer('Вариант не найден, обнови карточку', true);
  if (c.sentIdx >= 0) return answer('Ответ уже отправлен', true);
  if (c.sending) return answer('Уже отправляю…');
  c.sending = true;
  await answer('Отправляю в Threads…');
  try {
    await publishToThreads(v.text, c.replyId);
    c.sentIdx = idx; statsLogReply('manual');
    await edit(threadsReplyCard(c, c.variants, idx)).catch(() => {});
  } catch (e) {
    await answer('Не отправилось: ' + scrubToken(e.message).slice(0, 180), true);
  } finally {
    c.sending = false;
  }
}
// ── конец блока ответов в Threads ──

// ── Еженедельный отчет: Threads, канал, переходы из Threads в канал ──
// Раз в сутки (после STATS_HOUR_WARSAW, по умолчанию 9:00 Варшавы) бот обновляет цифры и пишет снимок, отчет за 7 дней присылает по понедельникам.
// Хранение в Notion: строки со статусом t_stats (снимок чисел на утро) и t_join (каждый вход в канал по пригласительной ссылке).
// Нужно: у токена Threads право threads_manage_insights; бот админ канала (для числа подписчиков и событий входа).
const STATS_HOUR = Number(process.env.STATS_HOUR_WARSAW) || 9;
const STATS_REPORT_DAYS = 7;
const STATS_WEEKDAY = process.env.STATS_WEEKDAY !== undefined && process.env.STATS_WEEKDAY !== '' ? Number(process.env.STATS_WEEKDAY) : 1;   // 0 воскресенье, 1 понедельник
const THREADS_INVITE_LINK = process.env.THREADS_INVITE_LINK || 'https://t.me/+WLghGJmGwXI3NmYy';
const statsState = { running: false, lastRunAt: null, lastError: null, joinsSeen: 0 };

const tgLinkCode = l => String(l || '').replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '').replace(/\.+$/, '').trim();
function isThreadsInvite(il) {
  if (!il) return false;
  if (/threads/i.test(String(il.name || ''))) return true;
  const a = tgLinkCode(il.invite_link), b = tgLinkCode(THREADS_INVITE_LINK);
  return !!a && !!b && b.startsWith(a);      // Telegram показывает чужие ссылки обрезанными, сравниваем по началу
}

async function statsCreateRow(name, status, text, iso) {
  return notionReq('POST', '/v1/pages', {
    parent: { type: 'data_source_id', data_source_id: NOTION_SCHEDULE_DS_ID },
    properties: {
      Name: { title: [{ type: 'text', text: { content: name } }] },
      Text: { rich_text: toRichText(text) },
      'Publish At': { date: { start: iso } },
      Status: { select: { name: status } }
    }
  });
}
// Каждый отправленный из бота ответ в Threads фиксируем строкой в Notion (kind: auto или manual), для отчета
function statsLogReply(kind) {
  if (!scheduleConfigured()) return;
  statsCreateRow('↩️ ответ в Threads', 't_reply', kind, new Date().toISOString()).catch(e => console.error('stats reply log:', scrubToken(e.message)));
}
async function statsQuery(status, extraFilters = [], direction = 'descending', size = 100) {
  try {
    const data = await notionReq('POST', `/v1/data_sources/${NOTION_SCHEDULE_DS_ID}/query`, {
      filter: { and: [{ property: 'Status', select: { equals: status } }, ...extraFilters] },
      sorts: [{ property: 'Publish At', direction }], page_size: size
    });
    return (data.results || []).map(pageToRow);
  } catch (e) {
    if (/select option|not found|validation/i.test(e.message)) return [];   // такого статуса в базе еще нет
    throw e;
  }
}

// Вход в канал: пишем строку в Notion. Нужен chat_member в allowed_updates вебхука и права админа у бота
async function handleChatMember(cm) {
  if (!cm || !cm.chat || cm.chat.type !== 'channel') return;
  const was = cm.old_chat_member && cm.old_chat_member.status, now = cm.new_chat_member && cm.new_chat_member.status;
  const wasIn = ['member', 'administrator', 'creator'].includes(was), isIn = ['member', 'administrator', 'creator'].includes(now);
  if (wasIn || !isIn) return;
  const via = cm.invite_link ? (isThreadsInvite(cm.invite_link) ? 'threads' : 'other-link') : 'no-link';
  statsState.joinsSeen++;
  await statsCreateRow('➕ вход в канал', 't_join', via, new Date().toISOString());
}

function statsParseInsight(data) {
  const out = {};
  for (const m of (data && data.data) || []) {
    out[m.name] = m.total_value ? (Number(m.total_value.value) || 0) : ((m.values || []).reduce((a, v) => a + (Number(v.value) || 0), 0));
  }
  return out;
}
async function statsThreads(fromMs, toMs) {
  const uid = await threadsUserId();
  const res = { ok: false, needPerm: false };
  try {
    const params = { metric: 'views,likes,replies,reposts,quotes', since: String(Math.floor(fromMs / 1000)), until: String(Math.floor(toMs / 1000)), metric_type: 'total_value' };
    let data;
    try { data = await threadsReq('GET', `/${uid}/threads_insights`, params); }
    catch (e) { if (/metric_type/i.test(e.message)) { delete params.metric_type; data = await threadsReq('GET', `/${uid}/threads_insights`, params); } else throw e; }
    res.user = statsParseInsight(data);
    try { res.followers = statsParseInsight(await threadsReq('GET', `/${uid}/threads_insights`, { metric: 'followers_count' })).followers_count; } catch { res.followers = null; }
    const posts = ((await threadsReq('GET', `/${uid}/threads`, { fields: 'id,text,timestamp', limit: '30' })).data || [])
      .filter(x => { const t = Date.parse(x.timestamp || 0); return t >= fromMs && t < toMs; });
    res.postsCount = posts.length;
    let best = null;
    for (const post of posts.slice(0, 10)) {
      try {
        const ins = statsParseInsight(await threadsReq('GET', `/${post.id}/insights`, { metric: 'views,likes,replies' }));
        if (!best || (ins.views || 0) > (best.ins.views || 0)) best = { post, ins };
      } catch { /* у отдельного поста метрик может не быть */ }
    }
    res.best = best;
    res.ok = true;
  } catch (e) {
    res.error = scrubToken(e.message);
    res.needPerm = /permission|scope|OAuth|manage_insights|\(#10\)|\(#200\)/i.test(e.message);
  }
  return res;
}

// Отчет за последние days полных дней (по умолчанию неделя). Снимки t_stats бот пишет каждый день, отправляет отчет раз в неделю.
async function buildStatsReport(days = STATS_REPORT_DAYS) {
  const nowMs = Date.now(), np = warsawParts(nowMs);
  const todayStart = warsawToUtcMs(np.y, np.mo, np.d, 0, 0);
  const sd = new Date(Date.UTC(np.y, np.mo - 1, np.d - days));       // нормализуем переход через начало месяца
  const yStart = warsawToUtcMs(sd.getUTCFullYear(), sd.getUTCMonth() + 1, sd.getUTCDate(), 0, 0);   // начало периода
  const dd = ms => { const p = warsawParts(ms + 3 * 3600 * 1000); return `${String(p.d).padStart(2, '0')}.${String(p.mo).padStart(2, '0')}`; };
  const lines = [days === 1 ? `📊 Отчет за ${dd(yStart)}` : `📊 Отчет за неделю ${dd(yStart)}–${dd(todayStart - 86400000)}`, ''];

  // Снимок на начало периода для дельты (утренний снимок первого дня периода или раньше)
  const prevRows = await statsQuery('t_stats', [{ property: 'Publish At', date: { before: new Date(yStart + 86400000).toISOString() } }], 'descending', 1);
  let prev = null; try { prev = prevRows[0] ? JSON.parse(prevRows[0].text) : null; } catch { prev = null; }
  const delta = (cur, old) => (cur == null || old == null) ? '' : ` (${cur - old >= 0 ? '+' : ''}${cur - old})`;

  const th = threadsConfigured() ? await statsThreads(yStart, todayStart) : { ok: false, error: 'нет THREADS_ACCESS_TOKEN' };
  const snapshot = { date: new Date(todayStart).toISOString().slice(0, 10) };
  if (th.ok) {
    const u = th.user || {};
    lines.push('Threads', `Просмотры ${u.views || 0}, лайки ${u.likes || 0}, ответы ${u.replies || 0}, репосты ${u.reposts || 0}, цитаты ${u.quotes || 0}`);
    lines.push(`Вышло постов: ${th.postsCount}`);
    {
      const rr = await statsQuery('t_reply', [
        { property: 'Publish At', date: { on_or_after: new Date(yStart).toISOString() } },
        { property: 'Publish At', date: { before: new Date(todayStart).toISOString() } }
      ]);
      const auto = rr.filter(x => x.text === 'auto').length;
      lines.push(`Ответов от бота в Threads: сам ${auto}, ты кнопкой ${rr.length - auto}`);
    }
    if (th.followers != null) { lines.push(`Подписчиков в Threads: ${th.followers}${delta(th.followers, prev && prev.thFollowers)}`); snapshot.thFollowers = th.followers; }
    if (th.best) lines.push(`Лучший пост ${days === 1 ? 'дня' : 'недели'} (его цифры за все время): «${String(th.best.post.text || '').replace(/\s+/g, ' ').slice(0, 80)}», просмотров ${th.best.ins.views || 0}, лайков ${th.best.ins.likes || 0}, ответов ${th.best.ins.replies || 0}`);
  } else if (th.needPerm) {
    lines.push('Threads', 'Нет доступа к статистике. В приложении Meta добавь право threads_manage_insights, сгенерируй токен заново и обнови THREADS_ACCESS_TOKEN в Railway.');
  } else {
    lines.push('Threads', 'Статистика не получена: ' + String(th.error || 'неизвестная ошибка').slice(0, 200));
  }
  lines.push('');

  // Канал
  let members = null;
  try { members = Number(await tgApi('getChatMemberCount', { chat_id: TELEGRAM_CHANNEL_ID })); } catch (e) { lines.push('Канал: не удалось получить число подписчиков (' + scrubToken(e.message).slice(0, 120) + ')'); }
  if (members != null) { lines.push(`Подписчиков в канале: ${members}${delta(members, prev && prev.tgMembers)}`); snapshot.tgMembers = members; }
  const joins = await statsQuery('t_join', [
    { property: 'Publish At', date: { on_or_after: new Date(yStart).toISOString() } },
    { property: 'Publish At', date: { before: new Date(todayStart).toISOString() } }
  ]);
  const fromThreads = joins.filter(j => j.text === 'threads').length;
  lines.push(`Пришли по ссылке из Threads: ${fromThreads}. Через другие ссылки или поиск: ${joins.length - fromThreads}.`);
  const joinsToday = await statsQuery('t_join', [{ property: 'Publish At', date: { on_or_after: new Date(todayStart).toISOString() } }]);
  const thToday = joinsToday.filter(j => j.text === 'threads').length;
  lines.push(`Сегодня с начала дня: по ссылке из Threads ${thToday}, остальные ${joinsToday.length - thToday}.`);
  lines.push('Входы считаются с момента, когда бот начал получать эти события.');
  return { text: lines.join('\n'), snapshot, todayStart };
}

async function statsRun({ manual = false } = {}) {
  if (statsState.running) return null;
  statsState.running = true; statsState.lastRunAt = new Date().toISOString();
  try {
    await refreshPostMetrics().catch(e => console.error('rubrics refresh:', scrubToken(e.message)));
    const rep = await buildStatsReport();
    // Каждый день бот только обновляет цифры и пишет снимок; сообщения уходят раз в неделю (STATS_WEEKDAY, по умолчанию понедельник) или по запросу
    const reportDay = (wp => new Date(Date.UTC(wp.y, wp.mo - 1, wp.d)).getUTCDay())(warsawParts(Date.now())) === STATS_WEEKDAY;
    if (manual || reportDay) for (const u of TELEGRAM_ALLOWED_USER_IDS) await botSend(Number(u), rep.text, { disable_web_page_preview: true });
    if (!manual && reportDay) {
      const rr = await buildRubricReport(7).catch(e => 'Сводка по рубрикам не собралась: ' + scrubToken(e.message).slice(0, 200));
      for (const u of TELEGRAM_ALLOWED_USER_IDS) await botSend(Number(u), rr, { disable_web_page_preview: true });
      const mr = await apModerationReport(7).catch(() => null);
      if (mr) for (const u of TELEGRAM_ALLOWED_USER_IDS) await botSend(Number(u), mr);
    }
    if (!manual) await statsCreateRow('📊 ' + rep.snapshot.date, 't_stats', JSON.stringify(rep.snapshot), new Date().toISOString());
    statsState.lastError = null;
    return rep;
  } catch (e) {
    statsState.lastError = scrubToken(e.message);
    console.error('stats:', statsState.lastError);
    if (manual) throw e;
    return null;
  } finally { statsState.running = false; }
}

async function statsTick() {
  if (process.env.STATS_REPORT === 'off' || !scheduleConfigured() || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID || !TELEGRAM_ALLOWED_USER_IDS.length) return;
  const np = warsawParts(Date.now());
  if (np.h < STATS_HOUR) return;
  const todayStart = warsawToUtcMs(np.y, np.mo, np.d, 0, 0);
  const done = await statsQuery('t_stats', [{ property: 'Publish At', date: { on_or_after: new Date(todayStart).toISOString() } }], 'descending', 1).catch(() => null);
  if (done === null || done.length) return;                // ошибка Notion или отчет за сегодня уже ушел
  await statsRun();
}
// ── конец блока отчета ──

// ── Статистика по рубрикам ──
// Раз в сутки (вместе с отчетом) бот обновляет у опубликованных за 30 дней постов просмотры, лайки, ответы, репосты.
// Рубрику ставишь руками в Notion (поле «Рубрика»). /rubrics [дни] присылает сводку по рубрикам.
const METRICS_WINDOW_DAYS = 14;   // старше двух недель цифры поста почти не меняются, их не трогаем
const RUBRICS = ['Новость + оценка', 'Механика денег', 'Люди и инструменты', 'Сарказм и личное'];
const RUBRIC_TARGET = { 'Новость + оценка': 40, 'Механика денег': 25, 'Люди и инструменты': 20, 'Сарказм и личное': 15 };
const normText = t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 120);

async function publishedThreadsRows(fromMs) {
  const out = []; let cursor;
  for (let i = 0; i < 5; i++) {
    const data = await notionReq('POST', `/v1/data_sources/${NOTION_SCHEDULE_DS_ID}/query`, {
      filter: { and: [statusIs(TS.published), { property: 'Publish At', date: { on_or_after: new Date(fromMs).toISOString() } }] },
      sorts: [{ property: 'Publish At', direction: 'descending' }], page_size: 100, ...(cursor ? { start_cursor: cursor } : {})
    });
    out.push(...(data.results || []).map(pageToRow));
    if (!data.has_more) break; cursor = data.next_cursor;
  }
  return out;
}

async function refreshPostMetrics(days = METRICS_WINDOW_DAYS) {
  if (!threadsConfigured() || !scheduleConfigured()) return { updated: 0 };
  await fillMissingRubrics().catch(e => console.error('rubrics: досылка рубрик', scrubToken(e.message)));
  const rows = await publishedThreadsRows(Date.now() - days * 86400000);
  if (!rows.length) return { updated: 0 };
  // Для старых постов без сохраненного ID ищем пост в Threads по ссылке или по тексту
  let feed = null;
  if (rows.some(r => !r.threadsId)) {
    const uid = await threadsUserId();
    feed = ((await threadsReq('GET', `/${uid}/threads`, { fields: 'id,text,permalink,timestamp', limit: '100' })).data || []);
  }
  let updated = 0, failed = 0;
  for (const r of rows) {
    let id = r.threadsId;
    if (!id && feed) {
      const hit = feed.find(x => (r.link && x.permalink === r.link) || (normText(x.text) && normText(x.text) === normText(r.text)));
      if (hit) id = hit.id;
    }
    if (!id) continue;
    try {
      const ins = statsParseInsight(await threadsReq('GET', `/${id}/insights`, { metric: 'views,likes,replies,reposts' }));
      const props = {
        'Просмотры': { number: ins.views || 0 }, 'Лайки': { number: ins.likes || 0 },
        'Ответы': { number: ins.replies || 0 }, 'Репосты': { number: ins.reposts || 0 },
        'Метрики обновлены': { date: { start: new Date().toISOString() } }
      };
      if (!r.threadsId) props['Threads ID'] = { rich_text: toRichText(String(id)) };
      await notionReq('PATCH', `/v1/pages/${encodeURIComponent(r.id)}`, { properties: props });
      updated++;
    } catch (e) { failed++; console.error('rubrics: метрики поста', r.id, scrubToken(e.message)); }
    await tSleep(300);
  }
  return { updated, failed };
}

async function buildRubricReport(days = 7) {
  const rows = await publishedThreadsRows(Date.now() - days * 86400000);
  const lines = [`🗂 Рубрики Threads за ${days} дн.`, 'Сравнение по цифрам через 48 часов после выхода, у всех постов одинаковый возраст.', ''];
  if (!rows.length) { lines.push('Опубликованных через бота постов за период нет.'); return lines.join('\n'); }
  const groups = {};
  let young = 0;
  for (const r of rows) {
    const k = r.rubric || 'Без рубрики';
    const g = groups[k] || (groups[k] = { n: 0, snap: 0, views: 0, react: 0 });
    g.n++;
    if (r.views48 != null) { g.snap++; g.views += r.views48; g.react += r.react48 || 0; }
    else if (Date.now() - Date.parse(r.publishAt) < SNAP_H * 3600000) young++;
  }
  const total = rows.length;
  for (const k of [...RUBRICS, 'Без рубрики']) {
    const g = groups[k];
    if (!g) { if (RUBRICS.includes(k)) lines.push(`${k}: 0 постов (план ${RUBRIC_TARGET[k]}%)`, ''); continue; }
    lines.push(`${k}: ${g.n} пост. (${Math.round(g.n * 100 / total)}%${RUBRIC_TARGET[k] ? `, план ${RUBRIC_TARGET[k]}%` : ''})`);
    if (g.snap) {
      lines.push(`  за 48 ч в среднем: просмотры ${Math.round(g.views / g.snap)}, реакции ${Math.round(g.react / g.snap)}`);
      lines.push(`  реакций на 100 просмотров: ${g.views ? (g.react * 100 / g.views).toFixed(1) : '0'}${g.snap < g.n ? ` (по ${g.snap} из ${g.n})` : ''}`);
    } else lines.push('  снимка 48 ч пока нет');
    lines.push('');
  }
  if (young) lines.push(`Моложе 48 часов, в сравнение пока не вошли: ${young}.`);
  if (groups['Без рубрики']) lines.push('Посты без рубрики: проставь поле «Рубрика» в Notion.');
  lines.push('Учитываются только посты, вышедшие через бота. Полные цифры по каждому посту лежат в Notion.');
  return lines.join('\n');
}

// Рубрику ставит модель по тексту поста; ручная правка в Notion имеет приоритет (бот не перезаписывает заполненное поле)
async function classifyRubric(text) {
  const system = `Ты раскладываешь посты Threads автора из индустрии ставок и iGaming по рубрикам. Рубрики:
«Новость + оценка»: пост отталкивается от конкретного события, новости, отчета, решения регулятора или компании и дает оценку автора.
«Механика денег»: пост объясняет, как устроены деньги, вероятности, маржа, коэффициенты, бонусы, лимиты, почему букмекер или игрок выигрывает и проигрывает, без привязки к свежей новости.
«Люди и инструменты»: пост про людей и профессии индустрии, команды, работу внутри компании, а также про инструменты, сервисы, ИИ, ботов и автоматизацию.
«Сарказм и личное»: ирония, наблюдение, шутка, личный момент или мнение автора о жизни и индустрии без разбора механики и без новости.
Если подходят несколько, выбери ту, на которой держится главный вывод поста.
Ответь ТОЛЬКО названием рубрики, ровно как в списке, без кавычек и пояснений.`;
  const raw = await claudeCall(system, String(text || '').slice(0, 3000), 50);
  if (!raw) return null;
  const t = raw.replace(/[«»"']/g, '').trim().toLowerCase();
  return RUBRICS.find(r => t.startsWith(r.toLowerCase())) || RUBRICS.find(r => t.includes(r.toLowerCase().split(' ')[0])) || null;
}

async function autoRubric(pageId, text) {
  try {
    if (!ANTHROPIC_API_KEY) return;
    const rubric = await classifyRubric(text);
    if (!rubric) return;
    await notionReq('PATCH', `/v1/pages/${encodeURIComponent(pageId)}`, { properties: { 'Рубрика': { select: { name: rubric } } } });
  } catch (e) { console.error('rubrics: автоклассификация', pageId, scrubToken(e.message)); }
}

// Посты, уже стоящие в очереди без рубрики (созданы до автоклассификации или классификация не прошла)
async function fillMissingRubrics() {
  if (!scheduleConfigured() || !ANTHROPIC_API_KEY) return 0;
  const data = await notionReq('POST', `/v1/data_sources/${NOTION_SCHEDULE_DS_ID}/query`, {
    filter: { and: [statusIs(TS.scheduled), { property: 'Рубрика', select: { is_empty: true } }] }, page_size: 50
  });
  let n = 0;
  for (const r of (data.results || []).map(pageToRow)) { await autoRubric(r.id, r.text); n++; }
  return n;
}

// Снимок через 48 часов: раз в час ищем посты, которым от 48 до 72 часов и у которых снимка еще нет.
// Окно до 72 часов страхует от перезапуска сервера; позже снимок не делаем, чтобы не сравнивать разный возраст.
const SNAP_H = 48, SNAP_LATE_H = 72;
let snapRunning = false;
async function snapshot48Tick() {
  if (snapRunning || !threadsConfigured() || !scheduleConfigured()) return;
  snapRunning = true;
  try {
    const now = Date.now();
    const data = await notionReq('POST', `/v1/data_sources/${NOTION_SCHEDULE_DS_ID}/query`, {
      filter: { and: [statusIs(TS.published),
        { property: 'Publish At', date: { on_or_before: new Date(now - SNAP_H * 3600000).toISOString() } },
        { property: 'Publish At', date: { after: new Date(now - SNAP_LATE_H * 3600000).toISOString() } },
        { property: 'Просмотры 48ч', number: { is_empty: true } }] }, page_size: 50
    });
    for (const r of (data.results || []).map(pageToRow)) {
      if (!r.threadsId) continue;
      try {
        const ins = statsParseInsight(await threadsReq('GET', `/${r.threadsId}/insights`, { metric: 'views,likes,replies,reposts' }));
        await notionReq('PATCH', `/v1/pages/${encodeURIComponent(r.id)}`, { properties: {
          'Просмотры 48ч': { number: ins.views || 0 },
          'Реакции 48ч': { number: (ins.likes || 0) + (ins.replies || 0) + (ins.reposts || 0) }
        } });
      } catch (e) { console.error('rubrics: снимок 48ч', r.id, scrubToken(e.message)); }
    }
  } catch (e) { console.error('rubrics: снимок 48ч', scrubToken(e.message)); }
  finally { snapRunning = false; }
}
// ── конец блока рубрик ──

// ── «100 голосов iGaming»: голосовые героя -> расшифровка -> черновик поста ──────────────────────────
// Бот принимает пересланные голосовые, Gemini расшифровывает, Claude раскладывает по вопросам из questions.json,
// результат лежит в Notion-базе NOTION_VOICE_DS_ID и показывается во вкладке «Голос» Mini App.

const NOTION_VOICE_DS_ID = (process.env.NOTION_VOICE_DS_ID || '').trim();
const GEMINI_TRANSCRIBE_MODEL = process.env.GEMINI_TRANSCRIBE_MODEL || 'gemini-2.5-flash';
const GEMINI_FILES_BASE = 'https://generativelanguage.googleapis.com';
const VOICE_STATUSES = ['черновик', 'на согласовании', 'опубликован'];
const VOICE_INLINE_MAX = 12 * 1024 * 1024; // больше: через Gemini Files API

const voiceConfigured = () => !!(NOTION_API_KEY && NOTION_VOICE_DS_ID);

function loadQuestions() {
  const q = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
  if (!Array.isArray(q.common) || !q.roles) throw new Error('questions.json: нет common или roles');
  return q;
}

// Роль -> { title, questions: [текст] }. Для other вопросы приходят от пользователя
function voiceRole(key, otherQs) {
  const q = loadQuestions();
  if (key === 'other') return { title: (q.other && q.other.title) || 'Другое', questions: otherQs || [] };
  const r = q.roles[key];
  if (!r) throw new Error('Неизвестная роль: ' + key);
  return { title: r.title, questions: r.questions };
}

// --- Notion ---

const rtFull = text => ({ rich_text: toRichText(String(text || '')) });

function pageToVoice(p) {
  const pr = p.properties || {};
  return {
    id: p.id,
    parentOk: !p.parent || p.parent.data_source_id === NOTION_VOICE_DS_ID,
    name: fromRichText(pr.Name && pr.Name.title),
    number: pr['Номер'] && pr['Номер'].number !== undefined ? pr['Номер'].number : null,
    role: (pr['Роль'] && pr['Роль'].select && pr['Роль'].select.name) || '',
    exp: fromRichText(pr['Стаж'] && pr['Стаж'].rich_text),
    status: (pr['Статус'] && pr['Статус'].select && pr['Статус'].select.name) || 'черновик',
    telegram: fromRichText(pr.Telegram && pr.Telegram.rich_text),
    linkedin: fromRichText(pr.LinkedIn && pr.LinkedIn.rich_text),
    risks: fromRichText(pr['Риски'] && pr['Риски'].rich_text),
    transcript: fromRichText(pr['Транскрипт'] && pr['Транскрипт'].rich_text),
    date: p.created_time || null
  };
}

async function voiceNextNumber() {
  const data = await notionReq('POST', `/v1/data_sources/${NOTION_VOICE_DS_ID}/query`, {
    sorts: [{ property: 'Номер', direction: 'descending' }], page_size: 1
  });
  const top = (data.results || []).map(pageToVoice)[0];
  return top && Number.isFinite(top.number) ? top.number + 1 : 1;
}

// Notion не принимает запятые в названиях select: заменяем на пробел
const notionSelectName = s => String(s || '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

async function voiceCreate({ number, roleTitle, exp, telegram, linkedin, risks, transcript, extra }) {
  const paragraphs = String(extra || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  const children = paragraphs.length
    ? [{ object: 'block', type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: 'Сверх вопросов' } }] } },
       ...paragraphs.map(t => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: toRichText(t) } }))].slice(0, 100)
    : [];
  const page = await notionReq('POST', '/v1/pages', {
    parent: { type: 'data_source_id', data_source_id: NOTION_VOICE_DS_ID },
    properties: {
      Name: { title: [{ type: 'text', text: { content: `Голос #${number}` } }] },
      'Номер': { number },
      'Роль': { select: { name: notionSelectName(roleTitle) } },
      'Стаж': rtFull(exp),
      'Статус': { select: { name: 'черновик' } },
      Telegram: rtFull(telegram),
      LinkedIn: rtFull(linkedin),
      'Риски': rtFull(risks),
      'Транскрипт': rtFull(transcript)
    },
    children
  });
  return pageToVoice(page);
}

async function voiceExtraOf(id) {
  const data = await notionReq('GET', `/v1/blocks/${encodeURIComponent(id)}/children?page_size=100`);
  return (data.results || [])
    .filter(b => b.type === 'paragraph')
    .map(b => fromRichText(b.paragraph && b.paragraph.rich_text))
    .filter(Boolean).join('\n\n');
}

async function voiceGet(id) {
  const v = pageToVoice(await notionReq('GET', `/v1/pages/${encodeURIComponent(id)}`));
  if (!v.parentOk) throw new Error('Страница не из базы голосов');
  return v;
}

// --- Gemini: расшифровка ---

async function geminiUploadFile(buf, mime) {
  const start = await fetch(`${GEMINI_FILES_BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buf.length),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: 'voice' } })
  });
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!start.ok || !uploadUrl) throw new Error(`Gemini Files: не удалось начать загрузку (HTTP ${start.status})`);
  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: buf
  });
  const info = await up.json().catch(() => null);
  if (!up.ok || !info || !info.file) throw new Error(`Gemini Files: загрузка не удалась (HTTP ${up.status})`);
  let file = info.file;
  for (let i = 0; i < 30 && file.state && file.state !== 'ACTIVE'; i++) {
    if (file.state === 'FAILED') throw new Error('Gemini Files: файл не обработан');
    await new Promise(r => setTimeout(r, 2000));
    const r = await fetch(`${GEMINI_FILES_BASE}/v1beta/${file.name}`, { headers: { 'x-goog-api-key': GEMINI_API_KEY } });
    file = (await r.json().catch(() => null)) || file;
  }
  return file;
}

async function geminiTranscribe(buf, mime) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY не задан в переменных Railway');
  const m = /ogg|opus/i.test(mime) ? 'audio/ogg' : mime;
  const part = buf.length <= VOICE_INLINE_MAX
    ? { inline_data: { mime_type: m, data: buf.toString('base64') } }
    : (f => ({ file_data: { mime_type: m, file_uri: f.uri } }))(await geminiUploadFile(buf, m));
  const body = {
    contents: [{ parts: [part, { text: 'Расшифруй это голосовое сообщение дословно, на языке оригинала (русский или украинский). Ничего не исправляй, не пересказывай и не добавляй. Верни только текст расшифровки, без пояснений и таймкодов.' }] }],
    generationConfig: { temperature: 0 }
  };
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await geminiPost(`${GEMINI_LEGACY_BASE}/${GEMINI_TRANSCRIBE_MODEL}:generateContent`, body);
    if (r.resp.ok) {
      const text = (((r.data || {}).candidates || [])[0] || {}).content;
      const out = text && (text.parts || []).map(p => p.text || '').join('').trim();
      if (out) return out;
      last = 'пустой ответ';
    } else {
      last = `HTTP ${r.resp.status}: ${((r.data && r.data.error && r.data.error.message) || r.raw || '').slice(0, 200)}`;
      if (r.resp.status < 429 && r.resp.status !== 408) break; // 4xx кроме 408/429: повтор не поможет
    }
    await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
  }
  throw new Error('Gemini не расшифровал голосовое: ' + last);
}

async function tgDownload(fileId) {
  const f = await tgApi('getFile', { file_id: fileId });
  if (!f.file_path) throw new Error('Telegram не отдал файл');
  const resp = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${f.file_path}`);
  if (!resp.ok) throw new Error(`Не скачался файл (HTTP ${resp.status})`);
  return Buffer.from(await resp.arrayBuffer());
}

// --- Claude: раскладка по вопросам ---

const VOICE_SYSTEM_PROMPT = `Ты редактор рубрики «100 голосов iGaming». Тебе дают расшифровку голосовых ответов героя интервью и список вопросов. Твоя работа: разложить сказанное героем по вопросам ПРЯМОЙ РЕЧЬЮ.

ЖЕСТКИЕ ПРАВИЛА:
1. Ответ на каждый вопрос это речь героя от первого лица, как он сказал. Убери только слова-паразиты, «ээ», «ну», «как бы», повторы и оговорки. Слова и формулировки героя сохраняй. Можно склеивать куски одного ответа, которые герой произнес в разных местах.
2. НИЧЕГО не дописывай, не пересказывай, не усиливай, не делай выводов, не придумывай связки. Каждая фраза в ответе должна быть в расшифровке. Если сомневаешься, оставь как у героя.
3. Если на вопрос героя нет ответа в расшифровке, верни для него пустую строку.
4. Интересное, что герой сказал вне вопросов, положи в "extra" (тоже прямой речью, те же правила очистки). Если такого нет, пустая строка.
5. Речь на украинском переведи на русский максимально близко к тексту, без украшений, и поставь для этого ответа "translated": true.
6. Без буквы «ё». Длинное тире как знак препинания не используй, дефис с пробелами тоже. Проценты записывай знаком % (не словом «процентов»).
7. "risks": список всего, по чему героя могут узнать: названия компаний и брендов, точные цифры, имена людей, города и страны, уникальные истории. Для каждого: "what" (что именно) и "quote" (короткая цитата места из ответа). Если ничего нет, пустой список.
8. Вопрос с пометкой [МОЖНО ЗАМЕНИТЬ] герой имел право заменить своим. Если вместо ответа на него герой явно говорит на другую тему, которую выбрал сам, положи этот рассказ в ответ на этот вопрос, а в "custom_question" запиши короткий вопрос, на который он на самом деле отвечает (одно предложение, без ё). Если герой ответил на исходный вопрос или ничего не заменял, "custom_question" пустая строка.
9. "best": id самого сильного ответа среди вопросов с id на r (не c). Сильный это конкретный случай из личного опыта, неочевидная мысль, детали, которых нет в общих словах. Выбирай только из непустых ответов. Если все ответы на r пустые, пустая строка.

Верни ТОЛЬКО JSON без пояснений и без markdown-ограждений, в формате:
{"answers":[{"id":"<id вопроса>","text":"...","translated":false}],"custom_question":"...","best":"<id>","extra":"...","risks":[{"what":"...","quote":"..."}]}
В "answers" должны быть все вопросы из списка, в том же порядке, с теми же id.`;

async function voiceStructure(questions, transcript) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY не задан');
  const list = questions.map(q => `${q.id}: ${q.text}${q.replaceable ? ' [МОЖНО ЗАМЕНИТЬ]' : ''}`).join('\n');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 8000, temperature: 0, system: VOICE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `ВОПРОСЫ:\n${list}\n\nРАСШИФРОВКА:\n${transcript}` }]
    })
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error('Claude: ' + ((data && data.error && data.error.message) || 'HTTP ' + resp.status));
  if (data.stop_reason === 'max_tokens') throw new Error('Ответ Claude обрезан по длине: слишком много голосовых за раз');
  const raw = ((data.content || [])[0] || {}).text || '';
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  let parsed;
  try { parsed = JSON.parse(raw.slice(a, b + 1)); } catch { throw new Error('Claude вернул не-JSON, попробуй «Готово» ещё раз'); }
  return parsed;
}

const voiceClean = t => noYo(String(t || '')).trim();

// Сборка двух версий из ответов модели: формат поста задаёт код, а не модель
// Telegram: все вопросы. LinkedIn: общие вопросы плюс самый сильный ответ из блока по роли.
// Последний вопрос роли герой может заменить своим: тогда в посте стоит его вопрос.
function voiceAssemble({ number, roleTitle, exp, questions, commonCount, parsed }) {
  const byId = Object.fromEntries((parsed.answers || []).map(a => [a.id, a]));
  const custom = voiceClean(parsed.custom_question);
  const qs = questions.map(q => (q.replaceable && custom ? { ...q, text: custom } : q));
  const head = `Голос #${number}: ${roleTitle}${exp ? ', ' + exp : ''}`;
  const has = q => !!voiceClean((byId[q.id] || {}).text);
  const block = (q, i) => {
    const a = byId[q.id] || {};
    const text = voiceClean(a.text);
    const body = text ? (a.translated ? `[ПЕРЕВОД]\n${text}` : text) : '[НЕТ ОТВЕТА]';
    return `**${i + 1}. ${q.text}**\n${body}`;
  };
  const roleQs = qs.slice(commonCount);
  const best = roleQs.find(q => q.id === parsed.best && has(q)) || roleQs.find(has);
  const liQs = [...qs.slice(0, commonCount), ...(best ? [best] : [])];
  const telegram = `${head}\n\n[ВСТУПЛЕНИЕ]\n\n${qs.map(block).join('\n\n')}\n\n[ФИНАЛ]`;
  const linkedin = `${head}\n\n${liQs.map(block).join('\n\n')}`.replace(/\*\*/g, '');
  const risks = (parsed.risks || []).filter(r => r && r.what)
    .map(r => `• ${voiceClean(r.what)}${r.quote ? `: «${voiceClean(r.quote)}»` : ''}`).join('\n');
  return { telegram, linkedin, risks, extra: voiceClean(parsed.extra) };
}

// --- Сессия в чате с ботом ---

const voiceSessions = new Map(); // userId -> сессия (в памяти: после перезапуска сервера открывается заново)

const voiceKb = rows => ({ inline_keyboard: rows });
const voiceCancelBtn = { text: 'Отмена', callback_data: 'vo:x' };
const voiceDoneBtn = { text: 'Готово', callback_data: 'vo:go' };

function voiceMediaOf(msg) {
  if (msg.voice) return { fileId: msg.voice.file_id, mime: msg.voice.mime_type || 'audio/ogg', size: msg.voice.file_size || 0 };
  if (msg.audio) return { fileId: msg.audio.file_id, mime: msg.audio.mime_type || 'audio/mpeg', size: msg.audio.file_size || 0 };
  if (msg.document && /^audio\//.test(msg.document.mime_type || '')) return { fileId: msg.document.file_id, mime: msg.document.mime_type, size: msg.document.file_size || 0 };
  return null;
}

const isVoiceMessage = msg => !!voiceMediaOf(msg);

const voiceWord = n => (n % 10 === 1 && n % 100 !== 11) ? 'голосовое' : 'голосовых';

async function voiceAnnounce(s) {
  s.timer = null;
  if (s.step === 'role') {
    const q = loadQuestions();
    const roleBtns = Object.entries(q.roles).map(([k, r]) => [{ text: r.title, callback_data: 'vo:r:' + k }]);
    roleBtns.push([{ text: (q.other && q.other.title) || 'Другое', callback_data: 'vo:r:other' }]);
    roleBtns.push([voiceCancelBtn]);
    return botSend(s.chatId, `Принял ${s.voices.length} ${voiceWord(s.voices.length)}. Чей голос?`, { reply_markup: voiceKb(roleBtns) });
  }
  return botSend(s.chatId, `Добавил. Всего голосовых: ${s.voices.length}.`, { reply_markup: voiceKb([[voiceDoneBtn, voiceCancelBtn]]) });
}

async function voiceIntake(msg) {
  const userId = String(msg.from.id);
  let s = voiceSessions.get(userId);
  if (s && s.busy) return botSend(msg.chat.id, 'Сейчас обрабатываю предыдущую пачку, подожди минуту.');
  if (!voiceConfigured()) return botSend(msg.chat.id, 'Голоса не настроены: задай NOTION_VOICE_DS_ID (база «100 голосов iGaming») в переменных Railway.');
  if (!s) {
    s = { userId, chatId: msg.chat.id, voices: [], step: 'role', role: null, number: null, exp: '', otherQs: [], timer: null, busy: false };
    voiceSessions.set(userId, s);
  }
  s.voices.push(voiceMediaOf(msg));
  // Пересланная пачка приходит сообщениями подряд: один ответ на всю пачку
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => voiceAnnounce(s).catch(e => console.error('voice announce:', scrubToken(e.message))), 1500);
}

async function voiceAskNumber(s) {
  s.step = 'number';
  let next = 1;
  try { next = await voiceNextNumber(); } catch (e) { console.error('voice number:', scrubToken(e.message)); }
  return botSend(s.chatId, `Номер голоса? Нажми кнопку или напиши число.`, {
    reply_markup: voiceKb([[{ text: `Голос #${next}`, callback_data: 'vo:n:' + next }], [voiceCancelBtn]])
  });
}

function voiceAskExp(s) {
  s.step = 'exp';
  return botSend(s.chatId, 'Стаж героя? Напиши текстом (например, «12 лет в индустрии») или пропусти.', {
    reply_markup: voiceKb([[{ text: 'Пропустить', callback_data: 'vo:skip' }], [voiceCancelBtn]])
  });
}

function voiceAskReady(s) {
  s.step = 'ready';
  const role = voiceRole(s.role, s.otherQs).title;
  return botSend(s.chatId, `Голос #${s.number}: ${role}${s.exp ? ', ' + s.exp : ''}\nГолосовых: ${s.voices.length}. Можно досылать ещё. Нажми «Готово», когда всё.`, {
    reply_markup: voiceKb([[voiceDoneBtn, voiceCancelBtn]])
  });
}

// Текст в чате, пока открыта сессия: номер, стаж или вопросы для роли «Другое». true = сообщение использовано
async function voiceText(msg) {
  const s = voiceSessions.get(String(msg.from.id));
  if (!s || s.busy) return false;
  const text = String(msg.text || '').trim();
  if (s.step === 'number') {
    if (!/^\d{1,4}$/.test(text)) { await botSend(s.chatId, 'Нужно число, например 7.'); return true; }
    s.number = Number(text);
    await voiceAskExp(s);
    return true;
  }
  if (s.step === 'exp') {
    s.exp = text.slice(0, 80);
    await voiceAskReady(s);
    return true;
  }
  if (s.step === 'otherq') {
    const qs = text.split('\n').map(x => x.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
    if (qs.length !== 3) { await botSend(s.chatId, 'Нужно ровно 3 вопроса, каждый с новой строки.'); return true; }
    s.otherQs = qs;
    await voiceAskNumber(s);
    return true;
  }
  return false;
}

async function handleVoiceCallback(cb) {
  const answer = (text) => tgApi('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {});
  const userId = String(cb.from.id);
  if (!TELEGRAM_ALLOWED_USER_IDS.includes(userId)) return answer('Нет доступа');
  const s = voiceSessions.get(userId);
  if (!s) return answer('Сессия голоса не открыта: перешли голосовые заново');
  if (s.busy) return answer('Обрабатываю, подожди');
  const parts = String(cb.data).split(':'); // vo:<kind>[:<arg>]
  const kind = parts[1], arg = parts[2];
  await answer();
  if (kind === 'x') {
    voiceSessions.delete(userId);
    return botSend(s.chatId, 'Отменено, голосовые не сохранены.');
  }
  if (kind === 'r' && s.step === 'role') {
    s.role = arg;
    if (arg === 'other') {
      s.step = 'otherq';
      return botSend(s.chatId, 'Пришли 3 вопроса для этого героя одним сообщением, каждый с новой строки.', { reply_markup: voiceKb([[voiceCancelBtn]]) });
    }
    return voiceAskNumber(s);
  }
  if (kind === 'n' && s.step === 'number') { s.number = Number(arg); return voiceAskExp(s); }
  if (kind === 'skip' && s.step === 'exp') { s.exp = ''; return voiceAskReady(s); }
  if (kind === 'go') {
    if (s.step !== 'ready') return botSend(s.chatId, 'Сначала выбери роль, номер и стаж.');
    return voiceProcess(s);
  }
}

// Расшифровка уже готова: раскладываем по вопросам роли и пишем в Notion. Вызывается и из бота, и из API (TTS-бот)
async function voiceSubmit({ role: roleKey, otherQs, number, exp, transcript }) {
  const role = voiceRole(roleKey, otherQs);
  const q = loadQuestions();
  const questions = [
    ...q.common.map((x, i) => ({ id: 'c' + (i + 1), text: typeof x === 'string' ? x : x.text })),
    ...role.questions.map((x, i, arr) => ({ id: 'r' + (i + 1), text: typeof x === 'string' ? x : x.text, replaceable: i === arr.length - 1 }))
  ];
  const parsed = await voiceStructure(questions, transcript);
  const out = voiceAssemble({ number, roleTitle: role.title, exp, questions, commonCount: q.common.length, parsed });
  await voiceCreate({ number, roleTitle: role.title, exp, ...out, transcript });
}

async function voiceProcess(s) {
  s.busy = true;
  try {
    await botSend(s.chatId, `Обрабатываю ${s.voices.length} ${voiceWord(s.voices.length)}, это займет пару минут…`);
    const parts = [];
    for (let i = 0; i < s.voices.length; i++) {
      let buf;
      try { buf = await tgDownload(s.voices[i].fileId); }
      catch (e) { throw new Error(`Голосовое ${i + 1}: ${scrubToken(e.message)} (бот скачивает файлы до 20 МБ)`); }
      const text = await geminiTranscribe(buf, s.voices[i].mime);
      parts.push(`[Голосовое ${i + 1}]\n${text}`);
    }
    const transcript = parts.join('\n\n');
    await voiceSubmit({ role: s.role, otherQs: s.otherQs, number: s.number, exp: s.exp, transcript });
    voiceSessions.delete(s.userId);
    return botSend(s.chatId, `Голос #${s.number} готов, открой вкладку Голос.`);
  } catch (e) {
    s.busy = false;
    console.error('voice process:', scrubToken(e.message));
    return botSend(s.chatId, `Не получилось: ${scrubToken(e.message).slice(0, 400)}\n\nСессия сохранена, нажми «Готово» ещё раз.`, { reply_markup: voiceKb([[voiceDoneBtn, voiceCancelBtn]]) }).catch(() => {});
  }
}

// --- Mini App: список и карточка голосов ---

// Закрытый API для TTS-бота (он принимает голосовые и расшифровывает их). Доступ по VOICE_API_SECRET
const VOICE_API_SECRET = (process.env.VOICE_API_SECRET || '').trim();

function voiceApiRoute(req, res) {
  const url = req.url.split('?')[0];
  if (!url.startsWith('/api/voice-api/')) return false;
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const auth = String(req.headers.authorization || '');
  if (!VOICE_API_SECRET || !safeEqual(auth, 'Bearer ' + VOICE_API_SECRET)) { send(403, { ok: false, error: 'forbidden' }); return true; }
  if (!voiceConfigured()) { send(500, { ok: false, error: 'Голоса не настроены: нет NOTION_VOICE_DS_ID' }); return true; }
  const run = async (body) => {
    try {
      if (req.method === 'GET' && url === '/api/voice-api/info') {
        const q = loadQuestions();
        let next = 1;
        try { next = await voiceNextNumber(); } catch (e) { console.error('voice number:', scrubToken(e.message)); }
        return send(200, {
          ok: true, next,
          roles: Object.entries(q.roles).map(([key, r]) => ({ key, title: r.title })),
          other: (q.other && q.other.title) || 'Другое',
          roleQuestions: (q.roles.head_of_sportsbook || Object.values(q.roles)[0]).questions.length
        });
      }
      if (req.method === 'POST' && url === '/api/voice-api/submit') {
        const d = JSON.parse(body || '{}');
        const number = Number(d.number);
        if (!d.role || !Number.isInteger(number) || number < 1 || !String(d.transcript || '').trim()) return send(400, { ok: false, error: 'нужны role, number, transcript' });
        await voiceSubmit({ role: d.role, otherQs: Array.isArray(d.otherQs) ? d.otherQs.map(String) : [], number, exp: String(d.exp || '').slice(0, 80), transcript: String(d.transcript) });
        return send(200, { ok: true, number });
      }
      return send(404, { ok: false, error: 'not found' });
    } catch (e) {
      console.error('voice api:', scrubToken(e.message));
      return send(500, { ok: false, error: scrubToken(e.message).slice(0, 400) });
    }
  };
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 3 * 1024 * 1024) req.destroy(); });
    req.on('end', () => run(body));
  } else run('');
  return true;
}

function voiceRoute(req, res) {
  const url = req.url.split('?')[0];
  const isList = req.method === 'GET' && url === '/api/voices';
  const isGet = req.method === 'GET' && url === '/api/voice';
  const isUpd = req.method === 'POST' && url === '/api/voice-update';
  if (!isList && !isGet && !isUpd) return false;
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const run = async (body) => {
    try {
      if (!voiceConfigured()) return send(503, { error: 'Голоса не настроены: задай NOTION_VOICE_DS_ID в переменных Railway' });
      const auth = await authorizeUser(req);
      if (!auth.ok) return send(auth.status, { error: auth.error });
      if (isList) {
        const data = await notionReq('POST', `/v1/data_sources/${NOTION_VOICE_DS_ID}/query`, {
          sorts: [{ property: 'Номер', direction: 'descending' }], page_size: 100
        });
        const items = (data.results || []).map(pageToVoice).map(v => ({ id: v.id, number: v.number, role: v.role, status: v.status, date: v.date }));
        return send(200, { items });
      }
      if (isGet) {
        const id = new URL(req.url, 'http://localhost').searchParams.get('id') || '';
        if (!/^[0-9a-f-]{32,40}$/i.test(id)) return send(400, { error: 'Некорректный id' });
        let v;
        try { v = await voiceGet(id); } catch { return send(404, { error: 'Голос не найден' }); }
        v.extra = await voiceExtraOf(id).catch(() => '');
        delete v.parentOk;
        return send(200, v);
      }
      const { id, telegram, linkedin, status } = JSON.parse(body);
      if (!/^[0-9a-f-]{32,40}$/i.test(String(id || ''))) return send(400, { error: 'Некорректный id' });
      if (status !== undefined && !VOICE_STATUSES.includes(status)) return send(400, { error: 'Неизвестный статус' });
      try { await voiceGet(id); } catch { return send(404, { error: 'Голос не найден' }); }
      const properties = {};
      if (typeof telegram === 'string') properties.Telegram = rtFull(telegram);
      if (typeof linkedin === 'string') properties.LinkedIn = rtFull(linkedin);
      if (status !== undefined) properties['Статус'] = { select: { name: status } };
      if (!Object.keys(properties).length) return send(400, { error: 'Нечего сохранять' });
      await notionReq('PATCH', `/v1/pages/${encodeURIComponent(id)}`, { properties });
      return send(200, { ok: true });
    } catch (err) {
      console.error('voice route error:', scrubToken(err.message));
      send(err.httpStatus || 500, { error: scrubToken(err.message) });
    }
  };
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2 * 1024 * 1024) req.destroy(); });
    req.on('end', () => run(body));
  } else {
    run('');
  }
  return true;
}

async function handleBotUpdate(update) {
  if (update.chat_member) return handleChatMember(update.chat_member).catch(e => console.error('chat_member:', scrubToken(e.message)));
  if (update.callback_query) {
    if (/^vo:/.test(String(update.callback_query.data || ''))) return handleVoiceCallback(update.callback_query).catch(e => console.error('voice cb:', scrubToken(e.message)));
    if (/^ap:/.test(String(update.callback_query.data || ''))) return handleApCallback(update.callback_query).catch(e => console.error('autopilot cb:', scrubToken(e.message)));
    if (/^cx:\d+$/.test(String(update.callback_query.data || ''))) return handleCommentCallback(update.callback_query);
    if (/^(tp:\d+:\d+|tm:\d+)$/.test(String(update.callback_query.data || ''))) return handleThreadsReplyCallback(update.callback_query);
    return handleBotCallback(update.callback_query);
  }
  const msg = update.message;
  // Группа обсуждений канала: комментарии под постами
  if (msg && msg.chat && (msg.chat.type === 'supergroup' || msg.chat.type === 'group')) {
    return handleGroupMessage(msg).catch(e => console.error('comments error:', scrubToken(e.message)));
  }
  if (!msg || !msg.from || !msg.chat || msg.chat.type !== 'private') return;
  const userId = String(msg.from.id);
  if (!TELEGRAM_ALLOWED_USER_IDS.includes(userId)) {
    return botSend(msg.chat.id, `Нет доступа. Твой Telegram ID: ${userId}`);
  }
  if (isVoiceMessage(msg) && VOICE_API_SECRET) {
    return botSend(msg.chat.id, 'Голосовые для «100 голосов» теперь принимает бот озвучки. Перешли их туда.');
  }
  if (isVoiceMessage(msg)) return voiceIntake(msg).catch(e => console.error('voice intake:', scrubToken(e.message)));
  if (msg.text && !msg.text.startsWith('/') && voiceSessions.has(userId) && await voiceText(msg).catch(e => { console.error('voice text:', scrubToken(e.message)); return false; })) return;
  if (msg.reply_to_message && msg.text && !msg.text.startsWith('/') && await apHandleEditReply(msg).catch(e => { console.error('autopilot reply:', scrubToken(e.message)); return false; })) return;
  const cmd = String(msg.text || '').trim().split(/\s|@/)[0].toLowerCase();
  if (cmd === '/draft') {
    if (!threadsConfigured()) return botSend(msg.chat.id, 'Threads не настроен: нет THREADS_ACCESS_TOKEN.');
    await botSend(msg.chat.id, 'Готовлю черновики на ближайшие дни, карточки придут сюда.');
    const r = await apTick({ force: true });
    if (!r) return botSend(msg.chat.id, 'Уже готовлю или не хватает настроек.');
    if (r.error) return botSend(msg.chat.id, 'Не получилось: ' + r.error.slice(0, 300));
    return botSend(msg.chat.id, r.created ? `Готово, черновиков: ${r.created}.` : 'Все ближайшие дни уже закрыты постами.');
  }
  if (cmd === '/scheduled') {
    if (!scheduleConfigured()) return botSend(msg.chat.id, 'Расписание не настроено: нет NOTION_API_KEY.');
    try {
      return await sendScheduledList(msg.chat.id, userId);
    } catch (e) {
      // Молчание в чате хуже понятной причины (например, база Notion не открыта интеграции)
      console.error('/scheduled:', scrubToken(e.message));
      return botSend(msg.chat.id, `Не удалось получить очередь: ${scrubToken(e.message).slice(0, 300)}`).catch(() => {});
    }
  }
  if (cmd === '/replies') {
    if (!threadsConfigured()) return botSend(msg.chat.id, 'Threads не настроен: нет THREADS_ACCESS_TOKEN.');
    const hours = Math.min(168, Math.max(1, Number((String(msg.text || '').match(/\d+/) || [24])[0]) || 24));
    await botSend(msg.chat.id, `Ищу ответы в Threads за последние ${hours} ч…`);
    const r = await threadsRepliesTick({ manual: true, hours });
    if (!r) return botSend(msg.chat.id, 'Проверка уже идет или не хватает настроек, попробуй через минуту.');
    if (r.error) return botSend(msg.chat.id, 'Не получилось: ' + r.error.slice(0, 300));
    return botSend(msg.chat.id, r.found ? `Нашел ответов: ${r.found}. Карточки выше.` : 'За этот период чужих ответов нет.');
  }
  if (cmd === '/stats') {
    try { const r = await statsRun({ manual: true }); if (!r) return botSend(msg.chat.id, 'Отчет уже собирается, подожди минуту.'); return; }
    catch (e) { return botSend(msg.chat.id, 'Не получилось собрать отчет: ' + scrubToken(e.message).slice(0, 300)).catch(() => {}); }
  }
  if (cmd === '/rubrics') {
    const days = Math.min(90, Math.max(1, Number((String(msg.text || '').match(/\d+/) || [7])[0]) || 7));
    try {
      await botSend(msg.chat.id, `Обновляю цифры постов и считаю рубрики за ${days} дн.…`);
      await refreshPostMetrics();
      return botSend(msg.chat.id, await buildRubricReport(days), { disable_web_page_preview: true });
    } catch (e) { return botSend(msg.chat.id, 'Не получилось: ' + scrubToken(e.message).slice(0, 300)).catch(() => {}); }
  }
  if (cmd === '/start' || cmd === '/help') {
    return botSend(msg.chat.id, 'Команды:\n/scheduled: запланированные посты, отмена и публикация сразу.\n/replies 24: найти ответы в Threads за последние 24 часа (число часов можно менять).\n/stats: отчет по Threads и каналу за последние 7 дней (сам приходит по понедельникам).\n/rubrics 7: сводка по рубрикам Threads за 7 дней (число дней можно менять).\n/draft: подготовить черновики Threads на ближайшие дни (автопилот).\n\nСоздавать и планировать посты нужно в приложении (кнопка меню).');
  }
}

async function handleBotCallback(cb) {
  const answer = (text, alert = false) => tgApi('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert }).catch(() => {});
  const userId = String(cb.from.id);
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const messageId = cb.message && cb.message.message_id;
  if (!TELEGRAM_ALLOWED_USER_IDS.includes(userId)) return answer('Нет доступа', true);
  const m = /^(c|p|b|y|r|s1|s3|sd|sn):([0-9a-f-]{32,40})$/i.exec(String(cb.data || ''));
  if (!m || !chatId) return answer('Неизвестная кнопка');
  const [, kind, id] = m;
  const edit = (text, markup) => tgApi('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: markup || { inline_keyboard: [] } }).catch(e => console.error('editMessageText:', scrubToken(e.message)));

  let row;
  try { row = await schedGet(id); } catch { return answer('Пост не найден или очередь недоступна', true); }
  if (String(row.owner) !== userId) return answer('Это не твой пост', true);
  if (row.status !== 'scheduled') {
    await answer(`Уже не в очереди: ${row.status}`);
    return edit(`${cardText(row)}\n\nСтатус: ${row.status}`);
  }

  if (kind === 'r') {
    await answer();
    return edit(`${cardText(row)}\n\nНа какое время перенести?`, rescheduleKeyboard(id, messageId));
  }
  if (['s1', 's3', 'sd', 'sn'].includes(kind)) {
    let updated;
    try {
      updated = await rescheduleRow(row, shiftedIso(row, kind));
    } catch (e) {
      return answer(String(e.message).slice(0, 190), true);
    }
    await answer('Перенесено');
    return edit(`✅ Перенесено\n\n${cardText(updated)}`, botKeyboard(id));
  }
  if (kind === 'c') {
    await schedUpdate(id, { status: 'cancelled' });
    await answer('Отменено');
    return edit(`❌ Отменено\n\n${cardText(row)}`);
  }
  if (kind === 'p') {
    await answer();
    return edit(`${cardText(row)}\n\nОпубликовать в канал прямо сейчас?`, { inline_keyboard: [[{ text: 'Да, опубликовать', callback_data: 'y:' + id }, { text: 'Назад', callback_data: 'b:' + id }]] });
  }
  if (kind === 'b') {
    await answer();
    return edit(cardText(row), botKeyboard(id));
  }
  // kind === 'y': публикация сразу, итог показываем на этой же карточке
  await answer('Публикую…');
  await edit(`⏳ Публикую…\n\n${cardText(row)}`);
  const r = await runScheduledPost(row, { checkStale: false, notify: false });
  if (r.status === 'published') return edit(`✅ Опубликовано${r.link ? '\n' + r.link : ''}\n\n${shortPreview(row.text, 500)}`);
  if (r.status === 'busy') return edit(`⏳ Уже публикуется\n\n${cardText(row)}`);
  return edit(`❌ Не удалось опубликовать: ${r.error}\n\n${shortPreview(row.text, 500)}`);
}

function getSubstackSystemPrompt() {
  return `Ты ghostwriter для Дмитрия Скакунова — Head of Sportsbook в iGaming, 18 лет в индустрии. Пишешь статью для его Substack newsletter на русском языке.

Substack — профессиональный канал для практиков индустрии: Head of Sportsbook, операционные и продуктовые менеджеры в iGaming.

ФОРМАТ СТАТЬИ:
- 700-1200 слов
- От первого лица
- Структура: личный момент или контекст → разворот ситуации с деталями → анализ что пошло не так и почему → позиция Дмитрия → практический вывод для читателя
- Не LinkedIn: нет коротких крючков по формуле, нет искусственного ритма из одиночных предложений
- Разговорный но структурированный — колонка практика, не академическая статья и не учебник
- Абзацы 3-5 предложений, текст читается как текст, не как слайды

ПРАВИЛА СТИЛЯ:
- Только русский. Отраслевые термины: GGR, NGR, sportsbook, CRM, hold%, margin, live betting
- Цифры и конкретные детали из кейса — использовать максимально
- Финал: конкретный вывод с позицией или открытый вопрос к читателю — уместно для newsletter
- Никакого корпоратива, мотивации, "синергии"
- Не выдумывай детали которых нет в кейсе

ЗАПРЕЩЕНО:
- LinkedIn-крючки первой строкой ("GGR вырос на 40%. Бизнес стал слабее.")
- AI-маркеры: "Вот как...", "Результат?", "В заключение...", "Честно говоря..."
- Структуры: "3 урока", "5 вещей которые я понял"
- Корпоративный язык и мотивационный тон

Отвечай ТОЛЬКО текстом статьи без заголовка. Никаких пояснений, вводных фраз, комментариев.`;
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startScheduling();
});
