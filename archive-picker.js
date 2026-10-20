'use strict';
// Еженедельная подборка «Что почитать из архива» для канала.
// Без внешних зависимостей. Подключается из server.js: require('./archive-picker')(deps).
// Callback-префикс «ar:» (префикс «ap:» занят автопилотом).

const ARCHIVE_CHANNEL = (process.env.ARCHIVE_CHANNEL || 'skakunov_igaming').replace(/^@/, '').trim();
const WEEKDAY = clampInt(process.env.ARCHIVE_WEEKDAY, 0, 6, 0);              // 0 воскресенье, 1 понедельник, 6 суббота
const WEEKLY_TIME = /^\d{1,2}:\d{2}$/.test(process.env.ARCHIVE_TIME || '') ? process.env.ARCHIVE_TIME : '11:00';
const TIME_ZONE = process.env.TIME_ZONE || 'Europe/Warsaw';
const MIN_AGE_DAYS = Number(process.env.MIN_AGE_DAYS) || 14;
const REPEAT_COOLDOWN_DAYS = Number(process.env.REPEAT_COOLDOWN_DAYS) || 84;
const LOOKBACK_DAYS = Number(process.env.ARCHIVE_LOOKBACK_DAYS) || 365;
const DRY_RUN = String(process.env.DRY_RUN === undefined ? 'true' : process.env.DRY_RUN).toLowerCase() !== 'false';
const HISTORY_DS_ID = process.env.ARCHIVE_NOTION_DS_ID || '60f3466c-3f35-4005-a915-5cfb07b16d02';
const MAX_PAGES = 20;
const PAGE_PAUSE_MS = 500;
const CANDIDATES = 5;
const PICK = 3;
const TITLE_MAX = 90;
const HEADER = 'Что почитать из архива';
// Веса ранжирования: перцентиль по просмотрам и перцентиль по реакциям на 1000 просмотров
const W_VIEWS = 0.6;
const W_REACTIONS = 0.4;

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
}

// ---------- Разбор страницы t.me/s/ ----------

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function htmlToText(html) {
  return decodeEntities(String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').trim();
}

// «1.2K» → 1200, «3M» → 3000000, «1 234» → 1234
function parseCount(raw) {
  const s = String(raw || '').replace(/\s/g, '').replace(',', '.');
  const m = /^(\d+(?:\.\d+)?)([KkMm]?)$/.exec(s);
  if (!m) return 0;
  const mult = m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1;
  return Math.round(Number(m[1]) * mult);
}

// Возвращает массив постов со страницы: { id, url, date, text, views, reactions }
function parseChannelPage(html, channel) {
  const posts = [];
  const parts = String(html).split(/<div class="tgme_widget_message_wrap/).slice(1);
  for (const part of parts) {
    const idm = new RegExp('data-post="' + channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(\\d+)"', 'i').exec(part);
    if (!idm) continue;
    const id = Number(idm[1]);
    // Основной текст помечен js-message_text; текст цитаты ответа (js-message_reply_text) пропускаем
    let text = '';
    const tre = /<div class="tgme_widget_message_text([^"]*)"[^>]*>([\s\S]*?)<\/div>/g;
    let tm;
    while ((tm = tre.exec(part))) {
      if (/js-message_reply_text/.test(tm[1])) continue;
      text = htmlToText(tm[2]);
      break;
    }
    const dm = /<time[^>]*datetime="([^"]+)"/.exec(part);
    const date = dm ? new Date(dm[1]) : null;
    const vm = /<span class="tgme_widget_message_views">([^<]*)<\/span>/.exec(part);
    let reactions = 0;
    const rx = /<span class="tgme_reaction[^"]*"[^>]*>([\s\S]*?)<\/span>/g;
    let r;
    while ((r = rx.exec(part))) {
      const t = htmlToText(r[1]);
      const cm = /(\d[\d.,]*\s*[KkMm]?)\s*$/.exec(t);
      if (cm) reactions += parseCount(cm[1]);
    }
    posts.push({
      id,
      url: `https://t.me/${channel}/${id}`,
      date: date && !isNaN(date) ? date : null,
      text,
      views: vm ? parseCount(vm[1]) : 0,
      reactions
    });
  }
  return posts;
}

function firstLine(text, max = TITLE_MAX) {
  const line = String(text || '').split('\n').map(s => s.trim()).find(Boolean) || '';
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s.,;:!?]+$/, '') + '…';
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- Ранжирование ----------

