import fs from 'fs';

export function parseTokenLine(line) {
  if (!line) return null;

  // Берём всё после номера до конца строки (authorization токены содержат пробел: "Bearer vcp_...")
  const numbered = line.trim().match(/^(\d+)\)\s*(.+)/);
  if (numbered && numbered[2].length > 20) {
    return { num: Number.parseInt(numbered[1], 10), token: numbered[2].trim() };
  }

  // ФИКС: старый формат used_tokens.txt ("U<token>  # used at ...") — срезаем префикс U,
  // иначе токен не совпадает с записью в tokens.txt и не считается исчерпанным
  const unmarked = line.trim().replace(/^U(?=[A-Za-z0-9])/, '');
  const token = unmarked.split(/\s+#/, 1)[0];
  return token.length > 20 && !token.includes('#') ? { num: null, token } : null;
}

export function loadTokens(tokensFile) {
  if (!fs.existsSync(tokensFile)) return [];
  return fs.readFileSync(tokensFile, 'utf-8')
    .split(/\r?\n/)
    .map(parseTokenLine)
    .filter(Boolean)
    .map(entry => entry.token);
}

// Возвращает [{num, token}] — с номерами из tokens.txt (1), 2), ...)
export function loadTokensWithNumbers(tokensFile) {
  if (!fs.existsSync(tokensFile)) return [];
  return fs.readFileSync(tokensFile, 'utf-8')
    .split(/\r?\n/)
    .map(parseTokenLine)
    .filter(Boolean);
}

export function getTokenNumber(tokensFile, token) {
  if (!fs.existsSync(tokensFile)) return null;
  const entry = fs.readFileSync(tokensFile, 'utf-8')
    .split(/\r?\n/)
    .map(parseTokenLine)
    .find(candidate => candidate?.token === token);
  return entry?.num ?? null;
}

// Writes a complete line before removing the active token, so a failed write
// never loses the only copy of a token.
export function moveTokenToUsed({ token, tokensFile, usedTokensFile }) {
  const lines = fs.existsSync(tokensFile)
    ? fs.readFileSync(tokensFile, 'utf-8').split(/\r?\n/)
    : [];

  let entry = null;
  const kept = lines.filter(line => {
    const parsed = parseTokenLine(line);
    if (!entry && parsed?.token === token) {
      entry = parsed;
      return false;
    }
    return true;
  });

  if (!entry) throw new Error('текущий токен не найден в tokens.txt');

  const existing = fs.existsSync(usedTokensFile) ? fs.readFileSync(usedTokensFile, 'utf-8') : '';
  const prefix = entry.num !== null ? `${entry.num})` : '';
  const separator = existing && !/\r?\n$/.test(existing) ? '\r\n' : '';
  const record = `${prefix}${entry.token}  # used at ${new Date().toISOString()}\r\n`;
  fs.appendFileSync(usedTokensFile, `${separator}${record}`, 'utf-8');

  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  fs.writeFileSync(tokensFile, kept.length ? `${kept.join('\r\n')}\r\n` : '', 'utf-8');

  const activeTokens = loadTokens(tokensFile);
  const usedTokens = loadTokens(usedTokensFile);
  if (activeTokens.includes(token) || !usedTokens.includes(token)) {
    throw new Error('проверка переноса не пройдена: файлы токенов не обновились');
  }
  return { number: entry.num, record: record.trim() };
}
