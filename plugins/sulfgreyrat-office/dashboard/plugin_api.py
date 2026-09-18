"""sulfgreyrat-office dashboard API (SulfGreyrat's office).

GET /api/plugins/sulfgreyrat-office/state -> snapshot for the pixel office:
who is on shift, who is working (and on which kanban task), board counters.

Read-only by construction: every SQLite handle is opened with mode=ro and
PRAGMA query_only. Session queries are aggregates only (no message content);
from kanban.db we read task titles/statuses — the same data the bundled
Kanban board shows.

Based on the backend of oslook/hermes-desktop-plugin-office-3d (MIT), with the
Windows-safe PID probe (os.kill(pid, 0) sends CTRL_C_EVENT on Windows).
"""
from __future__ import annotations

import asyncio
import atexit
import json
import os
import sqlite3
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter

router = APIRouter()

HERMES_HOME = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")

# A session touched within this window counts as "working right now".
ACTIVE_WINDOW_SEC = 90.0
# A task finished within this window gets a "done!" moment in the office.
JUST_DONE_SEC = 180.0
_STATE_TTL_SEC = 2.0

_db_lock = threading.Lock()
_ro_conns: Dict[str, sqlite3.Connection] = {}
_cache_lock = threading.Lock()
_cache: Optional[Tuple[float, Dict[str, Any]]] = None


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _discover_profiles() -> List[str]:
    names = ["default"]
    try:
        prof_dir = os.path.join(HERMES_HOME, "profiles")
        names.extend(sorted(
            d for d in os.listdir(prof_dir)
            if os.path.isdir(os.path.join(prof_dir, d))
        ))
    except OSError:
        pass
    return names


def _profile_home(profile: str) -> str:
    if profile == "default":
        return HERMES_HOME
    return os.path.join(HERMES_HOME, "profiles", profile)


def _pid_alive(pid: Any) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if os.name == "nt":
        # os.kill(pid, 0) is NOT a probe on Windows (bpo-14484).
        try:
            import psutil
            return psutil.pid_exists(pid)
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def _last_json_object(raw: str) -> Optional[Dict[str, Any]]:
    """gateway_state.json may hold several concatenated objects; take the last."""
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    end = raw.rfind("}")
    while end != -1:
        start = raw.rfind("{", 0, end)
        while start != -1:
            try:
                obj = json.loads(raw[start:end + 1])
                if isinstance(obj, dict):
                    return obj
            except json.JSONDecodeError:
                pass
            start = raw.rfind("{", 0, start)
        end = raw.rfind("}", 0, end)
    return None


