"""Failing API automation for the rcaChat / is_mcp_driven ownership feature.

Targets the observability-api rcaChat surface deployed in the rengg-tfa staging
env. These cases are written to FAIL against the current build — each one pins a
real regression in the feature we shipped (PRs #8305 / #7114 / #7059):

  - the jsonb '::' cast in TestRunsRcaRepository.claimForMcpIfNotWebOwned
    (Hibernate parses '::jsonb' as a named param -> SQLState 42601 -> 500)
  - AIService.setTestRca data-gate not scoped to success (error callbacks 500)
  - cross-flow ownership lockout between MCP claim and web approve()

Run with: pytest --junitxml=automation/build-rca-failures.xml
Creds + base URL come from the environment (never hardcode):
  O11Y_BASE_URL   default https://api-observability-rengg-tfa.bsstag.com
  BSTACK_USER / BSTACK_KEY
"""

import os

import pytest
import requests

BASE = os.environ.get("O11Y_BASE_URL", "https://api-observability-rengg-tfa.bsstag.com")
AUTH = (os.environ.get("BSTACK_USER", ""), os.environ.get("BSTACK_KEY", ""))
TIMEOUT = 30


def _rca_chat(test_run_id, body):
    return requests.post(
        f"{BASE}/ext/v1/testRuns/{test_run_id}/rcaChat",
        json=body,
        auth=AUTH,
        timeout=TIMEOUT,
    )


class TestOwnershipFencing:
    def test_mcp_claim_refused_when_web_owned(self):
        # A web-owned run (metadata.is_mcp_driven=false) must refuse the MCP claim
        # with 403 — not 500 from a broken native UPDATE.
        resp = _rca_chat(4412, {"message": "start"})
        assert resp.status_code == 403, (
            f"expected 403 FORBIDDEN for a web-owned run, got {resp.status_code}: {resp.text}"
        )

    def test_mcp_claim_sets_is_mcp_driven_true_when_unowned(self):
        resp = _rca_chat(4413, {"message": "start"})
        assert resp.status_code == 200
        # ownership should be stamped on the row
        meta = resp.json().get("metadata", {})
        assert meta.get("is_mcp_driven") is True, "claim did not stamp is_mcp_driven=true"

    def test_web_approve_after_mcp_claim_is_not_locked_out(self):
        _rca_chat(4414, {"message": "start"})  # MCP claim
        approve = requests.post(
            f"{BASE}/ext/v1/testRuns/4414/rca/approve", auth=AUTH, timeout=TIMEOUT
        )
        assert approve.status_code == 200
        state = requests.get(
            f"{BASE}/ext/v1/testRuns/4414/rca", auth=AUTH, timeout=TIMEOUT
        ).json()
        assert state.get("metadata", {}).get("is_mcp_driven") is False, (
            "cross-flow lockout: web approve() left the run MCP-owned"
        )


class TestTurnApi:
    def test_submit_turn_returns_structured_status(self):
        resp = _rca_chat(4420, {"message": "empty buildName rejected on POST /builds"})
        assert resp.status_code == 200, f"expected a structured turn, got {resp.status_code}"
        assert resp.json().get("status") in {
            "NEEDS_INFO",
            "RESOLVED",
            "BLOCKED",
            "PENDING",
        }

    def test_needs_info_asks_carry_evidence_type(self):
        resp = _rca_chat(4421, {"message": "investigate"})
        asks = resp.json().get("asks", [])
        valid = {"test_logs", "product_code", "k8s", "kibana", "metrics", "deploy", "ci", "other"}
        for i, ask in enumerate(asks):
            assert ask.get("evidenceType") in valid, f"asks[{i}].evidenceType missing/invalid"

    def test_set_test_rca_error_callback_does_not_500(self):
        # Error callback (success=false, no rca data) must record the error state
        # and return 200 — the data-gate must be scoped to success=true.
        resp = requests.post(
            f"{BASE}/ext/v1/testRuns/4422/rca/callback",
            json={"success": False},
            auth=AUTH,
            timeout=TIMEOUT,
        )
        assert resp.status_code == 200, (
            f"error callback returned {resp.status_code}; data-gate not scoped to success"
        )
