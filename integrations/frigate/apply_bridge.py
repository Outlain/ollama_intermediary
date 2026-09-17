"""Apply an exact-source, fail-closed bridge to Frigate commit bb6c2e9.

Run during a derived image build, never against a running installation.
All hashes and transformations are validated before any destination is edited.
"""

import argparse
import ast
import hashlib
from pathlib import Path

PIN = "bb6c2e9"
HASHES = {
    "frigate/api/event.py": "4cf7233c13ed55036076fd5d00dbf20c3e47e9f0f5b078600cc3499d0a14c1d3",
    "frigate/api/review.py": "bcbfc4b885ec0550737388dddce8dfcb5bb1ab73b26c4dbc65c972fbbcef132f",
    "frigate/embeddings/__init__.py": "c3edddd9f864d17a9fde621891cd0fb9335d1db867a4a10eaa0e0b2e14c0a20f",
    "frigate/embeddings/maintainer.py": "26bdf2bbaab6fd9abacd045ea190ae730315d1fb065649eaa8b73b2eb2a69c2c",
    "frigate/data_processing/post/object_descriptions.py": "c7da293415428173a7cf9a1a751d651cc5f7e2fbdb4c4baab2d12faac4331d97",
    "frigate/data_processing/post/review_descriptions.py": "6f70dc71eccc08748927b448864d4fa16cf4b5cdaff11847bd98876b0225c891",
    "frigate/genai/plugins/ollama.py": "c9fb96b05ffea84ab8c661e1accd0b16b71c9be2c265c69622ec78ddd360ef12",
}


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError("Bridge patch context did not match exactly once")
    return source.replace(old, new, 1)


def add_import(source):
    return replace_once(source, "import logging\n", "import logging\n\nfrom frigate import intermediary_bridge\n")


def transform(path, source):
    if path == "frigate/api/event.py":
        source = add_import(source)
        source = replace_once(
            source,
            "    request: Request, event_id: str, params: RegenerateQueryParameters = Depends()\n):\n    try:",
            "    request: Request, event_id: str, params: RegenerateQueryParameters = Depends()\n):\n    attempt = intermediary_bridge.request_attempt(request)\n    try:",
        )
        return replace_once(source, "(event.id, params.source, params.force),", "(event.id, params.source, params.force, attempt),")

    if path == "frigate/api/review.py":
        source = add_import(source)
        source = replace_once(
            source,
            "async def regenerate_review_description(request: Request, review_id: str):\n",
            "async def regenerate_review_description(request: Request, review_id: str):\n    attempt = intermediary_bridge.request_attempt(request)\n",
        )
        source = replace_once(source, "context.regenerate_review_description(review_id)", "context.regenerate_review_description(review_id, attempt=attempt)")
        return source + '''\n\n@router.get(
    "/intermediary/capabilities",
    dependencies=[Depends(require_role(["admin"]))],
    summary="Ollama intermediary native completion bridge capabilities",
)
def intermediary_capabilities(request: Request):
    return intermediary_bridge.capabilities(
        request.app.genai_manager.description_client
    )
'''

    if path == "frigate/embeddings/__init__.py":
        source = replace_once(source, "def regenerate_review_description(self, review_id: str) -> None:", "def regenerate_review_description(self, review_id: str, attempt: str | None = None) -> None:")
        return replace_once(source, '{"review_id": review_id},', '{"review_id": review_id, "attempt": attempt},')

    if path == "frigate/embeddings/maintainer.py":
        source = replace_once(source, "        event_id, source, force = payload", "        event_id, source, force = payload[:3]\n        attempt = payload[3] if len(payload) == 4 else None")
        return replace_once(source, '"source": RegenerateDescriptionEnum(source),\n                            "force": force,', '"source": RegenerateDescriptionEnum(source),\n                            "force": force,\n                            "attempt": attempt,')

    if path == "frigate/data_processing/post/object_descriptions.py":
        source = add_import(source)
        source = replace_once(source, "    def __regenerate_description(self, event_id: str, source: str, force: bool) -> None:", "    @intermediary_bridge.native_attempt\n    def __regenerate_description(self, event_id: str, source: str, force: bool) -> None:")
        source = replace_once(source, 'data["event_id"], data["source"], data["force"]', 'data["event_id"], data["source"], data["force"], attempt=data.get("attempt")')
        return replace_once(source, "        # Embed the description\n", "        intermediary_bridge.mark_success()\n\n        # Embed the description\n")

    if path == "frigate/data_processing/post/review_descriptions.py":
        source = add_import(source)
        source = replace_once(source, "                args=(review_id,),\n", '                args=(review_id,),\n                kwargs={"attempt": request_data.get("attempt")},\n')
        source = replace_once(source, "    def regenerate_description(self, review_id: str) -> None:", "    @intermediary_bridge.native_attempt\n    def regenerate_description(self, review_id: str) -> None:")
        source = replace_once(source, "        threading.Thread(\n            target=run_analysis,", "        intermediary_bridge.start_analysis_thread(\n            target=run_analysis,")
        source = replace_once(source, "                self.config.all_attributes,\n            ),\n        ).start()", "                self.config.all_attributes,\n            ),\n        )")
        return replace_once(source, '            "after": {k: v for k, v in final_data.items()},\n        },\n    )', '            "after": {k: v for k, v in final_data.items()},\n        },\n    )\n    intermediary_bridge.mark_success()')

    if path == "frigate/genai/plugins/ollama.py":
        source = add_import(source)
        return replace_once(source, "                headers=self._auth_headers(),\n            )\n            if not self.validate_model:", "                headers=self._auth_headers(),\n                event_hooks={\"request\": [intermediary_bridge.request_hook]},\n            )\n            if not self.validate_model:")
    raise ValueError("Unknown source path")


def prepare(root):
    prepared = {}
    for relative, expected in HASHES.items():
        path = root / relative
        original = path.read_bytes()
        if hashlib.sha256(original).hexdigest() != expected:
            raise ValueError(f"Unsupported Frigate source: {relative}; exact {PIN} sources required")
        patched = transform(relative, original.decode("utf-8"))
        ast.parse(patched, filename=relative)
        prepared[path] = patched
    bridge = Path(__file__).with_name("bridge.py").read_text()
    ast.parse(bridge, filename="frigate/intermediary_bridge.py")
    target = root / "frigate/intermediary_bridge.py"
    if target.exists():
        raise ValueError("Bridge already exists; rebuild from the original pinned image")
    prepared[target] = bridge
    return prepared


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="directory containing the frigate Python package")
    parser.add_argument("--check", action="store_true", help="verify hashes and patch syntax without writing")
    args = parser.parse_args()
    try:
        prepared = prepare(args.root)
    except (OSError, UnicodeError, ValueError, SyntaxError) as error:
        parser.exit(1, f"Bridge refused: {error}\n")
    if not args.check:
        for path, source in prepared.items():
            path.write_text(source)
    print(f"Frigate {PIN} bridge {'validated' if args.check else 'installed'} ({len(prepared)} files)")


if __name__ == "__main__":
    main()
