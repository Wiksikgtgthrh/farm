import express from 'express';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { getTokenNumber, loadTokens, loadTokensWithNumbers, moveTokenToUsed, parseTokenLine } from './src/lib/token-store.js';
import { V0ApiError, listChats, createChat, sendMessage, waitForCompletion, saveChatFiles, extractChatId } from './src/services/v0-api.js';

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

// Токены перечитываем с диска при каждом обращении — файлы правит и сервер, и пользователь
let tokensPool = loadTokens(TOKENS_FILE);
const exhaustedTokens = new Set();
let currentTokenIndex = 0;  // ФИКС: было не объявлено -> ReferenceError в strict mode (ESM)

console.log(`🔑 Загружено токенов: ${tokensPool.length}`);

// Переносит токен из tokens.txt в used_tokens.txt с префиксом U и перезагружает пул
function markTokenUsedInFile(token) {
  const moved = moveTokenToUsed({ token, tokensFile: TOKENS_FILE, usedTokensFile: USED_TOKENS_FILE });
  console.log(`🗃️ Токен перенесен: tokens.txt → used_tokens.txt (аккаунт #${moved.number ?? 'без номера'})`);

  tokensPool = loadTokens(TOKENS_FILE);
  exhaustedTokens.add(token);
  return true;
}

// Пул мог обновиться снаружи (докинули токены в tokens.txt) — перечитываем
function refreshTokensPool() {
  const fresh = loadTokens(TOKENS_FILE);

  // Перестраиваем exhausted из used_tokens.txt: что реально лежит в отработанных,
  // то и считаем исчерпанным. Ручной возврат токена (вырезал из used_tokens.txt
  // и положил обратно в tokens.txt) теперь снова делает его активным.
  const usedSet = new Set();
  if (fs.existsSync(USED_TOKENS_FILE)) {
    const usedRaw = fs.readFileSync(USED_TOKENS_FILE, 'utf-8').split(/\r?\n/);
    for (const line of usedRaw) {
      const parsed = parseTokenLine(line);
      if (parsed) usedSet.add(parsed.token);
    }
  }
  // Оставляем в exhausted только те, что либо уже не в активном пуле, либо помечены в used
  const freshSet = new Set(fresh);
  const newExhausted = new Set();
  for (const t of exhaustedTokens) {
    if (!freshSet.has(t) || usedSet.has(t)) newExhausted.add(t);
  }
  exhaustedTokens.clear();
  for (const t of newExhausted) exhaustedTokens.add(t);

  if (fresh.length !== tokensPool.length || fresh.some(t => !tokensPool.includes(t))) {
    tokensPool = fresh;
    if (tokensPool.length > 0) currentTokenIndex = currentTokenIndex % tokensPool.length;
    console.log(`🔑 Пул токенов обновлен с диска: ${tokensPool.length} шт. (исчерпано: ${exhaustedTokens.size})`);
  }
}

let browser;
let context;
let page;
let integrationInstalledForSession = false;
let integrationInstallStartedAt = 0;
let questionStepState = { fingerprint: '', submittedAt: 0 };

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

function detectTokenType(token) {
  const decoded = decodeURIComponent(token);
  if (decoded.startsWith('Bearer ') || decoded.startsWith('vcp_') || token.startsWith('Bearer%20') || token.startsWith('Bearer+')) return 'authorization';
  return 'user_session';
}

// Проверяет, что текущая страница реально авторизована под выставленным токеном.
// Надёжный сигнал авторизации — наличие поля ввода промпта (textarea / contenteditable).
// v0 при битом/expired токене редиректит на /login, где поля ввода нет.
async function isAuthorized() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = page.url();
    // Только явные страницы логина; /api/auth/callback — это OAuth редирект, не логин
    if (url.includes('/login?') || url.includes('/signin?') || url.includes('vercel.com/login')) {
      console.log(`  [isAuthorized] URL логина: ${url.substring(0, 80)}`);
      return false;
    }
    if (!url.includes('v0.app')) {
      console.log(`  [isAuthorized] не v0.app: ${url.substring(0, 80)}`);
      return false;
    }

    // На странице НЕ должно быть кнопок входа/регистрации (гостевая страница)
    const hasLoginButton = await page.locator('button:has-text("Sign Up"), button:has-text("Log In"), button:has-text("Get Started"), a:has-text("Sign Up"), a:has-text("Log In")')
      .first().isVisible({ timeout: 2000 }).catch(() => false);
    if (hasLoginButton) {
      console.log('  [isAuthorized] видна кнопка логина (гостевая страница)');
      return false;
    }

    // Должен быть либо чат (textarea/contenteditable + sidebar), либо project list
    const hasPrompt = await page.locator('textarea, [contenteditable="true"]')
      .first().isVisible({ timeout: 8000 }).catch(() => false);
    const hasSidebar = await page.locator('nav, [role="navigation"], aside, [data-sidebar]')
      .first().isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`  [isAuthorized] attempt=${attempt} url=v0.app hasPrompt=${hasPrompt} hasSidebar=${hasSidebar}`);
    if (hasPrompt || hasSidebar) return true;

    if (attempt < 2) {
      console.log('  [isAuthorized] reload...');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2500);
    }
  }
  return false;
}

// Группирует токены по номеру из tokens.txt: [{num, user_session, authorization}]
// Токены с одинаковым номером (1), 2)...) попадают в одну группу.
// Токены без номера группируются по порядку следования.
function groupTokens(tokenEntries) {
  const groups = new Map();

  for (const { num, token } of tokenEntries) {
    const key = num !== null ? String(num) : `_anon_${groups.size}`;
    if (!groups.has(key)) {
      groups.set(key, { user_session: null, authorization: null });
    }
    const group = groups.get(key);
    const type = detectTokenType(token);
    if (type === 'user_session') {
      group.user_session = token;
    } else {
      group.authorization = token;
    }
  }

  // Сортируем: сначала с номерами по возрастанию, потом анонимные
  const sorted = Array.from(groups.entries()).sort(([a], [b]) => {
    const aNum = Number.parseInt(a, 10);
    const bNum = Number.parseInt(b, 10);
    if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
    if (!Number.isNaN(aNum)) return -1;
    if (!Number.isNaN(bNum)) return 1;
    return 0;
  });

  return sorted.map(([key, g]) => {
    const n = Number.parseInt(key, 10);
    return { num: Number.isNaN(n) ? null : n, ...g };
  });
}

