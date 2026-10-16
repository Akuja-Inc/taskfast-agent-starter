#!/usr/bin/env python3
"""A stand-in TaskFast server for re-capturing the gh70 CLI output.

It answers the shapes `test/fixtures/openapi.yaml` documents on 127.0.0.1 so the real
taskfast binary can be driven without a marketplace account, a chain or funds. Every
request is written to stdout, which is what shows whether a command touched the chain.

  python3 stand-in-server.py [--port 4123]

Scenarios, by environment variable, so one capture is one server start:

  CLAIM_STATUS=409 CLAIM_CODE=bond_pending   what POST /tasks/{id}/claim answers
  REPORT_STATUS=409 REPORT_CODE=posting_disabled
                                             what POST /tasks/{id}/stake/report answers
  STAKE_STATUS=409 STAKE_CODE=bond_exists    what POST /tasks/{id}/stake answers
  QUOTE_STATUS=409 QUOTE_CODE=not_high_assurance
                                             what GET /tasks/{id}/stake/quote answers
  BALANCE_LOW=1                              balanceOf answers 1 base unit, so the
                                             wallet cannot cover the bond

The task id, addresses and transaction hash are fixed, so two captures of the same
command differ only in the signed transaction the throwaway keystore produces.
"""
import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TASK_ID = "4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b"
AGENT_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
WALLET = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f"
TOKEN = "0x20c0000000000000000000000000000000000000"
TASK_BOND = "0x1234567890abcdef1234567890abcdef12345678"
TX = "0x" + "ab" * 32
NUMBER = "0x" + "00" * 31 + "%02x"


def network(port: int) -> dict:
    # rpc_url must be on the same host as the api base, or the CLI refuses to route.
    return {"networks": {"testnet": {
        "chain_id": 42431,
        "rpc_url": f"http://127.0.0.1:{port}/rpc/testnet",
        "wss_url": "wss://rpc.moderato.tempo.xyz",
        "explorer_url": "https://explore.testnet.tempo.xyz",
        "default_stablecoin": TOKEN,
        "fee_tokens": [TOKEN],
        "task_bond_contract": TASK_BOND,
    }}}


def quote() -> dict:
    # required_amount is in bond base units (int64) and no decimals ride with it.
    return {"required_amount": 2500000, "value_basis": 40000000, "formula_version": "v1",
            "amount": None, "bond_status": None, "tier": "stake", "risk_class": "normal",
            "operator_class": "new"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "taskfast-stand-in"

    def log_message(self, *args):
        pass

    def reply(self, status: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def scenario(self, kind: str, default_status: int, default_code: str) -> tuple[int, str]:
        return int(os.environ.get(f"{kind}_STATUS", str(default_status))), os.environ.get(f"{kind}_CODE", default_code)

    def handle_request(self, method: str) -> None:
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}") if length else None
        print(f"{method} {self.path} body={json.dumps(body)}", flush=True)

        if path == "/config/network":
            return self.reply(200, network(self.server.server_address[1]))
        if path == "/platform/config":
            return self.reply(200, {"submission_fee": "0.25", "submission_fee_currency": "USD"})
        if path == "/agents/me":
            return self.reply(200, {"profile": {"id": AGENT_ID, "wallet_address": WALLET}})
        if path == f"/tasks/{TASK_ID}":
            return self.reply(200, {"id": TASK_ID, "status": "assigned", "title": "Write a haiku",
                                    "description": "A short poem.", "budget": "40.00",
                                    "assigned_account_id": AGENT_ID, "high_assurance": False,
                                    "pickup_window_hours": 24})
        if path == f"/tasks/{TASK_ID}/stake/quote":
            return self.quote_reply()
        if path == f"/tasks/{TASK_ID}/stake":
            return self.code_reply("STAKE", "bond_exists")
        if path == f"/tasks/{TASK_ID}/stake/report":
            return self.code_reply("REPORT", "posting_disabled")
        if path == f"/tasks/{TASK_ID}/claim":
            return self.claim_reply()
        if path == "/rpc/testnet":
            return self.rpc_reply(body or {})
        return self.reply(404, {"error": "not_found", "message": f"no route {path}"})

    def quote_reply(self):
        status, code = self.scenario("QUOTE", 200, "not_high_assurance")
        return self.reply(200, quote()) if status == 200 else self.reply(status, {"error": code, "message": f"quote refused: {code}"})

    def code_reply(self, kind: str, default: str):
        status, code = self.scenario(kind, 200, default)
        if status == 200:
            return self.reply(200, {"task_id": TASK_ID, "status": "posted", "post_tx_hash": TX, "verification": "pending"})
        return self.reply(status, {"error": code, "message": f"refused: {code}"})

    def claim_reply(self):
        status, code = self.scenario("CLAIM", 409, "bond_pending")
        if status == 200:
            return self.reply(200, {"task_id": TASK_ID, "status": "in_progress"})
        # ClaimFailure carries success/error/message rather than the shared Error shape.
        return self.reply(status, {"success": False, "error": code, "message": f"claim refused: {code}"})

    def rpc_reply(self, body: dict):
        method = body.get("method")
        if method == "eth_getTransactionReceipt":
            return self.reply(200, {"jsonrpc": "2.0", "id": body.get("id", 1), "result": {
                "transactionHash": TX, "transactionIndex": "0x0", "blockHash": "0x" + "cd" * 32,
                "blockNumber": "0x64", "from": WALLET, "to": TASK_BOND,
                "cumulativeGasUsed": "0x5208", "gasUsed": "0x5208", "effectiveGasPrice": "0x3b9aca00",
                "contractAddress": None, "logs": [], "logsBloom": "0x" + "00" * 256,
                "status": "0x1", "type": "0x0"}})
        if method == "eth_call":
            data = (body.get("params") or [{}])[0].get("data", "")
            if data.startswith("0x313ce567"):  # decimals()
                return self.reply(200, {"jsonrpc": "2.0", "id": body.get("id", 1), "result": NUMBER % 6})
            if data.startswith("0x70a08231"):  # balanceOf()
                result = NUMBER % 1 if os.environ.get("BALANCE_LOW") else "0x" + "00" * 24 + "ff" * 8
                return self.reply(200, {"jsonrpc": "2.0", "id": body.get("id", 1), "result": result})
            return self.reply(200, {"jsonrpc": "2.0", "id": body.get("id", 1), "result": "0x" + "ff" * 32})
        results = {"eth_chainId": "0xa5bf", "eth_blockNumber": "0x64", "eth_gasPrice": "0x3b9aca00",
                   "eth_getTransactionCount": "0x0", "eth_estimateGas": "0x5208", "eth_sendRawTransaction": TX}
        return self.reply(200, {"jsonrpc": "2.0", "id": body.get("id", 1), "result": results.get(method, "0x0")})

    def do_GET(self):
        self.handle_request("GET")

    def do_POST(self):
        self.handle_request("POST")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=4123)
    args = parser.parse_args()
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
