const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Модель и адрес вынесены в переменные окружения: у Google они менялись, и подстроить их можно без правки кода
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1';
const GEMINI_API_URL = process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/interactions';
const NOTION_DATABASE_ID = 'a81c0118449d47388b3fb612a509cd38';
const DRAFT_LAB_DATA_SOURCE_ID = '14814719-85c5-4819-a07e-3d1b773d6bdb';
const CAREER_CASES_DATA_SOURCE_ID = 'a81c0118-449d-4738-8b3f-b612a509cd38';

const MODEL = 'claude-sonnet-4-6';

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
- «Вот как...» / «Вот что...» / «Вот почему...» / «Давайте разберёмся» / «Копнём глубже»
- «Дело не в X, а в Y» / «Это не просто X — это Y» / «Речь не о X, речь о Y»
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
- Тире как рефлекс: 2+ тире в одном предложении, или «X — это Y» повторяется из абзаца в абзац

ЧТО НЕ ТРОГАТЬ (защищённые элементы):
- Короткие декларативные предложения — фирменный голос Дмитрия, не slop
- Цифры и метрики (GGR, NGR, hold%, margin, CAC, LTV, конкретные проценты)
- Личный якорь (момент или наблюдение из реального опыта) — не полируй, не вырезай
- Отраслевые термины: sportsbook, CRM, live betting, second bet, retention
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

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
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
        const systemPrompt = isTg ? getTelegramSystemPrompt() : getSystemPrompt() + buildStyleBlock(styleText);

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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text }));

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
        res.end(JSON.stringify({ text }));

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
        res.end(JSON.stringify({ text }));

      } catch (err) {
        console.error('rubric-format catch error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
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

async function geminiGenerateImage(prompt) {
  const call = async (withFormat) => {
    const reqBody = { model: GEMINI_IMAGE_MODEL, input: [{ type: 'text', text: prompt }] };
    if (withFormat) reqBody.response_format = { type: 'image', aspect_ratio: '3:4' };
    const resp = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify(reqBody)
    });
    const raw = await resp.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    return { resp, data, raw };
  };

  let r = await call(true);
  // Если Google не принял параметры формата, пробуем без них (картинка будет в размере по умолчанию)
  if (r.resp.status === 400) r = await call(false);

  if (!r.resp.ok) {
    throw new Error(`Gemini ${r.resp.status}: ${r.data?.error?.message || r.raw.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
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
крючок-парадокс → личное наблюдение → конкретный кейс или цифра → поворот/ловушка → управленческая ошибка → твоя позиция → сильный финал.

Обязателен личный якорь: одно предложение, показывающее что Дмитрий это видел лично.
Конкретная деталь вместо обобщённой эмоции (не «все довольны», а что именно произошло).
Не объясняй очевидное. Не учи. Пиши от первого лица.`;
  } else {
    return `Оформи в LinkedIn пост эту сырую мысль: "${input}". Тон: ${tone}.

Опорная структура (адаптируй, пиши потоком, швы не должны быть видны):
крючок-парадокс → личное наблюдение → конкретный кейс или цифра → поворот/ловушка → управленческая ошибка → твоя позиция → сильный финал.

Обязателен личный якорь: одно предложение, показывающее что Дмитрий это видел лично.
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
2. Личное наблюдение или момент — одно предложение, показывающее что Дмитрий видел это лично, а не прочитал в статье.
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
5. Аномалия из практики: "Я видел спортсбук с маржой 18% и очередью из игроков."

ПЛОХОЙ КРЮЧОК: начало как учебник, с определения, с "В современном мире", с вопроса.

---

ПРАВИЛА СТИЛЯ:
- Пиши ТОЛЬКО на русском. Отраслевые термины на английском: GGR, NGR, sportsbook, CRM, hold%, CAC, LTV, margin, second bet, live betting
- Короткие абзацы — 1-3 предложения. Иногда одно слово — норма
- Личный голос, от первого лица
- Конкретика — цифры, кейсы, механики, конкретные сцены и детали вместо общих фраз
- Финал острый — позиция, не вопрос
- Никакого корпоратива, мотивации, "синергии"
- Длина: 150-300 слов
- Эмодзи — максимум 1, только если уместно

ЛИЧНЫЙ ЯКОРЬ — обязательный элемент каждого поста:
Каждый пост должен содержать момент, наблюдение или ситуацию из реального опыта Дмитрия. Не обязательно полная история, достаточно одного предложения которое показывает что он это видел лично, а не прочитал в статье.
Формула: личное наблюдение или момент → системный вывод.
Посты без этого якоря работают хуже независимо от качества аналитики.

В каждом посте обязательно минимум одно из трёх:
- Личный кейс из реального опыта (sportsbook / iGaming)
- Конкретная цифра или метрика
- Нестандартная позиция или вывод к которому пришёл именно Дмитрий

ИЗБЕГАЙ ШАБЛОННЫХ ФРАЗ И AI-МАРКЕРОВ:
Никогда не использовать: "Вот как...", "Вот что...", "Дело не в X, а в Y", "Результат?", "Честно говоря...", "Фраза которая со мной осталась...", "В заключение...", структуры типа "3 урока" / "5 вещей которые я понял".
Также запрещено: "CRM ликует", "Finance страдает", "я вот видел", "я вот знаю", "и вот тут начинается", "спойлер", "синергия", "экосистема", "холистический подход".
Если формулировка похожа на штамп из тысячи бизнес постов или звучит как инфобизнесмен и LinkedIn-коуч, перепиши конкретнее и живее.

Голос: пост должен звучать как senior iGaming operator с реальным операционным опытом. Не как консультант. Не как инфобизнесмен. Не как LinkedIn-коуч.

САМОПРОВЕРКА перед выдачей (если хоть один ответ "нет" — перепиши):
- Узнает ли Head of Sportsbook эту проблему?
- Есть личный якорь?
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

И личный якорь: одно предложение показывающее что он это видел лично, не прочитал в статье.

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
«Вот как...», «Вот что...», «Вот почему...», «Дело не в X, а в Y», «Результат?», «Честно говоря...», «В заключение...», «Подводя итог...», «Давайте разберемся», «Копнем глубже», «Знакомо?», «Почему это важно?», «Что это значит для вас?»
Структуры-счетчики: «3 урока которые я вынес», «5 вещей которые я понял».
Канцелярит: «является», «представляет собой», «таким образом», «более того», «в связи с этим», «данный», «в современном мире», «играет ключевую роль».
Громкие пустые слова: «раскрыть потенциал», «трансформировать», «прорывной», «синергия», «экосистема» не в буквальном смысле.
Структурные тики: тройной рефрен ради ритма, открытие риторическим вопросом без напряжения, двойное проговаривание одной мысли, идеально ровный ритм всех предложений.

---

ФИНАЛЬНАЯ ПРОВЕРКА (если хотя бы одно «нет» — перепиши):
Ноль букв с двумя точками в тексте, проверено посимвольно.
Ноль тире и дефисов как пунктуации.
Ноль хэштегов.
Есть личный якорь.
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

ДОПОЛНИТЕЛЬНО — убрать если встречается:
«Вот как...», «Вот что...», «Результат?», «В заключение...», «Честно говоря...», «Знакомо?», «Что это значит для вас?»
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

async function runTelegramCritic(postText) {
  const system = `Ты редактор Telegram-канала iGaming практика с 18 годами в спортбуке. Получаешь черновик поста и возвращаешь усиленную версию.

Проверь по четырем осям и улучши слабые места:

1. ПЕРВАЯ ФРАЗА — сообщает предмет сразу или интригует пустотой? Если пустая или вопросительная — перепиши.
2. ЛИЧНЫЙ ЯКОРЬ — есть деталь показывающая что автор это видел лично, не прочитал? Если нет — добавь или усиль одним предложением.
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
});