// Перебирает токены, пока не добьётся авторизованной страницы.
// ВАЖНО: при неоднозначной авторизации НЕ переносим токен в used_tokens.txt —
// это могла быть медленная отрисовка SPA или временный редирект. Просто
// переходим к следующему кандидату в памяти, не трогая файлы.
// В used_tokens.txt токен попадает только при явном Out of Credit (markTokenUsedInFile).
async function ensureAuthorized() {
  // Шаг 0: живая сессия браузера (пользователь залогинен в Chrome через CDP) — куки не трогаем
  await page.goto('https://v0.app', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
  if (await isAuthorized()) {
    console.log('✅ Живая сессия v0 активна — куки не требуются.');
    return true;
  }

  refreshTokensPool();
  if (tokensPool.length === 0) {
    throw Object.assign(new Error('Пул токенов пуст — добавьте валидные токены в tokens.txt'), { statusCode: 401 });
  }

  const tokenEntries = loadTokensWithNumbers(TOKENS_FILE);
  const groups = groupTokens(tokenEntries);
  const triedGroups = new Set();

  for (let gIdx = 0; gIdx < groups.length; gIdx++) {
    const group = groups[gIdx];
    const groupKey = `${group.num ?? 'anon'}_${gIdx}`;
    if (triedGroups.has(groupKey)) continue;
    triedGroups.add(groupKey);

    const { user_session: us, authorization: auth } = group;

    // Комбинации для проверки: [описание, массив кук для установки]
    const combos = [];
    if (us) combos.push(['user_session', [{ type: 'user_session', token: us }]]);
    if (auth) {
      if (us) combos.push(['user_session+authorization', [
        { type: 'user_session', token: us },
        { type: 'authorization', token: auth }
      ]]);
      combos.push(['authorization', [{ type: 'authorization', token: auth }]]);
    }

    if (combos.length === 0) continue;

    let authorized = false;
    for (const [label, cookies] of combos) {
      // Очищаем и ставим все куки из комбинации
      integrationInstalledForSession = false;
      integrationInstallStartedAt = 0;
      questionStepState = { fingerprint: '', submittedAt: 0 };
      await context.clearCookies();

      const toAdd = [];
      for (const c of cookies) {
        if (c.type === 'authorization') {
          const raw = decodeURIComponent(c.token);
          const authValue = raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`;
          toAdd.push(
            { name: 'authorization', value: authValue, domain: '.vercel.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
            { name: 'authorization', value: authValue, domain: '.v0.app', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
          );
        } else {
          toAdd.push(
            { name: 'user_session', value: c.token, domain: '.v0.dev', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
            { name: 'user_session', value: c.token, domain: '.v0.app', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
          );
        }
      }
      await context.addCookies(toAdd);
      console.log(`  [ensureAuthorized] Пробую аккаунт #${group.num} (${label}), кук: ${toAdd.length}`);

      await page.goto('https://v0.app', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2000);

      if (await isAuthorized()) {
        console.log(`✅ Аккаунт #${group.num} авторизован (${label}).`);
        // ФИКС: синхронизируем currentTokenIndex с реально авторизованным токеном,
        // чтобы при Out of Credit в used переносился именно он, а не первый в пуле.
        const authzToken = group.authorization || group.user_session;
        const poolIdx = tokensPool.indexOf(authzToken);
        if (poolIdx >= 0) currentTokenIndex = poolIdx;
        authorized = true;
        break;
      }
    }

    if (authorized) return true;
    console.log(`🔒 Аккаунт #${group.num} не прошёл авторизацию — пропускаем.`);
  }

  throw Object.assign(
    new Error('Ни один токен не прошёл авторизацию за отведённое время. Возможно, v0 медленно грузится — попробуйте перезапустить, или обновите токены в tokens.txt'),
    { statusCode: 401 }
  );
}

async function ensurePageAlive() {
  if (!browser || !browser.isConnected()) {
    try {
      browser = await chromium.connectOverCDP('http://localhost:9333');
      console.log('🔗 Подключились к Chrome через CDP (порт 9333)');
    } catch (e) {
      console.log(`⚠️ CDP недоступен (${String(e.message || e).split('\n')[0]}) — запускаю новый браузер.`);
      console.log('   Подсказка: chrome.exe --remote-debugging-port=9333 --user-data-dir=%TEMP%\\chrome_link');
      browser = await chromium.launch({ headless: false });
    }
    // Живая сессия: если Chrome уже открыт с профилем (CDP), используем его контекст с куками
    const liveContexts = browser.contexts();
    if (liveContexts.length > 0) {
      context = liveContexts[0];
      console.log('🔓 Использую существующую сессию браузера (куки профиля Chrome).');
    } else {
      context = await browser.newContext({
        permissions: ['clipboard-read', 'clipboard-write']
      });
    }
    page = null;
  }
  if (!page || page.isClosed()) {
    page = await context.newPage();
    attachDbSniffer(page);
    // ensureAuthorized сама ставит куку и перебирает токены
    await ensureAuthorized();
  }
}

// --- Перенос сессии через share-ссылку ---

// На текущем аккаунте: открыть Share → выставить "Anyone on the web" → вернуть ссылку
// Каждый шаг ограничен по времени и логируется, чтобы перенос не зависал молча
async function enableSharingAndGetLink() {
  // Paywall/настройки интеграции могут оставаться поверх чата и перехватывать
  // клик по Share. Закрываем их до открытия Share-диалога.
  for (let attempt = 0; attempt < 3; attempt++) {
    const openDialog = page.locator('[role="dialog"][data-state="open"], [role="dialog"]').last();
    if (!(await openDialog.isVisible({ timeout: 500 }).catch(() => false))) break;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
    if (await openDialog.isVisible({ timeout: 200 }).catch(() => false)) {
      const close = openDialog.locator('button[aria-label*="close" i], button[aria-label*="dismiss" i]').first();
      await close.click({ force: true }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  // 1. Кнопка Share: прямая в шапке чата, либо внутри меню "..."
  console.log('🔍 Шаг 1/4: ищу кнопку Share...');
  let shareClicked = false;

  const directShare = page.locator('button[data-testid="share-block-button"], button[aria-label="Share"], button:has-text("Share")').first();
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

  // В актуальном v0 после первого клика может открыться мастер: выбрать
  // аккаунт/проект (галочка), затем подтвердить Duplicate ещё раз.
  await page.waitForTimeout(800);
  const accountChoice = page.locator(
    '[role="dialog"] input[type="radio"], [role="dialog"] input[type="checkbox"], ' +
    '[role="dialog"] [role="radio"], [role="dialog"] [role="checkbox"]'
  ).first();
  if (await accountChoice.isVisible({ timeout: 2000 }).catch(() => false)) {
    await accountChoice.click({ force: true });
    console.log('🔍 Выбран аккаунт для дублирования.');
    await page.waitForTimeout(500);
  }

  const confirmDuplicate = page.locator(
    '[role="dialog"] button:has-text("Duplicate"), [role="dialog"] button:has-text("Continue"), [role="dialog"] button:has-text("Create")'
  ).last();
  if (await confirmDuplicate.isVisible({ timeout: 3000 }).catch(() => false)) {
    const disabled = await confirmDuplicate.isDisabled().catch(() => true);
    if (!disabled) {
      await confirmDuplicate.click();
      console.log('🔍 Дублирование подтверждено.');
    }
  }

  // Ждем редиректа в клонированный чат нового аккаунта
  await page.waitForURL(/\/(chat|r)\//, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const newUrl = page.url();
  console.log(`📋 Чат продублирован в новый аккаунт: ${newUrl}`);
  return newUrl;
}

// Импорт чужого проекта по share-ссылке в текущую сессию
// Используется когда пользователь вводит continue_url или указывает в файле
async function importProjectFromUrl(projectUrl) {
  console.log(`\n🔗 Импортирую проект: ${projectUrl}`);
  
  // Если это уже наш чат (наш аккаунт), просто открываем
  if (projectUrl.includes('/chat/') && !(projectUrl.includes('/share/') || projectUrl.includes('?share='))) {
    console.log('📂 Это приватный чат, пробую открыть напрямую...');
    await page.goto(projectUrl, { timeout: 20000 });
    await page.waitForTimeout(3000);
    
    // Проверяем, не редиректнуло ли на логин или 404
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/404') || !currentUrl.includes('/chat/')) {
      throw new Error('Приватный чат недоступен. Используйте публичную share-ссылку');
    }
    
    console.log('✅ Приватный чат успешно открыт');
    return currentUrl;
  }
  
  // Если это share-ссылка, дублируем на текущий аккаунт
  const newUrl = await duplicateChatFromLink(projectUrl);
  console.log('✅ Проект импортирован в текущую сессию');
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
      // После duplicate убеждаемся, что новый аккаунт реально авторизован
      // (share-ссылка публичная, но кука могла не встать)
      if (!(await isAuthorized())) {
        console.log('🔒 После Duplicate страница не авторизована — перебираем токены.');
        await ensureAuthorized();
      }
    } catch (e) {
      console.log(`⚠️ Duplicate не удался (${e.message}). Открываем стартовую v0.app.`);
      await page.goto('https://v0.app');
    }
  } else if (inChat) {
    // Без share-ссылки приватный чат старого аккаунта новому недоступен —
    // НЕ открываем старый URL (приватный, даст 404/login), идём на стартовую
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
  refreshTokensPool();
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
      console.log(`🔄 Переключаемся на аккаунт #${i + 1} (токенов в активном пуле: ${tokensPool.length})`);

      await context.clearCookies();
      const type = detectTokenType(candidate);
      if (type === 'authorization') {
        const raw = decodeURIComponent(candidate);
        const authValue = raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`;
        await context.addCookies([
          { name: 'authorization', value: authValue, domain: '.vercel.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
          { name: 'authorization', value: authValue, domain: '.v0.app', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
        ]);
      } else {
        await context.addCookies([
          { name: 'user_session', value: candidate, domain: '.v0.dev', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
          { name: 'user_session', value: candidate, domain: '.v0.app', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }
        ]);
      }

      await page.goto('https://v0.app', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2000);

      // Новый токен может оказаться неавторизованным — проверяем.
      // При неудаче НЕ переносим в used_tokens.txt (это могла быть медленная
      // отрисовка), просто помечаем в памяти как пропущенный и ищем дальше.
      if (!(await isAuthorized())) {
        console.log(`🔒 Аккаунт #${i + 1} не прошёл авторизацию после 3 проверок — пропускаем (токен в файле оставляем).`);
        exhaustedTokens.add(candidate);
        continue;
      }
      console.log(`✅ Аккаунт #${i + 1} авторизован.`);
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

// Проверка: генерация ещё идёт? Дёргает page.evaluate с расширенным списком
// ключевых слов под новый UI v0 ("Worked for Ns", "Working", "Created" и т.д.).
async function isGenerationActive() {
  return await page.evaluate(() => {
    const text = (document.body && document.body.innerText) || '';
    const has = (s) => text.toLowerCase().includes(s.toLowerCase());
    const stopBtn = document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Cancel" i]');
    // В новом UI v0 кнопка Stop иногда не имеет aria-label. Её SVG содержит
    // квадрат с характерным path, как в кнопке, показанной во время генерации.
    const stopIcon = Array.from(document.querySelectorAll('button svg path')).some(path =>
      // У v0 круг и квадрат могут быть в одном длинном path. Ищем квадрат как
      // фрагмент, а не сравниваем атрибут d целиком.
      (path.getAttribute('d') || '').replace(/\s+/g, '').includes('M10.55.5H5.5V10.5H10.5V5.5Z')
    );
    // Карточки уточнений появляются отдельными этапами и на это время v0 может
    // убрать Stop-иконку. Пока есть прогресс вопросника и Next/Submit, работа
    // не завершена и автоответчик должен обработать следующий этап.
    const questionFormActive = Array.from(document.querySelectorAll('#prompt-form, [role="dialog"]')).some(container => {
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const text = container.innerText || '';
      const hasProgress = /\d+\s*(of|из|\/)\s*\d+/i.test(text);
      const hasAction = Array.from(container.querySelectorAll('button')).some(button =>
        /^(next|далее|continue|submit|отправить)$/i.test((button.innerText || '').trim())
      );
      const hasOptions = !!container.querySelector('div.flex.flex-col.gap-0\\.5 button[type="button"]');
      return hasAction && (hasProgress || hasOptions);
    });
    const stageWords = [
      "Generating", "Thinking", "Installing", "Executing", "Building",
      "Working", "Running", "Processing", "Analyzing", "Writing",
      "Creating", "Updating", "Compiling", "Bundling"
    ];
    const isWorking = stageWords.some(w => has(w));
    return !!stopBtn || stopIcon || questionFormActive || isWorking;
  }).catch(() => false);
}


// которые вылезают ПЕРЕД стартом генерации и блокируют всё.
// Стратегия: на каждом шаге жмём первый вариант (radio), затем Next.
// Если Next не активен или нет вариантов — жмём Skip. Повторяем, пока модалка
// не исчезнет или не упрёмся в лимит шагов.
async function dismissClarifyingQuestions() {
  const MAX_ROUNDS = 100;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const action = await page.evaluate(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 &&
          style.visibility !== 'hidden' && style.display !== 'none' &&
          style.opacity !== '0' && style.pointerEvents !== 'none';
      };
      const form = document.querySelector('#prompt-form');
      if (!form || !visible(form)) return { found: false };

      const isContinueButton = button => /^(next|далее|continue|submit|отправить)$/i.test((button.innerText || '').trim());
      const actionButtons = Array.from(form.querySelectorAll('button')).filter(button => visible(button) && isContinueButton(button));
      if (!actionButtons.length) return { found: false };

      // Next до выбора ответа обычно disabled. Всё равно берём последнюю
      // видимую кнопку текущего этапа и сначала выбираем вариант.
      const next = actionButtons.at(-1);

      let card = next;
      while (card && card !== form) {
        const hasHeading = !!card.querySelector?.('h2');
        const choiceCount = Array.from(card.querySelectorAll?.('button[type="button"]') || []).filter(button => {
          const text = (button.innerText || '').trim();
          return text && !/^(skip|пропустить|next|далее|continue|submit|отправить|close questions|scroll to bottom)$/i.test(text);
        }).length;
        if (hasHeading && choiceCount) break;
        card = card.parentElement;
      }
      if (!card || card === form) return { found: true, advanced: false };

      const option = Array.from(card.querySelectorAll('button[type="button"]')).find(button => {
        if (!visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
        const text = (button.innerText || '').trim();
        return text && !/^(skip|пропустить|next|далее|continue|submit|отправить|close questions|scroll to bottom)$/i.test(text);
      });
      if (!option) return { found: true, advanced: false };

      const title = (card.querySelector('h2')?.innerText || '').trim();
      const choices = Array.from(card.querySelectorAll('button[type="button"]'))
        .map(button => (button.innerText || '').trim())
        .filter(text => text && !/^(skip|пропустить|next|далее|continue|submit|отправить)$/i.test(text));
      return {
        found: true,
        ready: true,
        fingerprint: `${title}\n${choices.join('\n')}`,
        actionText: (next.innerText || '').trim()
      };
    }).catch(() => ({ found: false }));

    if (!action.found) {
      questionStepState = { fingerprint: '', submittedAt: 0 };
      return;
    }

    if (!action.ready) {
      console.log('⚠️ Next пока не активен, жду обновления формы.');
      await page.waitForTimeout(1000);
      continue;
    }

    // Один и тот же этап остаётся в DOM во время переходной анимации. Не
    // выбираем и не отправляем его повторно, пока React не отрисует новый.
    if (questionStepState.fingerprint === action.fingerprint) {
      if (Date.now() - questionStepState.submittedAt > 8000) {
        console.log('⚠️ Вопрос не сменился за 8 сек, жду UI v0 без повторного клика.');
      }
      await page.waitForTimeout(700);
      continue;
    }

    const clicked = await page.evaluate((fingerprint) => {
      const form = document.querySelector('#prompt-form');
      if (!form) return false;
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.opacity !== '0' && style.pointerEvents !== 'none';
      };
      const actionPattern = /^(next|далее|continue|submit|отправить)$/i;
      const actions = Array.from(form.querySelectorAll('button')).filter(button =>
        visible(button) && actionPattern.test((button.innerText || '').trim())
      );
      const next = actions.at(-1);
      if (!next) return false;
      let card = next;
      while (card && card !== form) {
        const title = (card.querySelector?.('h2')?.innerText || '').trim();
        const choices = Array.from(card.querySelectorAll?.('button[type="button"]') || [])
          .map(button => (button.innerText || '').trim())
          .filter(text => text && !/^(skip|пропустить|next|далее|continue|submit|отправить)$/i.test(text));
        if (`${title}\n${choices.join('\n')}` === fingerprint) break;
        card = card.parentElement;
      }
      if (!card || card === form) return false;
      const choice = Array.from(card.querySelectorAll('button[type="button"]')).find(button => {
        const text = (button.innerText || '').trim();
        return visible(button) && !button.disabled && text && !/^(skip|пропустить|next|далее|continue|submit|отправить)$/i.test(text);
      });
      if (!choice) return false;
      choice.click();
      return true;
    }, action.fingerprint).catch(() => false);

    if (!clicked) {
      await page.waitForTimeout(700);
      continue;
    }

    const actionButton = page.locator('#prompt-form button').filter({
      hasText: /^(Next|Далее|Continue|Submit|Отправить)$/i
    }).last();
    const actionHandle = await actionButton.elementHandle().catch(() => null);
    const enabled = actionHandle
      ? await page.waitForFunction(button =>
          !button.disabled && button.getAttribute('aria-disabled') !== 'true',
        actionHandle, { timeout: 3000 }).then(() => true).catch(() => false)
      : false;
    if (!enabled) {
      console.log('⚠️ Вариант выбран, но кнопка продолжения не активировалась.');
      await page.waitForTimeout(700);
      continue;
    }

    await actionButton.click({ force: true });
    questionStepState = { fingerprint: action.fingerprint, submittedAt: Date.now() };
    console.log(`💬 Раунд ${round + 1}: выбран верхний вариант, нажата ${action.actionText}.`);
    await page.waitForTimeout(1400);
  }
  console.log('⚠️ Достигнут защитный лимит автоответчика (100).');
}

async function getVisibleV0Status() {
  return await page.evaluate(() => {
    const text = (document.body && document.body.innerText) || '';
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    return lines
      .filter(line => /error|failed|unable|try again|upgrade|credit|limit|sign in|install|next|continue|не удалось|ошибка|лимит/i.test(line))
      .slice(-8)
      .join(' | ');
  }).catch(() => 'страница v0 была закрыта');
}

async function handleInstallPrompts() {
  if (integrationInstalledForSession) return false;

  // Если текущая сессия уже показывает Manage, повторно Install не нужен.
  if (await page.locator('button:has-text("Manage")').first().isVisible({ timeout: 500 }).catch(() => false)) {
    integrationInstalledForSession = true;
    integrationInstallStartedAt = 0;
    console.log('✅ Интеграция Neon установлена, кнопка Manage появилась.');
    return false;
  }

  // Install уже нажат. Не блокируем runner ожиданием Manage и не кликаем
  // повторно: проверим результат на следующем тике основного цикла.
  if (integrationInstallStartedAt) {
    if (Date.now() - integrationInstallStartedAt > 60000) {
      console.log('⚠️ Neon устанавливается больше 60 сек, продолжаю следить без повторного Install.');
      integrationInstalledForSession = true;
    }
    return false;
  }

  const installButtons = page.locator('button:has-text("Install")');
  let installBtn = null;
  for (let index = 0; index < await installButtons.count(); index++) {
    const candidate = installButtons.nth(index);
    if (!(await candidate.isVisible({ timeout: 300 }).catch(() => false))) continue;
    const cardText = await candidate.locator('xpath=ancestor::div[.//button[contains(., "Manage")]][1]')
      .innerText()
      .catch(() => '');
    if (!cardText) {
      installBtn = candidate;
      break;
    }
  }
  if (!installBtn) return false;

  console.log('🧩 Найдена интеграция с кнопкой Install. Запускаю установку...');
  const clicked = await installBtn.click({ force: true, timeout: 5000 }).then(() => true).catch(() => false);
  if (!clicked) return false;
  integrationInstallStartedAt = Date.now();
  console.log('⏳ Install нажат, Neon устанавливается в фоне.');
  return true;
}

async function handleGeneratedSecrets() {
  const result = await page.evaluate(() => {
    const input = Array.from(document.querySelectorAll('input[placeholder="Enter a key"]')).find(item => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!input) return { found: false };

    const card = input.closest('div.p-2\\.5') || input.parentElement?.parentElement?.parentElement?.parentElement;
    const label = card?.querySelector('label');
    const name = (label?.textContent || 'секрет').trim();
    const buttons = Array.from(card?.querySelectorAll('button') || []);
    const generate = buttons.find(button => (button.textContent || '').trim() === 'Generate');
    if (input.value.trim()) return { found: true, ready: true, name };
    if (!generate) return { found: true, ready: false, canGenerate: false, name };
    generate.click();
    return { found: true, ready: false, canGenerate: true, name };
  }).catch(() => ({ found: false }));

  if (!result.found) return false;
  if (result.ready) {
    await submitGeneratedSecret();
    return true;
  }
  if (!result.canGenerate) return false;

  console.log(`🔐 Найден ${result.name}. Генерирую секрет...`);
  const generated = await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('input[placeholder="Enter a key"]')).some(input => input.value.trim());
  }, { timeout: 15000 }).then(() => true).catch(() => false);

  console.log(generated
    ? `✅ ${result.name} сгенерирован.`
    : `⚠️ ${result.name} не заполнился за 15 сек.`);
  if (generated) await submitGeneratedSecret();
  return generated;
}

