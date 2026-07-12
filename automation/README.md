# Automation — RCA Feature Fencing

Failing API automation for the rcaChat / `is_mcp_driven` ownership feature
(observability-api, PRs #8305 / #7114 / #7059), run against the **rengg-tfa**
staging env. The failing build it produces is the **input the RCA plugin runs
against** — each failure pins a real regression so the collaborative RCA has
genuine material to trace back to our commits.

## Files
- `tests/test_rca_chat_api.py` — the automation cases (pytest + requests).
- `build-rca-failures.xml` — JUnit results (6 failures + 1 error) for upload.
- `upload.sh` — pushes the JUnit XML to Observability, creating the project/build.

## Credentials
Never commit creds. Export them (or `source automation/.env`, gitignored):
```bash
export BSTACK_USER=tfauser_wzgsM5
export BSTACK_KEY=<access-key>
export O11Y_BASE_URL=https://api-observability-rengg-tfa.bsstag.com
```

## Run + upload
```bash
# (optional) regenerate the XML against the live API
pytest automation/tests --junitxml=automation/build-rca-failures.xml

# upload → creates project "RCA Feature Fencing", build "VRT Build"
PROJECT_NAME="RCA Feature Fencing" BUILD_NAME="VRT Build" \
  ./automation/upload.sh automation/build-rca-failures.xml
```

The upload response carries the build id. Feed it to the plugin:
```
/factory <build-id>
```

## The failures (what RCA should rediscover)
| Test | Pins |
|---|---|
| `mcp_claim_refused_when_web_owned` | jsonb `::` cast → SQLState 42601 → 500 (TestRunsRcaRepository) |
| `mcp_claim_sets_is_mcp_driven_true` | jsonb_set never applied (same root cause) |
| `web_approve_after_mcp_claim_is_not_locked_out` | cross-flow ownership lockout |
| `submit_turn_returns_structured_status` | setTestRca 500 before turn produced |
| `needs_info_asks_carry_evidence_type` | ask.evidenceType null |
| `set_test_rca_error_callback_does_not_500` | data-gate not scoped to success (AIService) |
