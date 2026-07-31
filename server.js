import express from 'express';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// Фикс кодировки консоли Windows: иначе русские логи и промпты превращаются в "??????"
if (process.platform === 'win32') {
  try {
    const { execSync } = await import('child_process');
    execSync('chcp 65001', { stdio: 'ignore' });
    process.stdout.setDefaultEncoding('utf8');
  } catch (_) {}
}

const app = express();
app.use(express.json({ limit: '5mb' }));

// Создаем папки один раз при запуске
const outputDir = path.join(process.cwd(), 'output');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Файловый режим: prompts/ — сюда кладут .txt с промптом, prompts/done/ — отчеты
const promptsDir = path.join(process.cwd(), 'prompts');
const promptsDoneDir = path.join(promptsDir, 'done');
for (const dir of [promptsDir, promptsDoneDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const TOKENS_FILE = path.join(process.cwd(), 'tokens.txt');
const USED_TOKENS_FILE = path.join(process.cwd(), 'used_tokens.txt');

// Разбирает строку вида "1)eyJhbGci..." или голый токен
function parseTokenLine(line) {
  const m = line.trim().match(/^(\d+)\)\s*(\S+)/);
  if (m && m[2].length > 20) return { num: parseInt(m[1], 10), token: m[2] };
  const bare = line.trim();
  if (bare.length > 20 && !bare.includes('#')) return { num: null, token: bare };
  return null;
}

function loadTokens() {
  if (!fs.existsSync(TOKENS_FILE)) {
    console.error('❌ Файл tokens.txt не найден!');
    return [];
  }
  const rawContent = fs.readFileSync(TOKENS_FILE, 'utf-8');
  return rawContent
    .split(/[\r\n]+/)
    .map(line => parseTokenLine(line))
    .filter(Boolean)
    .map(x => x.token);
}



// Токены перечитываем с диска при каждом обращении — файлы правит и сервер, и пользователь
let tokensPool = loadTokens();
const exhaustedTokens = new Set();
let currentTokenIndex = 0;

console.log(`🔑 Загружено токенов: ${tokensPool.length}`);

// Переносит токен из tokens.txt в used_tokens.txt с префиксом U и перезагружает пул
function markTokenUsedInFile(token) {
  try {
    const lines = fs.existsSync(TOKENS_FILE)
      ? fs.readFileSync(TOKENS_FILE, 'utf-8').split(/\r?\n/)
      : [];

    const kept = [];
    let removed = false;
    let originalNum = null;
    for (const line of lines) {
      const parsed = parseTokenLine(line);
      if (!removed && parsed && parsed.token === token) {
        removed = true; // вырезаем строку с токеном целиком
        originalNum = parsed.num;
        continue;
      }
      kept.push(line);
    }

    // Убираем пустые хвостовые строки
    while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
    fs.writeFileSync(TOKENS_FILE, kept.join('\n') + (kept.length ? '\n' : ''), 'utf-8');

    // В файл использованных: порядковый номер исчерпания + исходный номер + токен
    // Пример: "1)3)eyJhbGci..." — первым исчерпал аккаунт №3
    if (removed) {
      const stamp = new Date().toISOString();
      const usageCount = fs.existsSync(USED_TOKENS_FILE)
        ? fs.readFileSync(USED_TOKENS_FILE, 'utf-8').split(/\r?\n/).filter(l => l.trim()).length
        : 0;
      const prefix = originalNum != null ? `${usageCount + 1})${originalNum})` : `${usageCount + 1})`;
      fs.appendFileSync(USED_TOKENS_FILE, `${prefix}${token}  # used at ${stamp}\n`, 'utf-8');
      console.log(`🗃️ Токен перенесен: tokens.txt → used_tokens.txt (запись ${prefix}...)`);
    }
  } catch (e) {
    console.error(`⚠️ Не удалось обновить файлы токенов: ${e.message}`);
  }

  tokensPool = loadTokens();
  exhaustedTokens.add(token);

  // Индекс не должен указывать за пределы нового пула
  if (tokensPool.length === 0) {
    currentTokenIndex = 0;
  } else {
    currentTokenIndex = currentTokenIndex % tokensPool.length;
  }
}

// Пул мог обновиться снаружи (докинули токены в tokens.txt) — перечитываем
function refreshTokensPool() {
  const fresh = loadTokens();
  if (fresh.length !== tokensPool.length || fresh.some(t => !tokensPool.includes(t))) {
    tokensPool = fresh;
    // Выкинуть из exhausted то, чего больше нет в файле used (пользователь вернул токен вручную)
    if (tokensPool.length > 0) currentTokenIndex = currentTokenIndex % tokensPool.length;
    console.log(`🔑 Пул токенов обновлен с диска: ${tokensPool.length} шт.`);
  }
}

let browser;
let context;
let page;

// --- Fallback-хранилище состояния чата из БД-запросов (Supabase и др.) ---
// Если share-link перенос по какой-то причине не сработает, здесь остаётся
// последнее перехваченное состояние чата (сообщения, файлы, версии).
const dbSniffLog = []; // кольцевой лог последних БД-ответов
const DB_SNIFF_LIMIT = 50;
let lastChatState = null; // { chatId, capturedAt, payload }

function attachDbSniffer(targetPage) {
  targetPage.on('response', async (response) => {
    try {
      const url = response.url();
      const looksLikeDb =
        url.includes('supabase') ||
        url.includes('/rest/v1/') ||
        url.includes('/api/chats') ||
        url.includes('/api/chat/') ||
        url.includes('postgres');

      if (!looksLikeDb || !response.ok()) return;

      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;

      const json = await response.json().catch(() => null);
      if (!json) return;

      const entry = { at: new Date().toISOString(), url, json };
      dbSniffLog.push(entry);
      if (dbSniffLog.length > DB_SNIFF_LIMIT) dbSniffLog.shift();

      // Эвристика: ответы, похожие на состояние чата с файлами/версиями
      const s = JSON.stringify(json);
      if (s.includes('"files"') || s.includes('"versions"') || s.includes('"messages"')) {
        const chatIdMatch = url.match(/chat[s]?\/([a-zA-Z0-9-]+)/);
        lastChatState = {
          chatId: chatIdMatch ? chatIdMatch[1] : null,
          capturedAt: entry.at,
          payload: json
        };
      }
    } catch (_) {
      // сниффер не должен ронять основной поток
    }
  });
}

async function setSessionCookie(token) {
  await context.clearCookies();
  await context.addCookies([{
    name: 'user_session',
    value: token,
    domain: 'v0.app',
    path: '/',
    httpOnly: true,
    secure: true
  }]);
}

async function ensurePageAlive() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write']
    });
    page = null;
  }
  if (!page || page.isClosed()) {
    if (tokensPool.length > 0) {
      await setSessionCookie(tokensPool[currentTokenIndex]);
    }
    page = await context.newPage();
    attachDbSniffer(page);
    await page.goto('https://v0.app');
  }
}

