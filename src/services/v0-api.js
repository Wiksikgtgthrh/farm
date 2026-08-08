// v0-api.js — работа с официальным API v0 (https://api.v0.dev) через API-ключи vcp_ из tokens.txt
// Документация: https://v0.app/docs/api/platform/overview
// Ключи: https://v0.app/settings/keys (beta — вызовы тратят кредиты аккаунта)
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const BASE = 'https://api.v0.dev/v1';

export class V0ApiError extends Error {
  constructor(message, { status = 0, type = '', retryable = false } = {}) {
    super(message);
    this.name = 'V0ApiError';
    this.status = status;
    this.type = type;
    this.retryable = retryable; // 402/429/5xx — можно попробовать другой аккаунт
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiCall(token, urlPath, { method = 'GET', body, timeoutMs = 90000 } = {}) {
  try {
    const res = await axios({
      method,
      url: `${BASE}${urlPath}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'v0-runner/1.0',
      },
      data: body,
      timeout: timeoutMs,
    });
    return res.data;
  } catch (e) {
    if (e.response) {
      const data = e.response.data;
      const msg = data?.error?.message || `HTTP ${e.response.status}`;
      const status = e.response.status;
      throw new V0ApiError(msg, {
        status,
        type: data?.error?.type || '',
        retryable: status === 402 || status === 429 || status === 409 || status >= 500,
      });
    }
    if (e.code === 'ECONNABORTED') {
      throw new V0ApiError(`Таймаут запроса к api.v0.dev (${Math.round(timeoutMs / 1000)}с)`, { type: 'timeout', retryable: true });
    }
    throw new V0ApiError(`Сеть: ${e.message}`, { type: 'network', retryable: true });
  }
}

// Список последних чатов аккаунта (для выбора проекта)
export async function listChats(token, { limit = 20 } = {}) {
  const data = await apiCall(token, `/chats?limit=${limit}`, { timeoutMs: 30000 });
  return data.chats || [];
}

// Создать новый чат (генерация с нуля)
export async function createChat(token, { message, systemPrompt } = {}) {
  const body = { message };
  if (systemPrompt) body.systemPrompt = systemPrompt;
  return apiCall(token, '/chats', { method: 'POST', body, timeoutMs: 300000 });
}

// Продолжить существующий чат (выбор проекта)
export async function sendMessage(token, chatId, { message, systemPrompt } = {}) {
  const body = { message };
  if (systemPrompt) body.systemPrompt = systemPrompt;
  return apiCall(token, `/chats/${chatId}/messages`, { method: 'POST', body, timeoutMs: 300000 });
}

// Сообщения чата (для определения завершения генерации)
export async function getMessages(token, chatId) {
  const data = await apiCall(token, `/chats/${chatId}/messages`, { timeoutMs: 60000 });
  return data.data || [];
}

// Файлы чата: [{ path, content, encoding: 'utf8' | 'base64' }] — вся файловая иерархия
export async function getChatFiles(token, chatId) {
  const data = await apiCall(token, `/chats/${chatId}/files`, { timeoutMs: 60000 });
  return data.files || [];
}

// Скачивает файлы чата и раскладывает по destDir с сохранением полной иерархии
export async function saveChatFiles(token, chatId, destDir) {
  const files = await getChatFiles(token, chatId);
  if (!files || files.length === 0) return { count: 0, files: [] };

  fs.mkdirSync(destDir, { recursive: true });
  const written = [];
  for (const f of files) {
    const safePath = path.normalize(f.path).replace(/^(\.\.(\/|\\))+/, '');
    const fullPath = path.join(destDir, safePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const content = f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : f.content;
    fs.writeFileSync(fullPath, content, f.encoding === 'base64' ? undefined : 'utf8');
    written.push(f.path);
  }
  return { count: written.length, files: written };
}

// Ждёт завершения генерации. Готово = последнее сообщение assistant с контентом,
// которое не меняется в течение 2 последовательных опросов (~20 сек стабильно).
export async function waitForCompletion(token, chatId, { timeoutMs = 600000, intervalMs = 10000, onProgress } = {}) {
  const deadline = Date.now() + timeoutMs;
  let prevSig = null;
  let stableTicks = 0;

  while (Date.now() < deadline) {
    const messages = await getMessages(token, chatId);
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant' && last.content) {
      const sig = `${last.updatedAt}|${last.content.length}`;
      if (prevSig === sig) {
        stableTicks++;
        if (stableTicks >= 2) return last;
      } else {
        prevSig = sig;
        stableTicks = 0;
      }
    } else {
      prevSig = null;
      stableTicks = 0;
    }
    if (onProgress) onProgress(messages);
    await sleep(intervalMs);
  }
  throw new V0ApiError('Превышено время ожидания генерации (10 минут)', { type: 'timeout' });
}

// Вытаскивает id чата из URL вида https://v0.app/chat/abc123 или просто id
export function extractChatId(urlOrId) {
  if (!urlOrId) return null;
  const m = String(urlOrId).match(/[a-zA-Z0-9_-]{8,}/);
  return m ? m[0] : null;
}