function percentileRanks(values) {
  const n = values.length;
  if (n <= 1) return values.map(() => 1);
  const sorted = [...values].sort((a, b) => a - b);
  return values.map(v => {
    const first = sorted.indexOf(v);
    const last = sorted.lastIndexOf(v);
    return ((first + last) / 2) / (n - 1);
  });
}

function dayKey(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function pickCandidates(pool, count = CANDIDATES) {
  if (!pool.length) return [];
  const vr = percentileRanks(pool.map(p => p.views));
  const rr = percentileRanks(pool.map(p => (p.views > 0 ? p.reactions / p.views * 1000 : 0)));
  const scored = pool.map((p, i) => ({ p, score: W_VIEWS * vr[i] + W_REACTIONS * rr[i] })).sort((a, b) => b.score - a.score);
  const out = [];
  const days = new Set();
  for (const { p } of scored) {
    const dk = p.date ? dayKey(p.date) : 'x' + p.id;
    if (days.has(dk)) continue;
    days.add(dk);
    out.push(p);
    if (out.length >= count) break;
  }
  return out;
}

function formatDateRu(d) {
  if (!d) return '';
  const sameYear = dayKey(d).slice(0, 4) === dayKey(new Date()).slice(0, 4);
  return new Intl.DateTimeFormat('ru-RU', { timeZone: TIME_ZONE, day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) }).format(d);
}

function buildDigestText(items) {
  const blocks = items.map(p => `<a href="${escHtml(p.url)}">${escHtml(p.title || firstLine(p.text) || 'Пост ' + p.id)}</a>\n${escHtml(formatDateRu(p.date))}`.trim());
  return `${HEADER}\n\n${blocks.join('\n\n')}`;
}

// Время в часовом поясе: { weekday 0..6, hh, mm, ymd }
function zonedNow(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const g = t => (parts.find(x => x.type === t) || {}).value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[g('weekday')];
  return { weekday: wd, hh: Number(g('hour')), mm: Number(g('minute')), ymd: `${g('year')}-${g('month')}-${g('day')}` };
}

// ---------- Модуль ----------