// --- Перенос сессии через share-ссылку ---

// На текущем аккаунте: открыть Share → выставить "Anyone on the web" → вернуть ссылку
// Каждый шаг ограничен по времени и логируется, чтобы перенос не зависал молча
async function enableSharingAndGetLink() {
  // 1. Кнопка Share: прямая в шапке чата, либо внутри меню "..."
  console.log('🔍 Шаг 1/4: ищу кнопку Share...');
  let shareClicked = false;

  const directShare = page.locator('button:has-text("Share")').first();
  if (await directShare.isVisible({ timeout: 3000 }).catch(() => false)) {
    await directShare.click();
    shareClicked = true;
  } else {
    const moreBtn = page.locator('button[aria-label*="more" i], button[aria-label*="options" i], button[aria-label*="menu" i], button:has-text("..."), button:has-text("⋯")').first();
    if (await moreBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await moreBtn.click();
      await page.waitForTimeout(500);
      const menuShare = page.locator('[role="menuitem"]:has-text("Share"), [role="menu"] button:has-text("Share"), [role="menu"] [role="menuitem"]:has-text("Share")').first();
      await menuShare.click({ timeout: 4000 });
      shareClicked = true;
    }
  }

  if (!shareClicked) {
    // Последняя надежда: иконка-стрелка/поделиться в шапке
    const iconShare = page.locator('header button[aria-label*="share" i], button[aria-label*="share" i]').first();
    if (await iconShare.isVisible({ timeout: 2000 }).catch(() => false)) {
      await iconShare.click();
      shareClicked = true;
    }
  }

  if (!shareClicked) throw new Error('кнопка Share не найдена на странице чата');
  await page.waitForTimeout(1500);

  // 2. Диалог Share открыт? Переключаем Visibility → "Anyone on the web"
  console.log('🔍 Шаг 2/4: выставляю "Anyone on the web"...');
  const dialog = page.locator('[role="dialog"]').last();
  await dialog.waitFor({ state: 'visible', timeout: 5000 });

  const visibilityDropdown = dialog.locator(
    'button:has-text("Only people with access"), [role="combobox"]:has-text("Only people"), button:has-text("Only people")'
  ).first();

  if (await visibilityDropdown.isVisible({ timeout: 2500 }).catch(() => false)) {
    await visibilityDropdown.click();
    await page.waitForTimeout(700);
    const anyoneOption = page.locator(
      '[role="option"]:has-text("Anyone on the web"), [role="menuitem"]:has-text("Anyone on the web"), [role="listbox"] *:has-text("Anyone on the web")'
    ).first();
    await anyoneOption.click({ timeout: 4000 });
    await page.waitForTimeout(1500); // ждем применения настроек на сервере
    console.log('🌐 Видимость переключена на "Anyone on the web"');
  } else {
    console.log('ℹ️ Дропдаун видимости не найден — возможно, чат уже публичный');
  }

  // 3. Copy Link
  console.log('🔍 Шаг 3/4: нажимаю Copy Link...');
  const copyBtn = dialog.locator('button:has-text("Copy Link"), button:has-text("Copy link")').first();
  await copyBtn.click({ timeout: 4000 });
  await page.waitForTimeout(700);

  // 4. Читаем ссылку: clipboard → input в диалоге
  console.log('🔍 Шаг 4/4: читаю ссылку...');
  let shareUrl = '';
  try {
    shareUrl = await Promise.race([
      page.evaluate(() => navigator.clipboard.readText()),
      new Promise((_, rej) => setTimeout(() => rej(new Error('clipboard timeout')), 3000))
    ]);
  } catch (_) {}

  if (!shareUrl || !shareUrl.startsWith('http')) {
    shareUrl = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) return '';
      const inp = dlg.querySelector('input[readonly], input[value*="http"], input[type="url"]');
      return inp ? inp.value : '';
    });
  }

  await page.keyboard.press('Escape'); // закрыть диалог
  await page.waitForTimeout(300);

  if (!shareUrl || !shareUrl.startsWith('http')) {
    throw new Error('ссылка не прочитана ни из буфера, ни из поля диалога');
  }

  console.log(`🔗 Share-ссылка получена: ${shareUrl}`);
  return shareUrl;
}

