"""Zugriff auf Host-Informationen aus dem Container heraus.

Der Container läuft mit `pid: host` und `network_mode: host`, d. h. /proc, /sys und
die Netzwerkschnittstellen sind die des Hosts. Dateien des Host-Dateisystems
(z. B. /etc/passwd, /etc/os-release) liegen read-only unter HOSTFS.
"""
from __future__ import annotations

import glob
import http.client
import json
import os
import platform
import socket
import time

from . import config


def host_path(path: str) -> str:
    """Host-Pfad -> Pfad im Container (unter HOSTFS)."""
    return config.HOSTFS + "/" + path.lstrip("/") if path != "/" else config.HOSTFS or "/"


def read_text(path: str, default: str = "") -> str:
    try:
        with open(path, "r", errors="replace") as fh:
            return fh.read().strip()
    except OSError:
        return default


def read_int(path: str, default: int | None = None) -> int | None:
    try:
        return int(read_text(path))
    except (ValueError, TypeError):
        return default


# --------------------------------------------------------------------------- Benutzer

class UserMap:
    """UID -> Benutzername anhand der /etc/passwd des Hosts (nicht des Containers)."""

    def __init__(self) -> None:
        self._map: dict[int, str] = {}
        self._loaded = 0.0

    def name(self, uid: int) -> str:
        if time.time() - self._loaded > 300:
            self._load()
        return self._map.get(uid, str(uid))

    def _load(self) -> None:
        mapping: dict[int, str] = {}
        for line in read_text(host_path("/etc/passwd")).splitlines():
            parts = line.split(":")
            if len(parts) > 2 and parts[2].isdigit():
                mapping[int(parts[2])] = parts[0]
        self._map = mapping or {0: "root"}
        self._loaded = time.time()


users = UserMap()


# --------------------------------------------------------------------------- Systeminfo

def system_info() -> dict:
    os_release = {}
    for line in read_text(host_path("/etc/os-release")).splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            os_release[k] = v.strip('"')
    cpu_model = ""
    for line in read_text("/proc/cpuinfo").splitlines():
        if line.startswith("model name"):
            cpu_model = line.split(":", 1)[1].strip()
            break
    hostname = read_text(host_path("/etc/hostname")) or socket.gethostname()
    import psutil

    return {
        "hostname": hostname,
        "os": os_release.get("PRETTY_NAME", "Linux"),
        "kernel": platform.release(),
        "arch": platform.machine(),
        "cpu_model": cpu_model,
        "cpu_cores": psutil.cpu_count(logical=False),
        "cpu_threads": psutil.cpu_count(logical=True),
        "boot_time": psutil.boot_time(),
        "mem_total": psutil.virtual_memory().total,
        "gpu": gpu.info(),
        "nvme": nvme_devices(),
    }


def nvme_devices() -> list[dict]:
    devs = []
    for d in sorted(glob.glob("/sys/class/nvme/nvme*")):
        devs.append({
            "name": os.path.basename(d),
            "model": read_text(d + "/model"),
            "serial": read_text(d + "/serial"),
            "firmware": read_text(d + "/firmware_rev"),
        })
    return devs


# --------------------------------------------------------------------------- GPU (AMD)

class AmdGpu:
    """Liest Auslastung, Speicher, Temperatur und Leistung einer AMD-GPU aus sysfs."""

    def __init__(self) -> None:
        self.dev: str | None = None
        self.hwmon: str | None = None
        for card in sorted(glob.glob("/sys/class/drm/card[0-9]*/device")):
            if os.path.exists(card + "/gpu_busy_percent"):
                self.dev = card
                mons = glob.glob(card + "/hwmon/hwmon*")
                self.hwmon = mons[0] if mons else None
                break

    @property
    def available(self) -> bool:
        return self.dev is not None

    def info(self) -> dict | None:
        if not self.dev:
            return None
        name = read_text(self.dev + "/product_name")
        if not name:
            # Marketingname steht nicht immer in sysfs – Geräte-ID als Fallback
            name = "AMD GPU " + read_text(self.dev + "/device")
        return {
            "name": name,
            "vram_total": read_int(self.dev + "/mem_info_vram_total", 0),
            "gtt_total": read_int(self.dev + "/mem_info_gtt_total", 0),
            "pcie": read_text(self.dev + "/current_link_speed"),
        }

    def sample(self) -> dict:
        if not self.dev:
            return {}
        d = self.dev
        out = {
            "gpu_busy": read_int(d + "/gpu_busy_percent"),
            "vram_used": read_int(d + "/mem_info_vram_used"),
            "vram_total": read_int(d + "/mem_info_vram_total"),
            "gtt_used": read_int(d + "/mem_info_gtt_used"),
            "gtt_total": read_int(d + "/mem_info_gtt_total"),
        }
        if self.hwmon:
            t = read_int(self.hwmon + "/temp1_input")
            p = read_int(self.hwmon + "/power1_average") or read_int(self.hwmon + "/power1_input")
            f = read_int(self.hwmon + "/freq1_input")
            out["gpu_temp"] = t / 1000 if t is not None else None
            out["gpu_power"] = p / 1_000_000 if p is not None else None
            out["gpu_sclk"] = f / 1_000_000 if f is not None else None
        return {k: v for k, v in out.items() if v is not None}


