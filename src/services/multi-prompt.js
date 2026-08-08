// multi-prompt.js — парсинг и выполнение цепочек промптов с триггерами
import fs from 'fs';
import path from 'path';

// Парсит многопромптовый файл
// Формат:
//   model: Opus 5
//   trigger: ✅ГОТОВО
//   retry_prompt: Доделай предыдущий шаг и напиши "{trigger}" когда закончишь.
//   continue_url: https://v0.app/chat/abc123 (опционально)
//
//   1) Первый промпт
//   2) Второй промпт
//   ...
export function parseMultiPromptFile(rawText) {
  const lines = rawText.replace(/^﻿/, '').split(/\r?\n/);
  
  let model = 'Opus 5';
  let trigger = '✅ГОТОВО';
  let retryPrompt = 'Доделай предыдущий шаг полностью и напиши "{trigger}" когда закончишь.';
  let continueUrl = '';
  
  let startIdx = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (line.match(/^model\s*:\s*(.+)$/i)) {
      model = line.match(/^model\s*:\s*(.+)$/i)[1].trim();
      startIdx = i + 1;
    } else if (line.match(/^trigger\s*:\s*(.+)$/i)) {
      trigger = line.match(/^trigger\s*:\s*(.+)$/i)[1].trim();
      startIdx = i + 1;
    } else if (line.match(/^retry_prompt\s*:\s*(.+)$/i)) {
      retryPrompt = line.match(/^retry_prompt\s*:\s*(.+)$/i)[1].trim();
      startIdx = i + 1;
    } else if (line.match(/^continue_url\s*:\s*(.*)$/i)) {
      continueUrl = line.match(/^continue_url\s*:\s*(.*)$/i)[1].trim();
      startIdx = i + 1;
    } else if (line.match(/^\d+\)/)) {
      // Начались промпты
      break;
    }
  }
  
  // Собираем пронумерованные промпты
  const prompts = [];
  let currentPrompt = null;
  
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(\d+)\)\s*(.+)$/);
    
    if (match) {
      if (currentPrompt) prompts.push(currentPrompt);
      currentPrompt = {
        num: parseInt(match[1], 10),
        text: match[2].trim()
      };
    } else if (currentPrompt && line.trim()) {
      currentPrompt.text += '\n' + line.trim();
    }
  }
  
  if (currentPrompt) prompts.push(currentPrompt);
  
  return {
    model,
    trigger,
    retryPrompt,
    continueUrl,
    prompts
  };
}

// Загружает прогресс цепочки промптов из файла состояния
// Формат: prompts/done/<jobName>.progress.json
export function loadProgress(jobName, promptsDir) {
  const progressFile = path.join(promptsDir, 'done', `${jobName}.progress.json`);
  
  if (!fs.existsSync(progressFile)) {
    return null;
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
    return data;
  } catch (e) {
    console.error(`⚠️ Не удалось прочитать прогресс: ${e.message}`);
    return null;
  }
}

// Сохраняет прогресс выполнения цепочки
export function saveProgress(jobName, promptsDir, data) {
  const doneDir = path.join(promptsDir, 'done');
  if (!fs.existsSync(doneDir)) fs.mkdirSync(doneDir, { recursive: true });
  
  const progressFile = path.join(doneDir, `${jobName}.progress.json`);
  fs.writeFileSync(progressFile, JSON.stringify(data, null, 2), 'utf-8');
}

// Проверяет, содержит ли ответ v0 триггер-слово
export function checkTriggerInResponse(responseText, trigger) {
  if (!trigger) return true; // Если триггера нет — считаем успешным
  return responseText.includes(trigger);
}

// Формирует retry-промпт с подстановкой триггера
export function buildRetryPrompt(originalPrompt, retryTemplate, trigger) {
  const retry = retryTemplate.replace(/\{trigger\}/g, trigger);
  return `${originalPrompt}\n\n${retry}`;
}