// На новом аккаунте: открыть share-ссылку и нажать Duplicate → чат клонируется со всеми файлами
async function duplicateChatFromLink(shareUrl) {
  console.log('🔍 Открываю share-ссылку на новом аккаунте...');
  await page.goto(shareUrl, { timeout: 20000 });
  await page.waitForTimeout(3000);

  const dupBtn = page.locator('button:has-text("Duplicate"), a:has-text("Duplicate"), button:has-text("Fork"), button:has-text("Remix")').first();
  await dupBtn.waitFor({ state: 'visible', timeout: 15000 });
  console.log('🔍 Кнопка Duplicate найдена, кликаю...');
  await dupBtn.click();

  // Ждем редиректа в клонированный чат нового аккаунта
  await page.waitForURL(/\/(chat|r)\//, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const newUrl = page.url();
  console.log(`📋 Чат продублирован в новый аккаунт: ${newUrl}`);
  return newUrl;
}

// Полный цикл переноса: share на старом → смена cookie → duplicate на новом
async function migrateSessionToNextToken() {
  const currentUrl = page.url();
  const inChat = currentUrl.includes('/chat/') || currentUrl.includes('/r/');

  let shareUrl = null;
  if (inChat) {
    try {
      // Жесткий таймаут на весь share-ритуал — перенос не должен висеть
      shareUrl = await Promise.race([
        enableSharingAndGetLink(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут share-ритуала (30 сек)')), 30000))
      ]);
    } catch (e) {
      console.log(`⚠️ Share-link не получен (${e.message}). Полагаемся на БД-fallback.`);
    }
  }

  const hasNext = await switchToNextToken();
  if (!hasNext) return false;

  if (shareUrl) {
    try {
      await duplicateChatFromLink(shareUrl);
    } catch (e) {
      console.log(`⚠️ Duplicate не удался (${e.message}). Пробуем открыть исходный URL.`);
      if (inChat) await page.goto(currentUrl);
    }
  } else if (inChat) {
    // Без share-ссылки приватный чат новому аккаунту недоступен — логируем fallback-состояние
    if (lastChatState) {
      console.log(`💾 Fallback: используем перехваченное состояние чата от ${lastChatState.capturedAt}`);
      const dumpPath = path.join(outputDir, `chat-state-${Date.now()}.json`);
      fs.writeFileSync(dumpPath, JSON.stringify(lastChatState, null, 2), 'utf-8');
      console.log(`💾 Состояние сохранено: ${dumpPath}`);
    }
    await page.goto('https://v0.app');
  } else {
    await page.goto('https://v0.app');
  }

  return true;
}

async function switchToNextToken() {
  if (tokensPool.length === 0) {
    console.error('🚨 Пул токенов пуст! Докиньте токенов в tokens.txt');
    return false;
  }

  const idx = currentTokenIndex % tokensPool.length;
  const usedToken = tokensPool[idx];
  console.log(`⚠️ Аккаунт #${idx + 1} исчерпал лимит кредитов.`);

  // Сразу переносим в used_tokens.txt с префиксом U и перечитываем пул
  markTokenUsedInFile(usedToken);

  // Сканируем свежий пул с начала: старые позиции сдвинулись после вырезания строки
  for (let i = 0; i < tokensPool.length; i++) {
    const candidate = tokensPool[i];
    if (!exhaustedTokens.has(candidate)) {
      currentTokenIndex = i;
      console.log(`🔄 Переключились на аккаунт #${i + 1} (свежих токенов в пуле: ${tokensPool.length - exhaustedTokens.size})`);
      await setSessionCookie(candidate);
      return true;
    }
  }

  console.error('🚨 Все аккаунты исчерпали свой баланс! Докиньте токенов в tokens.txt');
  return false;
}

// Проверка лимита кредитов на странице (по фрагментам UI с твоих скриншотов)
async function checkIsPaywall(page) {
  return await page.evaluate(() => {
    const text = document.body.innerText;
    const modal = document.querySelector('[role="dialog"], div[class*="modal"]');

    const paywallKeywords = [
      "Out of Credit",
      "out of credits",
      "Upgrade Plan",
      "reached your generation limit",
      "Upgrade to Pro",
      "No credits remaining",
      "Activate v0 Plus",
      "Subscribe to Plus"
    ];

    const hasTextMatch = paywallKeywords.some(kw => text.includes(kw));
    const hasModalMatch = modal && (
      modal.innerText.includes("Plus") ||
      modal.innerText.includes("Upgrade") ||
      modal.innerText.includes("Billing")
    );

    return hasTextMatch || hasModalMatch;
  });
}

// Поиск и клик по меню выбора моделей
async function openModelMenu() {
  const input = page.locator('textarea, [contenteditable="true"]').first();
  if (await input.isVisible()) {
    await input.click();
    await page.waitForTimeout(300);
  }

  const directBtn = page.locator('button:has-text("v0 Mini"), button:has-text("v0 Pro"), button:has-text("v0 Max"), button:has-text("v0")').first();
  if (await directBtn.isVisible()) {
    await directBtn.click();
    await page.waitForTimeout(500);
    return true;
  }

  const buttons = page.locator('button[aria-haspopup="menu"]');
  const count = await buttons.count();

  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    const txt = (await btn.innerText()).trim();
    const isBad = ['Team', 'Upgrade', 'projects', 'Settings', 'Chat', 'Import', 'Template', 'Start'].some(word => txt.includes(word));

    if (!isBad && txt.length > 0) {
      await btn.click();
      await page.waitForTimeout(500);
      return true;
    }
  }
  return false;
}

async function selectModelInUI(targetModelName) {
  try {
    const opened = await openModelMenu();
    if (!opened) return false;

    let option = page.locator(`[role="menuitem"]:has-text("${targetModelName}")`).first();

    if (await option.isVisible()) {
      await option.click();
      console.log(`🎯 Выбрана модель: ${targetModelName}`);
      return true;
    }

    const moreModelsBtn = page.locator('[role="menuitem"]:has-text("More models")').first();
    if (await moreModelsBtn.isVisible()) {
      await moreModelsBtn.hover();
      await moreModelsBtn.click();
      await page.waitForTimeout(500);

      option = page.locator(`[role="menuitem"]:has-text("${targetModelName}")`).first();
      if (await option.isVisible()) {
        await option.click();
        console.log(`🎯 Выбрана модель из подменю: ${targetModelName}`);
        return true;
      }
    }
  } catch (e) {
    console.log(`⚠️ Ошибка выбора модели: ${e.message}`);
  }
  return false;
}

// --- GET /api/models ---
app.get('/api/models', async (req, res) => {
  try {
    await ensurePageAlive();
    await page.goto('https://v0.app');
    await page.waitForTimeout(2500);

    const opened = await openModelMenu();
    if (!opened) {
      return res.status(500).json({ error: 'Не удалось найти меню моделей' });
    }

    const level1Text = await page.evaluate(() => {
      const menus = document.querySelectorAll('[role="menu"]');
      return menus.length > 0 ? menus[0].innerText : '';
    });

    const moreBtn = page.locator('[role="menuitem"]:has-text("More models")').first();
    let level2Text = '';

    if (await moreBtn.isVisible()) {
      await moreBtn.hover();
      await moreBtn.click();
      await page.waitForTimeout(600);

      level2Text = await page.evaluate(() => {
        const menus = document.querySelectorAll('[role="menu"]');
        return menus.length > 1 ? menus[menus.length - 1].innerText : '';
      });
    }

    await page.keyboard.press('Escape');

    const fullText = `${level1Text}\n${level2Text}`;
    const knownModels = [
      'v0 Mini', 'v0 Pro', 'v0 Max', 'v0 Max Fast',
      'Fable 5', 'Opus 5', 'Opus 5 Fast', 'GPT-5.6 Sol', 'Kimi K3'
    ];

    let foundModels = knownModels.filter(m => fullText.includes(m));

    if (foundModels.length === 0) {
      foundModels = fullText
        .split('\n')
        .map(s => s.trim())
        .filter(s => s && !s.includes('More models') && !s.includes('ACCESS TO ALL') && !s.includes('Upgrade') && s.length < 25);
      foundModels = Array.from(new Set(foundModels));
    }

    return res.json({
      success: true,
      availableModels: foundModels
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /api/chat-state — отладочный просмотр БД-fallback состояния ---
app.get('/api/chat-state', (req, res) => {
  res.json({
    success: true,
    lastChatState,
    recentDbResponsesCount: dbSniffLog.length
  });
});

// --- Файловый режим: парсер .txt с промптом ---
// Формат файла (UTF-8):
//   первая строка — необязательно "model: <имя модели>"
//   остальные строки — текст промпта (русский ок, кодировка UTF-8)
function parsePromptFile(rawText, fallbackModel) {
  const lines = rawText.replace(/^﻿/, '').split(/\r?\n/);
  let model = fallbackModel;
  let startIdx = 0;

  const firstLine = (lines[0] || '').trim();
  const modelMatch = firstLine.match(/^model\s*:\s*(.+)$/i);
  if (modelMatch) {
    model = modelMatch[1].trim();
    startIdx = 1;
  }

  const prompt = lines.slice(startIdx).join('\n').trim();
  return { prompt, model };
}

// --- Основной сценарий генерации, общий для HTTP и файлового режима ---
async function runGeneration({ prompt, model = 'Opus 5', jobName = null, outputSubDir = null }) {
  const saveDir = outputSubDir ? path.join(outputDir, outputSubDir) : outputDir;

  refreshTokensPool();

  if (tokensPool.length === 0 || exhaustedTokens.size >= tokensPool.length) {
    const err = new Error('Все аккаунты исчерпали баланс');
    err.statusCode = 429;
    throw err;
  }

  await ensurePageAlive();

  let attempts = 0;
  currentTokenIndex = currentTokenIndex % tokensPool.length;

  while (attempts < tokensPool.length) {
    attempts++;
    console.log(`\n🚀 Запуск генерации (Аккаунт #${(currentTokenIndex % tokensPool.length) + 1})...`);
    console.log(`📝 Промпт: "${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}"`);

    const currentUrl = page.url();
    if (!currentUrl.includes('/chat/') && !currentUrl.includes('/r/')) {
      await page.goto('https://v0.app');
    }

    const inputSelector = 'textarea, [contenteditable="true"]';
    await page.waitForSelector(inputSelector, { timeout: 15000 });

    // Выбор модели
    await selectModelInUI(model);

    // 1. Отправка промпта
    await page.fill(inputSelector, prompt);
    await page.keyboard.press('Enter');

    // Даем UI 2 секунды на реакцию (вдруг вылезет модалка Out of Credit)
    await page.waitForTimeout(2000);

    // 2. МГНОВЕННАЯ ПРОВЕРКА НА ЛИМИТ КРЕДИТОВ
    let isPaywall = await checkIsPaywall(page);

    if (isPaywall) {
      console.log(`❌ На аккаунте #${(currentTokenIndex % tokensPool.length) + 1} закончились токены (Out of Credit)! Переносим сессию...`);
      const migrated = await migrateSessionToNextToken();
      if (!migrated) break;
      continue;
    }

    // 3. ЖДЕМ СТАРТА
    console.log('⏳ Ждем запуск генерации на сервере v0...');
    let started = false;
    try {
      await page.waitForFunction(() => {
        const text = document.body.innerText;
        const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="Cancel"]');

        const isWorking = text.includes("Generating") ||
                          text.includes("Thinking") ||
                          text.includes("Installing") ||
                          text.includes("Executing") ||
                          text.includes("Building");

        return !!stopBtn || isWorking;
      }, { timeout: 15000 });

      started = true;
      console.log('⚡ Генерация официально пошла!');
    } catch (e) {
      console.log('⚠️ Статус генерации не засечен за 15 сек, но продолжаем контроль...');
    }

    // 4. ЖДЕМ ФИНИША (с динамическим отслеживанием пейволла)
    if (started) {
      console.log('⏳ Ждем полного завершения всех шагов v0...');
      try {
        await page.waitForFunction(() => {
          const text = document.body.innerText;
          const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="Cancel"]');

          const isPaywallPresent = text.includes("Out of Credit") ||
                                   text.includes("out of credits") ||
                                   text.includes("Upgrade Plan") ||
                                   text.includes("Activate v0 Plus");

          const isStillWorking = text.includes("Generating") ||
                                 text.includes("Thinking") ||
                                 text.includes("Installing") ||
                                 text.includes("Executing") ||
                                 text.includes("Building");

          return isPaywallPresent || (!stopBtn && !isStillWorking);
        }, { timeout: 240000 });

        const hitPaywallDuringGen = await checkIsPaywall(page);

        if (hitPaywallDuringGen) {
          console.log(`❌ Генерация прервана: у аккаунта #${(currentTokenIndex % tokensPool.length) + 1} закончились кредиты! Переносим сессию...`);
          const migrated = await migrateSessionToNextToken();
          if (!migrated) break;
          continue;
        }

        console.log('✨ Код сгенерирован! Ждем 4 сек на финализацию файлового дерева...');
        await page.waitForTimeout(4000);
        console.log('🎯 Генерация 100% окончена!');
      } catch (e) {
        throw new Error("Таймаут: генерация заняла больше 4 минут.");
      }
    } else {
      console.log('⏳ Ожидаем 25 секунд на случай быстрой генерации...');
      await page.waitForTimeout(25000);
    }

    // 5. ПЕРЕКЛЮЧАЕМСЯ НА ТАБ CODE И СОБИРАЕМ ФАЙЛЫ
    try {
      const codeTab = page.locator('button:has-text("Code"), [role="tab"]:has-text("Code")').first();
      if (await codeTab.isVisible()) {
        await codeTab.click();
        await page.waitForTimeout(800);
      }
    } catch (e) {}

    console.log('📦 Сборка файлов проекта...');
    const filesData = await page.evaluate(async () => {
      const resultFiles = [];
      const fileElements = Array.from(document.querySelectorAll('[data-filename], button[class*="file"], div[class*="file-item"]'));

      if (fileElements.length > 0) {
        for (const el of fileElements) {
          const filePath = el.getAttribute('data-filename') || el.innerText.trim();
          if (!filePath || !filePath.includes('.')) continue;

          el.click();
          await new Promise(r => setTimeout(r, 400));
          const codeElement = document.querySelector('.monaco-editor, pre, code');
          if (codeElement) {
            resultFiles.push({ relativePath: filePath, content: codeElement.innerText });
          }
        }
      }

      if (resultFiles.length === 0) {
        const codeElement = document.querySelector('.monaco-editor, pre, code');
        if (codeElement) {
          resultFiles.push({ relativePath: 'components/generated-component.tsx', content: codeElement.innerText });
        }
      }

      return resultFiles;
    });

    // Сохраняем файлы в папку output (или output/<имя-задачи> для файлового режима)
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
    const savedFilesInfo = [];
    for (const file of filesData) {
      const fullPath = path.join(saveDir, file.relativePath);
      const dirName = path.dirname(fullPath);

      if (!fs.existsSync(dirName)) {
        fs.mkdirSync(dirName, { recursive: true });
      }
      fs.writeFileSync(fullPath, file.content, 'utf-8');
      savedFilesInfo.push(file.relativePath);
      console.log(`  └─ Сохранен: ${path.relative(process.cwd(), fullPath)}`);
    }

    return {
      success: true,
      chatUrl: page.url(),
      modelUsed: model,
      accountUsed: (currentTokenIndex % tokensPool.length) + 1,
      filesSaved: savedFilesInfo,
      stats: {
        totalAccounts: tokensPool.length,
        exhaustedAccountsCount: exhaustedTokens.size,
        activeAccountsRemaining: tokensPool.length - exhaustedTokens.size
      }
    };
  }

  const err = new Error('Все аккаунты исчерпали лимит');
  err.statusCode = 429;
  throw err;
}

// --- Файловый вотчер: сканирует prompts/ каждые 2 сек ---
let fileJobRunning = false;

async function processPromptFiles() {
  if (fileJobRunning) return;

  const files = fs.readdirSync(promptsDir)
    .filter(f => f.toLowerCase().endsWith('.txt'))
    .sort();

  if (files.length === 0) return;

  fileJobRunning = true;
  const fileName = files[0];
  const jobName = path.basename(fileName, '.txt').replace(/[<>:"/\\|?*]/g, '_');
  const filePath = path.join(promptsDir, fileName);

  try {
    console.log(`\n📄 Найден файл промпта: prompts/${fileName}`);
    const rawText = fs.readFileSync(filePath, 'utf-8');
    const { prompt, model } = parsePromptFile(rawText, 'Opus 5');

    if (!prompt) {
      console.log('⚠️ Файл пустой — промпт не найден, файл удален.');
      fs.unlinkSync(filePath);
      return;
    }

    console.log(`🤖 Модель из файла: ${model}`);
    const result = await runGeneration({ prompt, model, jobName, outputSubDir: jobName });

    // Архивируем файл и пишем отчет рядом
    const doneFile = path.join(promptsDoneDir, fileName);
    fs.renameSync(filePath, doneFile);
    fs.writeFileSync(doneFile.replace(/\.txt$/i, '.result.json'), JSON.stringify(result, null, 2), 'utf-8');
    console.log(`✅ Задача "${jobName}" готова: файлы в output/${jobName}/, отчет в prompts/done/`);

  } catch (err) {
    console.error(`❌ Задача из файла "${fileName}" завершилась ошибкой: ${err.message}`);
    // Файл не удаляем — можно исправить/дождаться сброса кредитов и переименовать, чтобы переиграть
    const failReport = path.join(promptsDoneDir, fileName.replace(/\.txt$/i, '.error.txt'));
    fs.writeFileSync(failReport, `${new Date().toISOString()}\n${err.message}`, 'utf-8');
    // Убираем исходник из очереди, чтобы не крутить его бесконечно
    try { fs.renameSync(filePath, path.join(promptsDoneDir, fileName)); } catch (_) {}
  } finally {
    fileJobRunning = false;
  }
}

setInterval(() => {
  processPromptFiles().catch(e => console.error('❌ Вотчер упал:', e.message));
}, 2000);

// --- POST /api/generate ---
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, model = 'Opus 5' } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Промпт не передан' });

    const result = await runGeneration({ prompt, model });
    return res.json(result);

  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});


app.listen(3000, async () => {
  console.log('🚀 API запущен на http://localhost:3000');
  await ensurePageAlive();
});