gpu = AmdGpu()


# --------------------------------------------------------------------------- PSI

def pressure() -> dict:
    """Pressure Stall Information (Anteil Zeit, in der Tasks auf Ressourcen warten)."""
    out = {}
    for res in ("cpu", "memory", "io"):
        txt = read_text(f"/proc/pressure/{res}")
        for line in txt.splitlines():
            if line.startswith("some"):
                for part in line.split():
                    if part.startswith("avg10="):
                        out[f"psi_{res[:3]}"] = float(part[6:])
    return out


# --------------------------------------------------------------------------- Mounts

def host_mounts() -> list[dict]:
    """Echte Dateisysteme des Hosts aus /proc/1/mountinfo, dedupliziert pro Gerät."""
    by_dev: dict[str, dict] = {}
    for line in read_text("/proc/1/mountinfo").splitlines():
        parts = line.split()
        try:
            sep = parts.index("-")
        except ValueError:
            continue
        mountpoint = parts[4].replace("\\040", " ")
        fstype = parts[sep + 1]
        source = parts[sep + 2]
        if fstype not in config.REAL_FS:
            continue
        key = parts[2] + ":" + parts[3]  # major:minor + root innerhalb des FS
        entry = by_dev.get(key)
        if entry is None or len(mountpoint) < len(entry["mountpoint"]):
            aliases = [] if entry is None else entry["aliases"] + [entry["mountpoint"]]
            by_dev[key] = {"mountpoint": mountpoint, "fstype": fstype, "device": source,
                           "aliases": aliases}
        else:
            entry["aliases"].append(mountpoint)
    result = []
    for m in by_dev.values():
        try:
            st = os.statvfs(host_path(m["mountpoint"]))
        except OSError:
            continue
        total = st.f_blocks * st.f_frsize
        if total == 0:
            continue
        free = st.f_bavail * st.f_frsize
        used = (st.f_blocks - st.f_bfree) * st.f_frsize
        m.update({
            "total": total,
            "used": used,
            "free": free,
            # wie df: belegt / (belegt + für Benutzer verfügbar)
            "percent": round(used / (used + free) * 100, 1) if used + free else 0,
            "inodes_total": st.f_files,
            "inodes_used": st.f_files - st.f_ffree,
            "inodes_percent": round((st.f_files - st.f_ffree) / st.f_files * 100, 1) if st.f_files else 0,
        })
        result.append(m)
    result.sort(key=lambda m: m["mountpoint"])
    return result


# --------------------------------------------------------------------------- Docker

class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float = 10) -> None:
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._path)
        self.sock = sock


def docker_request(method: str, path: str, body: dict | None = None, timeout: float = 30) -> tuple[int, object]:
    """Beliebige Anfrage an die Docker-Engine-API. Gibt (HTTP-Status, Antwort) zurück, Status 0 = nicht erreichbar."""
    if not os.path.exists(config.DOCKER_SOCKET):
        return 0, "Docker-Socket nicht vorhanden"
    conn = _UnixHTTPConnection(config.DOCKER_SOCKET, timeout=timeout)
    try:
        payload = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"} if payload is not None else {}
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        try:
            data = json.loads(raw) if raw else None
        except ValueError:
            data = raw.decode(errors="replace")
        return resp.status, data
    except (OSError, http.client.HTTPException) as e:
        return 0, str(e)
    finally:
        conn.close()


def docker_get(path: str, timeout: float = 10):
    """GET gegen die Docker-Engine-API. Gibt None zurück, wenn Docker nicht erreichbar ist."""
    if not os.path.exists(config.DOCKER_SOCKET):
        return None
    conn = _UnixHTTPConnection(config.DOCKER_SOCKET, timeout=timeout)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        if resp.status != 200:
            return None
        return json.loads(resp.read())
    except (OSError, ValueError, http.client.HTTPException):
        return None
    finally:
        conn.close()
