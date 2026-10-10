"""Speicherplatzanalyse: Verzeichnis-Scans (du-ähnlich), Docker-Belegung, Füllprognose."""
from __future__ import annotations

import heapq
import os
import stat
import threading
import time
import uuid

from . import hostinfo


class ScanJob:
    """Durchläuft einen Verzeichnisbaum des Hosts (ohne Dateisystemgrenzen zu überschreiten).

    Gespeichert wird pro Verzeichnis: Größe (belegte Blöcke, wie `du`), Dateianzahl und
    die Namen der Unterverzeichnisse. Dadurch kann im Ergebnis ohne erneuten Scan
    beliebig tief navigiert werden. Zusätzlich werden die größten Dateien gesammelt.
    """

    MAX_LARGEST = 200

    def __init__(self, path: str) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.path = os.path.normpath("/" + path.strip().lstrip("/"))
        self.state = "running"
        self.error: str | None = None
        self.started = time.time()
        self.finished: float | None = None
        self.files = 0
        self.dirs_count = 0
        self.bytes = 0
        self.errors = 0
        self.current = self.path
        self.dirs: dict[str, list] = {}  # host-pfad -> [größe, dateien, [kind-namen]]
        self.largest: list[tuple[int, str, float]] = []  # Min-Heap (größe, pfad, mtime)
        self._cancel = threading.Event()
        self._seen_inodes: set[tuple[int, int]] = set()

    def cancel(self) -> None:
        self._cancel.set()

    def run(self) -> None:
        root_real = hostinfo.host_path(self.path)
        try:
            st = os.lstat(root_real)
            if not stat.S_ISDIR(st.st_mode):
                raise NotADirectoryError(self.path)
            self._walk(self.path, st.st_dev)
            self.state = "cancelled" if self._cancel.is_set() else "done"
        except Exception as exc:  # Fehler im Job melden statt Thread sterben lassen
            self.state = "error"
            self.error = str(exc)
        self.finished = time.time()
        self._seen_inodes.clear()

    def _walk(self, root: str, dev: int) -> None:
        # Iterativer Post-Order-Durchlauf, damit sehr tiefe Bäume keinen Rekursionsfehler auslösen
        stack: list[tuple[str, bool]] = [(root, False)]
        while stack:
            if self._cancel.is_set():
                return
            path, processed = stack.pop()
            if processed:
                entry = self.dirs[path]
                for child in entry[2]:
                    c = self.dirs.get(path.rstrip("/") + "/" + child)
                    if c:
                        entry[0] += c[0]
                        entry[1] += c[1]
                continue
            self.current = path
            self.dirs_count += 1
            size = 0
            files = 0
            children: list[str] = []
            try:
                with os.scandir(hostinfo.host_path(path)) as it:
                    for e in it:
                        try:
                            st = e.stat(follow_symlinks=False)
                        except OSError:
                            self.errors += 1
                            continue
                        if stat.S_ISDIR(st.st_mode):
                            if st.st_dev != dev:
                                continue  # anderes Dateisystem (Mountpoint)
                            children.append(e.name)
                            size += st.st_blocks * 512
                            continue
                        if st.st_nlink > 1:
                            key = (st.st_dev, st.st_ino)
                            if key in self._seen_inodes:
                                continue
                            self._seen_inodes.add(key)
                        used = st.st_blocks * 512
                        size += used
                        files += 1
                        if stat.S_ISREG(st.st_mode):
                            fp = path.rstrip("/") + "/" + e.name
                            if len(self.largest) < self.MAX_LARGEST:
                                heapq.heappush(self.largest, (used, fp, st.st_mtime))
                            elif used > self.largest[0][0]:
                                heapq.heapreplace(self.largest, (used, fp, st.st_mtime))
            except OSError:
                self.errors += 1
            self.files += files
            self.bytes += size
            self.dirs[path] = [size, files, children]
            stack.append((path, True))
            for child in children:
                stack.append((path.rstrip("/") + "/" + child, False))

    def summary(self) -> dict:
        end = self.finished or time.time()
        return {
            "id": self.id,
            "path": self.path,
            "state": self.state,
            "error": self.error,
            "started": self.started,
            "finished": self.finished,
            "duration": round(end - self.started, 1),
            "files": self.files,
            "dirs": self.dirs_count,
            "bytes": self.bytes,
            "errors": self.errors,
            "current": self.current if self.state == "running" else None,
        }

    def view(self, path: str | None) -> dict:
        """Inhalt eines Verzeichnisses innerhalb des Scan-Ergebnisses."""
        path = os.path.normpath("/" + (path or self.path).lstrip("/"))
        entry = self.dirs.get(path)
        if entry is None:
            return {"path": path, "found": False, "items": []}
        items = []
        dir_total = 0
        for name in entry[2]:
            cp = path.rstrip("/") + "/" + name
            c = self.dirs.get(cp)
            if c:
                items.append({"name": name, "path": cp, "type": "dir", "size": c[0], "files": c[1]})
                dir_total += c[0]
        # Dateien direkt in diesem Verzeichnis (frisch gelesen, günstig)
        loose = 0
        file_items = []
        try:
            with os.scandir(hostinfo.host_path(path)) as it:
                for e in it:
                    try:
                        st = e.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if stat.S_ISDIR(st.st_mode):
                        continue
                    used = st.st_blocks * 512
                    loose += used
                    file_items.append({"name": e.name, "path": path.rstrip("/") + "/" + e.name,
                                       "type": "link" if stat.S_ISLNK(st.st_mode) else "file",
                                       "size": used, "mtime": st.st_mtime})
        except OSError:
            pass
        file_items.sort(key=lambda x: -x["size"])
        items.sort(key=lambda x: -x["size"])
        parent = None
        if path != self.path:
            parent = os.path.dirname(path)
        return {
            "path": path,
            "found": True,
            "parent": parent,
            "size": entry[0],
            "files": entry[1],
            "items": items + file_items[:100],
            "more_files": max(0, len(file_items) - 100),
        }

    def largest_files(self, limit: int = 100) -> list[dict]:
        top = sorted(self.largest, reverse=True)[:limit]
        return [{"path": p, "size": s, "mtime": m} for s, p, m in top]


