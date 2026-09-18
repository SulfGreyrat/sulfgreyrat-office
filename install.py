"""Установка SulfGreyrat's office в Hermes.

    python install.py            # скопировать фронт и бэкенд, включить бэкенд
    python install.py --remove   # удалить файлы и выключить бэкенд

Фронтенд подхватывается Hermes Desktop на лету; бэкенд монтируется только
при старте — после первой установки перезапустите Desktop целиком.
"""
from __future__ import annotations

import os
import re
import shutil
import sys
import time
from pathlib import Path

ID = "sulfgreyrat-office"
HERE = Path(__file__).resolve().parent


def hermes_home() -> Path:
    env = os.environ.get("HERMES_HOME")
    if env:
        return Path(env)
    local = Path(os.environ.get("LOCALAPPDATA", "")) / "hermes"
    if os.name == "nt" and local.is_dir():
        return local
    return Path.home() / ".hermes"


def set_enabled(cfg_path: Path, on: bool) -> str:
    text = cfg_path.read_text(encoding="utf-8")
    m = re.search(r"^plugins:\n  enabled:\n((?:    - .*\n)*)", text, re.M)
    if not m:
        return "не нашёл plugins.enabled — добавьте '%s' вручную" % ID
    items = [line[6:].strip() for line in m.group(1).splitlines()]
    if (ID in items) == on:
        return "уже " + ("включён" if on else "выключен")
    items = items + [ID] if on else [i for i in items if i != ID]
    block = "plugins:\n  enabled:\n" + "".join("    - %s\n" % i for i in items)
    new = text[:m.start()] + block + text[m.end():]
    backup = cfg_path.with_name(cfg_path.name + ".bak-%s-%s" % (ID, time.strftime("%Y%m%d-%H%M%S")))
    shutil.copy2(cfg_path, backup)
    cfg_path.write_text(new, encoding="utf-8", newline="")
    try:
        import yaml
        loaded = yaml.safe_load(new)["plugins"]["enabled"]
        assert (ID in loaded) == on
    except ImportError:
        pass
    except Exception:
        shutil.copy2(backup, cfg_path)
        raise
    return ("включён" if on else "выключен") + ", бэкап: " + backup.name


def main() -> None:
    home = hermes_home()
    if not (home / "config.yaml").is_file():
        sys.exit("Не нашёл %s\\config.yaml — задайте HERMES_HOME" % home)
    fe = home / "desktop-plugins" / ID
    be = home / "plugins" / ID / "dashboard"

    if "--remove" in sys.argv:
        print("бэкенд:", set_enabled(home / "config.yaml", False))
        shutil.rmtree(fe, ignore_errors=True)
        shutil.rmtree(home / "plugins" / ID, ignore_errors=True)
        print("файлы удалены; перезапустите Hermes Desktop")
        return

    fe.mkdir(parents=True, exist_ok=True)
    be.mkdir(parents=True, exist_ok=True)
    shutil.copy2(HERE / "desktop-plugins" / ID / "plugin.js", fe / "plugin.js")
    for name in ("plugin_api.py", "manifest.json"):
        shutil.copy2(HERE / "plugins" / ID / "dashboard" / name, be / name)
    print("фронтенд ->", fe)
    print("бэкенд   ->", be)
    print("бэкенд:", set_enabled(home / "config.yaml", True))


if __name__ == "__main__":
    main()