def _gateway_alive(profile: str) -> bool:
    path = os.path.join(_profile_home(profile), "gateway_state.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = _last_json_object(f.read())
    except OSError:
        return False
    if not data:
        return False
    try:
        pid = int(data.get("pid"))
    except (TypeError, ValueError):
        return False
    return _pid_alive(pid)


def _ro_conn(path: str) -> Optional[sqlite3.Connection]:
    """Process-cached read-only connection. Caller holds _db_lock."""
    con = _ro_conns.get(path)
    if con is not None:
        try:
            con.execute("SELECT 1")
            return con
        except Exception:
            _drop_conn(path)
    if not os.path.exists(path):
        return None
    try:
        con = sqlite3.connect("file:" + path + "?mode=ro", uri=True,
                              timeout=2.0, check_same_thread=False)
        try:
            con.execute("PRAGMA query_only=ON")
        except sqlite3.Error:
            pass
        _ro_conns[path] = con
        return con
    except Exception:
        return None


def _drop_conn(path: str) -> None:
    con = _ro_conns.pop(path, None)
    if con is not None:
        try:
            con.close()
        except Exception:
            pass


@atexit.register
def _close_all() -> None:
    with _db_lock:
        for path in list(_ro_conns):
            _drop_conn(path)


def _query(path: str, sql: str, params: tuple = ()) -> List[tuple]:
    with _db_lock:
        con = _ro_conn(path)
        if con is None:
            return []
        try:
            return con.execute(sql, params).fetchall()
        except Exception:
            _drop_conn(path)
            return []


# ---------------------------------------------------------------------------
# readers
# ---------------------------------------------------------------------------

_SESSION_SQL = (
    "SELECT "
    "SUM(CASE WHEN last_activity_at >= ? THEN 1 ELSE 0 END), "
    "SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), "
    "SUM(COALESCE(actual_cost_usd, estimated_cost_usd, 0)), "
    "MAX(last_activity_at) "
    "FROM sessions"
)


def _session_stats(profile: str, now: float) -> Dict[str, Any]:
    out = {"active_sessions": 0, "tokens_total": 0, "cost_total": 0.0,
           "last_activity": None}
    rows = _query(os.path.join(_profile_home(profile), "state.db"),
                  _SESSION_SQL, (now - ACTIVE_WINDOW_SEC,))
    if not rows or not rows[0]:
        return out
    active, tokens, cost, last = rows[0]
    try:
        out["active_sessions"] = int(active or 0)
        out["tokens_total"] = int(tokens or 0)
        out["cost_total"] = round(float(cost or 0.0), 4)
        out["last_activity"] = float(last) if last is not None else None
    except (TypeError, ValueError):
        pass
    return out


def _board(now: float) -> Dict[str, Any]:
    path = os.path.join(HERMES_HOME, "kanban.db")
    counts: Dict[str, int] = {}
    for status, n in _query(path, "SELECT status, COUNT(*) FROM tasks GROUP BY status"):
        counts[str(status)] = int(n)

    lt = time.localtime(now)
    midnight = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
    done_today = _query(
        path, "SELECT COUNT(*) FROM tasks WHERE completed_at >= ? "
              "AND status IN ('done', 'archived')", (int(midnight),))

    running: Dict[str, Dict[str, Any]] = {}
    for tid, assignee, title, started in _query(
            path, "SELECT id, assignee, title, started_at FROM tasks "
                  "WHERE status = 'running' AND assignee IS NOT NULL "
                  "ORDER BY COALESCE(started_at, 0) DESC"):
        running.setdefault(str(assignee), {
            "id": tid, "title": str(title or "")[:160], "started_at": started})

    just_done: Dict[str, Dict[str, Any]] = {}
    for tid, assignee, title, completed in _query(
            path, "SELECT id, assignee, title, completed_at FROM tasks "
                  "WHERE status = 'done' AND assignee IS NOT NULL "
                  "AND completed_at >= ? ORDER BY completed_at DESC",
            (int(now - JUST_DONE_SEC),)):
        just_done.setdefault(str(assignee), {
            "id": tid, "title": str(title or "")[:160], "completed_at": completed})

    return {
        "queue": sum(counts.get(s, 0) for s in ("triage", "todo", "scheduled", "ready")),
        "running": counts.get("running", 0),
        "blocked": counts.get("blocked", 0),
        "review": counts.get("review", 0),
        "done_today": int(done_today[0][0]) if done_today else 0,
        "_running": running,
        "_just_done": just_done,
    }


def _collect() -> Dict[str, Any]:
    global _cache
    mono = time.monotonic()
    with _cache_lock:
        if _cache is not None and _cache[0] > mono:
            return _cache[1]

    now = time.time()
    gateway_online = _gateway_alive("default")
    board = _board(now)
    running = board.pop("_running")
    just_done = board.pop("_just_done")

    profiles = []
    for name in _discover_profiles():
        stats = _session_stats(name, now)
        task = running.get(name)
        busy = stats["active_sessions"] > 0 or task is not None
        profiles.append({
            "profile": name,
            "online": bool(gateway_online or busy),
            "busy": busy,
            "task": task,
            "just_done": None if busy else just_done.get(name),
            **stats,
        })

    payload = {"now": now, "gateway_online": gateway_online,
               "profiles": profiles, "board": board}
    with _cache_lock:
        _cache = (mono + _STATE_TTL_SEC, payload)
    return payload


@router.get("/state")
async def state() -> Dict[str, Any]:
    return await asyncio.to_thread(_collect)