async function submitGeneratedSecret() {
  const action = await page.evaluate(() => {
    const input = Array.from(document.querySelectorAll('input[placeholder="Enter a key"]')).find(item => item.value.trim());
    const section = input?.closest('div.p-2\\.5') || input?.parentElement?.parentElement?.parentElement?.parentElement;
    if (!section) return '';

    // Submit находится в общем контейнере мастера, часто правее карточки,
    // поэтому поднимаемся до ближайшего родителя с Submit.
    let container = section;
    let buttons = [];
    while (container && container !== document.body) {
      buttons = Array.from(container.querySelectorAll('button'));
      if (buttons.some(button => /^(submit|continue|save)$/i.test((button.textContent || '').trim()))) break;
      container = container.parentElement;
    }
    const submit = buttons.find(button => /^(submit|continue|save)$/i.test((button.textContent || '').trim()));
    const button = submit;
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return '';
    const text = (button.textContent || '').trim();
    button.click();
    return text;
  }).catch(() => '');

  if (action) {
    console.log(`🔐 Better Auth: нажата кнопка ${action}.`);
    await page.waitForTimeout(1500);
  }
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
    // Ищем текущую модель только в форме отправки. Глобальный поиск может взять
    // название модели из сообщения, рекомендации или уже открытого меню.
    const currentModel = await page.locator('#prompt-form button, form button').evaluateAll((buttons) => {
      const models = ['v0 Mini', 'v0 Pro', 'v0 Max', 'v0 Max Fast', 'Fable 5', 'Opus 5', 'Opus 5 Fast', 'GPT-5.6 Sol', 'Kimi K3'];
      for (const button of buttons) {
        const text = (button.innerText || '').trim();
        const found = models.find(model => text.includes(model));
        if (found) return found;
      }
      return null;
    }).catch(() => null);

    if (currentModel === targetModelName) {
      console.log(`🎯 Модель уже выбрана: ${targetModelName}`);
      return true;
    }
    if (currentModel) {
      console.log(`🔄 Текущая модель: ${currentModel}. Переключаю на: ${targetModelName}`);
    }

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


// ─────────────────────────────────────────────────────────────
// 🚀 API-режим: генерация через официальное API v0 (api.v0.dev)
// Использует ключи vcp_ из tokens.txt (Authorization: Bearer <ключ>)
// Ключи: https://v0.app/settings/keys  (beta — вызовы тратят кредиты)
// ─────────────────────────────────────────────────────────────
let apiKeyIndex = 0;

function getApiKeys() {
  return loadTokensWithNumbers(TOKENS_FILE)
    .filter(entry => detectTokenType(entry.token) === 'authorization')
    .map(entry => decodeURIComponent(entry.token).replace(/^Bearer\s+/, '').trim())
    .filter(t => t.length > 20);
}

// Одна генерация с ротацией ключей: создание чата или продолжение, ожидание, сохранение файлов
async function apiGenerateOnce(apiKeys, { message, chatId = null, systemPrompt = null, saveDir = null }) {
  // Минимум 2 попытки — таймауты бывают транзиентными (сеть/очередь v0)
  const attempts = Math.max(apiKeys.length, 2);
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    apiKeyIndex = apiKeyIndex % apiKeys.length;
    const token = apiKeys[apiKeyIndex];
    const accountNum = apiKeyIndex + 1;

    if (exhaustedTokens.has(token)) {
      apiKeyIndex++;
      continue;
    }

    try {
      let chat;
      if (chatId) {
        console.log(`📝 Продолжаю чат ${chatId} (аккаунт #${accountNum})...`);
        await sendMessage(token, chatId, { message, systemPrompt });
        chat = { id: chatId, webUrl: `https://v0.app/chat/${chatId}` };
      } else {
        console.log(`🚀 Создаю чат (аккаунт #${accountNum})...`);
        chat = await createChat(token, { message, systemPrompt });
        console.log(`   🔗 ${chat.webUrl || `https://v0.app/chat/${chat.id}`}`);
      }

      console.log('⏳ Жду генерацию (до 10 минут)...');
      const assistant = await waitForCompletion(token, chat.id, {
        onProgress: msgs => {
          const last = msgs[msgs.length - 1];
          const len = last && last.role === 'assistant' && last.content ? last.content.length : 0;
          console.log(`   [${new Date().toISOString().slice(11, 19)}] ответ: ${len} симв.`);
        },
      });

      let files = 0;
      if (saveDir) {
        const saved = await saveChatFiles(token, chat.id, saveDir);
        files = saved.count;
        console.log(`💾 Файлов сохранено: ${files} → ${saveDir}`);
      }

      return {
        chatId: chat.id,
        webUrl: chat.webUrl || `https://v0.app/chat/${chat.id}`,
        accountUsed: accountNum,
        assistant,
        files,
        saveDir,
      };
    } catch (e) {
      lastError = e;
      const creditIssue = e instanceof V0ApiError && (e.status === 402 || /credit|balance|quota|billing/i.test(e.message));
      if (e instanceof V0ApiError && (e.retryable || creditIssue)) {
        console.log(`⚠️ Аккаунт #${accountNum}: ${e.message} (${e.status}). Пробуем следующий...`);
        if (creditIssue) exhaustedTokens.add(token);
        apiKeyIndex++;
        await new Promise(r => setTimeout(r, 2500));
        continue;
      }
      throw e;
    }
  }
  throw lastError || new V0ApiError('Все API-аккаунты недоступны');
}

// Единичная генерация через API (новый проект или продолжение)
async function runApiGeneration({ prompt, model = 'Opus 5', jobName = null, outputSubDir = null, continueUrl = null }) {
  const apiKeys = getApiKeys();
  const chatId = continueUrl ? extractChatId(continueUrl) : null;
  const saveDir = outputSubDir
    ? path.join(outputDir, outputSubDir)
    : path.join(outputDir, chatId ? `chat-${chatId}` : `chat-${Date.now().toString(36)}`);

  const result = await apiGenerateOnce(apiKeys, { message: prompt, chatId, saveDir });

  // Если v0 ответил текстом без файлов — сохраняем ответ как RESULT.md
  if (result.files === 0) {
    const dir = result.saveDir || saveDir;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'RESULT.md'), result.assistant.content || '', 'utf8');
    console.log(`💾 Ответ сохранён: ${path.join(dir, 'RESULT.md')}`);
  }

  return {
    accountUsed: result.accountUsed,
    chatUrl: result.webUrl,
    shareUrl: null,
    files: result.files,
    summary: String(result.assistant.content || '').slice(0, 500),
  };
}

