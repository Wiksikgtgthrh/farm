import express from 'express';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

// Создаем папку output один раз при запуске
const outputDir = path.join(process.cwd(), 'output');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const TOKENS_FILE = path.join(process.cwd(), 'tokens.txt');

function loadTokens() {
  if (!fs.existsSync(TOKENS_FILE)) {
    console.error('❌ Файл tokens.txt не найден!');
    return [];
  }
  const rawContent = fs.readFileSync(TOKENS_FILE, 'utf-8');
  return rawContent
    .split(/[\r\n]+/)
    .flatMap(line => line.split(/\s+/))
    .map(t => t.replace(/['";]/g, '').trim())
    .filter(t => t.length > 20);
}

const tokensPool = loadTokens();
const exhaustedTokens = new Set();
let currentTokenIndex = 0;

console.log(`🔑 Загружено токенов: ${tokensPool.length}`);

let browser;
let context;
let page;

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
    context = await browser.newContext();
    page = null;
  }
  if (!page || page.isClosed()) {
    if (tokensPool.length > 0) {
      await setSessionCookie(tokensPool[currentTokenIndex]);
    }
    page = await context.newPage();
    await page.goto('https://v0.app');
  }
}

async function switchToNextToken() {
  exhaustedTokens.add(tokensPool[currentTokenIndex]);
  console.log(`⚠️ Аккаунт #${currentTokenIndex + 1} исчерпал лимит кредитов.`);

  let attempts = 0;
  while (attempts < tokensPool.length) {
    currentTokenIndex = (currentTokenIndex + 1) % tokensPool.length;
    attempts++;

    if (!exhaustedTokens.has(tokensPool[currentTokenIndex])) {
      console.log(`🔄 Переключились на аккаунт #${currentTokenIndex + 1}`);
      await setSessionCookie(tokensPool[currentTokenIndex]);
      return true;
    }
  }

  console.error('🚨 Все аккаунты исчерпали свой баланс!');
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

// --- POST /api/generate ---
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, model = 'Opus 5' } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Промпт не передан' });

    if (exhaustedTokens.size === tokensPool.length && tokensPool.length > 0) {
      return res.status(429).json({ error: 'Все аккаунты исчерпали баланс' });
    }

    await ensurePageAlive();

    let success = false;
    let attempts = 0;

    while (!success && attempts < tokensPool.length) {
      attempts++;
      console.log(`\n🚀 Запуск генерации (Аккаунт #${currentTokenIndex + 1})...`);
      console.log(`📝 Промпт: "${prompt}"`);

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
        console.log(`❌ На аккаунте #${currentTokenIndex + 1} закончились токены (Out of Credit)!`);
        const chatUrlToContinue = page.url();
        const hasNext = await switchToNextToken();
        if (!hasNext) break;

        if (chatUrlToContinue.includes('/chat/') || chatUrlToContinue.includes('/r/')) {
          await page.goto(chatUrlToContinue);
        } else {
          await page.goto('https://v0.app');
        }
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
            console.log(`❌ Генерация прервана: На аккаунте #${currentTokenIndex + 1} закончились кредиты!`);
            const chatUrlToContinue = page.url();
            const hasNext = await switchToNextToken();
            if (!hasNext) break;

            if (chatUrlToContinue.includes('/chat/') || chatUrlToContinue.includes('/r/')) {
              await page.goto(chatUrlToContinue);
            } else {
              await page.goto('https://v0.app');
            }
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

      // Сохраняем файлы в папку output
      const savedFilesInfo = [];
      for (const file of filesData) {
        const fullPath = path.join(outputDir, file.relativePath);
        const dirName = path.dirname(fullPath);

        if (!fs.existsSync(dirName)) {
          fs.mkdirSync(dirName, { recursive: true });
        }
        fs.writeFileSync(fullPath, file.content, 'utf-8');
        savedFilesInfo.push(file.relativePath);
        console.log(`  └─ Сохранен: output/${file.relativePath}`);
      }

      return res.json({
        success: true,
        chatUrl: page.url(),
        modelUsed: model,
        accountUsed: currentTokenIndex + 1,
        filesSaved: savedFilesInfo,
        stats: {
          totalAccounts: tokensPool.length,
          exhaustedAccountsCount: exhaustedTokens.size,
          activeAccountsRemaining: tokensPool.length - exhaustedTokens.size
        }
      });
    }

    res.status(429).json({ error: 'Все аккаунты исчерпали лимит' });

  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000, async () => {
  console.log('🚀 API запущен на http://localhost:3000');
  await ensurePageAlive();
});