function createArchivePicker(deps) {
  const { tgApi, botSend, notionReq, scrubToken, owners, channelId } = deps;
  const log = (...a) => console.error('archive-picker:', ...a.map(x => (x && x.message) ? scrubToken(x.message) : x));
  const ownerId = () => { const o = typeof owners === 'function' ? owners() : owners; return o && o[0] ? Number(o[0]) : null; };
  const channelTarget = () => (typeof channelId === 'function' ? channelId() : channelId);

  let session = null;        // { chatId, messageId, candidates, selected: [post], awaitingLink, pendingExtra, mode }
  let lastFiredKey = null;
  let lastPublishedAt = null;
  let lastRunError = null;
  let running = false;

  // --- сбор постов ---
  async function fetchPage(before) {
    const url = `https://t.me/s/${ARCHIVE_CHANNEL}` + (before ? `?before=${before}` : '');
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PostBot/1.0)', 'Accept-Language': 'ru' }, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`t.me HTTP ${resp.status}`);
    return resp.text();
  }

  async function collectPosts() {
    const all = new Map();
    const limit = Date.now() - LOOKBACK_DAYS * 86400000;
    let before = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const posts = parseChannelPage(await fetchPage(before), ARCHIVE_CHANNEL);
      if (!posts.length) break;
      posts.forEach(p => all.set(p.id, p));
      const minId = Math.min(...posts.map(p => p.id));
      const oldest = posts.filter(p => p.date).map(p => p.date.getTime());
      if (before !== null && minId >= before) break;
      before = minId;
      if (minId <= 1) break;
      if (oldest.length && Math.min(...oldest) < limit) break;
      await new Promise(r => setTimeout(r, PAGE_PAUSE_MS));
    }
    return [...all.values()].filter(p => p.text && !p.text.startsWith(HEADER));
  }

  // --- история в Notion ---
  async function loadUsedIds() {
    const used = new Set();
    let cursor;
    const since = new Date(Date.now() - REPEAT_COOLDOWN_DAYS * 86400000).toISOString().slice(0, 10);
    for (let i = 0; i < 10; i++) {
      const data = await notionReq('POST', `/v1/data_sources/${HISTORY_DS_ID}/query`, {
        filter: { property: 'Used at', date: { on_or_after: since } }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {})
      });
      for (const r of data.results || []) {
        const n = r.properties && r.properties['Post ID'] && r.properties['Post ID'].number;
        if (n) used.add(Number(n));
      }
      if (!data.has_more) break;
      cursor = data.next_cursor;
    }
    return used;
  }

  async function saveUsed(items) {
    const today = new Date().toISOString().slice(0, 10);
    for (const p of items) {
      await notionReq('POST', '/v1/pages', {
        parent: { type: 'data_source_id', data_source_id: HISTORY_DS_ID },
        properties: {
          'Title': { title: [{ type: 'text', text: { content: (p.title || firstLine(p.text) || 'Пост ' + p.id).slice(0, 200) } }] },
          'Post ID': { number: p.id },
          'URL': { url: p.url },
          'Used at': { date: { start: today } }
        }
      });
    }
  }

  // --- клавиатуры и тексты ---
  function candidatesText() {
    const s = session;
    const lines = s.candidates.map((p, i) => {
      const mark = s.selected.some(x => x.id === p.id) ? '✅ ' : '';
      return `${mark}${i + 1}. ${p.title}\n${formatDateRu(p.date)}, просмотров ${p.views}, реакций ${p.reactions}\n${p.url}`;
    });
    const extras = s.selected.filter(x => !s.candidates.some(c => c.id === x.id));
    const extraLine = extras.length ? `\n\nСвои ссылки: ${extras.map(x => x.title).join('; ')}` : '';
    return `${HEADER}: кандидаты на неделю\nВыбери три, выбрано ${s.selected.length} из ${PICK}.\n\n${lines.join('\n\n')}${extraLine}`;
  }

  function candidatesKeyboard() {
    const s = session;
    const nums = s.candidates.map((p, i) => ({ text: (s.selected.some(x => x.id === p.id) ? '✅ ' : '') + (i + 1), callback_data: 'ar:t:' + i }));
    return { inline_keyboard: [
      nums,
      [{ text: 'Своя ссылка', callback_data: 'ar:l' }],
      [{ text: `Предпросмотр ${s.selected.length}/${PICK}`, callback_data: 'ar:p' }],
      [{ text: 'Отмена', callback_data: 'ar:x' }]
    ] };
  }

  const edit = (text, kb, extra = {}) => tgApi('editMessageText', {
    chat_id: session.chatId, message_id: session.messageId, text,
    reply_markup: kb || { inline_keyboard: [] }, disable_web_page_preview: true, ...extra
  }).catch(e => { if (!/not modified/i.test(String(e.message))) log('edit', e); });

  async function render() {
    return edit(candidatesText(), candidatesKeyboard());
  }

  // --- сценарий ---
  async function suggest(chatId, { auto = false } = {}) {
    if (running) return botSend(chatId, 'Подборка уже собирается, подожди минуту.');
    if (session && session.mode !== 'done' && auto) return null;   // висит неподтвержденная
    running = true;
    try {
      await botSend(chatId, 'Собираю архив канала…');
      const [posts, used] = await Promise.all([
        collectPosts(),
        loadUsedIds().catch(e => { log('история недоступна', e); botSend(chatId, 'База истории в Notion недоступна, повторы не отсеиваются. Открой базу «PostBot: архив, использованные посты» интеграции (меню «…» → Connections).').catch(() => {}); return new Set(); })
      ]);
      if (!posts.length) throw new Error('со страницы канала не пришло ни одного поста');
      const minAge = Date.now() - MIN_AGE_DAYS * 86400000;
      const pool = posts.filter(p => (!p.date || p.date.getTime() <= minAge) && !used.has(p.id));
      const picked = pickCandidates(pool).map(p => ({ ...p, title: firstLine(p.text) || 'Пост ' + p.id }));
      if (!picked.length) return botSend(chatId, `Подходящих постов нет: все свежее ${MIN_AGE_DAYS} дн. или уже использованы за ${REPEAT_COOLDOWN_DAYS} дн.`);
      session = { chatId, messageId: null, candidates: picked, selected: [], awaitingLink: false, pendingExtra: null, mode: 'pick' };
      const sent = await botSend(chatId, candidatesText(), { reply_markup: candidatesKeyboard(), disable_web_page_preview: true });
      session.messageId = sent.message_id;
      lastRunError = null;
    } catch (e) {
      lastRunError = scrubToken(e.message);
      log('suggest', e);
      await botSend(chatId, 'Не удалось собрать архив: ' + scrubToken(e.message).slice(0, 250)).catch(() => {});
    } finally { running = false; }
  }

  async function findPost(id) {
    if (session) {
      const hit = session.candidates.find(c => c.id === id);
      if (hit) return hit;
    }
    try {
      const html = await (await fetch(`https://t.me/${ARCHIVE_CHANNEL}/${id}?embed=1`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PostBot/1.0)' }, signal: AbortSignal.timeout(15000) })).text();
      const p = parseChannelPage('<div class="tgme_widget_message_wrap">' + html, ARCHIVE_CHANNEL).find(x => x.id === id);
      const text = p && p.text;
      return { id, url: `https://t.me/${ARCHIVE_CHANNEL}/${id}`, date: p && p.date, text: text || '', views: p ? p.views : 0, reactions: p ? p.reactions : 0, title: firstLine(text) || 'Пост ' + id };
    } catch {
      return { id, url: `https://t.me/${ARCHIVE_CHANNEL}/${id}`, date: null, text: '', views: 0, reactions: 0, title: 'Пост ' + id };
    }
  }

  function parseOwnLink(text) {
    const m = new RegExp('(?:https?://)?(?:www\\.)?t\\.me/' + ARCHIVE_CHANNEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(\\d+)', 'i').exec(String(text || ''));
    return m ? Number(m[1]) : null;
  }

  async function handleMessage(msg) {
    if (!msg || !msg.text) return false;
    const owner = ownerId();
    if (!owner || msg.from.id !== owner) return false;
    const cmd = msg.text.trim().split(/\s|@/)[0].toLowerCase();
    if (cmd === '/suggest') { await suggest(msg.chat.id); return true; }
    if (cmd === '/status') {
      const w = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'][WEEKDAY];
      await botSend(msg.chat.id, `Подборка из архива: ${w} в ${WEEKLY_TIME} (${TIME_ZONE}).\nРежим: ${DRY_RUN ? 'DRY_RUN, в канал не публикуется' : 'боевой, публикация после подтверждения'}.\nКанал: ${ARCHIVE_CHANNEL}. Свежее ${MIN_AGE_DAYS} дн. не берется, повтор не раньше чем через ${REPEAT_COOLDOWN_DAYS} дн.\nПоследняя публикация: ${lastPublishedAt ? formatDateRu(lastPublishedAt) : 'с запуска сервера не было'}.${lastRunError ? '\nПоследняя ошибка: ' + lastRunError : ''}`);
      return true;
    }
    if (session && session.awaitingLink && !msg.text.startsWith('/')) {
      const id = parseOwnLink(msg.text);
      if (!id) { await botSend(msg.chat.id, `Нужна ссылка на пост канала, например https://t.me/${ARCHIVE_CHANNEL}/123`, { disable_web_page_preview: true }); return true; }
      session.awaitingLink = false;
      if (session.selected.some(x => x.id === id)) { await botSend(msg.chat.id, 'Этот пост уже выбран.'); await render(); return true; }
      const post = await findPost(id);
      if (session.selected.length < PICK) {
        session.selected.push(post);
        await render();
      } else {
        session.pendingExtra = post;
        session.mode = 'replace';
        const rows = session.selected.map((p, i) => [{ text: `Заменить: ${p.title}`.slice(0, 60), callback_data: 'ar:r:' + i }]);
        rows.push([{ text: 'Отмена', callback_data: 'ar:b' }]);
        await edit(`Уже выбрано три. Какой пост заменить на «${post.title}»?`, { inline_keyboard: rows });
      }
      return true;
    }
    return false;
  }

  async function handleCallback(cb) {
    const answer = (text, alert = false) => tgApi('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert }).catch(() => {});
    const owner = ownerId();
    if (!owner || cb.from.id !== owner) return answer('Нет доступа', true);
    if (!session || !cb.message || cb.message.message_id !== session.messageId) return answer('Подборка устарела, вызови /suggest', true);
    const data = String(cb.data || '');
    const m = /^ar:(t|l|p|x|b|go|r)(?::(\d+))?$/.exec(data);
    if (!m) return answer('Неизвестная кнопка');
    const [, kind, arg] = m;
    const s = session;

    if (kind === 't') {
      const p = s.candidates[Number(arg)];
      if (!p) return answer('Нет такого номера');
      const at = s.selected.findIndex(x => x.id === p.id);
      if (at >= 0) s.selected.splice(at, 1);
      else if (s.selected.length >= PICK) return answer(`Уже выбрано ${PICK}, сними одно`, true);
      else s.selected.push(p);
      await answer();
      return render();
    }
    if (kind === 'l') {
      s.awaitingLink = true;
      await answer();
      return botSend(s.chatId, `Пришли ссылку на пост канала, например https://t.me/${ARCHIVE_CHANNEL}/123`, { disable_web_page_preview: true });
    }
    if (kind === 'r') {
      const i = Number(arg);
      if (!s.pendingExtra || !s.selected[i]) { s.mode = 'pick'; await answer(); return render(); }
      s.selected[i] = s.pendingExtra;
      s.pendingExtra = null;
      s.mode = 'pick';
      await answer('Заменено');
      return render();
    }
    if (kind === 'b') {
      s.mode = 'pick'; s.pendingExtra = null; s.awaitingLink = false;
      await answer();
      return render();
    }
    if (kind === 'x') {
      s.mode = 'done';
      await answer('Отменено');
      await edit('Подборка отменена.');
      session = null;
      return;
    }
    if (kind === 'p') {
      if (s.selected.length !== PICK) return answer(`Нужно ровно ${PICK}, сейчас ${s.selected.length}`, true);
      s.mode = 'preview';
      await answer();
      const label = DRY_RUN ? '[DRY RUN, в канал не уйдет]\n\n' : '';
      return edit(label + buildDigestText(s.selected), { inline_keyboard: [
        [{ text: DRY_RUN ? 'Отправить мне (DRY RUN)' : 'Опубликовать', callback_data: 'ar:go' }],
        [{ text: 'Изменить выбор', callback_data: 'ar:b' }, { text: 'Отмена', callback_data: 'ar:x' }]
      ] }, { parse_mode: 'HTML' });
    }
    if (kind === 'go') {
      if (s.mode !== 'preview' || s.selected.length !== PICK) return answer('Сначала предпросмотр', true);
      const text = buildDigestText(s.selected);
      const items = s.selected.slice();
      s.mode = 'done';
      await answer(DRY_RUN ? 'DRY RUN' : 'Публикую…');
      try {
        if (DRY_RUN) {
          await botSend(s.chatId, '[DRY RUN]\n\n' + text, { parse_mode: 'HTML', disable_web_page_preview: true });
          await edit('Проверено в режиме DRY RUN: сообщение отправлено тебе, в канал ничего не ушло, история не записана.');
        } else {
          const target = channelTarget();
          if (!target) throw new Error('не задан TELEGRAM_CHANNEL_ID');
          await tgApi('sendMessage', { chat_id: target, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
          lastPublishedAt = new Date();
          let note = 'Опубликовано.';
          await saveUsed(items).catch(e => { log('история не записана', e); note += ' История в Notion не записалась, следи, чтобы эти посты не попали в следующую подборку.'; });
          await edit(note + '\n\n' + text, null, { parse_mode: 'HTML' });
        }
      } catch (e) {
        log('publish', e);
        s.mode = 'preview';
        await botSend(s.chatId, 'Не удалось опубликовать: ' + scrubToken(e.message).slice(0, 250)).catch(() => {});
        return;
      }
      session = null;
    }
  }

  // --- расписание ---
  function tick() {
    const owner = ownerId();
    if (!owner) return;
    const now = zonedNow();
    if (now.weekday !== WEEKDAY) return;
    const [th, tm] = WEEKLY_TIME.split(':').map(Number);
    const minutesPast = (now.hh * 60 + now.mm) - (th * 60 + tm);
    if (minutesPast < 0 || minutesPast > 60) return;
    if (lastFiredKey === now.ymd) return;
    lastFiredKey = now.ymd;
    suggest(owner, { auto: true }).catch(e => log('tick', e));
  }

  function start() {
    if (!ownerId()) { console.log('archive-picker: выключен, нет TELEGRAM_ALLOWED_USER_IDS'); return; }
    setInterval(tick, 60 * 1000);
    console.log(`archive-picker: включен, ${DRY_RUN ? 'DRY_RUN' : 'боевой режим'}, день ${WEEKDAY}, время ${WEEKLY_TIME} ${TIME_ZONE}`);
  }

  return { start, handleMessage, handleCallback, _internal: { parseChannelPage, parseCount, pickCandidates, firstLine, buildDigestText, parseOwnLink } };
}

module.exports = createArchivePicker;
module.exports._pure = { parseChannelPage, parseCount, pickCandidates, firstLine, buildDigestText, zonedNow, percentileRanks };