// Многопромптовая цепочка через API: все шаги в одном чате, триггеры по тексту ответа
async function runApiMultiPrompt({ config, jobName }) {
  const apiKeys = getApiKeys();
  const saveDir = path.join(outputDir, jobName);
  let chatId = config.continueUrl ? extractChatId(config.continueUrl) : null;

  for (const step of config.prompts) {
    console.log(`\n📋 Шаг ${step.num}/${config.prompts.length}: ${step.text.slice(0, 100)}...`);
    let done = false;
    for (let retry = 0; retry < 3 && !done; retry++) {
      const result = await apiGenerateOnce(apiKeys, {
        message: retry === 0 ? step.text : buildRetryPrompt(step.text, config.retryPrompt, config.trigger),
        chatId,
        saveDir,
      });
      chatId = result.chatId;
      done = checkTriggerInResponse(result.assistant.content || '', config.trigger);
      console.log(done
        ? `✅ Шаг ${step.num} завершён (триггер найден).`
        : `⚠️ Триггер «${config.trigger}» не найден — retry ${retry + 1}/3.`);
    }
    if (!done) {
      console.log(`❌ Шаг ${step.num} не прошёл триггер после 3 попыток — цепочка остановлена.`);
      break;
    }
  }
  console.log(`\n✅ Цепочка завершена. Проект: ${saveDir}`);
}

