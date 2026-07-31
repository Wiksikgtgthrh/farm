# -*- coding: utf-8 -*-
"""
w.py — отправка промпта на локальный v0-сервер без мучений с кодировкой.

Использование (во втором терминале, БЕЗ кавычек):
    python w.py Создай лендинг для кофейни с тёмной темой
    python w.py -m "v0 Mini" Сделай форму логина

Модель по умолчанию: Opus 5. Если первый аргумент совпал с именем
известной модели (например: python w.py v0 Mini сделай ...) — он тоже
будет воспринят как модель.

Кодировка: аргументы командной строки Windows приходят в Unicode,
stdout переводится в UTF-8 — русский текст доезжает до сервера без "??????".
"""
import sys
import json
import urllib.request

SERVER = 'http://localhost:3000/api/generate'
DEFAULT_MODEL = 'Opus 5'

KNOWN_MODELS = [
    'v0 Mini', 'v0 Pro', 'v0 Max', 'v0 Max Fast',
    'Fable 5', 'Opus 5', 'Opus 5 Fast', 'GPT-5.6 Sol', 'Kimi K3'
]

# stdout/stderr в UTF-8, чтобы и ответы с русским текстом печатались нормально
for stream_name in ('stdout', 'stderr'):
    stream = getattr(sys, stream_name, None)
    if stream and hasattr(stream, 'reconfigure'):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass


def main():
    args = sys.argv[1:]

    if not args or args[0] in ('-h', '--help', '/?'):
        print(__doc__)
        sys.exit(0)

    model = DEFAULT_MODEL

    # Вариант 1: флаг -m <модель>
    if args[0] == '-m':
        if len(args) < 3:
            print('❌ После -m укажи модель и промпт: python w.py -m "v0 Mini" промпт')
            sys.exit(1)
        model = args[1]
        args = args[2:]
    else:
        # Вариант 2: промпт начинается с имени известной модели ("v0 Mini ...")
        for known in sorted(KNOWN_MODELS, key=len, reverse=True):
            candidate = ' '.join(args[:len(known.split())])
            if candidate.lower() == known.lower() and len(args) > len(known.split()):
                model = known
                args = args[len(known.split()):]
                break

    prompt = ' '.join(args).strip()
    if not prompt:
        print('❌ Промпт пустой.')
        sys.exit(1)

    payload = json.dumps({'prompt': prompt, 'model': model}, ensure_ascii=False).encode('utf-8')

    req = urllib.request.Request(
        SERVER,
        data=payload,
        headers={'Content-Type': 'application/json; charset=utf-8'},
        method='POST'
    )

    print(f'🤖 Модель: {model}')
    print(f'📝 Промпт ({len(prompt)} симв.): {prompt[:100]}{"…" if len(prompt) > 100 else ""}')
    print('⏳ Отправлено, ждем генерацию (может занять до 4 минут)...\n')

    try:
        with urllib.request.urlopen(req, timeout=360) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        print(f'❌ Сервер ответил {e.code}: {body}')
        sys.exit(1)
    except Exception as e:
        print(f'❌ Не удалось достучаться до сервера: {e}')
        print('   Сервер запущен? (npm start в первом терминале)')
        sys.exit(1)

    if data.get('success'):
        print('✅ Генерация завершена!')
        print(f'🔗 Чат: {data.get("chatUrl")}')
        print(f'👤 Аккаунт: #{data.get("accountUsed")}')
        saved = data.get('filesSaved') or []
        print(f'📦 Файлов сохранено: {len(saved)}')
        for f in saved:
            print(f'   └─ output/{f}')
        stats = data.get('stats') or {}
        if stats:
            print(f'🔑 Аккаунтов активно: {stats.get("activeAccountsRemaining")}/{stats.get("totalAccounts")}')
    else:
        print(f'⚠️ Ответ сервера: {json.dumps(data, ensure_ascii=False, indent=2)}')


if __name__ == '__main__':
    main()
