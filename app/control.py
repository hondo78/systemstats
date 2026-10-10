"""Stack-Steuerung über die Docker-API: Starten/Stoppen/Neustarten und Neustart-Richtlinie je Compose-Projekt.

Arbeitet auf den vorhandenen Containern (wie `docker compose start/stop/restart`), nicht auf den
Compose-Dateien: Stacks nach `docker compose down` tauchen nicht auf, und eine geänderte
Neustart-Richtlinie gilt nur bis zum nächsten Neuerstellen der Container durch `docker compose up`.
"""
from __future__ import annotations

import logging
import re
import threading
import time

from . import config, hostinfo
from .processes import containers

log = logging.getLogger(__name__)

ACTIONS = ("start", "stop", "restart")
POLICIES = ("no", "always", "unless-stopped", "on-failure")
STOP_TIMEOUT = 30


def _own_container_id() -> str:
    """ID des eigenen Containers (cgroup: host -> /proc/self/cgroup enthält docker-<id>.scope)."""
    m = re.search(r"docker[-/]([0-9a-f]{64})", hostinfo.read_text("/proc/self/cgroup"))
    return m.group(1) if m else ""


OWN_ID = _own_container_id()


def own_project() -> str:
    meta = containers.by_id.get(OWN_ID)
    return meta["project"] if meta else ""


def stack_members(project: str) -> list[tuple[str, dict]]:
    return [(cid, m) for cid, m in containers.by_id.items() if m["project"] == project]


def _start_order(members: list[tuple[str, dict]]) -> list[tuple[str, dict]]:
    """Abhängigkeiten (depends_on) zuerst, sonst alphabetisch."""
    by_service: dict[str, list] = {}
    for cid, m in members:
        by_service.setdefault(m["service"], []).append((cid, m))
    order, done = [], set()

    def visit(svc: str, stack: set) -> None:
        if svc in done or svc in stack or svc not in by_service:
            return
        stack.add(svc)
        for dep in sorted({d for _, m in by_service[svc] for d in m["depends_on"]}):
            visit(dep, stack)
        done.add(svc)
        order.extend(by_service[svc])

    for svc in sorted(by_service):
        visit(svc, set())
    return order


class ControlError(Exception):
    pass


class StackControl:
    """Führt Stack-Aktionen im Hintergrund aus; je Projekt höchstens ein laufender Auftrag."""

    def __init__(self) -> None:
        self.jobs: dict[str, dict] = {}
        self._lock = threading.Lock()

    def _check(self, project: str) -> list[tuple[str, dict]]:
        if not config.CONTROL_ENABLED:
            raise ControlError("Steuerung ist deaktiviert (CONTROL_ENABLED=0)")
        if not project:
            raise ControlError("Nur Compose-Stacks können gesteuert werden")
        if project == own_project():
            raise ControlError("Der eigene Stack (systemstats) kann nicht über das Dashboard gesteuert werden")
        members = stack_members(project)
        if not members:
            raise ControlError(f"Stack '{project}' nicht gefunden")
        return members

    def run(self, project: str, action: str) -> dict:
        if action not in ACTIONS:
            raise ControlError(f"Unbekannte Aktion '{action}'")
        members = self._check(project)
        with self._lock:
            job = self.jobs.get(project)
            if job and job["running"]:
                raise ControlError(f"Für '{project}' läuft bereits: {job['action']}")
            job = self.jobs[project] = {"project": project, "action": action, "running": True,
                                        "started": time.time(), "finished": None, "done": 0,
                                        "total": len(members), "current": None, "errors": []}
        threading.Thread(target=self._run, args=(job, members), daemon=True, name=f"ctl-{project}").start()
        return dict(job)

    def _run(self, job: dict, members: list[tuple[str, dict]]) -> None:
        action = job["action"]
        log.info("Stack %s: %s (%d Container)", job["project"], action, len(members))
        order = _start_order(members)
        if action == "stop":
            order.reverse()  # abhängige Dienste zuerst stoppen
        for cid, m in order:
            job["current"] = m["name"]
            if action == "start" and m["state"] == "running":
                pass
            else:
                path = f"/containers/{cid}/{action}" + ("" if action == "start" else f"?t={STOP_TIMEOUT}")
                status, data = hostinfo.docker_request("POST", path, timeout=STOP_TIMEOUT + 30)
                # 304 = war bereits im Zielzustand
                if status not in (204, 304):
                    msg = data.get("message") if isinstance(data, dict) else data
                    job["errors"].append(f"{m['name']}: {msg or 'HTTP ' + str(status)}")
            job["done"] += 1
        job.update(running=False, current=None, finished=time.time())
        containers.refresh()
        log.info("Stack %s: %s fertig, %d Fehler", job["project"], action, len(job["errors"]))

    def set_restart_policy(self, project: str, policy: str, max_retries: int = 0) -> dict:
        if policy not in POLICIES:
            raise ControlError(f"Unbekannte Neustart-Richtlinie '{policy}'")
        members = self._check(project)
        body = {"RestartPolicy": {"Name": policy, "MaximumRetryCount": max(0, int(max_retries)) if policy == "on-failure" else 0}}
        errors = []
        for cid, m in members:
            status, data = hostinfo.docker_request("POST", f"/containers/{cid}/update", body)
            if status != 200:
                msg = data.get("message") if isinstance(data, dict) else data
                errors.append(f"{m['name']}: {msg or 'HTTP ' + str(status)}")
            containers.restart_policy(cid, fresh=True)
        containers.refresh()
        log.info("Stack %s: Neustart-Richtlinie %s, %d Fehler", project, policy, len(errors))
        return {"project": project, "policy": policy, "updated": len(members) - len(errors), "errors": errors}


control = StackControl()
