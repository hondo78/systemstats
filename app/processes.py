"""Prozessmonitor: periodische Momentaufnahme aller Host-Prozesse inkl. Container-Zuordnung."""
from __future__ import annotations

import os
import re
import threading
import time

import psutil

from . import hostinfo

_CGROUP_RE = re.compile(r"(?:docker[-/]|containerd[-/]|libpod[-/])([0-9a-f]{64})")


class ContainerRegistry:
    """Container-ID -> Metadaten, regelmäßig über die Docker-API aktualisiert."""

    def __init__(self) -> None:
        self.by_id: dict[str, dict] = {}
        self.available = False
        self.updated = 0.0
        self.stats: dict[str, dict] = {}
        self._prev_cg: dict[str, tuple] = {}
        self._restart: dict[str, dict] = {}  # Container-ID -> RestartPolicy (nur per Inspect abrufbar)

    def restart_policy(self, cid: str, fresh: bool = False) -> dict:
        if fresh or cid not in self._restart:
            info = hostinfo.docker_get(f"/containers/{cid}/json")
            pol = ((info or {}).get("HostConfig") or {}).get("RestartPolicy") or {}
            self._restart[cid] = {"name": pol.get("Name") or "no", "max_retries": pol.get("MaximumRetryCount") or 0}
        return self._restart[cid]

    def refresh(self) -> None:
        data = hostinfo.docker_get("/containers/json?all=1")
        if data is None:
            self.available = False
            return
        self.available = True
        mapping = {}
        for c in data:
            labels = c.get("Labels") or {}
            mapping[c["Id"]] = {
                "id": c["Id"][:12],
                "name": (c.get("Names") or ["/?"])[0].lstrip("/"),
                "image": c.get("Image", ""),
                "state": c.get("State", ""),
                "status": c.get("Status", ""),
                "created": c.get("Created"),
                "project": labels.get("com.docker.compose.project", ""),
                "service": labels.get("com.docker.compose.service", ""),
                "depends_on": [d.split(":", 1)[0] for d in labels.get("com.docker.compose.depends_on", "").split(",") if d],
                "working_dir": labels.get("com.docker.compose.project.working_dir", ""),
                "restart": self.restart_policy(c["Id"]),
                "ports": sorted({
                    f"{p.get('PublicPort')}->{p.get('PrivatePort')}/{p.get('Type')}"
                    for p in c.get("Ports") or [] if p.get("PublicPort")
                }),
            }
        self.by_id = mapping
        self._restart = {k: v for k, v in self._restart.items() if k in mapping}
        self.updated = time.time()

    # ------------------------------------------------------------------ cgroup-Statistik

    def _cgroup_dir(self, cid: str) -> str | None:
        base = hostinfo.host_path("/sys/fs/cgroup")
        for cand in (f"{base}/system.slice/docker-{cid}.scope", f"{base}/docker/{cid}"):
            if os.path.isdir(cand):
                return cand
        return None

    def cgroup_sample(self) -> dict[str, dict]:
        """CPU/RAM/IO je laufendem Container aus der cgroup v2 des Hosts (wie `docker stats`)."""
        now = time.time()
        out: dict[str, dict] = {}
        for cid, meta in list(self.by_id.items()):
            if meta["state"] != "running":
                continue
            d = self._cgroup_dir(cid)
            if not d:
                continue
            cpu_usec = rbytes = wbytes = 0
            for line in hostinfo.read_text(d + "/cpu.stat").splitlines():
                if line.startswith("usage_usec"):
                    cpu_usec = int(line.split()[1])
                    break
            for line in hostinfo.read_text(d + "/io.stat").splitlines():
                for part in line.split()[1:]:
                    k, _, v = part.partition("=")
                    if k == "rbytes":
                        rbytes += int(v)
                    elif k == "wbytes":
                        wbytes += int(v)
            mem = hostinfo.read_int(d + "/memory.current", 0) or 0
            inactive = 0
            for line in hostinfo.read_text(d + "/memory.stat").splitlines():
                if line.startswith("inactive_file "):
                    inactive = int(line.split()[1])
                    break
            limit_txt = hostinfo.read_text(d + "/memory.max")
            st = {"mem": max(0, mem - inactive), "mem_limit": int(limit_txt) if limit_txt.isdigit() else None,
                  "pids": hostinfo.read_int(d + "/pids.current", 0)}
            prev = self._prev_cg.get(cid)
            if prev:
                dt = now - prev[0]
                st["cpu"] = round(max(0, cpu_usec - prev[1]) / (dt * 1e4), 1)  # % eines Kerns
                st["io_r"] = max(0, rbytes - prev[2]) / dt
                st["io_w"] = max(0, wbytes - prev[3]) / dt
            self._prev_cg[cid] = (now, cpu_usec, rbytes, wbytes)
            out[cid] = st
        self.stats = out
        return out

    def name(self, cid: str | None) -> str | None:
        if not cid:
            return None
        c = self.by_id.get(cid)
        return c["name"] if c else cid[:12]


containers = ContainerRegistry()


