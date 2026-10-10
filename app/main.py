"""FastAPI-Anwendung: REST-API + statisches Frontend."""
from __future__ import annotations

import collections
import logging
import socket
import time
from contextlib import asynccontextmanager
from pathlib import Path

import psutil
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import analysis, config, hostinfo, storage
from .collector import collector
from .control import ControlError, control, own_project
from .processes import containers, monitor

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
STATIC = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    containers.refresh()
    collector.mounts = hostinfo.host_mounts()
    collector.mounts_time = time.time()
    collector.start()
    yield
    collector.stop()


app = FastAPI(title="Systemstats", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=2000)


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


# --------------------------------------------------------------------------- System / Live

_sysinfo_cache: dict = {}


@app.get("/api/system")
def system():
    if not _sysinfo_cache or time.time() - _sysinfo_cache["t"] > 300:
        _sysinfo_cache.update(t=time.time(), data=hostinfo.system_info())
    data = dict(_sysinfo_cache["data"])
    data["uptime"] = time.time() - data["boot_time"]
    data["now"] = time.time()
    data["docker"] = containers.available
    data["collector_started"] = collector.started
    return data


@app.get("/api/live")
def live(since: float = 0, limit: int = Query(300, le=2000)):
    return {"samples": collector.live_since(since, limit)}


@app.get("/api/health")
def health():
    return analysis.health()


# --------------------------------------------------------------------------- Prozesse

@app.get("/api/processes")
def processes():
    ts, rows = monitor.get()
    out = []
    for r in rows:
        r = dict(r)
        if len(r["cmdline"]) > 400:
            r["cmdline"] = r["cmdline"][:400] + "…"
        out.append(r)
    vm = psutil.virtual_memory()
    return {"ts": ts, "mem_total": vm.total, "ncpu": monitor.ncpu, "processes": out}


@app.get("/api/processes/top")
def processes_top(n: int = Query(8, le=50)):
    _, rows = monitor.get()
    keep = ("pid", "name", "user", "container", "cpu", "rss")
    slim = lambda r: {k: r[k] for k in keep}
    return {
        "by_cpu": [slim(r) for r in sorted(rows, key=lambda r: -r["cpu"])[:n]],
        "by_mem": [slim(r) for r in sorted(rows, key=lambda r: -r["rss"])[:n]],
    }


@app.get("/api/processes/{pid}")
def process_detail(pid: int):
    d = monitor.detail(pid)
    if d is None:
        raise HTTPException(404, "Prozess nicht gefunden")
    return d


# --------------------------------------------------------------------------- Container

@app.get("/api/containers")
def container_list():
    _, rows = monitor.get()
    agg: dict[str, dict] = {}
    for r in rows:
        cid = r["container_id"]
        if not cid:
            continue
        a = agg.setdefault(cid, {"cpu": 0.0, "rss": 0, "procs": 0, "threads": 0, "io_read": 0.0, "io_write": 0.0})
        a["cpu"] += r["cpu"]
        a["rss"] += r["rss"]
        a["procs"] += 1
        a["threads"] += r["threads"]
        a["io_read"] += r["io_read"] or 0
        a["io_write"] += r["io_write"] or 0
    out = []
    for cid, meta in containers.by_id.items():
        a = agg.get(cid, {})
        cg = containers.stats.get(cid, {})
        out.append({**meta, "full_id": cid,
                    # cgroup-Werte bevorzugen; Prozesssummen nur als Fallback (RSS zählt Shared Memory mehrfach)
                    "cpu": cg.get("cpu", round(a.get("cpu", 0), 1)),
                    "mem": cg.get("mem", a.get("rss", 0)), "mem_limit": cg.get("mem_limit"),
                    "procs": a.get("procs", 0), "threads": a.get("threads", 0),
                    "io_read": cg.get("io_r", a.get("io_read", 0)), "io_write": cg.get("io_w", a.get("io_write", 0))})
    return {"available": containers.available, "updated": containers.updated, "containers": out,
            "control": {"enabled": config.CONTROL_ENABLED, "own_project": own_project(), "jobs": control.jobs}}


class StackAction(BaseModel):
    action: str


class RestartPolicy(BaseModel):
    policy: str
    max_retries: int = 0


@app.post("/api/stacks/{project}/action")
def stack_action(project: str, req: StackAction):
    try:
        return control.run(project, req.action)
    except ControlError as e:
        raise HTTPException(400, str(e))


@app.post("/api/stacks/{project}/restart-policy")
def stack_restart_policy(project: str, req: RestartPolicy):
    try:
        return control.set_restart_policy(project, req.policy, req.max_retries)
    except ControlError as e:
        raise HTTPException(400, str(e))


# --------------------------------------------------------------------------- Speicher

@app.get("/api/storage/mounts")
def mounts():
    ms = hostinfo.host_mounts()
    collector.mounts, collector.mounts_time = ms, time.time()
    fc = storage.fill_forecast(collector.db, ms)
    for m in ms:
        m["forecast"] = fc.get(m["mountpoint"])
    s = collector.latest()
    disks = {}
    for k, v in s.items():
        if k.startswith(("disk_r:", "disk_w:", "disk_util:")):
            metric, dev = k.split(":", 1)
            disks.setdefault(dev, {})[metric] = v
    return {"mounts": ms, "disks": disks, "nvme": hostinfo.nvme_devices()}