class ScanManager:
    def __init__(self) -> None:
        self.jobs: dict[str, ScanJob] = {}
        self.lock = threading.Lock()

    def start(self, path: str) -> ScanJob:
        job = ScanJob(path)
        with self.lock:
            # laufenden Scan desselben Pfads abbrechen, alte Ergebnisse begrenzen
            for j in self.jobs.values():
                if j.path == job.path and j.state == "running":
                    j.cancel()
            done = sorted((j for j in self.jobs.values() if j.state != "running"), key=lambda j: j.started)
            for j in done[:-4]:
                self.jobs.pop(j.id, None)
            self.jobs[job.id] = job
        threading.Thread(target=job.run, name=f"scan-{job.id}", daemon=True).start()
        return job

    def get(self, job_id: str) -> ScanJob | None:
        return self.jobs.get(job_id)

    def list(self) -> list[dict]:
        return [j.summary() for j in sorted(self.jobs.values(), key=lambda j: -j.started)]


scans = ScanManager()


# --------------------------------------------------------------------------- Docker

_docker_df_cache: dict = {"time": 0.0, "data": None, "running": False}
_docker_df_lock = threading.Lock()


def _compute_docker_df() -> None:
    try:
        data = hostinfo.docker_get("/system/df", timeout=300)
        if data is None:
            result = {"available": False}
        else:
            images = data.get("Images") or []
            conts = data.get("Containers") or []
            vols = data.get("Volumes") or []
            cache = data.get("BuildCache") or []
            used_images = {c.get("ImageID") for c in conts}
            result = {
                "available": True,
                "layers_size": data.get("LayersSize", 0),
                "images": {
                    "count": len(images),
                    "size": sum(i.get("Size", 0) for i in images),
                    "shared": sum(i.get("SharedSize", 0) or 0 for i in images if (i.get("SharedSize") or 0) > 0),
                    "unused_count": sum(1 for i in images if i.get("Id") not in used_images),
                    "unused_size": sum(i.get("Size", 0) - max(0, i.get("SharedSize") or 0)
                                       for i in images if i.get("Id") not in used_images),
                    "top": sorted([
                        {"tag": (i.get("RepoTags") or ["<none>"])[0], "size": i.get("Size", 0),
                         "created": i.get("Created"), "used": i.get("Id") in used_images,
                         "containers": i.get("Containers", 0)}
                        for i in images], key=lambda x: -x["size"])[:40],
                },
                "containers": {
                    "count": len(conts),
                    "size_rw": sum(c.get("SizeRw", 0) or 0 for c in conts),
                    "top": sorted([
                        {"name": (c.get("Names") or ["/?"])[0].lstrip("/"), "size_rw": c.get("SizeRw", 0) or 0,
                         "state": c.get("State"), "image": c.get("Image")}
                        for c in conts], key=lambda x: -x["size_rw"])[:40],
                },
                "volumes": {
                    "count": len(vols),
                    "size": sum(max(0, (v.get("UsageData") or {}).get("Size", 0)) for v in vols),
                    "unused_count": sum(1 for v in vols if (v.get("UsageData") or {}).get("RefCount", 0) == 0),
                    "unused_size": sum(max(0, (v.get("UsageData") or {}).get("Size", 0))
                                       for v in vols if (v.get("UsageData") or {}).get("RefCount", 0) == 0),
                    "top": sorted([
                        {"name": v.get("Name"), "size": max(0, (v.get("UsageData") or {}).get("Size", 0)),
                         "refs": (v.get("UsageData") or {}).get("RefCount", 0)}
                        for v in vols], key=lambda x: -x["size"])[:40],
                },
                "build_cache": {
                    "count": len(cache),
                    "size": sum(b.get("Size", 0) for b in cache),
                    "reclaimable": sum(b.get("Size", 0) for b in cache if not b.get("InUse") and not b.get("Shared")),
                },
            }
        _docker_df_cache["data"] = result
        _docker_df_cache["time"] = time.time()
    finally:
        _docker_df_cache["running"] = False


