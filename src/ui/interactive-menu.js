// interactive-menu.js — интерактивное меню выбора сценария и модели
import prompts from 'prompts';

// Список известных моделей v0
export const KNOWN_MODELS = [
  'v0 Mini',
  'v0 Pro', 
  'v0 Max',
  'v0 Max Fast',
  'Fable 5',
  'Opus 5',
  'Opus 5 Fast',
  'GPT-5.6 Sol',
  'Kimi K3'
];

// Главное меню: выбор режима работы
export async function showMainMenu() {
  const response = await prompts({
    type: 'select',
    name: 'mode',
    message: '🎯 Выберите режим работы:',
    choices: [
      { title: '🆕 Новый проект (один промпт)', value: 'single' },
      { title: '🔗 Продолжить существующий проект', value: 'continue' },
      { title: '📋 Многопромптовая цепочка (новый проект)', value: 'multi-new' },
      { title: '♻️  Продолжить многопромптовую цепочку', value: 'multi-continue' },
      { title: '🔄 HTTP API режим (фоновый)', value: 'api' }
    ],
    initial: 0
  });

  if (!response.mode) {
    console.log('\n❌ Отменено пользователем');
    process.exit(0);
  }

  return response.mode;
}

// Выбор модели
export async function selectModel(availableModels = KNOWN_MODELS) {
  const choices = availableModels.map((model, idx) => ({
    title: `${idx + 1}. ${model}`,
    value: model
  }));

  const response = await prompts({
    type: 'select',
    name: 'model',
    message: '🤖 Выберите модель:',
    choices,
    initial: availableModels.indexOf('Opus 5') >= 0 ? availableModels.indexOf('Opus 5') : 0
  });

  if (!response.model) {
    console.log('\n❌ Отменено пользователем');
    process.exit(0);
  }

  return response.model;
}

// Ввод URL существующего проекта
export async function inputProjectUrl() {
  const response = await prompts({
    type: 'text',
    name: 'url',
    message: '🔗 Введите URL проекта v0 (например: https://v0.app/chat/abc123):',
    validate: value => {
      if (!value.trim()) return 'URL не может быть пустым';
      if (!value.includes('v0.app')) return 'URL должен содержать v0.app';
      return true;
    }
  });

  if (!response.url) {
    console.log('\n❌ Отменено пользователем');
    process.exit(0);
  }

  return response.url.trim();
}

// Ввод одиночного промпта
export async function inputSinglePrompt() {
  const response = await prompts({
    type: 'text',
    name: 'prompt',
    message: '📝 Введите промпт:',
    validate: value => value.trim() ? true : 'Промпт не может быть пустым'
  });

  if (!response.prompt) {
    console.log('\n❌ Отменено пользователем');
    process.exit(0);
  }

  return response.prompt.trim();
}

// Выбор файла многопромптовой задачи из prompts/
export async function selectMultiPromptFile(promptsDir, fs, path) {
  const files = fs.readdirSync(promptsDir)
    .filter(f => f.toLowerCase().endsWith('.txt'))
    .sort();

  if (files.length === 0) {
    console.log('\n❌ В папке prompts/ нет .txt файлов');
    process.exit(1);
  }

  const choices = files.map(file => ({
    title: file,
    value: file
  }));

  const response = await prompts({
    type: 'select',
    name: 'file',
    message: '📋 Выберите файл с цепочкой промптов:',
    choices
  });

  if (!response.file) {
    console.log('\n❌ Отменено пользователем');
    process.exit(0);
  }

  return response.file;
}

// Подтверждение продолжения с текущим прогрессом
export async function confirmContinue(jobName, currentStep, totalSteps) {
  const response = await prompts({
    type: 'confirm',
    name: 'continue',
    message: `♻️  Найден прогресс задачи "${jobName}": шаг ${currentStep}/${totalSteps}. Продолжить?`,
    initial: true
  });

  if (response.continue === undefined) {
    console.log('\n❌ Отменено пользователем');
    process.exit(0);
  }

  return response.continue;
}


// Выбор проекта из списка последних чатов (API-режим)
export async function selectProject(chats) {
  const choices = [
    ...chats.map((c, i) => ({
      title: `${i + 1}. ${(c.title || c.id || '').slice(0, 50)} (${c.id})`,
      value: c.id,
    })),
    { title: '🔗 Ввести URL вручную', value: '__url__' },
  ];
  const response = await prompts({
    type: 'select',
    name: 'project',
    message: '📂 Выберите проект:',
    choices,
    initial: 0,
  });
  return response?.project ?? '__url__';
}