@app.get("/api/storage/docker")
def docker_storage(refresh: bool = False):
    return storage.docker_df(refresh)


@app.get("/api/storage/logs")
def docker_logs():
    logs = storage.container_logs(containers)
    return {"total": sum(l["size"] for l in logs), "logs": logs[:50]}


class ScanRequest(BaseModel):
    path: str


@app.post("/api/storage/scan")
def start_scan(req: ScanRequest):
    job = storage.scans.start(req.path)
    return job.summary()


@app.get("/api/storage/scans")
def list_scans():
    return {"scans": storage.scans.list()}


def _job(job_id: str) -> storage.ScanJob:
    job = storage.scans.get(job_id)
    if job is None:
        raise HTTPException(404, "Scan nicht gefunden")
    return job


@app.get("/api/storage/scan/{job_id}")
def scan_view(job_id: str, path: str | None = None):
    job = _job(job_id)
    return {"summary": job.summary(), "view": job.view(path)}


@app.get("/api/storage/scan/{job_id}/largest")
def scan_largest(job_id: str, limit: int = Query(100, le=200)):
    return {"files": _job(job_id).largest_files(limit)}


@app.delete("/api/storage/scan/{job_id}")
def scan_cancel(job_id: str):
    job = _job(job_id)
    job.cancel()
    return job.summary()


# --------------------------------------------------------------------------- Netzwerk

_conn_cache: dict = {"t": 0.0, "data": None}


@app.get("/api/network")
def network():
    stats = psutil.net_if_stats()
    addrs = psutil.net_if_addrs()
    io = psutil.net_io_counters(pernic=True)
    ifaces = []
    for name, st in stats.items():
        if name.startswith("veth"):
            continue
        ips = [a.address for a in addrs.get(name, []) if a.family in (socket.AF_INET, socket.AF_INET6)]
        mac = next((a.address for a in addrs.get(name, []) if a.family == psutil.AF_LINK), "")
        c = io.get(name)
        ifaces.append({
            "name": name, "up": st.isup, "speed": st.speed, "mtu": st.mtu, "mac": mac,
            "addresses": ips,
            "physical": hostinfo.read_text(f"/sys/class/net/{name}/device/uevent") != "",
            "bytes_recv": c.bytes_recv if c else 0, "bytes_sent": c.bytes_sent if c else 0,
            "errin": c.errin if c else 0, "errout": c.errout if c else 0,
            "dropin": c.dropin if c else 0, "dropout": c.dropout if c else 0,
        })
    ifaces.sort(key=lambda i: (not i["physical"], i["name"]))
    veth_count = sum(1 for n in stats if n.startswith("veth"))

    if time.time() - _conn_cache["t"] > 10 or _conn_cache["data"] is None:
        _, rows = monitor.get()
        names = {r["pid"]: (r["name"], r["container"]) for r in rows}
        port_owner = {}
        for meta in containers.by_id.values():
            for p in meta["ports"]:
                pub, _, rest = p.partition("->")
                port_owner[(int(pub), rest.rsplit("/", 1)[-1])] = meta["name"]
        listen = []
        states: collections.Counter = collections.Counter()
        remote: collections.Counter = collections.Counter()
        try:
            conns = psutil.net_connections(kind="inet")
        except (psutil.Error, OSError):
            conns = []
        seen = set()
        for c in conns:
            proto = "TCP" if c.type == socket.SOCK_STREAM else "UDP"
            if c.status == psutil.CONN_LISTEN or (proto == "UDP" and not c.raddr):
                key = (proto, c.laddr.ip, c.laddr.port, c.pid)
                if key in seen:
                    continue
                seen.add(key)
                n = names.get(c.pid, (None, None))
                cont = n[1]
                if n[0] == "docker-proxy":
                    # veröffentlichte Ports gehören logisch zum Ziel-Container
                    cont = port_owner.get((c.laddr.port, proto.lower()), cont)
                listen.append({"proto": proto, "ip": c.laddr.ip, "port": c.laddr.port, "pid": c.pid,
                               "process": n[0], "container": cont})
            elif proto == "TCP":
                states[c.status] += 1
                if c.raddr and c.status == psutil.CONN_ESTABLISHED:
                    remote[c.raddr.ip] += 1
        listen.sort(key=lambda x: (x["port"], x["proto"]))
        _conn_cache.update(t=time.time(), data={
            "listening": listen,
            "states": dict(states.most_common()),
            "top_remote": [{"ip": ip, "count": n} for ip, n in remote.most_common(15)],
        })
    return {"interfaces": ifaces, "veth_count": veth_count, **_conn_cache["data"]}


# --------------------------------------------------------------------------- Analyse

@app.get("/api/analysis/history")
def analysis_history(range: str = "1h", keys: str = "cpu", points: int = Query(400, le=2000)):
    return analysis.history(range, [k for k in keys.split(",") if k], points)


@app.get("/api/analysis/top")
def analysis_top(range: str = "24h", limit: int = Query(20, le=100)):
    return analysis.top_processes(range, limit)


@app.get("/api/analysis/disk")
def analysis_disk(range: str = "7d"):
    return analysis.disk_history(range)


app.mount("/static", StaticFiles(directory=STATIC), name="static")
