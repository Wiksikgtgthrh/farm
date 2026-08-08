// v0-api.js — работа с официальным API v0 (https://api.v0.dev) через API-ключи vcp_ из tokens.txt
// Документация: https://v0.app/docs/api/platform/overview
// Ключи: https://v0.app/settings/keys (beta — вызовы тратят кредиты аккаунта)
//
// ВАЖНО про боевое API (проверено 2026-08-08):
//   - GET  /chats                  — список чатов (data[])
//   - GET  /chats/{id}             — чат целиком; ВНУТРИ лежат файлы:
//                                     chat.files [{meta.file, source}] и latestVersion.files [{name, content}]
//   - POST /chats                  — создать чат (СИНХРОННО: ждёт генерацию 1-5 минут)
//   - POST /chats/{id}/messages    — продолжить чат (тоже синхронно)
//   - GET  /chats/{id}/messages    — сообщения
//   - /chats/async, /chats/stream, /chats/{id}/files — есть в OpenAPI, но на боевом API
//     возвращают 405/404 — НЕ ИСПОЛЬЗОВАТЬ
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
  return data.data || [];
}

// Получить чат целиком — в нём же и файлы (chat.files / latestVersion.files)
export async function getChat(token, chatId) {
  return apiCall(token, `/chats/${chatId}`, { timeoutMs: 60000 });
}

// Создать чат (синхронно — ждёт завершения генерации)
export async function createChat(token, { message, systemPrompt } = {}) {
  const body = { message };
  if (systemPrompt) body.systemPrompt = systemPrompt;
  return apiCall(token, '/chats', { method: 'POST', body, timeoutMs: 300000 });
}

// Продолжить чат (синхронно)
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

// Файлы чата из GET /chats/{id}: предпочитаем chat.files [{meta.file, source}],
// fallback — latestVersion.files [{name, content}]
export async function getChatFiles(token, chatId) {
  const chat = await getChat(token, chatId);
  const fromFiles = (chat.files || [])
    .filter(f => f?.meta?.file)
    .map(f => ({ path: f.meta.file, content: f.source || '', encoding: 'utf8' }));
  if (fromFiles.length > 0) return fromFiles;
  return (chat.latestVersion?.files || [])
    .filter(f => f?.name)
    .map(f => ({ path: f.name, content: f.content || '', encoding: 'utf8' }));
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

// Находит свежий чат, созданный после указанного времени (для live-режима)
export async function findNewestChat(token, afterIso, { timeoutMs = 45000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chats = await listChats(token, { limit: 10 }).catch(() => []);
    const fresh = chats.find(c => c.createdAt && c.createdAt >= afterIso);
    if (fresh) return fresh;
    await sleep(2500);
  }
  return null;
}

// ЖИВАЯ ГЕНЕРАЦИЯ: запрос создания/продолжения уходит в фоне (не ждём ответа),
// id чата находим через список, затем каждые intervalMs качаем GET /chats/{id}
// и пишем файлы на диск ПО МЕРЕ ПОЯВЛЕНИЯ (как IDE). Завершение — статус версии.
// Возвращает { id, webUrl, assistant, count, files }.
export async function generateLive(token, { message, systemPrompt = null, chatId = null, saveDir = null, timeoutMs = 600000, intervalMs = 5000, onFile } = {}) {
  let id = chatId;

  if (!id) {
    const before = new Date().toISOString();
    // Fire-and-forget: создаём чат, но ответа не ждём (вернётся через 1-5 минут)
    createChat(token, { message, systemPrompt })
      .then(chat => { if (chat?.id) id = chat.id; })
      .catch(() => {});
    // Пока запрос летит — ищем только что созданный чат в списке
    const fresh = await findNewestChat(token, before);
    if (!fresh) throw new V0ApiError('Не удалось найти созданный чат в списке', { type: 'timeout' });
    id = fresh.id;
  } else {
    // Продолжение чата — тоже fire-and-forget
    sendMessage(token, chatId, { message, systemPrompt }).catch(() => {});
  }

  const deadline = Date.now() + timeoutMs;
  const saved = new Map();
  let assistant = null;
  let status = null;

  if (saveDir) fs.mkdirSync(saveDir, { recursive: true });

  const poll = async () => {
    const chat = await getChat(token, id).catch(() => null);
    if (!chat) return;
    status = chat.latestVersion?.status || null;
    // Файлы пишем сразу, как только появились (даже если генерация ещё идёт)
    if (saveDir) {
      const files = (chat.files || []).filter(f => f?.meta?.file);
      for (const f of files) {
        const p = f.meta.file;
        const content = f.source || '';
        if (saved.get(p) !== content) {
          const safePath = path.normalize(p).replace(/^(\.\.(\/|\\))+/, '');
          const fullPath = path.join(saveDir, safePath);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, content, 'utf8');
          const marker = saved.has(p) ? '~' : '+';
          if (onFile) onFile({ marker, path: p, size: content.length });
          saved.set(p, content);
        }
      }
    }
    // Текст ассистента
    const messages = await getMessages(token, id).catch(() => []);
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant' && last.content) assistant = last;
  };

  while (Date.now() < deadline) {
    await poll();
    if (status === 'completed' || status === 'error' || status === 'failed' || status === 'cancelled') break;
    await sleep(intervalMs);
  }
  await poll(); // финальная синхронизация

  if (status === 'error' || status === 'failed' || status === 'cancelled') {
    throw new V0ApiError(`Генерация завершилась со статусом ${status}`, { type: 'generation_failed' });
  }
  if (!assistant) {
    throw new V0ApiError('Превышено время ожидания генерации (10 минут)', { type: 'timeout' });
  }
  return { id, webUrl: `https://v0.app/chat/${id}`, assistant, count: saved.size, files: [...saved.keys()] };
}

// Ожидание завершения (для случаев без сохранения файлов)
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
