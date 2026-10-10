"""Zentrale Konfiguration (per Umgebungsvariablen überschreibbar)."""
import os


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


# Pfad, unter dem das Host-Root-Dateisystem read-only eingehängt ist
HOSTFS = os.environ.get("HOSTFS", "/hostfs").rstrip("/")
DOCKER_SOCKET = os.environ.get("DOCKER_SOCKET", "/var/run/docker.sock")
DB_PATH = os.environ.get("DB_PATH", "/data/systemstats.db")

# Stack-Steuerung (Starten/Stoppen, Neustart-Richtlinie) über die Docker-API; 0 = nur lesend
CONTROL_ENABLED = os.environ.get("CONTROL_ENABLED", "1").lower() not in ("0", "false", "no", "")

# Abtastintervalle in Sekunden
SAMPLE_INTERVAL = _env_float("SAMPLE_INTERVAL", 2.0)
PROC_INTERVAL = _env_float("PROC_INTERVAL", 3.0)
DOCKER_INTERVAL = _env_float("DOCKER_INTERVAL", 15.0)
DISK_USAGE_INTERVAL = _env_float("DISK_USAGE_INTERVAL", 600.0)

# Live-Puffer im RAM (Anzahl Samples) – 1800 * 2 s = 1 h
LIVE_BUFFER = int(_env_float("LIVE_BUFFER", 1800))

# Aufbewahrung in der SQLite-Datenbank (Tage)
RETENTION_METRICS_DAYS = _env_float("RETENTION_METRICS_DAYS", 30)
RETENTION_PROCS_DAYS = _env_float("RETENTION_PROCS_DAYS", 14)
RETENTION_DISK_DAYS = _env_float("RETENTION_DISK_DAYS", 180)

# Schwellwerte für die Zustandsbewertung: (Warnung, Kritisch)
THRESHOLDS = {
    "disk_pct": (_env_float("WARN_DISK_PCT", 85), _env_float("CRIT_DISK_PCT", 95)),
    "inode_pct": (85, 95),
    "mem_avail_pct": (15, 5),  # unterschreiten = schlecht
    "swap_pct": (50, 90),
    "cpu_temp": (85, 95),
    "gpu_temp": (85, 95),
    "nvme_temp": (70, 80),
    "psi_mem": (10, 30),
    "psi_io": (20, 50),
    "psi_cpu": (40, 80),
    "days_until_full": (30, 7),  # unterschreiten = schlecht
}

# Dateisystemtypen, die als "echte" Datenträger gelten
REAL_FS = {
    "ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "vfat", "exfat", "ntfs", "ntfs3",
    "fuseblk", "f2fs", "jfs", "reiserfs", "nfs", "nfs4", "cifs", "smb3", "fuse.sshfs",
    "fuse.mergerfs", "bcachefs",
}