def docker_df(refresh: bool = False) -> dict:
    """Docker-Speicherbelegung. `docker system df` kann lange dauern – daher asynchron mit Cache."""
    with _docker_df_lock:
        stale = time.time() - _docker_df_cache["time"] > 900
        if (refresh or stale or _docker_df_cache["data"] is None) and not _docker_df_cache["running"]:
            _docker_df_cache["running"] = True
            threading.Thread(target=_compute_docker_df, name="docker-df", daemon=True).start()
    return {"running": _docker_df_cache["running"], "time": _docker_df_cache["time"],
            "data": _docker_df_cache["data"]}


# --------------------------------------------------------------------------- Prognose

def fill_forecast(db, mounts: list[dict], days: float = 14) -> dict[str, dict]:
    """Lineare Regression der Belegung je Mountpoint -> Wachstum/Tag und Tage bis voll."""
    since = time.time() - days * 86400
    out = {}
    for m in mounts:
        rows = db.execute(
            "SELECT ts, used FROM disk_usage WHERE mountpoint=? AND ts>=? ORDER BY ts",
            (m["mountpoint"], since),
        )
        rows = list(rows) + [(time.time(), m["used"])]
        span = rows[-1][0] - rows[0][0]
        if len(rows) < 3 or span < 3600:
            out[m["mountpoint"]] = {"samples": len(rows), "span_h": round(span / 3600, 1),
                                    "per_day": None, "days_until_full": None}
            continue
        n = len(rows)
        mx = sum(r[0] for r in rows) / n
        my = sum(r[1] for r in rows) / n
        sxx = sum((r[0] - mx) ** 2 for r in rows)
        sxy = sum((r[0] - mx) * (r[1] - my) for r in rows)
        slope = sxy / sxx if sxx else 0  # Bytes pro Sekunde
        per_day = slope * 86400
        days_full = None
        if per_day > 0:
            days_full = round(m["free"] / per_day, 1)
        out[m["mountpoint"]] = {"samples": n, "span_h": round(span / 3600, 1),
                                "per_day": round(per_day), "days_until_full": days_full}
    return out


# --------------------------------------------------------------------------- Container-Logs

def container_logs(registry) -> list[dict]:
    """Größe der json-file-Logs aller Container (häufige, unbemerkte Platzfresser)."""
    import glob

    out = []
    base = hostinfo.host_path("/var/lib/docker/containers")
    for path in glob.glob(base + "/*/*-json.log*"):
        try:
            st = os.stat(path)
        except OSError:
            continue
        cid = os.path.basename(os.path.dirname(path))
        meta = registry.by_id.get(cid, {})
        out.append({
            "container": meta.get("name", cid[:12]),
            "state": meta.get("state", "?"),
            "path": path[len(hostinfo.host_path("/")):] if path.startswith(hostinfo.host_path("/")) else path,
            "size": st.st_blocks * 512,
            "mtime": st.st_mtime,
        })
    out.sort(key=lambda x: -x["size"])
    return out
