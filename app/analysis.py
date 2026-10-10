"""Auswertung: Zustandsbewertung (Warnungen), Zeitreihen-Abfragen und Top-Verbraucher."""
from __future__ import annotations

import json
import math
import time

from . import config, storage
from .collector import collector
from .processes import containers, monitor

RANGES = {"15m": 900, "1h": 3600, "6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400}


def _level(value: float, warn: float, crit: float, lower_is_bad: bool = False) -> str:
    if lower_is_bad:
        return "crit" if value <= crit else "warn" if value <= warn else "ok"
    return "crit" if value >= crit else "warn" if value >= warn else "ok"


def health() -> dict:
    """Prüft aktuelle Werte gegen Schwellwerte und liefert eine Liste von Befunden."""
    s = collector.latest()
    t = config.THRESHOLDS
    items: list[dict] = []

    def add(level, area, title, detail, value=None):
        items.append({"level": level, "area": area, "title": title, "detail": detail, "value": value})

    if s:
        avail_pct = s["mem_avail"] / s["mem_total"] * 100 if s.get("mem_total") else 100
        add(_level(avail_pct, *t["mem_avail_pct"], lower_is_bad=True), "RAM",
            "Verfügbarer Arbeitsspeicher", f"{avail_pct:.1f} % verfügbar", round(avail_pct, 1))
        if s.get("swap_total"):
            sp = s["swap_used"] / s["swap_total"] * 100
            add(_level(sp, *t["swap_pct"]), "RAM", "Swap-Belegung", f"{sp:.1f} % belegt", round(sp, 1))
        ncpu = monitor.ncpu
        lvl = "crit" if s["load5"] > ncpu * 1.5 else "warn" if s["load5"] > ncpu else "ok"
        add(lvl, "CPU", "Systemlast (5 min)", f"{s['load5']:.2f} bei {ncpu} Threads", s["load5"])
        if "cpu_temp" in s:
            add(_level(s["cpu_temp"], *t["cpu_temp"]), "CPU", "CPU-Temperatur", f"{s['cpu_temp']:.0f} °C", s["cpu_temp"])
        if "gpu_temp" in s:
            add(_level(s["gpu_temp"], *t["gpu_temp"]), "GPU", "GPU-Temperatur", f"{s['gpu_temp']:.0f} °C", s["gpu_temp"])
        for k, v in s.items():
            if k.startswith("temp:nvme"):
                add(_level(v, *t["nvme_temp"]), "Speicher", f"Temperatur {k[5:]}", f"{v:.0f} °C", v)
        for key, label in (("psi_cpu", "CPU"), ("psi_mem", "RAM"), ("psi_io", "I/O")):
            if key in s:
                add(_level(s[key], *t[key]), label, f"Druck (PSI) {label}",
                    f"{s[key]:.1f} % der Zeit warten Tasks (10 s)", s[key])
        if s.get("zombies"):
            add("warn" if s["zombies"] > 5 else "info", "Prozesse", "Zombie-Prozesse",
                f"{int(s['zombies'])} Zombie-Prozesse", s["zombies"])

    mounts = collector.mounts
    forecast = storage.fill_forecast(collector.db, mounts) if mounts else {}
    for m in mounts:
        add(_level(m["percent"], *t["disk_pct"]), "Speicher", f"Belegung {m['mountpoint']}",
            f"{m['percent']:.1f} % belegt, {_fmt_bytes(m['free'])} frei", m["percent"])
        if m["inodes_total"]:
            lvl = _level(m["inodes_percent"], *t["inode_pct"])
            if lvl != "ok":
                add(lvl, "Speicher", f"Inodes {m['mountpoint']}", f"{m['inodes_percent']:.1f} % belegt", m["inodes_percent"])
        fc = forecast.get(m["mountpoint"])
        if fc and fc["days_until_full"] is not None:
            lvl = _level(fc["days_until_full"], *t["days_until_full"], lower_is_bad=True)
            add(lvl, "Speicher", f"Prognose {m['mountpoint']}",
                f"voll in ca. {fc['days_until_full']:.0f} Tagen (+{_fmt_bytes(fc['per_day'])}/Tag)",
                fc["days_until_full"])

    if containers.available:
        bad = [c for c in containers.by_id.values()
               if c["state"] == "restarting" or "unhealthy" in c["status"]]
        for c in bad:
            add("warn", "Container", f"Container {c['name']}", c["status"])
        big_logs = [l for l in storage.container_logs(containers) if l["size"] > 2 * 1024 ** 3]
        for l in big_logs[:5]:
            add("crit" if l["size"] > 20 * 1024 ** 3 else "warn", "Speicher", f"Container-Log {l['container']}",
                f"{_fmt_bytes(l['size'])} json-Log – Log-Rotation (max-size) fehlt?", l["size"])
        exited = [c for c in containers.by_id.values() if c["state"] in ("exited", "dead")]
        if exited:
            add("info", "Container", "Gestoppte Container", f"{len(exited)} Container nicht aktiv", len(exited))

    order = {"crit": 0, "warn": 1, "info": 2, "ok": 3}
    items.sort(key=lambda i: order[i["level"]])
    summary = {lvl: sum(1 for i in items if i["level"] == lvl) for lvl in order}
    overall = "crit" if summary["crit"] else "warn" if summary["warn"] else "ok"
    return {"overall": overall, "summary": summary, "items": items, "forecast": forecast}


def _fmt_bytes(n: float | None) -> str:
    if n is None:
        return "?"
    units = ["B", "KB", "MB", "GB", "TB", "PB"]
    i = 0
    n = float(n)
    while abs(n) >= 1024 and i < len(units) - 1:
        n /= 1024
        i += 1
    return f"{n:.1f} {units[i]}"


def _percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    vs = sorted(values)
    k = (len(vs) - 1) * p
    lo, hi = math.floor(k), math.ceil(k)
    return vs[lo] + (vs[hi] - vs[lo]) * (k - lo)


def history(range_key: str, keys: list[str], points: int = 400) -> dict:
    """Zeitreihen + Statistik (min/avg/max/p95) für die angefragten Schlüssel.

    Bis 1 h werden die 2-s-Rohdaten aus dem RAM genutzt, darüber die Minutenaggregate
    aus SQLite. Ein Schlüssel mit Präfix "*" (z. B. "*core:") liefert alle passenden Schlüssel.
    """
    seconds = RANGES.get(range_key, 3600)
    now = time.time()
    since = now - seconds
    rows: list[tuple[float, dict, dict]] = []
    if seconds <= 3600:
        for s in collector.live_since(since):
            rows.append((s["ts"], s, s))
    else:
        for ts, avg, mx in collector.db.execute(
                "SELECT ts, avg, max FROM metrics_1m WHERE ts >= ? ORDER BY ts", (since,)):
            rows.append((ts + 30, json.loads(avg), json.loads(mx)))

    # Wildcards auflösen
    resolved: list[str] = []
    for k in keys:
        if k.startswith("*"):
            prefix = k[1:]
            found = set()
            for _, a, _ in rows[-50:]:
                found.update(x for x in a if x.startswith(prefix))
            resolved.extend(sorted(found, key=_natural_key))
        else:
            resolved.append(k)

    # Auf maximal `points` Buckets verdichten
    bucket = max(1, math.ceil(len(rows) / points))
    series: dict[str, list] = {k: [] for k in resolved}
    series_max: dict[str, list] = {k: [] for k in resolved}
    ts_out: list[float] = []
    for i in range(0, len(rows), bucket):
        chunk = rows[i:i + bucket]
        ts_out.append(round(chunk[-1][0], 1))
        for k in resolved:
            vals = [a.get(k) for _, a, _ in chunk if a.get(k) is not None]
            mxs = [m.get(k) for _, _, m in chunk if m.get(k) is not None]
            series[k].append(round(sum(vals) / len(vals), 3) if vals else None)
            series_max[k].append(max(mxs) if mxs else None)

    stats = {}
    for k in resolved:
        vals = [a.get(k) for _, a, _ in rows if a.get(k) is not None]
        mxs = [m.get(k) for _, _, m in rows if m.get(k) is not None]
        if not vals:
            stats[k] = None
            continue
        stats[k] = {
            "min": min(vals),
            "avg": sum(vals) / len(vals),
            "max": max(mxs) if mxs else max(vals),
            "p95": _percentile(vals, 0.95),
            "last": vals[-1],
        }
    return {
        "range": range_key,
        "source": "live" if seconds <= 3600 else "db",
        "resolution": (config.SAMPLE_INTERVAL if seconds <= 3600 else 60) * bucket,
        "coverage": (rows[-1][0] - rows[0][0]) if len(rows) > 1 else 0,
        "ts": ts_out,
        "series": series,
        "series_max": series_max,
        "stats": stats,
    }


def _natural_key(s: str):
    import re
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s)]