// --- Основной сценарий генерации, общий для HTTP и файлового режима ---
async function runGeneration({ prompt, model = 'Opus 5', jobName = null, outputSubDir = null, continueUrl = null }) {
  const saveDir = outputSubDir ? path.join(outputDir, outputSubDir) : outputDir;

  // 🚀 API-режим: если в tokens.txt есть vcp_ ключи — генерируем через официальное API v0
  if (getApiKeys().length > 0) {
    return runApiGeneration({ prompt, model, jobName, outputSubDir, continueUrl });
  }

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
    // Перед каждой попыткой перечитываем пул — пользователь мог докинуть токенов
    refreshTokensPool();
    if (tokensPool.length === 0) break;
    currentTokenIndex = currentTokenIndex % tokensPool.length;

    console.log(`\n🚀 Запуск генерации (Аккаунт #${(currentTokenIndex % tokensPool.length) + 1})...`);
    console.log(`📝 Промпт: "${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}"`);

    const currentUrl = page.url();
    // Если передан continueUrl, открываем его только если мы не в нужном чате
    if (continueUrl) {
      if (!currentUrl.includes(continueUrl.split('/').pop())) {
        await page.goto(continueUrl, { timeout: 20000 });
        await page.waitForTimeout(2000);
      }
    } else if (!currentUrl.includes('/chat/') && !currentUrl.includes('/r/')) {
      await page.goto('https://v0.app');
    }

    // Проверяем авторизацию перед отправкой: битый токен даёт /login и input не найдётся
    if (!(await isAuthorized())) {
      console.log(`🔒 Аккаунт #${(currentTokenIndex % tokensPool.length) + 1} не авторизован — переключаемся.`);
      const switched = await switchToNextToken();
      if (!switched) break;
      continue;
    }

    const inputSelector = 'textarea, [contenteditable="true"]';
    await page.waitForSelector(inputSelector, { timeout: 15000 });

    // Выбор модели
    await selectModelInUI(model);

    // 1. Отправка промпта
    await page.fill(inputSelector, prompt);
    await page.keyboard.press('Enter');

    // Даем UI 2 секунды на реакцию (модалка уточняющих вопросов / Out of Credit)
    await page.waitForTimeout(2000);

    // 1b. АВТООТВЕТЧИК на уточняющие вопросы v0 ("Какой тип боя? 1 of 3" и т.д.),
    //     которые блокируют старт генерации. Жмём первый вариант → Next, пока не закроются.
    await handleInstallPrompts();
    await dismissClarifyingQuestions();
    await handleGeneratedSecrets();

    // 2. МГНОВЕННАЯ ПРОВЕРКА НА ЛИМИТ КРЕДИТОВ
    let isPaywall = await checkIsPaywall(page);

    if (isPaywall) {
      console.log(`❌ На аккаунте #${(currentTokenIndex % tokensPool.length) + 1} закончились токены (Out of Credit)! Переносим сессию...`);
      const migrated = await migrateSessionToNextToken();
      if (!migrated) break;
      continue;
    }

    // 3. ЖДЕМ СТАРТА — с повторным прогоном автоответчика, если генерация
    //    не стартовала (модалка уточняющих вопросов могла вылезти с задержкой)
    console.log('⏳ Ждем запуск генерации на сервере v0...');
    let started = false;
    const startDeadline = Date.now() + 60000;
    while (Date.now() < startDeadline) {
      if (!browser?.isConnected() || !page || page.isClosed()) {
        throw new Error('Окно Chromium было закрыто до запуска генерации');
      }
      const detected = await isGenerationActive();

      if (detected) { started = true; break; }

      // Не пошла — возможно, снова висит модалка вопросов. Прогоняем и ждём дальше.
      await handleInstallPrompts();
      await dismissClarifyingQuestions();
      await handleGeneratedSecrets();
      await page.waitForTimeout(2500);
    }

    if (started) {
      console.log('⚡ Генерация официально пошла!');
    } else {
      const status = await getVisibleV0Status();
      throw new Error(`v0 не запустил генерацию за 60 секунд.${status ? ` Видимое состояние: ${status}` : ''}`);
    }

    // 4. ЖДЕМ ФИНИША (с динамическим отслеживанием пейволла И модалок вопросов)
    if (started) {
      console.log('⏳ Ждем полного завершения всех шагов v0...');
      let finished = false;
      let quietTicks = 0; // считаем подряд идущие "тихие" тики — финиш = 5 подряд
      const finishDeadline = Date.now() + 600000;
      while (Date.now() < finishDeadline) {
        // На каждом тике прогоняем автоответчик — v0 может подкинуть вопрос
        // прямо посреди генерации, и она встанет, пока не ответим.
        await handleInstallPrompts();
        await dismissClarifyingQuestions();
        await handleGeneratedSecrets();

        const state = await page.evaluate(() => {
          const text = (document.body && document.body.innerText) || '';
          const isPaywallPresent = text.includes("Out of Credit") ||
                                   text.includes("out of credits") ||
                                   text.includes("Upgrade Plan") ||
                                   text.includes("Activate v0 Plus");
          return { paywall: isPaywallPresent };
        }).catch(() => ({ paywall: false }));
        state.active = await isGenerationActive();

        if (state.paywall) { finished = true; break; }
        if (state.active) {
          quietTicks = 0;
        } else {
          quietTicks++;
          if (quietTicks >= 5) { finished = true; break; } // 5 тиков тишины = реально финиш
        }
        await page.waitForTimeout(2500);
      }

      if (!finished) {
        throw new Error("Таймаут: генерация заняла больше 10 минут.");
      }

        const hitPaywallDuringGen = await checkIsPaywall(page);

        if (hitPaywallDuringGen) {
          console.log(`❌ Генерация прервана: у аккаунта #${(currentTokenIndex % tokensPool.length) + 1} закончились кредиты! Переносим сессию...`);
          const migrated = await migrateSessionToNextToken();
          if (!migrated) break;
          continue;
        }

        console.log('✨ Код сгенерирован.');
        await page.waitForTimeout(4000);
    }

    // 5. ПЕРЕКЛЮЧАЕМСЯ НА ТАБ CODE И СОБИРАЕМ ФАЙЛЫ
    try {
      const codeTab = page.locator('button:has-text("Code"), [role="tab"]:has-text("Code")').first();
      if (await codeTab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await codeTab.click();
        await page.waitForTimeout(1000);
      }
    } catch (e) {}

    // Сначала пытаемся вытащить файлы через API-состояние чата v0 (если есть в window),
    // это надёжнее парсинга DOM. Иначе — ручной обход дерева файлов.
    let filesData = [];

    // Путь A: API/состояние проекта в глобальных объектах v0
    try {
      filesData = await page.evaluate(() => {
        const out = [];
        // v0 иногда кладёт состояние в __NEXT_DATA__ или в глобальный store
        const nd = window.__NEXT_DATA__ && window.__NEXT_DATA__.props && window.__NEXT_DATA__.props.pageProps;
        if (nd) {
          const json = JSON.stringify(nd);
          if (json.includes('"files"')) {
            const walk = (obj) => {
              if (!obj || typeof obj !== 'object') return;
              if (Array.isArray(obj)) { for (const x of obj) walk(x); return; }
              if (obj.path && obj.content && typeof obj.content === 'string') {
                out.push({ relativePath: obj.path, content: obj.content });
              }
              for (const k of Object.keys(obj)) walk(obj[k]);
            };
            walk(nd);
          }
        }
        return out;
      }).catch(() => []);
    } catch (e) {}

    // Путь B: обход дерева файлов в DOM + чтение Monaco по клику
    if (filesData.length === 0) {
      const fileItems = await page.locator(
        '[data-filename], [class*="file-item"], [class*="FileItem"], ' +
        'button[class*="file"], [role="treeitem"], [class*="file-tree"] [class*="file"]'
      ).elementHandles().catch(() => []);

      for (const el of fileItems) {
        const filePath = await el.getAttribute('data-filename').catch(() => null)
          || (await el.innerText().catch(() => '')).trim();
        if (!filePath || !filePath.includes('.') || filePath.length > 200) continue;

        await el.click({ force: true }).catch(() => {});
        await page.waitForTimeout(500);

        // Чтение через Monaco-модель (точный контент без line-numbers), fallback на DOM
        const content = await page.evaluate(() => {
          // Monaco: пробуем получить текст из активной модели
          try {
            const editors = window.monaco && window.monaco.editor && window.monaco.editor.getEditors
              ? window.monaco.editor.getEditors() : [];
            if (editors && editors.length > 0) {
              const m = editors[editors.length - 1].getModel();
              if (m) return m.getValue();
            }
          } catch (_) {}
          // Fallback: DOM, выкидываем номера строк
          const ed = document.querySelector('.monaco-editor, pre, code');
          if (ed) return ed.innerText.replace(/^\s*\d+\n/gm, '').replace(/^\s*\d+(?=\D)/gm, '');
          return '';
        }).catch(() => '');

        if (content && content.trim().length > 0) {
          filesData.push({ relativePath: filePath, content });
        }
      }
    }

    // Путь C: фолбэк — хоть один файл из активного редактора
    if (filesData.length === 0) {
      const content = await page.evaluate(() => {
        try {
          const editors = window.monaco && window.monaco.editor && window.monaco.editor.getEditors
            ? window.monaco.editor.getEditors() : [];
          if (editors && editors.length > 0) {
            const m = editors[editors.length - 1].getModel();
            if (m) return m.getValue();
          }
        } catch (_) {}
        const ed = document.querySelector('.monaco-editor, pre, code');
        return ed ? ed.innerText : '';
      }).catch(() => '');
      if (content && content.trim()) {
        filesData.push({ relativePath: 'components/generated-component.tsx', content });
      }
    }

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
    }

    let shareUrl = null;
    try {
      shareUrl = await enableSharingAndGetLink();
    } catch (error) {
      console.log(`⚠️ Не удалось получить Share-ссылку: ${error.message}`);
    }

    return {
      success: true,
      chatUrl: page.url(),
      shareUrl,
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


// --- Интерактивный режим ---
import { 
  showMainMenu, 
  selectModel, 
  inputProjectUrl, 
  inputSinglePrompt,
  selectMultiPromptFile,
  selectProject,
  confirmContinue,
  KNOWN_MODELS
} from './src/ui/interactive-menu.js';

import {
  parseMultiPromptFile,
  loadProgress,
  saveProgress,
  checkTriggerInResponse,
  buildRetryPrompt
} from './src/services/multi-prompt.js';

let interactiveMode = null;
let fileWatcherEnabled = false;

async function startInteractiveMode() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   v0 Runner — Интерактивный режим     ║');
  console.log('╚════════════════════════════════════════╝\n');

  const mode = await showMainMenu();
  interactiveMode = mode;

  if (mode === 'api') {
    console.log('\n🔄 Запущен в режиме HTTP API + файловый вотчер');
    console.log('📂 Кладите .txt файлы в prompts/ для автоматической обработки');
    console.log('🌐 HTTP API доступен на http://localhost:3000\n');
    fileWatcherEnabled = true;
    return;
  }

  // Для всех остальных режимов отключаем файловый вотчер
  fileWatcherEnabled = false;

  // 🚀 API-режим: если в tokens.txt есть vcp_ ключи — браузер не нужен,
  // генерация идёт через официальное API v0 (api.v0.dev)
  if (getApiKeys().length > 0) {
    console.log('🔑 Найдены API-ключи (vcp_) — генерация через официальное API без браузера.');
  } else {
    await ensurePageAlive();
  }

  if (mode === 'single') {
    await runSinglePromptMode();
  } else if (mode === 'continue') {
    await runContinueProjectMode();
  } else if (mode === 'multi-new') {
    await runMultiPromptMode(false);
  } else if (mode === 'multi-continue') {
    await runMultiPromptMode(true);
  }
}

