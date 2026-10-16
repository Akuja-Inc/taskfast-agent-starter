#!/usr/bin/env python3
"""A stand-in TaskFast server for re-capturing the gh71 CLI output.

It answers the shapes `test/fixtures/openapi.yaml` documents on 127.0.0.1 so the real
taskfast binary can be driven without a marketplace account. Every request is written
to stdout: for a multipart upload, the part's filename, content type and size, which is
what shows how many uploads landed before a refusal.

  python3 stand-in-server.py [--port 4124]

Scenarios, by environment variable, so one capture is one server start:

  UPLOAD_FAIL_AT=2 UPLOAD_STATUS=415 UPLOAD_CODE=unsupported_media_type
                                  the 2nd POST /tasks/{id}/artifacts is refused
  SUBMIT_STATUS=422               POST /tasks/{id}/submit (or /remedy) answers
                                  CompletionFailure: criteria not met
  SUBMIT_STATUS=409 SUBMIT_CODE=task_not_eligible
                                  POST /tasks/{id}/submit (or /remedy) is refused
  UPLOADED=1                      the task already holds one uploaded results.json
"""
import argparse
import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TASK_ID = "4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b"
AGENT_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
ARTIFACT = "550e8400-e29b-41d4-a716-4466554400%02d"
AT = "2026-10-16T12:00:00Z"


def artifact(n: int, filename: str, content_type: str, size: int) -> dict:
    return {"id": ARTIFACT % n, "filename": filename, "content_type": content_type,
            "url": f"/api/artifacts/{TASK_ID}/{ARTIFACT % n}-{filename}", "size_bytes": size,
            "output_cid": None, "cid_status": "witnessed", "task_id": TASK_ID, "line_count": 1,
            "entry_count": None, "uploaded_by_id": AGENT_ID, "created_at": AT}


def evaluation(passed: bool) -> dict:
    return {"passed": passed, "evaluated_at": AT, "criteria_results": [{
        "criterion": {"description": "results.json exists", "check_type": "file_exists",
                      "check_expression": "results.json", "expected_value": "true"},
        "passed": passed, "evidence": "found" if passed else "no artifact matched results.json"}]}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "taskfast-stand-in"
    uploads: list[dict] = []

    def log_message(self, *args):
        pass

    def reply(self, status: int, body: dict | None) -> None:
        raw = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def handle_request(self, method: str) -> None:
        path = self.path.split("?")[0]
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        part = None
        if (self.headers.get("Content-Type") or "").startswith("multipart/form-data"):
            head = raw.split(b"\r\n\r\n", 1)[0].decode(errors="replace")
            name = re.search(r'filename="([^"]*)"', head)
            kind = re.search(r"Content-Type: *(\S+)", head, re.I)
            body_start = raw.index(b"\r\n\r\n") + 4
            size = len(raw[body_start:raw.rindex(b"\r\n--")])
            part = {"filename": name and name.group(1), "content_type": kind and kind.group(1), "size": size}
            print(f"{method} {self.path} part={json.dumps(part)}", flush=True)
        else:
            print(f"{method} {self.path} body={raw.decode(errors='replace') or 'null'}", flush=True)

        if path == "/agents/me":
            return self.reply(200, {"profile": {"id": AGENT_ID}})
        if path == f"/tasks/{TASK_ID}/artifacts" and method == "POST":
            return self.upload_reply(part or {})
        if path == f"/tasks/{TASK_ID}/artifacts" and method == "GET":
            return self.reply(200, {"data": self.uploads, "meta": {"has_more": False, "next_cursor": None, "total_count": len(self.uploads)}})
        if path.startswith(f"/tasks/{TASK_ID}/artifacts/") and method == "DELETE":
            return self.reply(204, None)
        if path in (f"/tasks/{TASK_ID}/submit", f"/tasks/{TASK_ID}/remedy"):
            return self.submit_reply()
        return self.reply(404, {"error": "not_found", "message": f"no route {path}"})

    def upload_reply(self, part: dict):
        n = len(self.uploads) + 1
        if os.environ.get("UPLOAD_FAIL_AT") == str(n):
            code = os.environ.get("UPLOAD_CODE", "unsupported_media_type")
            return self.reply(int(os.environ.get("UPLOAD_STATUS", "415")), {"error": code, "message": f"upload refused: {code}"})
        row = artifact(n, part.get("filename") or "", part.get("content_type") or "", part.get("size") or 0)
        Handler.uploads.append(row)
        return self.reply(201, row)

    def submit_reply(self):
        status = int(os.environ.get("SUBMIT_STATUS", "200"))
        if status == 200:
            return self.reply(200, {"success": True, "task_id": TASK_ID, "status": "under_review",
                                    "message": "Task submitted for review", "evaluation": evaluation(True),
                                    "review_deadline": "2026-10-17T12:00:00Z"})
        if status == 422:
            return self.reply(422, {"success": False, "task_id": TASK_ID, "status": "in_progress",
                                    "message": "Completion criteria not met", "evaluation": evaluation(False)})
        code = os.environ.get("SUBMIT_CODE", "task_not_eligible")
        return self.reply(status, {"error": code, "message": f"refused: {code}"})

    def do_GET(self):
        self.handle_request("GET")

    def do_POST(self):
        self.handle_request("POST")

    def do_DELETE(self):
        self.handle_request("DELETE")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=4124)
    args = parser.parse_args()
    if os.environ.get("UPLOADED"):
        Handler.uploads.append(artifact(1, "results.json", "application/json", 20))
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