def top_processes(range_key: str, limit: int = 20) -> dict:
    """Prozessgruppen (Name + Container) mit dem höchsten Verbrauch im Zeitraum."""
    seconds = RANGES.get(range_key, 3600)
    since = time.time() - seconds
    minutes = collector.db.execute(
        "SELECT COUNT(DISTINCT ts), MIN(ts) FROM proc_1m WHERE ts >= ?", (since,))[0]
    n_minutes = minutes[0] or 0
    if not n_minutes:
        return {"minutes": 0, "by_cpu": [], "by_mem": []}
    q = """
        SELECT name, container, SUM(cpu) / ? AS cpu_avg, MAX(cpu) AS cpu_peak,
               AVG(rss) AS rss_avg, MAX(rss) AS rss_peak, MAX(count) AS count, COUNT(*) AS present
        FROM proc_1m WHERE ts >= ? GROUP BY name, container
    """
    rows = collector.db.execute(q, (n_minutes, since))
    data = [{"name": r[0], "container": r[1], "cpu_avg": round(r[2], 2), "cpu_peak": round(r[3], 1),
             "rss_avg": int(r[4]), "rss_peak": int(r[5]), "count": r[6],
             "presence": round(r[7] / n_minutes * 100)} for r in rows]
    return {
        "minutes": n_minutes,
        "since": minutes[1],
        "by_cpu": sorted(data, key=lambda d: -d["cpu_avg"])[:limit],
        "by_mem": sorted(data, key=lambda d: -d["rss_avg"])[:limit],
    }


def disk_history(range_key: str) -> dict:
    seconds = RANGES.get(range_key, 7 * 86400)
    since = time.time() - seconds
    out: dict[str, list] = {}
    for ts, mp, used, total in collector.db.execute(
            "SELECT ts, mountpoint, used, total FROM disk_usage WHERE ts >= ? ORDER BY ts", (since,)):
        out.setdefault(mp, []).append([ts, used, total])
    return out
