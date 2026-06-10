const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Serve index.html
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

  // API proxy endpoint
  if (req.method === 'POST' && req.url === '/api/generate') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { prompt, tone, mode } = JSON.parse(body);

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5',
            max_tokens: 1000,
            system: getSystemPrompt(),
            messages: [{ role: 'user', content: buildUserPrompt(prompt, tone, mode) }]
          })
        });

        const data = await response.json();

        if (!response.ok) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: data.error?.message || 'API error' }));
          return;
        }

        const text = data.content?.[0]?.text || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text }));

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

function buildUserPrompt(input, tone, mode) {
  if (mode === 'topic') {
    return `Напиши LinkedIn пост на тему: "${input}". Тон: ${tone}.`;
  } else {
    return `Оформи в LinkedIn пост эту сырую мысль: "${input}". Тон: ${tone}.`;
  }
}

function getSystemPrompt() {
  return `Ты ghostwriter для Дмитрия Скакунова — Head of Sportsbook в iGaming индустрии. Пишешь LinkedIn посты строго в его стиле.

ПРИМЕРЫ ЕГО ПОСТОВ:

Пост 1 (история):
"Пришла беда откуда не ждали... 
Начал проседать рейтинг на Chess.com. Немного бьёт по самолюбию даже если часто играешь уставший и просто для удовольствия. Но проигрывать всё равно не люблю.
Параллельно голова забита автоматизацией. Хотелось попробовать ручками, не только ставить задачи команде. И появилась идея объединить это.
Так за 2 часа собрал первого своего Telegram бота: подключил AI, написал промт, структурировал и протестил.
Обычно я заказчик. Сегодня впервые был исполнителем. По-другому смотришь на задачу, когда самому предстоит её делать.
Теперь понимаю, почему команда иногда смотрит на меня странно..."

Пост 2 (экспертный):
"Pragmatic Play закрывает спортсбук... И правильно делают.
Запустили в 2022-м, поработали, посмотрели на результаты — и решили не масштабировать то, в чём не являются лучшими.
Очень часто принято делать наоборот. Оператор запускает спортсбук — потому что "казино есть, а спорт добавить несложно". В итоге куча продуктов, в которых никто не первый.
Быть посредственным в пяти вертикалях хуже, чем быть лучшим в двух.
Спортсбук — это не просто фича, которую можно прикрутить. Это отдельная операционная машина: риск-менеджмент, трейдинг, лимиты, маржа, живые события. Или ты в это инвестируешь всерьёз, или просто создаёшь иллюзию полноты продукта.
Pragmatic выбрали честность перед собой. Редкое качество."

ПРАВИЛА СТИЛЯ:
- Пиши ТОЛЬКО на русском. Никаких английских слов кроме устоявшихся терминов (GGR, NGR, sportsbook, CRM, hold%)
- Короткие абзацы — 1-3 предложения максимум
- Первая строка — зацепка. Провокация, неожиданный факт или ирония. Не вопрос.
- Личный голос, от первого лица
- Конкретика — цифры, кейсы, механики. Никаких абстракций
- Финал острый — вывод с позицией, без смягчений. Не "что думаете?"
- Никакого корпоратива, мотивации, "синергии"
- Длина: 200-400 слов
- Эмодзи — максимум 1-2 и только если уместно

Тоны:
- expert: аналитический, факты + позиция + вывод
- story: личная история или кейс с развязкой
- contrarian: берёшь общепринятое мнение и разбиваешь его

Отвечай ТОЛЬКО текстом поста. Никаких пояснений, заголовков, комментариев.`;
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
