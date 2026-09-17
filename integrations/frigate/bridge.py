"""Opt-in, metadata-only bridge for Frigate bb6c2e9 native descriptions.

Installed as frigate.intermediary_bridge by apply_bridge.py. Attempt tickets
are capabilities: never log them, prompts, callback bodies, or exceptions.
"""

import contextvars
import functools
import http.client
import json
import os
import re
import threading
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

HEADER = "X-Ollama-Intermediary-Attempt"
PROTOCOL = "ollama-intermediary-v1"
CALLBACK_PATH = "/_intermediary/v1/frigate/attempt"
TICKET = re.compile(r"^[0-9a-f]{64}$")
_current = contextvars.ContextVar("intermediary_attempt", default=None)


def enabled():
    return os.environ.get("FRIGATE_INTERMEDIARY_BRIDGE") == "1"


def callback_url(client):
    """Only the configured provider origin may receive a ticket callback."""
    config = getattr(client, "genai_config", None)
    provider = getattr(config, "provider", None)
    if getattr(provider, "value", provider) != "ollama":
        return None
    base = getattr(config, "base_url", None)
    if not isinstance(base, str) or any(ord(char) < 32 for char in base):
        return None
    try:
        parsed = urlsplit(base)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.path not in ("", "/")
        ):
            return None
        # Force invalid ports to fail before a native request is accepted.
        parsed.port
    except ValueError:
        return None
    return base.rstrip("/") + CALLBACK_PATH


def capabilities(client):
    supported = enabled() and callback_url(client) is not None
    return {
        "protocol": PROTOCOL,
        "object": supported,
        "review": supported,
        "completion_reports": supported,
    }


def request_attempt(request):
    """Validate at the existing admin-protected regeneration endpoint."""
    ticket = request.headers.get(HEADER)
    if ticket is None:
        return None
    from fastapi import HTTPException

    if not isinstance(ticket, str) or not TICKET.fullmatch(ticket):
        raise HTTPException(status_code=400, detail="Invalid intermediary attempt")
    manager = getattr(request.app, "genai_manager", None)
    client = getattr(manager, "description_client", None)
    if not capabilities(client)["completion_reports"]:
        raise HTTPException(status_code=409, detail="Intermediary bridge unavailable")
    return ticket


@dataclass
class Attempt:
    ticket: str
    destination: str
    outcome: str = "failed"
    reason: str = "generation_failed"


def mark_success():
    """A valid native result has been handed to Frigate's save path."""
    attempt = _current.get()
    if attempt is not None:
        attempt.outcome = "success"
        attempt.reason = "generation_finished"


def request_hook(request):
    """HTTPX request hook; scoped context prevents cross-thread contamination."""
    request.headers.pop(HEADER, None)
    attempt = _current.get()
    if attempt is None:
        return
    destination = urlsplit(attempt.destination)
    actual = urlsplit(str(request.url))
    if (
        actual.scheme == destination.scheme
        and actual.hostname == destination.hostname
        and (actual.port or (443 if actual.scheme == "https" else 80))
        == (destination.port or (443 if destination.scheme == "https" else 80))
        and actual.path in ("/api/generate", "/api/chat")
        and request.method.upper() == "POST"
    ):
        request.headers[HEADER] = attempt.ticket


def report_completion(attempt):
    """Bounded best effort. No redirects or general API credentials are used."""
    destination = urlsplit(attempt.destination)
    body = json.dumps({"outcome": attempt.outcome, "reason": attempt.reason})
    connection_type = (
        http.client.HTTPSConnection
        if destination.scheme == "https"
        else http.client.HTTPConnection
    )
    for delay in (0, 0.25, 1.0):
        if delay:
            time.sleep(delay)
        connection = None
        try:
            connection = connection_type(
                destination.hostname, destination.port, timeout=2
            )
            connection.request(
                "POST",
                CALLBACK_PATH,
                body=body,
                headers={HEADER: attempt.ticket, "Content-Type": "application/json"},
            )
            response = connection.getresponse()
            # Never read/retain a potentially sensitive or unbounded response body.
            if 200 <= response.status < 300:
                return True
            # A redirect is never followed. Stale/invalid tickets are not retried.
            if 300 <= response.status < 500 and response.status != 429:
                return False
        except (OSError, ValueError, http.client.HTTPException):
            pass
        finally:
            if connection is not None:
                connection.close()
    return False


def native_attempt(function):
    """Report once, after ALL work belonging to a tagged regeneration returns."""
    @functools.wraps(function)
    def wrapped(self, *args, attempt=None, **kwargs):
        if attempt is None:
            return function(self, *args, **kwargs)
        client = getattr(self.genai_manager, "description_client", None)
        destination = callback_url(client)
        if not TICKET.fullmatch(attempt) or destination is None:
            raise ValueError("Invalid intermediary attempt context")
        context = Attempt(attempt, destination)
        token = _current.set(context)
        try:
            return function(self, *args, **kwargs)
        except Exception:
            if context.outcome != "success":
                context.reason = "native_error"
            raise
        finally:
            _current.reset(token)
            report_completion(context)

    return wrapped


def start_analysis_thread(*, target, args):
    """Live analysis stays asynchronous; tagged parent waits for its child.

    ContextVars do not propagate to threads automatically. The attempt object
    is shared only with this child so a success mark reaches the reporting
    parent. The parent is already the native regeneration background thread.
    """
    context = contextvars.copy_context()
    attempt = _current.get()
    worker = threading.Thread(target=context.run, args=(target, *args))
    worker.start()
    if attempt is not None:
        worker.join()
    return worker
