"""Команда агентов для SulfGreyrat's office.

    python setup_agents.py             # создать 8 профилей-ролей и закрепить оркестратора
    python setup_agents.py --dry-run   # только показать, что будет сделано
    python setup_agents.py --no-soul   # не дописывать роль в SOUL.md профилей
    python setup_agents.py --no-alias  # не создавать команды-обёртки (architect, tester, ...)

Что делает:
  1. Для каждой роли создаёт профиль Hermes
     (`hermes profile create <имя> --clone --description ...`) — клон активного
     профиля, поэтому у агента сразу есть модель, ключи и скиллы.
     Уже существующий профиль не пересоздаётся — только обновляется описание.
  2. Дописывает в SOUL.md профиля короткую инструкцию роли (между маркерами,
     повторный запуск ничего не дублирует).
  3. Закрепляет основной профиль `default` оркестратором Kanban
     (`kanban.orchestrator_profile: default` в config.yaml, с бэкапом).
  4. Включает оркестратору инструменты Kanban (`toolsets: [hermes-cli, kanban]`),
     чтобы он сам создавал карточки и раздавал задачи.

Описания профилей важны: по ним оркестратор Kanban решает, кому отдать задачу.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

AGENTS = [
    ("architect", "Архитектор. Разбивает задачу на компоненты, выбирает решения до кода.",
     "Ты архитектор. Сфокусируйся на структуре и решениях ДО кода: разбей задачу на "
     "компоненты, назови компромиссы, опиши план реализации. Код пиши, только если это "
     "явно требуется."),
    ("designer", "Дизайнер. UI/UX, макеты, визуальная консистентность.",
     "Ты дизайнер. Фокус на UI/UX и визуальной консистентности: макет, стили, раскладка. "
     "Обосновывай решения по интерфейсу."),
    ("developer", "Разработчик. Реализует и проверяет код запуском.",
     "Ты разработчик. Реализуй решение полностью и рабочим кодом, проверь его запуском "
     "там, где это возможно."),
    ("devops", "DevOps. Инфраструктура, CI/CD, деплой, мониторинг.",
     "Ты DevOps. Инфраструктура, CI/CD, деплой, мониторинг. Проверяй изменения безопасным "
     "способом перед применением."),
    ("prod-operator", "Прод. Отдельная граница доверия: НИЧЕГО автоматически.",
     "Ты прод-оператор. Максимальная осторожность: ничего не меняй на проде без явного "
     "подтверждения на каждый шаг."),
    ("researcher", "Исследователь. Собирает и сравнивает информацию, не пишет код.",
     "Ты исследователь. Сначала собери информацию (веб, документация, существующий код), "
     "сравни варианты. Не пиши и не правь код без явного запроса — отдай выводы и "
     "рекомендацию."),
    ("reviewer", "Ревьюер. Анализирует код и решения, не переписывает без запроса.",
     "Ты ревьюер. Читай и анализируй, не переписывай код за автора без явного запроса. "
     "Отчёт — по пунктам: что не так, почему, что исправить, насколько критично."),
    ("tester", "Тестировщик. Запускает и проверяет, фиксирует баги и результаты проверки.",
     "Ты тестировщик. Проверяй работу запуском и тестами, ищи баги и граничные случаи, "
     "фиксируй результат (что запускал, что получил) в итоговом отчёте."),
]

BEGIN = "<!-- sulfgreyrat-office:role -->"
END = "<!-- /sulfgreyrat-office:role -->"


def hermes_home() -> Path:
    env = os.environ.get("HERMES_HOME")
    if env:
        return Path(env)
    local = Path(os.environ.get("LOCALAPPDATA", "")) / "hermes"
    if os.name == "nt" and local.is_dir():
        return local
    return Path.home() / ".hermes"


def hermes_cli(home: Path) -> str:
    found = shutil.which("hermes")
    if found:
        return found
    for cand in (home / "hermes-agent" / "venv" / "Scripts" / "hermes.exe",
                 home / "hermes-agent" / "venv" / "bin" / "hermes"):
        if cand.is_file():
            return str(cand)
    sys.exit("Не нашёл команду hermes — установите Hermes Agent или добавьте его в PATH")


def run(cmd: list[str], dry: bool) -> None:
    print("  $", " ".join(f'"{c}"' if " " in c else c for c in cmd))
    if dry:
        return
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if res.returncode != 0:
        sys.exit("  ! ошибка:\n" + (res.stderr or res.stdout)[-800:])


def write_role(soul: Path, name: str, prompt: str, dry: bool) -> str:
    block = f"{BEGIN}\n## Роль в команде: {name}\n\n{prompt}\n{END}\n"
    text = soul.read_text(encoding="utf-8") if soul.is_file() else ""
    if BEGIN in text:
        new = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", block, text, flags=re.S)
        verdict = "роль обновлена" if new != text else "роль уже на месте"
    else:
        new = text.rstrip("\n") + ("\n\n" if text.strip() else "") + block
        verdict = "роль дописана"
    if not dry and new != text:
        soul.write_text(new, encoding="utf-8")
    return verdict


def pin_orchestrator(cfg: Path, dry: bool) -> str:
    text = cfg.read_text(encoding="utf-8")
    if re.search(r"^kanban:\n(?:  .*\n)*?  orchestrator_profile:", text, re.M):
        return "оркестратор уже задан — не трогаю"
    if re.search(r"^kanban:\n", text, re.M):
        new = re.sub(r"^kanban:\n", "kanban:\n  orchestrator_profile: default\n", text, count=1, flags=re.M)
    else:
        new = text.rstrip("\n") + "\nkanban:\n  orchestrator_profile: default\n"
    if dry:
        return "будет задан kanban.orchestrator_profile: default"
    backup = cfg.with_name(cfg.name + ".bak-agents-" + time.strftime("%Y%m%d-%H%M%S"))
    shutil.copy2(cfg, backup)
    cfg.write_text(new, encoding="utf-8", newline="")
    return "kanban.orchestrator_profile: default (бэкап " + backup.name + ")"


def enable_kanban_tools(cfg: Path, dry: bool) -> str:
    """Инструменты kanban_create/kanban_list видны агенту, только если в корневом
    `toolsets` конфига есть `kanban` — иначе оркестратор не сможет раздавать задачи."""
    text = cfg.read_text(encoding="utf-8")
    try:
        import yaml
        current = (yaml.safe_load(text) or {}).get("toolsets")
    except ImportError:
        current = "unknown" if re.search(r"^toolsets:", text, re.M) else None
    if isinstance(current, list) and "kanban" in current:
        return "инструменты Kanban у оркестратора уже включены"
    if current is not None:
        return ("в config.yaml уже есть свой `toolsets` — добавьте в него `kanban` вручную, "
                "чтобы оркестратор мог создавать карточки")
    if dry:
        return "будет добавлено toolsets: [hermes-cli, kanban]"
    backup = cfg.with_name(cfg.name + ".bak-agents-" + time.strftime("%Y%m%d-%H%M%S") + "-tools")
    shutil.copy2(cfg, backup)
    cfg.write_text(text.rstrip("\n") + "\ntoolsets:\n  - hermes-cli\n  - kanban\n", encoding="utf-8", newline="")
    return "toolsets: [hermes-cli, kanban] — оркестратор может раздавать задачи (бэкап " + backup.name + ")"


def main() -> None:
    dry = "--dry-run" in sys.argv
    soul = "--no-soul" not in sys.argv
    no_alias = "--no-alias" in sys.argv
    home = hermes_home()
    if not (home / "config.yaml").is_file():
        sys.exit(f"Не нашёл {home / 'config.yaml'} — сначала настройте Hermes (hermes setup) или задайте HERMES_HOME")
    cli = hermes_cli(home)
    print(f"HERMES_HOME: {home}" + ("   [dry-run]" if dry else ""))

    for name, desc, prompt in AGENTS:
        pdir = home / "profiles" / name
        print(f"\n[{name}]")
        if pdir.is_dir():
            run([cli, "profile", "describe", name, "--text", desc], dry)
        else:
            extra = ["--no-alias"] if no_alias else []
            run([cli, "profile", "create", name, "--clone", "--description", desc, *extra], dry)
        if soul:
            print("  ", write_role(pdir / "SOUL.md", name, prompt, dry))

    print("\n[kanban]")
    print("  ", pin_orchestrator(home / "config.yaml", dry))
    print("  ", enable_kanban_tools(home / "config.yaml", dry))
    print("\nГотово. Дальше: включите Kanban в Hermes Desktop (Settings > Plugins) и держите "
          "gateway запущенным — диспетчер задач живёт в нём.")


if __name__ == "__main__":
    main()
