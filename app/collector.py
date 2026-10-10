"""Hintergrund-Sammler: Systemmetriken, Live-Puffer und Langzeit-Historie in SQLite.

Jedes Sample ist ein flaches Dict {schlüssel: zahl}. Zusammengesetzte Werte werden
mit Doppelpunkt kodiert, z. B. "core:3", "net_rx:enp1s0", "disk_util:nvme0n1",
"temp:nvme0". Pro Minute werden Mittel- und Maximalwerte aller Schlüssel in SQLite
abgelegt; daraus speisen sich die Analyse-Ansichten.
"""
from __future__ import annotations

import collections
import glob
import json
import logging
import os
import sqlite3
import threading
import time

import psutil

from . import config, hostinfo
from .processes import containers, monitor

log = logging.getLogger("systemstats.collector")

_VIRTUAL_IF_PREFIXES = ("lo", "veth", "br-", "docker", "virbr", "vnet", "tun", "tap", "tailscale", "wg")


def _is_physical_if(name: str) -> bool:
    return os.path.exists(f"/sys/class/net/{name}/device") and not name.startswith(_VIRTUAL_IF_PREFIXES)


def _is_physical_disk(name: str) -> bool:
    # Ganze Geräte (keine Partitionen, keine loop-/ram-Geräte)
    if name.startswith(("loop", "ram", "zram", "sr")):
        return False
    return os.path.exists(f"/sys/block/{name}")