// Режим 1: Одиночный промпт
async function runSinglePromptMode() {
  const model = await selectModel(KNOWN_MODELS);
  const prompt = await inputSinglePrompt();

  console.log(`\n🤖 Модель: ${model}`);
  console.log(`📝 Промпт: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}\n`);

  try {
    const result = await runGeneration({ prompt, model });
    console.log('\n✅ Генерация завершена!');
    console.log(`👤 Аккаунт: #${result.accountUsed}`);
    console.log(`🔗 Чат: ${result.chatUrl}`);
    if (result.shareUrl) console.log(`🔗 Share: ${result.shareUrl}`);
  } catch (error) {
    console.error(`\n❌ Ошибка: ${error.message}`);
  }

  process.exit(0);
}

// Режим 2: Продолжить существующий проект
async function runContinueProjectMode() {
  const apiKeys = getApiKeys();
  let projectUrl = null;

  if (apiKeys.length > 0) {
    // API-режим: показываем последние проекты аккаунта для выбора
    try {
      const chats = await listChats(apiKeys[apiKeyIndex % apiKeys.length], { limit: 10 });
      if (chats.length > 0) {
        const picked = await selectProject(chats);
        if (picked === '__url__') {
          projectUrl = await inputProjectUrl();
        } else {
          projectUrl = `https://v0.app/chat/${picked}`;
          console.log(`📂 Выбран проект: ${projectUrl}`);
        }
      } else {
        projectUrl = await inputProjectUrl();
      }
    } catch (e) {
      console.log(`⚠️ Не удалось получить список проектов (${e.message}) — введите URL.`);
      projectUrl = await inputProjectUrl();
    }
  } else {
    projectUrl = await inputProjectUrl();
  }

  const model = await selectModel(KNOWN_MODELS);
  const prompt = await inputSinglePrompt();

  console.log(`🤖 Модель: ${model}`);
  console.log(`📝 Промпт: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}\n`);

  try {
    const importedUrl = apiKeys.length > 0
      ? projectUrl
      : await importProjectFromUrl(projectUrl);
    
    const result = await runGeneration({ prompt, model, continueUrl: importedUrl });
    console.log('\n✅ Генерация завершена!');
    console.log(`👤 Аккаунт: #${result.accountUsed}`);
    console.log(`🔗 Чат: ${result.chatUrl}`);
    if (result.shareUrl) console.log(`🔗 Share: ${result.shareUrl}`);
  } catch (error) {
    console.error(`\n❌ Ошибка: ${error.message}`);
  }

  process.exit(0);
}