class ProcessMonitor:
    def __init__(self) -> None:
        self._procs: dict[int, psutil.Process] = {}
        self._static: dict[tuple[int, float], dict] = {}  # (pid, create_time) -> unveränderliche Daten
        self._prev_io: dict[int, tuple[float, int, int]] = {}
        self.snapshot: list[dict] = []
        self.snapshot_time = 0.0
        self.lock = threading.Lock()
        self.ncpu = psutil.cpu_count() or 1

    def _static_info(self, p: psutil.Process, ctime: float) -> dict:
        key = (p.pid, ctime)
        info = self._static.get(key)
        if info is None:
            cmdline = ""
            try:
                cmdline = " ".join(p.cmdline())
            except (psutil.Error, OSError):
                pass
            cid = None
            cgroup = hostinfo.read_text(f"/proc/{p.pid}/cgroup")
            m = _CGROUP_RE.search(cgroup)
            if m:
                cid = m.group(1)
            info = {"cmdline": cmdline, "container_id": cid}
            self._static[key] = info
        return info

    def sample(self) -> None:
        now = time.time()
        seen: set[int] = set()
        rows: list[dict] = []
        attrs = ["pid", "ppid", "name", "uids", "status", "create_time", "num_threads",
                 "memory_info", "cpu_percent", "nice"]
        for p in psutil.process_iter():
            pid = p.pid
            # Prozessobjekte wiederverwenden, damit cpu_percent() einen Bezugswert hat
            cached = self._procs.get(pid)
            if cached is not None and cached.is_running():
                p = cached
            else:
                self._procs[pid] = p
            seen.add(pid)
            try:
                with p.oneshot():
                    d = p.as_dict(attrs=attrs, ad_value=None)
                    io = None
                    try:
                        io = p.io_counters()
                    except (psutil.Error, OSError):
                        pass
            except psutil.NoSuchProcess:
                continue
            except psutil.Error:
                continue
            ctime = d["create_time"] or 0
            static = self._static_info(p, ctime)
            mem = d["memory_info"]
            read_rate = write_rate = None
            if io is not None:
                prev = self._prev_io.get(pid)
                if prev and prev[0] < now:
                    dt = now - prev[0]
                    read_rate = max(0, (io.read_bytes - prev[1]) / dt)
                    write_rate = max(0, (io.write_bytes - prev[2]) / dt)
                self._prev_io[pid] = (now, io.read_bytes, io.write_bytes)
            uid = d["uids"].real if d["uids"] else None
            rows.append({
                "pid": pid,
                "ppid": d["ppid"],
                "name": d["name"] or "?",
                "user": hostinfo.users.name(uid) if uid is not None else "?",
                "status": d["status"],
                "nice": d["nice"],
                "threads": d["num_threads"] or 0,
                "cpu": round(d["cpu_percent"] or 0.0, 1),
                "rss": mem.rss if mem else 0,
                "vms": mem.vms if mem else 0,
                "started": ctime,
                "io_read": read_rate,
                "io_write": write_rate,
                "cmdline": static["cmdline"],
                "container_id": static["container_id"],
                "container": containers.name(static["container_id"]),
            })
        # Verschwundene Prozesse aufräumen
        for pid in list(self._procs):
            if pid not in seen:
                self._procs.pop(pid, None)
                self._prev_io.pop(pid, None)
        if len(self._static) > len(seen) * 2 + 1000:
            alive = {(r["pid"], r["started"]) for r in rows}
            self._static = {k: v for k, v in self._static.items() if k in alive}
        with self.lock:
            self.snapshot = rows
            self.snapshot_time = now

    def get(self) -> tuple[float, list[dict]]:
        with self.lock:
            return self.snapshot_time, self.snapshot

    def detail(self, pid: int) -> dict | None:
        try:
            p = psutil.Process(pid)
            with p.oneshot():
                d = p.as_dict(attrs=["pid", "ppid", "name", "exe", "cwd", "cmdline", "status",
                                     "create_time", "num_threads", "nice", "uids", "gids",
                                     "memory_full_info", "cpu_times", "num_fds", "num_ctx_switches",
                                     "ionice", "cpu_affinity", "terminal"], ad_value=None)
            files = []
            try:
                files = [f.path for f in p.open_files()][:200]
            except (psutil.Error, OSError):
                pass
            conns = []
            try:
                for c in p.net_connections(kind="inet")[:200]:
                    conns.append({
                        "type": "TCP" if c.type == 1 else "UDP",
                        "laddr": f"{c.laddr.ip}:{c.laddr.port}" if c.laddr else "",
                        "raddr": f"{c.raddr.ip}:{c.raddr.port}" if c.raddr else "",
                        "status": c.status,
                    })
            except (psutil.Error, OSError):
                pass
            children = []
            try:
                children = [{"pid": c.pid, "name": c.name()} for c in p.children()[:100]]
            except (psutil.Error, OSError):
                pass
            parents = []
            try:
                parents = [{"pid": c.pid, "name": c.name()} for c in p.parents()]
            except (psutil.Error, OSError):
                pass
        except psutil.NoSuchProcess:
            return None
        mem = d.pop("memory_full_info")
        ct = d.pop("cpu_times")
        ctx = d.pop("num_ctx_switches")
        uids = d.pop("uids")
        d.pop("gids")
        ion = d.pop("ionice")
        cid = None
        m = _CGROUP_RE.search(hostinfo.read_text(f"/proc/{pid}/cgroup"))
        if m:
            cid = m.group(1)
        d.update({
            "cmdline": " ".join(d.get("cmdline") or []),
            "user": hostinfo.users.name(uids.real) if uids else "?",
            "memory": mem._asdict() if mem else None,
            "cpu_user": ct.user if ct else None,
            "cpu_system": ct.system if ct else None,
            "ctx_voluntary": ctx.voluntary if ctx else None,
            "ctx_involuntary": ctx.involuntary if ctx else None,
            "ionice": str(ion.ioclass) if ion else None,
            "container": containers.name(cid),
            "cgroup": hostinfo.read_text(f"/proc/{pid}/cgroup"),
            "open_files": files,
            "connections": conns,
            "children": children,
            "parents": parents,
        })
        # Lebenden Snapshot-Wert für CPU % mitliefern
        _, snap = self.get()
        for r in snap:
            if r["pid"] == pid:
                d["cpu"] = r["cpu"]
                break
        return d


monitor = ProcessMonitor()