class Database:
    def __init__(self, path: str) -> None:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.path = path
        self.lock = threading.Lock()
        self.conn = sqlite3.connect(path, check_same_thread=False, timeout=30)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS metrics_1m (
                ts INTEGER PRIMARY KEY,      -- Minutenbeginn (Unix-Sekunden)
                avg TEXT NOT NULL,           -- JSON {key: mittelwert}
                max TEXT NOT NULL            -- JSON {key: maximum}
            );
            CREATE TABLE IF NOT EXISTS proc_1m (
                ts INTEGER NOT NULL,
                name TEXT NOT NULL,
                container TEXT,
                cpu REAL NOT NULL,           -- mittlere CPU % in der Minute (Summe aller gleichnamigen Prozesse)
                rss INTEGER NOT NULL,        -- maximaler RSS in der Minute
                count INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_proc_ts ON proc_1m(ts);
            CREATE TABLE IF NOT EXISTS disk_usage (
                ts INTEGER NOT NULL,
                mountpoint TEXT NOT NULL,
                used INTEGER NOT NULL,
                total INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_disk_ts ON disk_usage(mountpoint, ts);
            """
        )
        self.conn.commit()

    def execute(self, sql: str, params=()) -> list:
        with self.lock:
            return self.conn.execute(sql, params).fetchall()

    def executemany(self, sql: str, rows) -> None:
        with self.lock:
            self.conn.executemany(sql, rows)
            self.conn.commit()

    def commit_one(self, sql: str, params=()) -> None:
        with self.lock:
            self.conn.execute(sql, params)
            self.conn.commit()


class Collector:
    def __init__(self) -> None:
        self.db = Database(config.DB_PATH)
        self.live: collections.deque[dict] = collections.deque(maxlen=config.LIVE_BUFFER)
        self.lock = threading.Lock()
        self._stop = threading.Event()
        self._prev_net = None
        self._prev_disk = None
        self._prev_t = None
        self._minute_samples: list[dict] = []
        self._minute_procs: dict[tuple[str, str | None], list] = {}
        self._minute_proc_samples = 0
        self._current_minute = None
        self._mlock = threading.Lock()  # schützt die Minuten-Akkumulatoren der Prozesse
        self.mounts: list[dict] = []
        self.mounts_time = 0.0
        self.started = time.time()
        psutil.cpu_percent(percpu=True)

    # ------------------------------------------------------------------ Lebenszyklus

    def start(self) -> None:
        threading.Thread(target=self._run_metrics, name="metrics", daemon=True).start()
        threading.Thread(target=self._run_procs, name="procs", daemon=True).start()
        threading.Thread(target=self._run_slow, name="slow", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self, interval: float, fn) -> None:
        next_t = time.monotonic()
        while not self._stop.is_set():
            try:
                fn()
            except Exception:  # Sammler darf nie sterben
                log.exception("Fehler in %s", fn.__name__)
            next_t += interval
            delay = next_t - time.monotonic()
            if delay < 0:
                next_t = time.monotonic()
                delay = 0
            self._stop.wait(delay)

    def _run_metrics(self) -> None:
        self._loop(config.SAMPLE_INTERVAL, self.sample_metrics)

    def _run_procs(self) -> None:
        self._loop(config.PROC_INTERVAL, self.sample_procs)

    def _run_slow(self) -> None:
        last_docker = last_disk = last_cleanup = 0.0
        while not self._stop.is_set():
            now = time.time()
            try:
                if now - last_docker >= config.DOCKER_INTERVAL:
                    containers.refresh()
                    last_docker = now
                if now - self.mounts_time >= 30:
                    self.mounts = hostinfo.host_mounts()
                    self.mounts_time = now
                if now - last_disk >= config.DISK_USAGE_INTERVAL:
                    self.db.executemany(
                        "INSERT INTO disk_usage(ts, mountpoint, used, total) VALUES (?,?,?,?)",
                        [(int(now), m["mountpoint"], m["used"], m["total"]) for m in self.mounts],
                    )
                    last_disk = now
                if now - last_cleanup >= 3600:
                    self._cleanup(now)
                    last_cleanup = now
            except Exception:
                log.exception("Fehler im langsamen Sammler")
            self._stop.wait(5)

    def _cleanup(self, now: float) -> None:
        self.db.commit_one("DELETE FROM metrics_1m WHERE ts < ?", (now - config.RETENTION_METRICS_DAYS * 86400,))
        self.db.commit_one("DELETE FROM proc_1m WHERE ts < ?", (now - config.RETENTION_PROCS_DAYS * 86400,))
        self.db.commit_one("DELETE FROM disk_usage WHERE ts < ?", (now - config.RETENTION_DISK_DAYS * 86400,))

    # ------------------------------------------------------------------ Metriken

    def sample_metrics(self) -> None:
        now = time.time()
        s: dict[str, float] = {"ts": round(now, 2)}

        cores = psutil.cpu_percent(percpu=True)
        s["cpu"] = round(sum(cores) / len(cores), 1) if cores else 0
        for i, c in enumerate(cores):
            s[f"core:{i}"] = c
        times = psutil.cpu_times_percent()
        s["cpu_user"] = times.user + times.nice
        s["cpu_system"] = times.system + getattr(times, "irq", 0) + getattr(times, "softirq", 0)
        s["cpu_iowait"] = getattr(times, "iowait", 0)
        s["cpu_steal"] = getattr(times, "steal", 0)
        freq = psutil.cpu_freq()
        if freq:
            s["cpu_freq"] = round(freq.current)
        s["load1"], s["load5"], s["load15"] = (round(x, 2) for x in os.getloadavg())

        vm = psutil.virtual_memory()
        s["mem_total"] = vm.total
        s["mem_used"] = vm.total - vm.available
        s["mem_avail"] = vm.available
        s["mem_cached"] = getattr(vm, "cached", 0) + getattr(vm, "buffers", 0)
        s["mem_shared"] = getattr(vm, "shared", 0)
        sw = psutil.swap_memory()
        s["swap_total"] = sw.total
        s["swap_used"] = sw.used

        # Raten (Netz / Datenträger) relativ zum vorigen Sample
        net = psutil.net_io_counters(pernic=True)
        disk = psutil.disk_io_counters(perdisk=True)
        if self._prev_t is not None:
            dt = now - self._prev_t
            rx_total = tx_total = 0.0
            for name, c in net.items():
                p = self._prev_net.get(name)
                if not p or name == "lo":
                    continue
                rx = max(0, c.bytes_recv - p.bytes_recv) / dt
                tx = max(0, c.bytes_sent - p.bytes_sent) / dt
                if name.startswith(("veth", "br-", "docker", "virbr", "vnet")):
                    continue  # virtuelle Container-/VM-Schnittstellen nicht einzeln speichern
                s[f"net_rx:{name}"] = round(rx)
                s[f"net_tx:{name}"] = round(tx)
                if _is_physical_if(name):
                    rx_total += rx
                    tx_total += tx
            s["net_rx"] = round(rx_total)
            s["net_tx"] = round(tx_total)
            r_total = w_total = 0.0
            for name, c in disk.items():
                p = self._prev_disk.get(name)
                if not p or not _is_physical_disk(name):
                    continue
                r = max(0, c.read_bytes - p.read_bytes) / dt
                w = max(0, c.write_bytes - p.write_bytes) / dt
                busy = getattr(c, "busy_time", 0) - getattr(p, "busy_time", 0)
                s[f"disk_r:{name}"] = round(r)
                s[f"disk_w:{name}"] = round(w)
                s[f"disk_util:{name}"] = round(min(100.0, max(0, busy) / (dt * 10)), 1)
                if not name.startswith("dm-"):  # dm-Geräte liegen auf physischen Geräten
                    r_total += r
                    w_total += w
            s["disk_r"] = round(r_total)
            s["disk_w"] = round(w_total)
        self._prev_net, self._prev_disk, self._prev_t = net, disk, now

        # Temperaturen
        try:
            temps = psutil.sensors_temperatures()
        except Exception:
            temps = {}
        for chip, entries in temps.items():
            for idx, e in enumerate(entries):
                if e.current is None or e.current <= 0:
                    continue
                if chip == "k10temp" or chip == "coretemp":
                    if e.label in ("Tctl", "Package id 0", "") and "cpu_temp" not in s:
                        s["cpu_temp"] = e.current
                    continue
                if chip == "amdgpu":
                    continue  # kommt aus dem GPU-Sampler
                if chip == "nvme":
                    continue  # wird unten pro Gerät eindeutig zugeordnet
                label = chip if not e.label else f"{chip}/{e.label}"
                s[f"temp:{label}"] = e.current

        # NVMe-Temperatur ("Composite" = temp1) direkt je Controller – psutil-Reihenfolge ist nicht stabil
        for hw in glob.glob("/sys/class/nvme/nvme*/hwmon*/temp1_input"):
            t = hostinfo.read_int(hw)
            if t:
                s[f"temp:{hw.split('/')[4]}"] = t / 1000

        s.update(hostinfo.gpu.sample())
        s.update(hostinfo.pressure())

        for cid, st in containers.cgroup_sample().items():
            name = containers.by_id[cid]["name"]
            if "cpu" in st:
                s[f"ct_cpu:{name}"] = st["cpu"]
            s[f"ct_mem:{name}"] = st["mem"]

        _, procs = monitor.get()
        if procs:
            s["procs"] = len(procs)
            s["threads"] = sum(p["threads"] for p in procs)
            s["zombies"] = sum(1 for p in procs if p["status"] == "zombie")

        with self.lock:
            self.live.append(s)
        self._accumulate_minute(s)

    def _accumulate_minute(self, s: dict) -> None:
        minute = int(s["ts"] // 60 * 60)
        if self._current_minute is None:
            self._current_minute = minute
        if minute != self._current_minute:
            self._flush_minute()
            self._current_minute = minute
        self._minute_samples.append(s)

    def _flush_minute(self) -> None:
        samples, self._minute_samples = self._minute_samples, []
        with self._mlock:
            procs, self._minute_procs = self._minute_procs, {}
            nproc, self._minute_proc_samples = self._minute_proc_samples, 0
        ts = self._current_minute
        if samples:
            sums: dict[str, float] = {}
            counts: dict[str, int] = {}
            maxes: dict[str, float] = {}
            for s in samples:
                for k, v in s.items():
                    if k == "ts" or v is None:
                        continue
                    sums[k] = sums.get(k, 0) + v
                    counts[k] = counts.get(k, 0) + 1
                    if v > maxes.get(k, float("-inf")):
                        maxes[k] = v
            avg = {k: round(sums[k] / counts[k], 3) for k in sums}
            self.db.commit_one(
                "INSERT OR REPLACE INTO metrics_1m(ts, avg, max) VALUES (?,?,?)",
                (ts, json.dumps(avg, separators=(",", ":")), json.dumps(maxes, separators=(",", ":"))),
            )
        if procs and nproc:
            rows = []
            for (name, cont), (cpu_sum, rss_max, cnt_max) in procs.items():
                rows.append((ts, name, cont, round(cpu_sum / nproc, 2), rss_max, cnt_max))
            # nur relevante Gruppen speichern: Top 25 nach CPU und Top 25 nach RAM
            top = set(sorted(rows, key=lambda r: -r[3])[:25]) | set(sorted(rows, key=lambda r: -r[4])[:25])
            self.db.executemany(
                "INSERT INTO proc_1m(ts, name, container, cpu, rss, count) VALUES (?,?,?,?,?,?)",
                list(top),
            )

    def sample_procs(self) -> None:
        monitor.sample()
        _, procs = monitor.get()
        groups: dict[tuple[str, str | None], list] = {}
        for p in procs:
            key = (p["name"], p["container"])
            g = groups.get(key)
            if g is None:
                groups[key] = [p["cpu"], p["rss"], 1]
            else:
                g[0] += p["cpu"]
                g[1] += p["rss"]
                g[2] += 1
        with self._mlock:
            for key, (cpu, rss, cnt) in groups.items():
                acc = self._minute_procs.get(key)
                if acc is None:
                    self._minute_procs[key] = [cpu, rss, cnt]
                else:
                    acc[0] += cpu
                    acc[1] = max(acc[1], rss)
                    acc[2] = max(acc[2], cnt)
            self._minute_proc_samples += 1

    # ------------------------------------------------------------------ Abfragen

    def live_since(self, since: float, limit: int | None = None) -> list[dict]:
        with self.lock:
            data = [s for s in self.live if s["ts"] > since]
        if limit:
            data = data[-limit:]
        return data

    def latest(self) -> dict:
        with self.lock:
            return dict(self.live[-1]) if self.live else {}


collector = Collector()