// Режим 3 и 4: Многопромптовая цепочка
async function runMultiPromptMode(shouldContinue) {
  const fileName = await selectMultiPromptFile(promptsDir, fs, path);
  const filePath = path.join(promptsDir, fileName);
  const jobName = path.basename(fileName, '.txt').replace(/[<>:"/\\|?*]/g, '_');

  const rawText = fs.readFileSync(filePath, 'utf-8');
  const config = parseMultiPromptFile(rawText);

  if (config.prompts.length === 0) {
    console.log('\n❌ В файле не найдено пронумерованных промптов');
    process.exit(1);
  }

  console.log(`\n📋 Задача: ${jobName}`);
  console.log(`🤖 Модель: ${config.model}`);
  console.log(`🎯 Триггер завершения: ${config.trigger}`);
  console.log(`📝 Промптов в цепочке: ${config.prompts.length}\n`);

  // 🚀 API-режим цепочки (официальное API, vcp_ ключи из tokens.txt)
  if (getApiKeys().length > 0) {
    try {
      await runApiMultiPrompt({ config, jobName });
      console.log('\n✅ Цепочка (API) завершена.');
    } catch (error) {
      console.error(`\n❌ Ошибка: ${error.message}`);
    }
    process.exit(0);
  }

  let progress = loadProgress(jobName, promptsDir);
  let startStep = 0;
  let currentProjectUrl = null;

  if (shouldContinue && progress) {
    const shouldCont = await confirmContinue(jobName, progress.currentStep, config.prompts.length);
    if (shouldCont) {
      startStep = progress.currentStep - 1;
      if (progress.continueUrl) {
        console.log(`🔗 Восстанавливаю проект: ${progress.continueUrl}\n`);
        currentProjectUrl = await importProjectFromUrl(progress.continueUrl);
      }
    }
  } else if (config.continueUrl) {
    currentProjectUrl = await importProjectFromUrl(config.continueUrl);
  }

  const outputSubDir = path.join('multi', jobName);

  for (let i = startStep; i < config.prompts.length; i++) {
    const promptItem = config.prompts[i];
    const stepNum = i + 1;

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📌 Шаг ${stepNum}/${config.prompts.length}: ${promptItem.text.slice(0, 60)}...`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    let attempt = 0;
    let success = false;
    const maxRetries = 2;

    while (!success && attempt <= maxRetries) {
      attempt++;
      
      let currentPrompt = promptItem.text;
      if (attempt > 1) {
        console.log(`♻️  Попытка ${attempt}/${maxRetries + 1} (retry с автодополнением)\n`);
        currentPrompt = buildRetryPrompt(promptItem.text, config.retryPrompt, config.trigger);
      }

      try {
        const result = await runGeneration({ 
          prompt: currentPrompt, 
          model: config.model, 
          jobName: `${jobName}_step${stepNum}`,
          outputSubDir,
          continueUrl: currentProjectUrl
        });

        // Обновляем currentProjectUrl для следующего шага
        currentProjectUrl = result.chatUrl;

        // Проверяем наличие триггера в последнем ответе v0
        const lastResponse = await page.evaluate(() => {
          const messages = Array.from(document.querySelectorAll('[data-message-role="assistant"]'));
          if (messages.length === 0) return '';
          return messages[messages.length - 1].innerText;
        });

        if (checkTriggerInResponse(lastResponse, config.trigger)) {
          console.log(`✅ Триггер "${config.trigger}" найден! Шаг ${stepNum} завершён.`);
          success = true;

          // Сохраняем прогресс
          saveProgress(jobName, promptsDir, {
            jobName,
            currentStep: stepNum + 1,
            totalSteps: config.prompts.length,
            continueUrl: result.chatUrl,
            lastUpdate: new Date().toISOString()
          });

        } else {
          console.log(`⚠️ Триггер "${config.trigger}" не найден в ответе.`);
          if (attempt <= maxRetries) {
            console.log(`♻️  Повторяю шаг с retry-промптом...`);
          }
        }

      } catch (error) {
        console.error(`❌ Ошибка на шаге ${stepNum}: ${error.message}`);
        
        if (error.message.includes('закончились') || error.message.includes('исчерпал')) {
          console.log(`♻️  Кредиты исчерпаны, сохраняю прогресс для продолжения позже...`);
          
          saveProgress(jobName, promptsDir, {
            jobName,
            currentStep: stepNum,
            totalSteps: config.prompts.length,
            continueUrl: page.url(),
            lastUpdate: new Date().toISOString(),
            needsRetry: true
          });

          console.log(`\n💾 Прогресс сохранён. Запустите заново с режимом "Продолжить многопромптовую цепочку"`);
          process.exit(1);
        }

        throw error;
      }
    }

    if (!success) {
      console.log(`\n❌ Не удалось выполнить шаг ${stepNum} за ${maxRetries + 1} попыток`);
      process.exit(1);
    }
  }

  console.log(`\n\n🎉 Цепочка "${jobName}" полностью завершена!`);
  console.log(`📂 Файлы сохранены в: output/${outputSubDir}/`);
  
  // Удаляем файл прогресса
  const progressFile = path.join(promptsDir, 'done', `${jobName}.progress.json`);
  if (fs.existsSync(progressFile)) fs.unlinkSync(progressFile);
  
  // Архивируем исходный файл
  const doneFile = path.join(promptsDoneDir, fileName);
  fs.renameSync(filePath, doneFile);

  process.exit(0);
}

// Файловый вотчер (работает только в режиме API)
setInterval(() => {
  if (fileWatcherEnabled) {
    processPromptFiles().catch(e => console.error('❌ Вотчер упал:', e.message));
  }
}, 2000);

app.listen(3000, async () => {
  try {
    await startInteractiveMode();
  } catch (e) {
    if (e.statusCode === 401) {
      console.error(`\n❌ ${e.message}`);
    } else {
      console.error(`\n💥 КРИТИЧЕСКАЯ ОШИБКА: ${e.message}`);
      console.error(e.stack);
    }
    console.log('\n🛑 Сервер продолжает работу. Обновите tokens.txt и перезапустите.');
  }
});
