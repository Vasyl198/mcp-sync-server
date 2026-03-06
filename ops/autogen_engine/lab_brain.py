import argparse
import calendar
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Tuple, Optional
from urllib.parse import parse_qs, unquote, urlparse

import requests
from autogen_agentchat.agents import AssistantAgent
from autogen_core.models import ModelFamily
from autogen_ext.models.openai import OpenAIChatCompletionClient
from ftfy import fix_text


SYSTEM_PROMPT = """You are LabBrain, the central orchestration agent for an AI lab.

Rules:
1) Be tool-first and evidence-first.
2) Never claim success without verifiable evidence.
3) Output concise, actionable engineering steps.
4) If context is insufficient, state exactly what evidence is missing.
5) Never claim you are ChatGPT, GPT-4, OpenAI model, Claude, or any other provider identity.
6) If user asks who you are or which model is used, answer strictly with runtime identity:
   - Role: LabBrain
   - Orchestrator: AutoGen
   - LLM backend: value from OPENAI_MODEL
7) For general knowledge questions, answer directly in plain language (2-6 sentences), without asking for extra setup, tools, APIs, or investigation plans.
"""

_MCP_SESSION_ID: str = ""
_MCP_FAILURE_COUNT: int = 0
_MCP_CIRCUIT_OPEN_UNTIL: float = 0.0


STRICT_CONTRACT_INTENTS = {
  "identity", "capabilities", "constraints", "smalltalk", "next_steps",
  "datetime", "metrics", "fs", "tasks", "sync", "weather", "web", "status",
  "tool_call", "repo_maintenance", "pure_logic", "basic_fact", "operational", "operational_analysis", "system_recovery", "capability_proof", "improvement_plan", "external_hook_probe", "external_security_analysis", "external_app_analysis", "general", "error",
}

DECISION_REQUIRED_INTENTS = {
  "operational_analysis",
  "system_recovery",
  "improvement_plan",
  "capability_proof",
}

OPERATIONAL_INTENTS = {
  "operational",
  "operational_analysis",
  "system_recovery",
  "external_hook_probe",
  "external_security_analysis",
  "external_app_analysis",
  "web",
  "weather",
  "tasks",
  "metrics",
  "fs",
  "sync",
  "status",
  "tool_call",
  "repo_maintenance",
  "improvement_plan",
  "capability_proof",
}

DOMAIN_SIGNATURES = {
  "tools",
  "ops-metrics",
  "memory",
  "code-change",
  "web-research",
  "identity",
  "reasoning",
  "general",
}


def _now_iso() -> str:
  return datetime.now(timezone.utc).isoformat()


def _norm(text: str) -> str:
  cleaned = _decode_mojibake_text((text or "").strip())
  return re.sub(r"\s+", " ", cleaned.lower())


def _env_int(name: str, default: int) -> int:
  raw = str(os.getenv(name, "") or "").strip()
  if not raw:
    return int(default)
  try:
    return int(raw)
  except Exception:
    return int(default)


def _json_dumps(obj: Any, max_len: int | None = None) -> str:
  try:
    s = json.dumps(obj, ensure_ascii=False)
  except Exception:
    s = str(obj)
  if max_len and len(s) > max_len:
    return s[:max_len] + "..."
  return s


def _normalize_result_url(url: str) -> str:
  u = str(url or "").strip()
  if not u:
    return ""
  try:
    parsed = urlparse(u)
    # DuckDuckGo redirect format: /l/?uddg=<target>
    if "duckduckgo.com" in (parsed.netloc or ""):
      qs = parse_qs(parsed.query or "")
      uddg = qs.get("uddg", [])
      if uddg:
        target = unquote(str(uddg[0]).strip())
        if target.startswith("http://") or target.startswith("https://"):
          return target
  except Exception:
    pass
  return u


def _extract_first_url(text: str) -> str:
  src = str(text or "")
  m = re.search(r"https?://[^\s)>\]\"']+", src, flags=re.IGNORECASE)
  if not m:
    return ""
  return str(m.group(0)).strip().rstrip(".,;")


def _required_roots() -> List[str]:
  raw = os.getenv("LAB_REQUIRED_ROOTS", r"C:\Users\anani\Projects,C:\Users\anani\.codeium\windsurf")
  return [x.strip().lower() for x in raw.split(",") if x.strip()]


def _decode_mojibake_text(text: str) -> str:
  s = text or ""
  if not s:
    return s

  # First pass: robust generic mojibake fixer.
  try:
    fixed = fix_text(s, fix_encoding=True)
    if fixed and fixed != s:
      s = fixed
  except Exception:
    pass

  def _is_cyr(ch: str) -> bool:
    return "\u0400" <= ch <= "\u04ff"

  def _score(candidate: str) -> int:
    cyr = sum(1 for ch in candidate if _is_cyr(ch))
    cjk = sum(1 for ch in candidate if "\u4e00" <= ch <= "\u9fff")
    bad = candidate.count("\ufffd") + candidate.count("?")
    boost = 0
    lc = candidate.lower()
    for tok in ("Ñ‡Ñ‚Ð¾", "ÐºÐ°Ðº", "ÑÐµÐ³Ð¾Ð´Ð½Ñ", "Ð¿Ð¾ÐºÐ°Ð¶Ð¸", "Ð¸Ð½ÑÑ‚Ñ€ÑƒÐ¼ÐµÐ½Ñ‚", "Ð¾Ñ‚Ð²ÐµÑ‚", "Ð²Ñ€ÐµÐ¼Ñ", "Ð¼ÐµÑ‚Ñ€Ð¸ÐºÐ¸"):
      if tok in lc:
        boost += 20
    return cyr * 2 + boost - cjk * 3 - bad

  has_cyr = any(_is_cyr(ch) for ch in s)
  latin_noise = sum(1 for ch in s if ord(ch) in (0x00D0, 0x00D1, 0x00C2, 0x00C3))
  cjk_noise = sum(1 for ch in s if "\u4e00" <= ch <= "\u9fff")
  suspicious = (latin_noise >= 2 and not has_cyr) or (cjk_noise > 0 and not has_cyr)
  if not suspicious:
    return s

  candidates = [s]
  encode_encs = ("latin-1", "cp1251", "cp866", "cp1252", "utf-8")
  decode_encs = ("utf-8", "cp1251", "cp866", "cp1252")
  for e in encode_encs:
    try:
      b = s.encode(e, errors="replace")
    except Exception:
      continue
    for d in decode_encs:
      try:
        x = b.decode(d, errors="replace")
        if x:
          candidates.append(x)
      except Exception:
        continue

  best = max(candidates, key=_score)
  if _score(best) > _score(s):
    return best
  return s


def _sanitize_text_encoding(value: Any) -> Any:
  if isinstance(value, str):
    return _decode_mojibake_text(value)
  if isinstance(value, list):
    return [_sanitize_text_encoding(x) for x in value]
  if isinstance(value, dict):
    return {k: _sanitize_text_encoding(v) for k, v in value.items()}
  return value


def _redact_text(s: str) -> str:
  out = s or ""
  patterns = [
    (r"(?i)authorization\s*:\s*bearer\s+[A-Za-z0-9\-\._~\+\/=]+", "Authorization: Bearer [REDACTED]"),
    (r"(?i)bearer\s+[A-Za-z0-9\-\._~\+\/=]{12,}", "Bearer [REDACTED]"),
    (r"(?i)sk-[A-Za-z0-9\-_]{12,}", "sk-[REDACTED]"),
    (r"(?i)(api[_-]?key\s*[=:]\s*)[^\s,;]+", r"\1[REDACTED]"),
  ]
  for p, repl in patterns:
    out = re.sub(p, repl, out)
  return out


def _redact_sensitive(value: Any) -> Any:
  if isinstance(value, str):
    return _redact_text(value)
  if isinstance(value, list):
    return [_redact_sensitive(x) for x in value]
  if isinstance(value, dict):
    sanitized: Dict[str, Any] = {}
    for k, v in value.items():
      key = str(k).lower()
      if key in {"authorization", "api_key", "token", "bearer"}:
        sanitized[k] = "[REDACTED]"
      else:
        sanitized[k] = _redact_sensitive(v)
    return sanitized
  return value


def _learning_dir() -> Path:
  d = Path(__file__).resolve().parents[2] / "_sync" / "autogen_learning"
  d.mkdir(parents=True, exist_ok=True)
  return d


def _ttl_cache_path() -> Path:
  return _learning_dir() / "tool_ttl_cache.json"


def _load_ttl_cache() -> Dict[str, Any]:
  p = _ttl_cache_path()
  if not p.exists():
    return {}
  try:
    return json.loads(p.read_text(encoding="utf-8"))
  except Exception:
    return {}


def _save_ttl_cache(cache: Dict[str, Any]) -> None:
  try:
    _ttl_cache_path().write_text(_json_dumps(cache), encoding="utf-8")
  except Exception:
    pass


def _cache_key(name: str, args: Dict[str, Any]) -> str:
  raw = f"{name}:{_json_dumps(args)}"
  return hashlib.sha1(raw.encode("utf-8", errors="ignore")).hexdigest()


def _build_tool_plan(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
  attempted_tools = list(payload.get("attempted_tools", []) or [])
  used_tools = set(payload.get("used_tools", []) or [])
  plan: List[Dict[str, Any]] = []
  for name in attempted_tools[:12]:
    plan.append(
      {
        "tool": str(name),
        "args": {},
        "why": "runtime-selected tool for task execution",
        "evidence_required": True,
        "status": "used" if name in used_tools else "attempted",
      }
    )
  return plan


def _build_claims(payload: Dict[str, Any], evidence: List[str]) -> List[Dict[str, Any]]:
  answer = str(payload.get("answer", "") or "").strip()
  first_line = answer.splitlines()[0].strip() if answer else ""
  if not first_line:
    return []
  intent = str(payload.get("intent", "general"))
  requires_evidence = _requires_tool_evidence(str(payload.get("task", ""))) or intent in {
    "operational",
    "operational_analysis",
    "system_recovery",
    "improvement_plan",
    "capability_proof",
    "repo_maintenance",
  }
  refs: List[str] = []
  for i, ev in enumerate(evidence[:5]):
    if str(ev).strip():
      refs.append(f"evidence[{i}]")
  supported = (not requires_evidence) or len(refs) > 0
  return [
    {
      "text": first_line,
      "requires_evidence": requires_evidence,
      "evidence_refs": refs,
      "supported": supported,
    }
  ]


def _answer_has_caution(answer: str) -> bool:
  low = str(answer or "").lower()
  markers = [
    "предварительный ответ",
    "без tool-evidence",
    "нужна проверка",
    "verify",
    "needs verification",
    "ограничения",
    "constraints",
  ]
  return any(m in low for m in markers)


def _has_unsupported_claim(payload: Dict[str, Any], claims: List[Dict[str, Any]]) -> bool:
  if any(bool(c.get("requires_evidence")) and (not bool(c.get("supported"))) for c in claims):
    return True
  intent = str(payload.get("intent", "general"))
  task = str(payload.get("task", ""))
  answer = str(payload.get("answer", "") or "")
  evidence = list(payload.get("evidence", []) or [])
  used_tools = list(payload.get("used_tools", []) or [])
  has_evidence = len(evidence) > 0 or len(used_tools) > 0
  if intent in DECISION_REQUIRED_INTENTS and not has_evidence:
    return True
  if intent == "general" and (not has_evidence) and _needs_verification_general(task, answer) and (not _answer_has_caution(answer)):
    return True
  return False


def _extract_reason_text(answer: str) -> str:
  text = str(answer or "")
  if not text:
    return ""
  m = re.search(r"(?i)(причины|reason|root causes?)\s*:\s*([^\n]+)", text)
  if m:
    return m.group(2).strip().rstrip(".")
  details = _extract_section(text, "Details:")
  if details:
    first = details[0].lstrip("- ").strip()
    if first:
      return first.rstrip(".")
  return ""


def _extract_expected_effect(answer: str) -> str:
  steps = _extract_section(answer, "Next steps:")
  if steps:
    first = steps[0].lstrip("- ").strip()
    if first:
      return f"Execute: {first.rstrip('.')}. Expected measurable stabilization."
  return ""


def _build_decision_contract(payload: Dict[str, Any], evidence: List[str]) -> Tuple[Dict[str, Any], bool]:
  intent = str(payload.get("intent", "general"))
  answer = str(payload.get("answer", "") or "")
  synthesized = False

  why = str(payload.get("decision_why", "") or "").strip()
  if not why:
    why = _extract_reason_text(answer)
  if not why:
    synthesized = True
    if intent == "system_recovery":
      why = "System recovery is prioritized because meta stability is below target and requires controlled stabilization."
    elif intent == "operational_analysis":
      why = "Operational analysis is required to identify active blockers using tool evidence."
    elif intent == "improvement_plan":
      why = "Improvement plan is required to convert diagnosed weaknesses into measurable actions."
    elif intent == "capability_proof":
      why = "Capability proof is required to verify claims using tool evidence."
    else:
      why = "Decision rationale synthesized from available context."

  expected_effect = str(payload.get("decision_expected_effect", "") or "").strip()
  if not expected_effect:
    expected_effect = _extract_expected_effect(answer)
  if not expected_effect:
    synthesized = True
    expected_effect = "Quality and stability signals should improve after executing the next steps."

  risk = str(payload.get("decision_risk", "") or "").strip()
  if not risk:
    if payload.get("llm_error"):
      risk = "LLM/backend instability can reduce response quality."
    elif payload.get("quality_gate_applied"):
      risk = "Quality gate indicates potential regressions if changes bypass verification."
    else:
      risk = "Incorrect routing or stale telemetry can cause false conclusions."
  if not risk:
    synthesized = True
    risk = "Insufficient evidence increases the probability of wrong decisions."

  success_criteria = str(payload.get("decision_success_criteria", "") or "").strip()
  if not success_criteria:
    if intent in {"system_recovery", "operational_analysis"}:
      success_criteria = "meta_stable=true OR arena_entropy<=0.92, gihi_delta_ultra>=-0.02, error_jobs_effective=0, queue_depth_total=0."
    elif intent == "improvement_plan":
      success_criteria = "Planned steps completed and quality gates pass without regression."
    elif intent == "capability_proof":
      success_criteria = "All claimed capabilities are backed by tool evidence with verifier pass."
    else:
      success_criteria = "Decision outcomes are supported by evidence and meet quality gates."

  evidence_refs: List[str] = []
  for i, ev in enumerate((evidence or [])[:8]):
    if str(ev).strip():
      evidence_refs.append(f"evidence[{i}]")

  dc = {
    "why": why,
    "expected_effect": expected_effect,
    "risk": risk,
    "success_criteria": success_criteria,
    "evidence_refs": evidence_refs,
  }
  return dc, synthesized


def _build_output_contract(payload: Dict[str, Any]) -> Dict[str, Any]:
  task = str(payload.get("task", ""))
  intent = str(payload.get("intent", "general"))
  confidence = float(payload.get("intent_confidence", 0.0))
  answer = str(payload.get("answer", ""))
  domain_signature = str(payload.get("domain_signature", "general"))
  used_tools = list(payload.get("used_tools", []) or [])
  attempted_tools = list(payload.get("attempted_tools", []) or [])
  evidence = list(payload.get("evidence", []) or [])
  warnings: List[str] = []
  if payload.get("boot_ok") is False:
    warnings.append("boot_sequence_failed")
  if payload.get("quality_gate_applied"):
    warnings.append("quality_gate_applied")
  if payload.get("reference_quality_gate_applied"):
    warnings.append("reference_quality_gate_applied")
  if payload.get("retry_policy_gate_applied"):
    warnings.append("retry_policy_gate_applied")
  if payload.get("identity_guard_applied"):
    warnings.append("identity_guard_applied")
  if payload.get("llm_error"):
    warnings.append("llm_error")

  tool_calls = []
  for t in attempted_tools:
    tool_calls.append({
      "name": str(t),
      "status": "used" if t in used_tools else "attempted",
    })

  plan = []
  if used_tools:
    plan.append("Tools were used to verify the answer.")
  elif intent in {"smalltalk", "identity", "capabilities", "constraints", "next_steps"}:
    plan.append("Tools were not required for this intent.")
  else:
    plan.append("Tool verification or request clarification is required.")

  tool_plan = _build_tool_plan(payload)
  claims = _build_claims(payload, evidence)
  decision_contract, decision_synthesized = _build_decision_contract(payload, evidence)
  if decision_synthesized:
    warnings.append("decision_contract_synthesized")
  unsupported_claim = _has_unsupported_claim(payload, claims)
  verifier = {
    "pass": (not unsupported_claim) and all((not c.get("requires_evidence")) or bool(c.get("supported")) for c in claims),
    "coverage": round((sum(1 for c in claims if c.get("supported")) / len(claims)), 3) if claims else 1.0,
  }
  judge = {
    "verdict": "pass" if verifier["pass"] else "fail",
    "reason": "claims_evidence_ok" if verifier["pass"] else "unsupported_claim_detected",
  }

  return {
    "schema_version": "labbrain.contract.v1",
    "ts_utc": payload.get("ts_utc", _now_iso()),
    "task": task,
    "intent": intent,
    "domain_signature": domain_signature,
    "confidence": round(confidence, 3),
    "plan": plan[:5],
    "tool_calls": tool_calls[:20],
    "tool_plan": tool_plan,
    "claims": claims,
    "decision_contract": decision_contract,
    "evidence": [str(x) for x in evidence[:30]],
    "verifier": verifier,
    "judge": judge,
    "warnings": warnings[:10],
    "answer": answer,
  }


def _validate_output_contract(contract: Dict[str, Any]) -> Tuple[bool, List[str]]:
  errs: List[str] = []
  if contract.get("schema_version") != "labbrain.contract.v1":
    errs.append("schema_version")
  if not isinstance(contract.get("task"), str):
    errs.append("task_type")
  intent = contract.get("intent")
  if intent not in STRICT_CONTRACT_INTENTS:
    errs.append("intent_value")
  domain_signature = contract.get("domain_signature")
  if domain_signature not in DOMAIN_SIGNATURES:
    errs.append("domain_signature")
  conf = contract.get("confidence")
  if not isinstance(conf, (int, float)) or conf < 0 or conf > 1:
    errs.append("confidence_range")
  for k in ("plan", "tool_calls", "tool_plan", "claims", "evidence", "warnings"):
    if not isinstance(contract.get(k), list):
      errs.append(f"{k}_type")
  dc = contract.get("decision_contract")
  if not isinstance(dc, dict):
    errs.append("decision_contract_type")
  else:
    for k in ("why", "expected_effect", "risk", "success_criteria"):
      v = dc.get(k)
      if not isinstance(v, str) or not v.strip():
        errs.append(f"decision_contract_{k}")
    if not isinstance(dc.get("evidence_refs"), list):
      errs.append("decision_contract_evidence_refs")
  if intent in DECISION_REQUIRED_INTENTS:
    if not isinstance(dc, dict):
      errs.append("decision_contract_required_missing")
    else:
      for k in ("why", "expected_effect", "risk", "success_criteria"):
        if not str(dc.get(k, "")).strip():
          errs.append("decision_contract_required_incomplete")
          break
  for k in ("verifier", "judge"):
    if not isinstance(contract.get(k), dict):
      errs.append(f"{k}_type")
  if not isinstance(contract.get("answer"), str):
    errs.append("answer_type")
  return len(errs) == 0, errs


def _detect_domain_signature(task: str, intent: str, used_tools: List[str]) -> str:
  q = _norm(task)
  tset = set(str(x) for x in (used_tools or []))
  if intent in {"pure_logic"}:
    return "reasoning"
  if intent in {"identity", "capabilities", "constraints", "smalltalk"}:
    return "identity"
  if intent in {"capability_proof"}:
    return "ops-metrics"
  if intent in {"improvement_plan"}:
    return "ops-metrics"
  if intent in {"metrics", "operational_analysis", "system_recovery", "external_hook_probe", "external_security_analysis", "external_app_analysis"}:
    return "ops-metrics"
  if intent in {"web", "weather"}:
    return "web-research"
  if intent in {"status"}:
    return "memory"
  if re.search(r"\b(fix|bug|refactor|implement|patch|test|rollback|optimi[sz]e)\b", q):
    return "code-change"
  if re.search(r"Ð¸ÑÐ¿Ñ€Ð°Ð²|Ñ€ÐµÑ„Ð°ÐºÑ‚Ð¾Ñ€|Ð¾Ð¿Ñ‚Ð¸Ð¼Ð¸Ð·|Ñ‚ÐµÑÑ‚|Ð¿Ð°Ñ‚Ñ‡|ÐºÐ¾Ð´|Ð¾ÑˆÐ¸Ð±Ðº|Ð´ÐµÐ±Ð°Ð³|rollback", q):
    return "code-change"
  if intent in {"tool_call", "fs", "tasks", "sync", "datetime", "operational"}:
    return "tools"
  if tset.intersection({"whoami", "fs", "exec", "tasks", "sync_status"}):
    return "tools"
  if tset.intersection({"worker_metrics_snapshot", "intelligence_meta_snapshot", "intelligence_health_snapshot"}):
    return "ops-metrics"
  if tset.intersection({"project_context_get", "project_context_set", "memory_query", "memory_store"}):
    return "memory"
  return "general"


def _finalize_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
  out = dict(payload or {})
  if "ts_utc" not in out:
    out["ts_utc"] = _now_iso()
  if "domain_signature" not in out:
    out["domain_signature"] = _detect_domain_signature(
      str(out.get("task", "")),
      str(out.get("intent", "general")),
      list(out.get("used_tools", []) or []),
    )

  # Anti-repeat formatting: diversify presentation for very similar consecutive answers.
  try:
    intent = str(out.get("intent", "general"))
    answer = str(out.get("answer", "") or "")
    task = str(out.get("task", "") or "")
    anti_repeat_blocked_intents = {
      "operational_analysis",
      "system_recovery",
      "improvement_plan",
      "capability_proof",
      "repo_maintenance",
      "external_hook_probe",
      "external_security_analysis",
      "external_app_analysis",
    }
    if answer and len(answer) > 60 and intent not in {"error", "identity"}:
      if intent in anti_repeat_blocked_intents:
        pass
      else:
        ctx = _load_session_context(ttl_hours=24)
        prev_task = str(ctx.get("prev_task", ""))
        prev_intent = str(ctx.get("prev_intent", ""))
        prev_answer = str(ctx.get("prev_answer", ""))
        if prev_task and prev_answer and prev_intent == intent:
          sim_task = _jaccard_similarity(task, prev_task)
          sim_answer = _jaccard_similarity(answer[:400], prev_answer[:400])
          if sim_task >= 0.45 or sim_answer >= 0.55:
            idx = int(ctx.get("anti_repeat_idx", 0) or 0)
            mode = idx % 3
            rewritten = _rewrite_answer_variant(answer, mode)
            if rewritten and rewritten != answer:
              out["answer"] = rewritten
              _update_session_fields({
                "last_answer": rewritten[:500],
                "anti_repeat_idx": idx + 1,
                "anti_repeat_applied": True,
                "anti_repeat_last_mode": mode,
                "anti_repeat_similarity_task": round(sim_task, 3),
                "anti_repeat_similarity_answer": round(sim_answer, 3),
              })
  except Exception:
    pass

  # Decision gate: for operational/recovery/planning intents, always include rationale block.
  try:
    intent = str(out.get("intent", "general"))
    if intent in DECISION_REQUIRED_INTENTS:
      answer = str(out.get("answer", "") or "").strip()
      low = answer.lower()
      has_rationale = ("why:" in low) or ("rationale:" in low) or ("почему:" in low)
      if not has_rationale:
        dc, _ = _build_decision_contract(out, list(out.get("evidence", []) or []))
        rationale_lines = [
          "Rationale:",
          f"- Why: {dc.get('why', '')}",
          f"- Expected effect: {dc.get('expected_effect', '')}",
          f"- Risk: {dc.get('risk', '')}",
          f"- Success criteria: {dc.get('success_criteria', '')}",
        ]
        out["answer"] = (answer + "\n" + "\n".join(rationale_lines)).strip()
        _update_session_fields({"decision_gate_applied": True})
  except Exception:
    pass

  # Reference quality gate: enforce Plan/Act/Verify/Report blocks for operational intents.
  try:
    kind = str(out.get("intent", "general"))
    answer = str(out.get("answer", "") or "")
    rewritten, applied = _enforce_reference_sections(kind, answer)
    if applied and rewritten:
      out["answer"] = rewritten
      out["reference_quality_gate_applied"] = True
      out["quality_gate_applied"] = True
      _update_session_fields({"reference_quality_gate_applied": True, "reference_quality_gate_intent": kind})
  except Exception:
    pass

  # Retry/Rollback gate: operational failures must include deterministic recovery steps.
  try:
    kind = str(out.get("intent", "general"))
    answer = str(out.get("answer", "") or "")
    if kind in OPERATIONAL_INTENTS:
      low = answer.lower()
      has_hard_failure = bool(
        re.search(
          r"("
          r"не удалось|"
          r"failed|"
          r"tool route не сработал|"
          r"circuit_open|"
          r"mcp tool error|"
          r"request failed|"
          r"http 5\d\d|"
          r"connection error|"
          r"timed out|"
          r"timeout exceeded|"
          r"unknown job\.type"
          r")",
          low,
        )
      )
      has_nonzero_error_counters = bool(
        re.search(r"\berror_jobs(?:_effective)?\s*=\s*[1-9]\d*\b", low)
        or re.search(r"\berrors_count\s*[:=]\s*[1-9]\d*\b", low)
        or re.search(r"\blatest_status\s*[:=]\s*\"?error\"?\b", low)
      )
      has_failure_markers = has_hard_failure or has_nonzero_error_counters
      if has_failure_markers and ("retry policy:" not in low):
        retry_block = "\n".join([
          "Retry policy:",
          "- Retry: enqueue async execution via queue_push(type=exec|project_task) instead of repeating sync call.",
          "- Verify: collect evidence from job_history_list and latest *_latest.json checkpoints.",
          "- Rollback: if repeated failure persists, run ops/autogen_engine/autogen_policy_rollback_playbook.ps1 and re-run quality_tick.",
        ])
        out["answer"] = (answer + "\n" + retry_block).strip()
        out["retry_policy_gate_applied"] = True
        out["quality_gate_applied"] = True
        _update_session_fields({"retry_policy_gate_applied": True, "retry_policy_gate_intent": kind})
  except Exception:
    pass
  return out


def _log_contract_snapshot(payload: Dict[str, Any], contract: Dict[str, Any], valid: bool) -> None:
  root = Path(__file__).resolve().parents[2]
  log_dir = root / "_sync" / "autogen_learning"
  log_dir.mkdir(parents=True, exist_ok=True)
  out = log_dir / "dialog_contract_samples.jsonl"
  row = {
    "ts_utc": payload.get("ts_utc", _now_iso()),
    "task": payload.get("task", ""),
    "intent": payload.get("intent", ""),
    "contract_valid": bool(valid),
    "contract": contract,
  }
  row = _redact_sensitive(_sanitize_text_encoding(row))
  with out.open("a", encoding="utf-8") as f:
    f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _log_decision_trace(payload: Dict[str, Any], contract: Dict[str, Any], valid: bool) -> None:
  try:
    intent = str(contract.get("intent", ""))
    if intent not in DECISION_REQUIRED_INTENTS:
      return
    root = Path(__file__).resolve().parents[2]
    log_dir = root / "_sync" / "autogen_learning"
    log_dir.mkdir(parents=True, exist_ok=True)
    latest = log_dir / "decision_trace_latest.json"
    history = log_dir / "decision_trace_history.jsonl"
    dc = contract.get("decision_contract", {})
    row = {
      "ts_utc": payload.get("ts_utc", _now_iso()),
      "session_id": _session_id(),
      "task": payload.get("task", ""),
      "intent": intent,
      "domain_signature": contract.get("domain_signature", ""),
      "contract_valid": bool(valid),
      "judge": contract.get("judge", {}),
      "decision_contract": {
        "why": (dc or {}).get("why", ""),
        "expected_effect": (dc or {}).get("expected_effect", ""),
        "risk": (dc or {}).get("risk", ""),
        "success_criteria": (dc or {}).get("success_criteria", ""),
        "evidence_refs": (dc or {}).get("evidence_refs", []),
      },
      "used_tools": list(payload.get("used_tools", []) or []),
      "attempted_tools": list(payload.get("attempted_tools", []) or []),
      "warnings": list(contract.get("warnings", []) or []),
    }
    row = _redact_sensitive(_sanitize_text_encoding(row))
    latest.write_text(json.dumps(row, ensure_ascii=False, indent=2), encoding="utf-8")
    with history.open("a", encoding="utf-8") as f:
      f.write(json.dumps(row, ensure_ascii=False) + "\n")
  except Exception:
    pass


def build_client() -> OpenAIChatCompletionClient:
  model = os.getenv("OPENAI_MODEL", "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf")
  base_url = os.getenv("OPENAI_BASE_URL", "http://127.0.0.1:11435/v1")
  api_key = os.getenv("OPENAI_API_KEY", "local-anything")
  timeout_sec_raw = os.getenv("OPENAI_TIMEOUT_SEC", "").strip()
  timeout_ms_raw = os.getenv("OPENAI_TIMEOUT_MS", "").strip()
  timeout = 120.0
  try:
    if timeout_sec_raw:
      timeout = float(timeout_sec_raw)
    elif timeout_ms_raw:
      ms = float(timeout_ms_raw)
      timeout = 120.0 if ms <= 0 else (ms / 1000.0)
  except Exception:
    timeout = 120.0
  return OpenAIChatCompletionClient(
    model=model,
    base_url=base_url,
    api_key=api_key,
    timeout=timeout,
    model_info={
      "vision": False,
      "function_calling": True,
      "json_output": True,
      "structured_output": True,
      "family": ModelFamily.UNKNOWN,
    },
  )


# ---- Question intent detection (Stage 2) ----

def _detect_intent(task: str) -> Dict[str, Any]:
  q = _norm(task)
  # Explicit tool-call intent (must be checked before generic capabilities routing).
  if re.search(r"(используй|вызови|запусти|use|call|run)\s+(инструмент|tool)\s+[a-z0-9_\-]+", q):
    return {"intent": "tool_call", "confidence": 0.99}
  if re.search(r"(используй|вызови|use|call)\s+whoami|whoami\s+(вывод|output|result)", q):
    return {"intent": "tool_call", "confidence": 0.99}

  # Code-change intent (keep high priority to avoid collisions with capabilities words like "инструменты").
  if re.search(r"\b(refactor|fix|bug|patch|implement|code change|debug|rollback|tests?)\b", q):
    return {"intent": "operational", "confidence": 0.96}
  if re.search(r"(рефактор|исправ|баг|патч|дебаг|откат|тест|обработчик|код)", q):
    return {"intent": "operational", "confidence": 0.96}

  # Memory/context intent.
  if re.search(r"(контекст\s+проекта|project context|project memory|память\s+проекта|adr)", q):
    return {"intent": "status", "confidence": 0.97}

  # Metrics/ops intent (explicit Russian + English phrases).
  if re.search(r"(покажи\s+метрик|метрики\s+лаборатор|глубин[ау]\s+очеред|queue depth|worker metrics|lab metrics)", q):
    return {"intent": "metrics", "confidence": 0.98}

  if re.search(r"\b(run|execute|perform|do)\b.*\b(system analysis|analy[sz]e system|operational analysis|severity|top causes)\b", q):
    return {"intent": "operational_analysis", "confidence": 0.99}
  if re.search(r"(hook\s*probe|detect\s*hooks|hook\s*coverage|определи.*hook|анализ.*hook|какие.*hooks)", q):
    return {"intent": "external_hook_probe", "confidence": 0.99}
  if re.search(r"(security\s*analysis|security\s*mode|scan\s*vulnerab|trivy|osv|анализ.*безопас|поиск.*уязв)", q):
    return {"intent": "external_security_analysis", "confidence": 0.99}
  if re.search(r"(external\s*app\s*analysis|анализ.*внешн.*прилож|контейнер.*анализ|docker.*анализ.*прилож)", q):
    return {"intent": "external_app_analysis", "confidence": 0.99}
  if re.search(r"\b(last|recent)\s+\d+\s+jobs\b|job history|error jobs|queue jobs", q):
    return {"intent": "operational_analysis", "confidence": 0.98}
  if re.search(r"\b(recovery tick|safe recovery|controller.*learning analyzer|meta stability)\b", q):
    return {"intent": "system_recovery", "confidence": 0.99}
  if re.search(r"(stabilization plan|stabilisation plan|safe stabilization plan|telemetry evidence)", q):
    return {"intent": "improvement_plan", "confidence": 0.98}
  if re.search(r"\b(run|execute)\b.*(\.ps1|\.py|python\s+-m\s+unittest|stdout)", q):
    return {"intent": "operational", "confidence": 0.99}
  if re.search(r"(system\s*recovery|recovery\s*loop|recovery\s*playbook|system_recovery|автопетл|авто\s*цикл|цикл\s+восстанов)", q):
    return {"intent": "system_recovery", "confidence": 0.99}
  # High-priority natural language routes (robust to phrase variants/typos).
  if re.search(r"\b(привет|здравствуй|добрый|как дела|hello|hi|hey)\b", q):
    return {"intent": "smalltalk", "confidence": 0.96}
  if re.search(r"(кто\s+ты|ты\s+кто|рас+кажи.*о\s*себе|раскажи.*о\s*себе|who are you|which model|какую\s+модель|какой\s+у\s+тебя\s+llm)", q):
    return {"intent": "identity", "confidence": 0.99}
  if re.search(
    r"(сделай|выполни|проведи|запусти|проанализируй).*(анализ.*состояни|текущ.*состояни|идентификац.*проблем|сбор.*метрик|диагностик|performance analysis|identify problems|current state)",
    q,
  ):
    return {"intent": "operational_analysis", "confidence": 0.99}
  if re.search(r"\b(rca|root cause|корнев\w+\s+причин|разбор\s+причин)\b", q):
    if re.search(r"(stressed|degraded|meta_state|system_health|восстанов|stability|стабилиз)", q):
      return {"intent": "system_recovery", "confidence": 0.99}
    return {"intent": "operational_analysis", "confidence": 0.98}
  if re.search(
    r"(улучш|восстанов|почин|исправ|стабилиз|сними).*(system_health|meta_state|stressed|энтроп|gihi|ошибк|error_jobs|систем)",
    q,
  ):
    return {"intent": "system_recovery", "confidence": 0.99}
  if re.search(r"(system\s*recovery|recovery\s*playbook|system_recovery|восстановлени[ея]\s+систем|тик\s+восстановлени[яе])", q):
    return {"intent": "system_recovery", "confidence": 0.99}
  if re.search(r"(что\s+ты\s+узнал.*анализ|итог.*анализ|вывод.*анализ|results? of analysis)", q):
    return {"intent": "operational_analysis", "confidence": 0.97}
  if re.search(r"(погода|weather|температур|дожд|снег|ветер|прогноз)", q):
    return {"intent": "weather", "confidence": 0.97}
  if re.search(r"(день\s+недел|котор.*час|время|дата|сегодня|завтра|послезавтра|вчера|следующ.*месяц|next month|tomorrow|day of week)", q):
    return {"intent": "datetime", "confidence": 0.98}
  if re.search(r"(какие.*инструмент|что\s+ты\s+умеешь|mcp\s+tools|available tools|describe each tool|list all tools)", q):
    return {"intent": "capabilities", "confidence": 0.99}
  if re.search(r"(какие.*ограничени|limitations|constraints|почему.*конкретизац)", q):
    return {"intent": "constraints", "confidence": 0.98}
  if re.search(r"(распиши|составь|дай).*(план).*(устранени|исправлени).*(недостатк)", q):
    return {"intent": "improvement_plan", "confidence": 0.99}
  if re.search(r"(план|roadmap|как улучшить|улучши).*(преимущ|возможност|эффективност|сильн\w+\s+сторон)", q):
    return {"intent": "improvement_plan", "confidence": 0.99}
  if re.search(r"(план|roadmap|как исправить|как устранить|улучш).*(недостатк|минус|слабые\s+сторон)", q):
    return {"intent": "improvement_plan", "confidence": 0.99}
  if re.search(r"(опиши|перечисли|какие|есть|твои|твои\s+же).*(преимущ).*(недостатк|минус|слабые\s+сторон)", q):
    return {"intent": "operational_analysis", "confidence": 0.97}
  if re.search(r"(какие|есть|твои|твои\s+же|почему).*(недостатк|минус|слабые\s+сторон)", q):
    return {"intent": "operational_analysis", "confidence": 0.98}
  if re.search(r"(докажи|подтверди|проверь|инструментальн|на\s+самом\s+деле).*(преимущ|уме(ешь|ет)|планир|исполня|масштаб|адаптац|отклик)", q):
    return {"intent": "capability_proof", "confidence": 0.98}
  if re.search(r"(проверь|проверить|проанализируй|посмотри|открой|show|check|inspect)\s+.*(\.ps1|\.py|\.md|\.json|\.ya?ml|\.ts|\.js|\.txt)\b", q):
    return {"intent": "operational", "confidence": 0.99}
  if _is_operational_request(task):
    return {"intent": "operational", "confidence": 0.95}
  if _is_basic_fact_request(task):
    return {"intent": "basic_fact", "confidence": 0.98}
  if _is_pure_logic_request(task):
    return {"intent": "pure_logic", "confidence": 0.96}
  if _is_repo_maintenance_request(task):
    return {"intent": "repo_maintenance", "confidence": 0.97}
  # Fast routes for common UX prompts that previously fell into generic clarification.
  if (" llm " in f" {q} ") or ("backend" in q) or ("model engine" in q):
    return {"intent": "identity", "confidence": 0.99}
  if ("ÐºÐ¾Ð½ÐºÑ€ÐµÑ‚Ð¸Ð·Ð°Ñ†" in q) or ("clarification" in q) or ("why do you need clarification" in q):
    return {"intent": "constraints", "confidence": 0.98}
  if (
    ("Ð¾Ð¿Ð¸ÑˆÐ¸ ÐºÐ°Ð¶Ð´Ñ‹Ð¹ Ð¸Ð½ÑÑ‚Ñ€ÑƒÐ¼ÐµÐ½Ñ‚" in q)
    or ("Ð¿ÐµÑ€ÐµÑ‡Ð¸ÑÐ»Ð¸ Ð¸Ð½ÑÑ‚Ñ€ÑƒÐ¼ÐµÐ½Ñ‚Ñ‹" in q)
    or ("Ð²ÑÐµ Ð¸Ð½ÑÑ‚Ñ€ÑƒÐ¼ÐµÐ½Ñ‚Ñ‹" in q)
    or ("describe each tool" in q)
    or ("list all tools" in q)
  ):
    return {"intent": "capabilities", "confidence": 0.99}
  if any(x in q for x in ["ÐºÐ°ÐºÐ¸Ðµ Ð¾Ð³Ñ€Ð°Ð½Ð¸Ñ‡ÐµÐ½Ð¸Ñ", "ÐºÐ°ÐºÐ¸Ðµ Ñƒ Ñ‚ÐµÐ±Ñ Ð¾Ð³Ñ€Ð°Ð½Ð¸Ñ‡ÐµÐ½Ð¸Ñ", "Ñ‚Ð²Ð¾Ð¸ Ð¾Ð³Ñ€Ð°Ð½Ð¸Ñ‡ÐµÐ½Ð¸Ñ", "limitations", "constraints", "internet search limits"]):
    return {"intent": "constraints", "confidence": 0.99}
  if re.search(r"^Ð¿Ñ€Ð¸Ð²ÐµÑ‚$|^Ð·Ð´Ñ€Ð°Ð²ÑÑ‚Ð²ÑƒÐ¹|^Ð´Ð¾Ð±Ñ€Ñ‹Ð¹|^ÐºÐ°Ðº Ð´ÐµÐ»Ð°|^hello$|^hi$|^hey$", q):
    return {"intent": "smalltalk", "confidence": 0.95}
  if re.search(r"Ñ‡Ñ‚Ð¾ Ð´Ð°Ð»ÑŒÑˆÐµ|Ñ‡Ñ‚Ð¾ Ð´ÐµÐ»Ð°ÐµÐ¼ Ð´Ð°Ð»ÑŒÑˆÐµ|next step|Ð´Ð°Ð»ÑŒÑˆÐµ Ð¿Ð¾ Ð¿Ð»Ð°Ð½Ñƒ|Ð¿Ð»Ð°Ð½", q):
    return {"intent": "next_steps", "confidence": 0.94}
  if ("Ð¼Ð¾Ð´ÐµÐ»" in q and ("ÐºÐ°ÐºÐ°Ñ" in q or "ÐºÑ‚Ð¾" in q or "Ð¾ ÑÐµÐ±Ðµ" in q)) or ("who are you" in q) or ("which model" in q):
    return {"intent": "identity", "confidence": 0.99}
  if re.search(r"ÐºÑ‚Ð¾\\s*Ñ‚Ñ‹|ÐºÐ°ÐºÐ°Ñ\\s+.*Ð¼Ð¾Ð´ÐµÐ»|Ñ€Ð°ÑÑÐºÐ°Ð¶Ð¸\\s+.*Ð¾\\s*ÑÐµÐ±Ðµ|Ð¾\\s*ÑÐµÐ±Ðµ", q):
    return {"intent": "identity", "confidence": 0.99}
  if re.search(r"ÐºÐ°ÐºÐ¸Ðµ\\s+.*Ð¸Ð½ÑÑ‚Ñ€ÑƒÐ¼ÐµÐ½Ñ‚|Ñ‡Ñ‚Ð¾\\s+Ñ‚Ñ‹\\s+ÑƒÐ¼ÐµÐµÑˆÑŒ|Ñ„ÑƒÐ½ÐºÑ†", q) or ("available tools" in q):
    return {"intent": "capabilities", "confidence": 0.99}
  if any(x in q for x in ["mcp tool", "mcp tools", "ÐºÐ°ÐºÐ¸Ðµ mcp", "ÐºÐ°ÐºÐ¸Ðµ mcp tools", "ÐºÐ°ÐºÐ¸Ðµ Ð¸Ð½ÑÑ‚Ñ€ÑƒÐ¼ÐµÐ½Ñ‚Ñ‹ mcp"]):
    return {"intent": "capabilities", "confidence": 0.99}
  # Deterministic web intent for direct internet/search/site requests.
  if any(
    x in q
    for x in [
      "в интернете",
      "найди в интернете",
      "поиск в интернете",
      "в сети",
      "найди сайт",
      "сайт ",
      "github",
      "github.com",
      "search web",
      "find in internet",
      "find in web",
      "find website",
      "find site",
      "lookup",
    ]
  ):
    return {"intent": "web", "confidence": 0.93}
  patterns: List[Tuple[str, float, List[str]]] = [
    ("basic_fact", 0.98, ["2+2", "сколько дней в неделе", "сколько минут в часе", "сколько месяцев", "days in week", "minutes in hour", "months in year"]),
    ("pure_logic", 0.97, ["Ð»Ð¾Ð³Ð¸Ñ‡ÐµÑÐºÐ°Ñ Ð·Ð°Ð´Ð°Ñ‡Ð°", "Ð³Ð¾Ð»Ð¾Ð²Ð¾Ð»Ð¾Ð¼ÐºÐ°", "Ð´Ð¾ÐºÐ°Ð¶Ð¸", "Ð½ÐµÐ²Ð¾Ð·Ð¼Ð¾Ð¶Ð½Ð¾", "logic puzzle", "prove", "impossible", "schedule", "slots", "ÑÑ‰Ð¸Ðº", "ÑÐ±Ð»Ð¾ÐºÐ¸", "Ð°Ð¿ÐµÐ»ÑŒÑÐ¸Ð½Ñ‹"]),
    ("identity", 0.99, ["ÐºÑ‚Ð¾ Ñ‚Ñ‹", "Ð¾ ÑÐµÐ±Ðµ", "ÐºÐ°ÐºÐ°Ñ Ð¼Ð¾Ð´ÐµÐ»ÑŒ", "what model", "which model", "who are you"]),
    ("capabilities", 0.99, ["ÐºÐ°ÐºÐ¸Ðµ Ð¸Ð½ÑÑ‚Ñ€ÑƒÐ¼ÐµÐ½Ñ‚Ñ‹", "Ñ‡Ñ‚Ð¾ Ñ‚Ñ‹ ÑƒÐ¼ÐµÐµÑˆÑŒ", "what tools", "your capabilities", "available tools", "mcp tools", "mcp tool", "ÐºÐ°ÐºÐ¸Ðµ mcp"]),
    ("constraints", 0.99, ["ÐºÐ°ÐºÐ¸Ðµ Ð¾Ð³Ñ€Ð°Ð½Ð¸Ñ‡ÐµÐ½Ð¸Ñ", "Ñ‚Ð²Ð¾Ð¸ Ð¾Ð³Ñ€Ð°Ð½Ð¸Ñ‡ÐµÐ½Ð¸Ñ", "limitations", "constraints"]),
    ("datetime", 0.98, ["ÐºÐ¾Ñ‚Ð¾Ñ€Ñ‹Ð¹ Ñ‡Ð°Ñ", "Ð²Ñ€ÐµÐ¼Ñ", "Ð´ÐµÐ½ÑŒ Ð½ÐµÐ´ÐµÐ»Ð¸", "Ð´Ð°Ñ‚Ð°", "what time", "weekday", "day of week"]),
    ("metrics", 0.95, ["Ð¼ÐµÑ‚Ñ€Ð¸ÐºÐ¸", "metrics", "show lab metrics", "queue depth", "ÑÐ¾ÑÑ‚Ð¾ÑÐ½Ð¸Ðµ Ð»Ð°Ð±Ð¾Ñ€Ð°Ñ‚Ð¾Ñ€Ð¸Ð¸"]),
    ("fs", 0.97, ["Ð¿Ð¾ÐºÐ°Ð¶Ð¸ Ð¿Ð°Ð¿ÐºÐ¸", "ÑÐ¿Ð¸ÑÐ¾Ðº Ñ„Ð°Ð¹Ð»Ð¾Ð²", "list files", "list folders", "projects", "root folders access", "root folders"]),
    ("tasks", 0.90, ["Ð·Ð°Ð´Ð°Ñ‡Ð¸", "tasks", "task list", "Ð¿Ð¾ÐºÐ°Ð¶Ð¸ Ð·Ð°Ð´Ð°Ñ‡Ð¸"]),
    ("status", 0.92, ["project memory", "project context", "Ð¿Ð°Ð¼ÑÑ‚ÑŒ Ð¿Ñ€Ð¾ÐµÐºÑ‚Ð°", "adr", "ÐºÐ¾Ð½Ñ‚ÐµÐºÑÑ‚ Ð¿Ñ€Ð¾ÐµÐºÑ‚Ð°"]),
    ("sync", 0.90, ["sync status", "ÑÑ‚Ð°Ñ‚ÑƒÑ ÑÐ¸Ð½Ñ…Ñ€Ð¾Ð½Ð¸Ð·Ð°Ñ†Ð¸Ð¸", "ÑÐ¸Ð½Ñ…Ñ€Ð¾Ð½Ð¸Ð·Ð°Ñ†", "synchronization state"]),
    ("weather", 0.90, ["Ð¿Ð¾Ð³Ð¾Ð´Ð°", "weather"]),
    ("web", 0.85, ["Ð² Ð¸Ð½Ñ‚ÐµÑ€Ð½ÐµÑ‚Ðµ", "Ð½Ð°Ð¹Ð´Ð¸ Ð² Ð¸Ð½Ñ‚ÐµÑ€Ð½ÐµÑ‚Ðµ", "search web", "Ð½Ð¾Ð²Ð¾ÑÑ‚Ð¸", "ÐºÑƒÑ€Ñ", "find in internet", "find in web", "usd uah", "exchange rate"]),
    ("status", 0.97, ["Ð¿Ð¾ÐºÐ°Ð¶Ð¸ ÑÐ¾ÑÑ‚Ð¾ÑÐ½Ð¸Ðµ ÑÐ¸ÑÑ‚ÐµÐ¼Ñ‹", "system status", "/status", "lab health"]),
  ]
  best = {"intent": "general", "confidence": 0.30}
  def _match_key(text: str, key: str) -> bool:
    k = str(key or "")
    if not k:
      return False
    if re.fullmatch(r"[a-z_]+", k):
      return re.search(rf"\b{re.escape(k)}\b", text) is not None
    return k in text
  for intent, conf, keys in patterns:
    if any(_match_key(q, k) for k in keys):
      if conf > best["confidence"]:
        best = {"intent": intent, "confidence": conf}
  if re.search(r"ÐºÐ¾Ñ‚Ð¾Ñ€.*Ñ‡Ð°Ñ", q):
    best = {"intent": "datetime", "confidence": 0.98}
  if best.get("intent") == "general" and _is_operational_request(task):
    best = {"intent": "operational", "confidence": 0.90}
  return best


async def _llm_intent_refine(task: str, initial: Dict[str, Any]) -> Dict[str, Any]:
  initial_intent = str(initial.get("intent", "general"))
  initial_conf = float(initial.get("confidence", 0.0))
  if initial_conf >= 0.55 and initial_intent not in {"general", "unknown"}:
    return initial

  schema_hint = (
    '{"intent":"identity|capabilities|capability_proof|improvement_plan|constraints|smalltalk|next_steps|datetime|metrics|fs|tasks|sync|weather|web|status|tool_call|repo_maintenance|pure_logic|basic_fact|operational|operational_analysis|system_recovery|external_hook_probe|external_security_analysis|external_app_analysis|general",'
    '"confidence":0.0}'
  )
  prompt = (
    "Classify user request intent into one allowed intent.\n"
    f"Return ONLY JSON in exact shape: {schema_hint}\n"
    f"User task: {task}"
  )
  try:
    client = build_client()
    agent = AssistantAgent(name="intent_router", model_client=client, system_message="Return strict JSON only.")
    result = await agent.run(task=prompt)
    await client.close()
    text = ""
    msgs = getattr(result, "messages", None) or []
    if msgs:
      text = str(getattr(msgs[-1], "content", "") or "")
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
      obj = json.loads(text[start:end + 1])
      intent = str(obj.get("intent", "general"))
      conf = float(obj.get("confidence", 0.0))
      if intent in STRICT_CONTRACT_INTENTS and 0 <= conf <= 1 and conf > initial_conf:
        return {"intent": intent, "confidence": conf}
  except Exception:
    return initial
  return initial


# ---- Identity / capabilities guards ----

def _is_identity_question(task: str) -> bool:
  return _detect_intent(task)["intent"] == "identity"


def _identity_answer() -> str:
  model = os.getenv("OPENAI_MODEL", "unknown")
  return (
    "Ð¯ LabBrain (Ñ†ÐµÐ½Ñ‚Ñ€Ð°Ð»ÑŒÐ½Ñ‹Ð¹ Ð°Ð³ÐµÐ½Ñ‚ Ð»Ð°Ð±Ð¾Ñ€Ð°Ñ‚Ð¾Ñ€Ð¸Ð¸). "
    "ÐžÑ€ÐºÐµÑÑ‚Ñ€Ð°Ñ‚Ð¾Ñ€: AutoGen. "
    f"LLM backend: {model}."
  )


def _is_capabilities_question(task: str) -> bool:
  return _detect_intent(task)["intent"] == "capabilities"


def _is_constraints_question(task: str) -> bool:
  return _detect_intent(task)["intent"] == "constraints"


TOOL_DESCRIPTIONS: Dict[str, str] = {
  "agent_dispatch_tick": "Dispatch queued role-based agent tasks.",
  "evolution_tick": "Create shadow candidate versions for agents.",
  "exec": "Run shell/PowerShell commands via MCP.",
  "fs": "File system operations (list/read/write/exists).",
  "intelligence_meta_snapshot": "Meta intelligence diagnostics and health trends.",
  "job_history_list": "Read history and status of background jobs.",
  "memory_prune": "Prune old memory records.",
  "memory_query": "Query project memory records.",
  "memory_store": "Store new memory record.",
  "memory_update": "Update existing memory record.",
  "mutation_effectiveness_snapshot": "Mutation effectiveness metrics.",
  "project_context_get": "Read project context/roadmap/constraints.",
  "project_context_set": "Update project context/roadmap/constraints.",
  "project_create": "Create or update a project context root.",
  "queue_push": "Push async job to queue.",
  "read_url_content": "Read web page content by URL.",
  "router_execute_exec_queue": "Execute one job from exec queue.",
  "search_web": "Search the web by query.",
  "shadow_evaluation_tick": "Evaluate and promote/discard shadow versions.",
  "sync": "Sync bridge operations and status.",
  "tasks": "Task graph CRUD, planning and orchestration.",
  "weather": "Fetch weather for a location.",
  "web": "Web helper (search/read/chunk).",
  "whoami": "Show server roots, tools and runtime info.",
  "worker_metrics_snapshot": "Worker/queue performance metrics.",
}


def _capabilities_answer(current_allowed: Optional[List[str]] = None) -> str:
  model = os.getenv("OPENAI_MODEL", "unknown")
  base_url = os.getenv("OPENAI_BASE_URL", "unknown")
  mcp_url = os.getenv("LAB_MCP_URL", "http://127.0.0.1:3000/mcp")
  env_tools = os.getenv(
    "LAB_MCP_TOOL_ALLOWLIST",
    "*",
  ).strip()

  if current_allowed is not None:
    tools_list = sorted([t for t in current_allowed if str(t).strip()])
  else:
    tools_list = sorted([x.strip() for x in env_tools.split(",") if x.strip()])

  lines: List[str] = [
    "LabBrain capabilities (deterministic):",
    "1. Role: LabBrain (central orchestrator).",
    "2. Orchestration runtime: AutoGen.",
    f"3. LLM backend: {model}.",
    f"4. LLM endpoint: {base_url}.",
    f"5. MCP endpoint: {mcp_url}.",
    f"6. Available MCP tools ({len(tools_list)}):",
  ]
  if not tools_list:
    lines.append("- (none)")
    return "\n".join(lines)

  for name in tools_list:
    desc = TOOL_DESCRIPTIONS.get(name, "General MCP operation (description not specified in catalog).")
    lines.append(f"- {name}: {desc}")
  return "\n".join(lines)


def _constraints_answer(current_allowed: Optional[List[str]] = None) -> str:
  tools = os.getenv(
    "LAB_MCP_TOOL_ALLOWLIST",
    "*",
  ).strip()
  if current_allowed is not None:
    tools = ",".join(current_allowed)
  return (
    "ÐœÐ¾Ð¸ Ñ‚ÐµÐºÑƒÑ‰Ð¸Ðµ Ð¾Ð³Ñ€Ð°Ð½Ð¸Ñ‡ÐµÐ½Ð¸Ñ:\n"
    "1) Ð¯ Ð½Ðµ Ð¿Ñ€Ð¸Ð´ÑƒÐ¼Ñ‹Ð²Ð°ÑŽ Ñ„Ð°ÐºÑ‚Ñ‹: Ð´Ð»Ñ Ð²Ñ€ÐµÐ¼ÐµÐ½Ð¸/Ð¿Ð¾Ð³Ð¾Ð´Ñ‹/Ð½Ð¾Ð²Ð¾ÑÑ‚ÐµÐ¹ Ð½ÑƒÐ¶ÐµÐ½ ÑƒÑÐ¿ÐµÑˆÐ½Ñ‹Ð¹ tool-call.\n"
    "2) Web-Ð¾Ñ‚Ð²ÐµÑ‚ Ð·Ð°Ð²Ð¸ÑÐ¸Ñ‚ Ð¾Ñ‚ Ð¸ÑÑ‚Ð¾Ñ‡Ð½Ð¸ÐºÐ°: ÐµÑÐ»Ð¸ `web(op=search)`/`search_web` Ð²ÐµÑ€Ð½ÑƒÐ» Ð¿ÑƒÑÑ‚Ð¾Ð¹ `results[]`, Ð´Ð°ÑŽ ÑÑ‚Ð¾ ÐºÐ°Ðº Ð¾Ð³Ñ€Ð°Ð½Ð¸Ñ‡ÐµÐ½Ð¸Ðµ.\n"
    "3) Ð Ð°Ð±Ð¾Ñ‚Ð°ÑŽ Ñ‚Ð¾Ð»ÑŒÐºÐ¾ Ð² Ñ€Ð°Ð¼ÐºÐ°Ñ… Ñ€Ð°Ð·Ñ€ÐµÑˆÑ‘Ð½Ð½Ñ‹Ñ… MCP tools.\n"
    f"4) Ð¢ÐµÐºÑƒÑ‰Ð¸Ð¹ allowlist: {tools or '(none)'}.\n"
    "5) Ð•ÑÐ»Ð¸ tool Ð½ÐµÐ´Ð¾ÑÑ‚ÑƒÐ¿ÐµÐ½ Ð¸Ð»Ð¸ Ð²ÐµÑ€Ð½ÑƒÐ» Ð¾ÑˆÐ¸Ð±ÐºÑƒ, Ñ ÑÐ¾Ð¾Ð±Ñ‰Ð°ÑŽ Ð¾ÑˆÐ¸Ð±ÐºÑƒ Ð¸ Ð¿Ñ€ÐµÐ´Ð»Ð°Ð³Ð°ÑŽ ÑÐ»ÐµÐ´ÑƒÑŽÑ‰Ð¸Ð¹ ÑˆÐ°Ð³."
  )


def _contains_identity_hallucination(answer: str) -> bool:
  a = (answer or "").lower()
  bad_markers = ["chatgpt-4", "chatgpt 4", "gpt-4", "gpt4", "i am chatgpt", "openai model", "anthropic", "claude"]
  return any(m in a for m in bad_markers)


def _strip_identity_preamble(text: str) -> str:
  lines = str(text or "").splitlines()
  out: List[str] = []
  for ln in lines:
    l = ln.strip().lower()
    if l in {"labbrain", "- role: labbrain", "- orchestrator: autogen"}:
      continue
    if l.startswith("- llm backend:"):
      continue
    out.append(ln)
  return "\n".join(out).strip()


# ---- Tool allowlist / MCP wire ----

def _mcp_allowed_tools() -> List[str]:
  raw = os.getenv(
    "LAB_MCP_TOOL_ALLOWLIST",
    "*",
  )
  return [x.strip() for x in raw.split(",") if x.strip()]


def _extract_requested_tool(task: str, allowed: set[str]) -> Tuple[str | None, Dict[str, Any], Optional[str]]:
  raw = (task or "").strip()
  q = _norm(task)
  explicit_tool_mode = bool(
    re.search(
      r"(используй\s+инструмент|вызови\s+инструмент|запусти\s+инструмент|use\s+tool|run\s+tool|call\s+tool|\btool\s+[a-z0-9_]+|\binstrument\b)",
      q,
    )
  )
  patterns = [
    r"(?:используй|вызови|запусти|use|run|call)\s+(?:инструмент|tool)\s+([a-zA-Z0-9_]+)",
    r"(?:(?:инструмент|tool)\s+)([a-zA-Z0-9_]+)",
  ]
  candidate = None
  for p in patterns:
    m = re.search(p, q)
    if m:
      candidate = (m.group(1) or "").strip()
      break
  if not candidate:
    return None, {}, None
  if not explicit_tool_mode:
    return None, {}, None

  # Normalize common phrases where first capture may become a helper keyword.
  if candidate == "tool":
    m_tool = re.search(r"(?:use|run|call)\s+tool\s+([a-zA-Z0-9_]+)", q)
    if m_tool:
      candidate = (m_tool.group(1) or "").strip()
  if candidate == "call":
    m_call = re.search(r"(?:use|run|call)\s+tool\s+call\s+([a-zA-Z0-9_]+)", q)
    if m_call:
      candidate = (m_call.group(1) or "").strip()

  if candidate not in allowed:
    return candidate, {}, None

  # Optional explicit args in user text: "... args { ... }" / "... Ð°Ñ€Ð³ÑƒÐ¼ÐµÐ½Ñ‚Ñ‹ { ... }"
  m_args = re.search(r"(?:args|аргументы)\s*(\{.*\})", raw, flags=re.IGNORECASE | re.DOTALL)
  if m_args:
    args_str = (m_args.group(1) or "").strip()
    try:
      parsed = json.loads(args_str)
      if not isinstance(parsed, dict):
        return candidate, {}, "args должен быть JSON-объектом."
      return candidate, parsed, None
    except Exception as e:
      return candidate, {}, f"Некорректный JSON args: {e}"

  defaults: Dict[str, Dict[str, Any]] = {
    "whoami": {},
    "sync": {"op": "status"},
    "exec": {
      "cmd": "powershell",
      "args": ["-NoProfile", "-Command", "Get-Date -Format 'dddd, yyyy-MM-dd HH:mm:ss'"],
      "timeout_ms": 10000,
    },
    "worker_metrics_snapshot": {},
    "intelligence_meta_snapshot": {},
    "tasks": {"op": "list", "limit": 20},
    "fs": {"op": "list", "dir": r"C:\Users\anani\Projects", "limit": 50},
    "search_web": {"query": raw, "max_results": 5},
    "web": {"op": "search", "query": raw, "max_results": 5},
    "weather": {"location": "Odesa, Ukraine"},
    "read_url_content": {"url": "https://platform.openai.com/docs", "max_chars": 1500},
  }
  return candidate, defaults.get(candidate, {}), None


def _extract_json_from_sse_payload(text: str) -> Dict[str, Any]:
  # Robust SSE parse: collect data: lines by event blocks and try latest valid JSON.
  candidates: List[str] = []
  current: List[str] = []
  for raw_line in (text or "").splitlines():
    line = raw_line.rstrip("\r")
    if not line.strip():
      if current:
        candidates.append("\n".join(current).strip())
        current = []
      continue
    if line.startswith("data:"):
      current.append(line[len("data:"):].strip())
  if current:
    candidates.append("\n".join(current).strip())

  if not candidates and "data:" in (text or ""):
    parts = (text or "").split("data:")
    candidates.extend([p.strip() for p in parts[1:] if p.strip()])

  for raw in reversed(candidates):
    try:
      return json.loads(raw)
    except Exception:
      continue

  # Fallback: extract JSON object from raw SSE text.
  t = text or ""
  start = t.find("{")
  end = t.rfind("}")
  if start >= 0 and end > start:
    snippet = t[start:end + 1]
    try:
      return json.loads(snippet)
    except Exception:
      pass
  return {}


def _mcp_initialize_session(timeout_sec: int = 15) -> Tuple[bool, str]:
  global _MCP_SESSION_ID
  if _MCP_SESSION_ID:
    return True, _MCP_SESSION_ID
  url = os.getenv("LAB_MCP_URL", "http://127.0.0.1:3000/mcp")
  headers: Dict[str, str] = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  }
  token = os.getenv("LAB_MCP_BEARER", "").strip()
  if token:
    headers["Authorization"] = f"Bearer {token}"
  init_body = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {"name": "labbrain", "version": "1.0.0"},
    },
  }
  try:
    r = requests.post(url, headers=headers, json=init_body, timeout=timeout_sec)
    if r.status_code >= 400:
      return False, f"initialize failed HTTP {r.status_code}: {r.text[:300]}"
    sid = r.headers.get("mcp-session-id", "").strip()
    if not sid:
      return False, "initialize failed: missing mcp-session-id header"
    _MCP_SESSION_ID = sid
    return True, sid
  except Exception as e:
    return False, f"initialize request failed: {e}"


def _mcp_call_tool(tool_name: str, arguments: Dict[str, Any] | None = None, timeout_sec: int = 15) -> Tuple[bool, str]:
  global _MCP_SESSION_ID, _MCP_FAILURE_COUNT, _MCP_CIRCUIT_OPEN_UNTIL
  url = os.getenv("LAB_MCP_URL", "http://127.0.0.1:3000/mcp")
  headers: Dict[str, str] = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  }
  token = os.getenv("LAB_MCP_BEARER", "").strip()
  if token:
    headers["Authorization"] = f"Bearer {token}"

  ok_init, init_msg = _mcp_initialize_session(timeout_sec=timeout_sec)
  if not ok_init:
    return False, init_msg

  headers["mcp-session-id"] = _MCP_SESSION_ID
  body = {
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {"name": tool_name, "arguments": arguments or {}},
  }
  now = time.time()
  if _MCP_CIRCUIT_OPEN_UNTIL > now:
    return False, f"MCP circuit_open until={datetime.fromtimestamp(_MCP_CIRCUIT_OPEN_UNTIL, timezone.utc).isoformat()}"

  backoff = [0.3, 1.0, 2.0]
  last_err = "unknown"
  for attempt, pause_sec in enumerate(backoff, start=1):
    try:
      r = requests.post(url, headers=headers, json=body, timeout=timeout_sec)
      if r.status_code == 400 and "No valid session ID" in (r.text or ""):
        _MCP_SESSION_ID = ""
        ok_init2, init_msg2 = _mcp_initialize_session(timeout_sec=timeout_sec)
        if not ok_init2:
          last_err = init_msg2
          raise RuntimeError(init_msg2)
        headers["mcp-session-id"] = _MCP_SESSION_ID
        r = requests.post(url, headers=headers, json=body, timeout=timeout_sec)

      if r.status_code >= 500:
        last_err = f"MCP HTTP {r.status_code}: {r.text[:300]}"
        raise RuntimeError(last_err)
      if r.status_code >= 400:
        _MCP_FAILURE_COUNT += 1
        return False, f"MCP HTTP {r.status_code}: {r.text[:300]}"

      payload = _extract_json_from_sse_payload(r.text)
      if not payload:
        try:
          payload = r.json()
        except Exception:
          _MCP_FAILURE_COUNT += 1
          return False, f"MCP non-JSON response: {r.text[:300]}"

      if isinstance(payload, dict) and payload.get("error"):
        _MCP_FAILURE_COUNT += 1
        return False, f"MCP error: {payload.get('error')}"

      result = payload.get("result") if isinstance(payload, dict) else payload

      # Treat MCP tool envelope errors as failed calls.
      if isinstance(result, dict):
        if result.get("isError") is True:
          content = result.get("content")
          err_msg = _json_dumps(content, 500) if content is not None else _json_dumps(result, 500)
          _MCP_FAILURE_COUNT += 1
          return False, f"MCP tool error (isError=true): {err_msg}"
        content = result.get("content")
        if isinstance(content, list):
          for item in content:
            if isinstance(item, dict):
              txt = str(item.get("text", ""))
              if "MCP error -32602" in txt or "Tool not found" in txt:
                _MCP_FAILURE_COUNT += 1
                return False, txt

      _MCP_FAILURE_COUNT = 0
      _MCP_CIRCUIT_OPEN_UNTIL = 0.0
      return True, _json_dumps(result)
    except Exception as e:
      last_err = str(e)
      if attempt < len(backoff):
        time.sleep(pause_sec)
        continue

  _MCP_FAILURE_COUNT += 1
  if _MCP_FAILURE_COUNT >= 5:
    _MCP_CIRCUIT_OPEN_UNTIL = time.time() + 60.0
  return False, f"MCP request failed after retries: {last_err}"


def _extract_tool_text(result_json: str) -> str:
  try:
    payload = json.loads(result_json)
    content = payload.get("content")
    if isinstance(content, list) and content:
      first = content[0]
      if isinstance(first, dict) and isinstance(first.get("text"), str):
        return first["text"]
  except Exception:
    pass
  return result_json


def _extract_tool_object(result_json: str) -> Any:
  text = _extract_tool_text(result_json)
  try:
    value: Any = json.loads(text)
    if isinstance(value, str):
      s = value.strip()
      if s.startswith("{") or s.startswith("["):
        try:
          return json.loads(s)
        except Exception:
          return value
    return _sanitize_text_encoding(value)
  except Exception:
    return _sanitize_text_encoding(text)


def _extract_exec_stdout(obj: Any) -> str:
  if isinstance(obj, dict):
    for key in ("stdout", "out", "output", "text"):
      val = obj.get(key)
      if isinstance(val, str) and val.strip():
        return val.strip()
  if isinstance(obj, str):
    return obj.strip()
  return _json_dumps(obj, 1200)


# ---- Response shaping (Stage 4 + 10) ----

def _format_response(kind: str, summary: str, verified: List[str] | None = None, details: List[str] | None = None,
                     actions: List[str] | None = None, warnings: List[str] | None = None) -> str:
  verified = verified or []
  details = details or []
  actions = actions or []
  warnings = warnings or []
  reference_mode = os.getenv("LAB_REFERENCE_MODE", "1").strip().lower() in {"1", "true", "yes", "on"}
  reference_kinds = {
    "operational", "operational_analysis", "system_recovery",
    "web", "weather", "tasks", "metrics", "fs", "sync", "status", "tool_call",
  }

  lines: List[str] = []
  lines.append(f"{summary}")
  if reference_mode and kind in reference_kinds:
    lines.append("Plan:")
    if actions:
      lines.extend([f"- {a}" for a in actions[:3]])
    else:
      lines.append("- Выполнить tool-first проверку и собрать проверяемые факты.")
    lines.append("Act:")
    if verified:
      lines.extend([f"- {v}" for v in verified[:8]])
    else:
      lines.append("- Инструменты не были вызваны.")
    lines.append("Verify:")
    if details:
      lines.extend([f"- {d}" for d in details[:8]])
    else:
      lines.append("- Нет дополнительных деталей проверки.")
    lines.append("Report:")
    lines.append(f"- {summary}")
    if warnings:
      lines.extend([f"- Constraint: {w}" for w in warnings[:5]])
    # Keep legacy sections for existing tooling/parsers.
    if verified:
      lines.append("Verified:")
      lines.extend([f"- {v}" for v in verified[:8]])
    if details:
      lines.append("Details:")
      lines.extend([f"- {d}" for d in details[:8]])
    if actions:
      lines.append("Next steps:")
      lines.extend([f"- {a}" for a in actions[:5]])
    if warnings:
      lines.append("Constraints:")
      lines.extend([f"- {w}" for w in warnings[:5]])
    return "\n".join(lines)

  if verified:
    lines.append("Verified:")
    lines.extend([f"- {v}" for v in verified[:8]])
  if details:
    lines.append("Details:")
    lines.extend([f"- {d}" for d in details[:8]])
  if actions:
    lines.append("Next steps:")
    lines.extend([f"- {a}" for a in actions[:5]])
  if warnings:
    lines.append("Constraints:")
    lines.extend([f"- {w}" for w in warnings[:5]])
  return "\n".join(lines)


def _reference_mode_enabled() -> bool:
  return os.getenv("LAB_REFERENCE_MODE", "1").strip().lower() in {"1", "true", "yes", "on"}


def _reference_kinds() -> set[str]:
  return {
    "operational", "operational_analysis", "system_recovery",
    "web", "weather", "tasks", "metrics", "fs", "sync", "status", "tool_call",
  }


def _reference_sections_present(answer: str) -> bool:
  low = str(answer or "").lower()
  return ("plan:" in low) and ("act:" in low) and ("verify:" in low) and ("report:" in low)


def _enforce_reference_sections(kind: str, answer: str) -> Tuple[str, bool]:
  text = str(answer or "").strip()
  if not text:
    return text, False
  if not _reference_mode_enabled():
    return text, False
  if kind not in _reference_kinds():
    return text, False
  if _reference_sections_present(text):
    return text, False

  verified = _extract_section(text, "Verified:")
  details = _extract_section(text, "Details:")
  actions = _extract_section(text, "Next steps:")
  warnings = _extract_section(text, "Constraints:")
  summary = ""
  for ln in text.splitlines():
    s = ln.strip()
    if not s:
      continue
    if s.endswith(":"):
      continue
    if s.startswith("- "):
      continue
    summary = s
    break
  if not summary:
    summary = "Ответ переведен в reference mode формат."
  return _format_response(kind, summary, verified=verified, details=details, actions=actions, warnings=warnings), True


def _requires_tool_evidence(task: str) -> bool:
  q = _norm(task)
  keys = [
    "сегодня", "завтра", "вчера", "день недели", "который час", "время", "дата",
    "погода", "курс", "новости", "папки", "файлы", "метрики", "интернет",
    "queue depth", "weather", "date", "time", "news", "usd",
  ]
  return any(k in q for k in keys)


def _is_goal_intake(task: str) -> bool:
  q = _norm(task)
  goal_keys = [
    "improve", "optimize", "build", "implement", "refactor", "fix", "stabilize",
    "ÑƒÐ»ÑƒÑ‡ÑˆÐ¸", "ÑƒÐ»ÑƒÑ‡ÑˆÐ¸Ñ‚ÑŒ", "Ð¾Ð¿Ñ‚Ð¸Ð¼Ð¸Ð·Ð¸Ñ€ÑƒÐ¹", "ÑÐ´ÐµÐ»Ð°Ð¹", "Ñ€ÐµÐ°Ð»Ð¸Ð·ÑƒÐ¹", "Ð¸ÑÐ¿Ñ€Ð°Ð²ÑŒ", "Ð´Ð¾Ð±Ð°Ð²ÑŒ",
  ]
  return any(k in q for k in goal_keys)


def _is_code_change_goal(task: str) -> bool:
  q = _norm(task)
  code_keys = [
    "fix bug", "fix test", "implement", "refactor", "change code", "patch",
    "Ð¸ÑÐ¿Ñ€Ð°Ð²ÑŒ", "Ð¿Ð¾Ñ‡Ð¸Ð½Ð¸", "Ñ€ÐµÑ„Ð°ÐºÑ‚Ð¾Ñ€", "Ñ€ÐµÐ°Ð»Ð¸Ð·ÑƒÐ¹", "Ð´Ð¾Ð±Ð°Ð²ÑŒ Ð² ÐºÐ¾Ð´", "Ð¿Ð°Ñ‚Ñ‡",
  ]
  return any(k in q for k in code_keys)


def _is_repo_maintenance_request(task: str) -> bool:
  q = _norm(task)
  has_docs_target = any(
    k in q
    for k in [
      "license",
      "security.md",
      "readme",
      "commercial setup",
      "variant 1",
      "Ð´Ð¾Ð±Ð°Ð²Ð¸Ñ‚ÑŒ license",
      "Ð´Ð¾Ð±Ð°Ð²ÑŒ license",
      "Ð¾Ð±Ð½Ð¾Ð²Ð¸ readme",
      "Ð´Ð¾Ð±Ð°Ð²ÑŒ security.md",
    ]
  )
  has_action = any(
    k in q
    for k in [
      "add",
      "create",
      "update",
      "prepare repository",
      "Ð¿Ð¾Ð´Ð³Ð¾Ñ‚Ð¾Ð²",
      "Ð´Ð¾Ð±Ð°Ð²",
      "Ð¾Ð±Ð½Ð¾Ð²",
      "Ð¿Ñ€Ð¾Ð³Ð¾Ð½",
      "Ð·Ð°Ð¿ÑƒÑÑ‚Ð¸",
    ]
  )
  return has_docs_target and has_action


def _is_pure_logic_request(task: str) -> bool:
  q = _norm(task)
  logic_keys_ru = ["логическ", "задач", "головолом", "докажи", "невозмож"]
  if any(k in q for k in logic_keys_ru):
    return True
  if re.search(r"\b(puzzle|logic|prove|impossible|schedule|slot|meeting|joint)\b", q):
    return True

  has_box_fruit = (
    (("яблок" in q) and ("апельс" in q))
    or (("apple" in q) and ("orange" in q))
    or (("ящик" in q) and ("надпис" in q))
    or (("box" in q) and ("label" in q))
  )
  has_all_labels_wrong = (
    bool(re.search(r"все.*надпис.*невер", q))
    or ("all labels are wrong" in q)
    or ("all labels incorrect" in q)
    or ("all labels wrong" in q)
  )
  if has_box_fruit and has_all_labels_wrong:
    return True

  time_marks = re.findall(r"\b\d{1,2}:\d{2}\b", task)
  has_ab = bool(re.search(r"\bA\b", task, flags=re.IGNORECASE)) and bool(
    re.search(r"\bB\b", task, flags=re.IGNORECASE)
  )
  has_slot_ctx = (
    ("слот" in q)
    or ("slot" in q)
    or ("встреч" in q)
    or ("meeting" in q)
    or ("joint" in q)
    or ("совмест" in q)
  )
  return len(time_marks) >= 4 and has_ab and has_slot_ctx


def _to_minutes(hhmm: str) -> int:
  h, m = hhmm.split(":")
  return int(h) * 60 + int(m)


def _extract_ranges(text: str) -> List[Tuple[str, str]]:
  out: List[Tuple[str, str]] = []
  for m in re.finditer(r"(\d{1,2}:\d{2})\s*(?:-|–|—|â€“)\s*(\d{1,2}:\d{2})", text):
    out.append((m.group(1), m.group(2)))
  return out


def _solve_logic_boxes(task: str) -> Optional[str]:
  q = _norm(task)
  has_box = ("ящик" in q) or ("box" in q)
  has_apple = ("яблок" in q) or ("apple" in q)
  has_orange = ("апельс" in q) or ("orange" in q)
  if not (has_box and has_apple and has_orange):
    return None
  if not (
    bool(re.search(r"все.*надпис.*невер", q))
    or ("all labels are wrong" in q)
    or ("all labels incorrect" in q)
    or ("all labels wrong" in q)
  ):
    return None
  return (
    "Given:\n"
    "- Есть 3 ящика: «Яблоки», «Апельсины», «Яблоки и апельсины».\n"
    "- Все надписи неверны.\n"
    "Check:\n"
    "1) Открываем ящик «Яблоки и апельсины».\n"
    "2) Поскольку надпись неверна, этот ящик НЕ может быть смешанным.\n"
    "3) По одному фрукту из этого ящика определяем: там только яблоки или только апельсины.\n"
    "4) Два остальных ящика раскладываются однозначно по правилу «все надписи неверны».\n"
    "Conclusion:\n"
    "- Первый ход: открыть ящик «Яблоки и апельсины»; он не mixed.\n"
    "- Далее содержимое двух остальных ящиков выводится однозначно."
  )


def _solve_logic_schedule(task: str) -> Optional[str]:
  q = _norm(task)
  has_slot_ctx = (("встреч" in q or "meeting" in q) and ("слот" in q or "slot" in q))
  has_time_dense = len(re.findall(r"\b\d{1,2}:\d{2}\b", task)) >= 6
  has_ab = bool(re.search(r"\bA\b", task, flags=re.IGNORECASE)) and bool(
    re.search(r"\bB\b", task, flags=re.IGNORECASE)
  )
  if not (has_slot_ctx or (has_time_dense and has_ab)):
    return None

  required = None
  m_required = re.search(r"(\d+)\s*(?:совмест|joint|общ|обо)", q)
  if m_required:
    try:
      required = int(m_required.group(1))
    except Exception:
      required = None

  lines = task.splitlines()
  a_ranges: List[Tuple[int, int]] = []
  b_ranges: List[Tuple[int, int]] = []
  slot_ranges: List[Tuple[int, int]] = []

  for ln in lines:
    lq = _norm(ln)
    ranges = _extract_ranges(ln)
    if not ranges:
      continue
    if bool(re.search(r"\bA\b", ln, flags=re.IGNORECASE)) or ("участник a" in lq) or bool(re.search(r"\b(a|participant a)\b", lq)):
      for s, e in ranges:
        a_ranges.append((_to_minutes(s), _to_minutes(e)))
      continue
    if bool(re.search(r"\bB\b", ln, flags=re.IGNORECASE)) or ("участник b" in lq) or bool(re.search(r"\b(b|participant b)\b", lq)):
      for s, e in ranges:
        b_ranges.append((_to_minutes(s), _to_minutes(e)))
      continue
    if ("слот" in lq) or ("slot" in lq):
      for s, e in ranges:
        slot_ranges.append((_to_minutes(s), _to_minutes(e)))

  # Fallback: if explicit slot ranges are missing, parse "slot starts: 09:00, 09:40, ..."
  if not slot_ranges:
    slot_start_line = ""
    for ln in lines:
      lq = _norm(ln)
      if ("старты слотов" in lq) or ("slot starts" in lq):
        slot_start_line = ln
        break
    starts_src = slot_start_line if slot_start_line else task
    starts = [ _to_minutes(t) for t in re.findall(r"\b\d{1,2}:\d{2}\b", starts_src) ]
    if starts:
      dur = 30
      m_dur = re.search(r"по\s*(\d+)\s*мин", q)
      if not m_dur:
        m_dur = re.search(r"(\d+)\s*minute", q)
      if m_dur:
        try:
          dur = int(m_dur.group(1))
        except Exception:
          dur = 30
      slot_ranges = [(s, s + dur) for s in starts]

  # Fallback: infer required joint meetings from line mentioning both A and B.
  if required is None:
    for ln in lines:
      if bool(re.search(r"\bA\b", ln, flags=re.IGNORECASE)) and bool(re.search(r"\bB\b", ln, flags=re.IGNORECASE)):
        m_num = re.search(r"\b(\d+)\b", ln)
        if m_num:
          try:
            required = int(m_num.group(1))
            break
          except Exception:
            pass

  # Fallback: if A/B lines were not labeled, use first 2 ranges as A/B windows and remaining as slots.
  if (not a_ranges or not b_ranges) and len(_extract_ranges(task)) >= 3:
    all_ranges = [(_to_minutes(s), _to_minutes(e)) for s, e in _extract_ranges(task)]
    if not a_ranges:
      a_ranges = [all_ranges[0]]
    if not b_ranges and len(all_ranges) > 1:
      b_ranges = [all_ranges[1]]
    if not slot_ranges and len(all_ranges) > 2:
      slot_ranges = all_ranges[2:]

  if not a_ranges or not b_ranges or not slot_ranges:
    return None

  a_start = min(x[0] for x in a_ranges)
  a_end = max(x[1] for x in a_ranges)
  b_start = min(x[0] for x in b_ranges)
  b_end = max(x[1] for x in b_ranges)
  inter_start = max(a_start, b_start)
  inter_end = min(a_end, b_end)
  joint = [(s, e) for (s, e) in slot_ranges if s >= inter_start and e <= inter_end]

  if required is not None and len(joint) < required:
    def _hhmm(v: int) -> str:
      return f"{v//60:02d}:{v%60:02d}"
    checks = [f"{_hhmm(s)}-{_hhmm(e)} {'[OK]' if (s, e) in joint else '[NO]'}" for s, e in slot_ranges]
    return (
      "Given:\n"
      f"- A доступен: {_hhmm(a_start)}â€“{_hhmm(a_end)}.\n"
      f"- B доступен: {_hhmm(b_start)}â€“{_hhmm(b_end)}.\n"
      f"- Требуется совместных встреч: {required}.\n"
      "Check:\n"
      f"- Пересечение доступности A и B: {_hhmm(inter_start)}â€“{_hhmm(inter_end)}.\n"
      "- Проверка слотов:\n"
      + "\n".join([f"  - {c}" for c in checks]) + "\n"
      f"- Совместно возможных слотов: {len(joint)}.\n"
      "Conclusion:\n"
      f"- Невозможно: требуется {required}, но доступно только {len(joint)} совместных слотов."
    )
  return None


def _logic_verify(task: str, answer: str) -> Tuple[bool, str]:
  q = _norm(task)
  a = _norm(answer)
  # Box puzzle consistency: "all labels wrong" forbids mixed in box labeled mixed.
  if (
    (bool(re.search(r"все.*надпис.*невер", q)) or ("all labels are wrong" in q))
    and ((("яблок" in q) and ("апельс" in q)) or (("apple" in q) and ("orange" in q)))
  ):
    bad = (
      ("яблоки и апельсины" in a and ("содержит оба" in a or "оба фрукта" in a))
      or ("apples and oranges" in a and ("contains both" in a or "both fruits" in a))
    )
    if bad:
      return False, "logic_contradiction: mixed label cannot be true when all labels are wrong"
  return True, "ok"


def _solve_pure_logic(task: str) -> Optional[str]:
  ans = _solve_logic_boxes(task)
  if ans:
    return ans
  ans = _solve_logic_schedule(task)
  if ans:
    return ans
  return None


def _is_basic_fact_request(task: str) -> bool:
  q = _norm(task)
  if re.search(r"^\s*\d+\s*[\+\-\*/]\s*\d+\s*$", q):
    return True
  ru_week = bool(re.search(r"сколько\s+дн\w*\s+в\s+недел\w*", q))
  ru_hour = bool(re.search(r"сколько\s+минут\w*\s+в\s+(?:одн\w+\s+)?час\w*", q))
  ru_month = bool(re.search(r"сколько\s+месяц\w*\s+(?:в\s+)?год\w*", q))
  en_week = ("days in week" in q)
  en_hour = ("minutes in hour" in q)
  en_month = ("months in year" in q)
  return ru_week or ru_hour or ru_month or en_week or en_hour or en_month


def _solve_basic_fact(task: str) -> Optional[str]:
  q = _norm(task)

  if re.search(r"^\s*(\d+)\s*\+\s*(\d+)\s*$", q):
    m = re.search(r"^\s*(\d+)\s*\+\s*(\d+)\s*$", q)
    if m:
      return str(int(m.group(1)) + int(m.group(2)))
  if re.search(r"^\s*(\d+)\s*-\s*(\d+)\s*$", q):
    m = re.search(r"^\s*(\d+)\s*-\s*(\d+)\s*$", q)
    if m:
      return str(int(m.group(1)) - int(m.group(2)))
  if re.search(r"^\s*(\d+)\s*\*\s*(\d+)\s*$", q):
    m = re.search(r"^\s*(\d+)\s*\*\s*(\d+)\s*$", q)
    if m:
      return str(int(m.group(1)) * int(m.group(2)))

  if bool(re.search(r"сколько\s+дн\w*\s+в\s+недел\w*", q)) or ("days in week" in q):
    return "7"
  if bool(re.search(r"сколько\s+минут\w*\s+в\s+(?:одн\w+\s+)?час\w*", q)) or ("minutes in hour" in q):
    return "60"
  if bool(re.search(r"сколько\s+месяц\w*\s+(?:в\s+)?год\w*", q)) or ("months in year" in q):
    return "12"
  return None


def _ru_weekday_name(idx: int) -> str:
  names = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"]
  return names[idx % 7]


def _solve_datetime_fact(task: str) -> Optional[str]:
  q = _norm(task)
  now = datetime.now()
  if ("завтра" in q) and ("день недел" in q):
    d = now + timedelta(days=1)
    return f"Завтра: {_ru_weekday_name(d.weekday())} ({d.strftime('%Y-%m-%d')})."
  if ("послезавтра" in q) and ("день недел" in q):
    d = now + timedelta(days=2)
    return f"Послезавтра: {_ru_weekday_name(d.weekday())} ({d.strftime('%Y-%m-%d')})."
  if ("вчера" in q) and ("день недел" in q):
    d = now - timedelta(days=1)
    return f"Вчера был: {_ru_weekday_name(d.weekday())} ({d.strftime('%Y-%m-%d')})."
  if re.search(r"сколько\s+дн\w*.*следующ\w*\s+месяц", q) or ("days in next month" in q):
    y = now.year
    m = now.month + 1
    if m == 13:
      y += 1
      m = 1
    days = calendar.monthrange(y, m)[1]
    return f"В следующем месяце ({y}-{m:02d}) дней: {days}."
  return None


def _is_operational_request(task: str) -> bool:
  q = _norm(task)
  has_workspace_context = bool(
    re.search(
      r"(в моем проекте|в моём проекте|в репозитории|в репо|в этой папке|в логах|у меня|in repo|in project|workspace|project|repo)",
      q,
    )
  )
  has_file_like_target = bool(
    re.search(
      r"(\.ps1|\.py|\.md|\.json|\.ya?ml|\.ts|\.js|\.txt|readme|license|security\.md|config|конфиг|лог|script|скрипт|файл|папк|директори|path)",
      q,
    )
  )
  has_operational_verb = bool(
    re.search(r"\b(проверь|проверить|проанализируй|посмотри|открой|прочитай|find|check|inspect|read|list)\b", q)
  )
  return has_workspace_context or (has_operational_verb and has_file_like_target)


def _extract_candidate_path(task: str) -> str:
  s = str(task or "")
  m = re.search(r"([A-Za-z]:[\\/][^\s\"']+)", s)
  if m:
    return m.group(1).rstrip(".,;:!?)(").replace("/", "\\")
  m = re.search(r"([A-Za-z]:[\\/](?:[^\"'\r\n])+)", s)
  if m:
    return m.group(1).strip().rstrip(".,;:!?)(").replace("/", "\\")
  m = re.search(r"((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.(?:ps1|py|md|json|yaml|yml|ts|js|txt))", s)
  if m:
    return m.group(1).replace("/", "\\")
  m = re.search(r"\b([A-Za-z0-9_.-]+\.(?:ps1|py|md|json|yaml|yml|ts|js|txt))\b", s)
  if m:
    return m.group(1)
  return ""


def _expand_candidate_paths(path_hint: str) -> List[str]:
  p = str(path_hint or "").strip().replace("/", "\\")
  if not p:
    return []
  variants: List[str] = [p]
  if ("\\" not in p) and ("/" not in p):
    variants.extend(
      [
        f"ops\\autogen_engine\\{p}",
        f"ops\\windsurf_hooks\\{p}",
        f"ops\\autogen_engine\\qwen_pipeline\\{p}",
        f"ops\\autogen_engine\\train\\{p}",
      ]
    )
  # Deduplicate while preserving order.
  uniq: List[str] = []
  for v in variants:
    if v not in uniq:
      uniq.append(v)
  return uniq


def _extract_external_analysis_params(task: str) -> Dict[str, str]:
  s = str(task or "")
  q = _norm(s)
  out: Dict[str, str] = {
    "base_url": "",
    "container_name": "",
    "app_path": "",
    "compose_file": "",
    "service": "",
    "image_ref": "",
  }

  m_url = re.search(r"(https?://[^\s\"'<>]+)", s, re.IGNORECASE)
  if m_url:
    out["base_url"] = m_url.group(1).rstrip(".,;:!?)(")

  m_container = re.search(r"(?:container|контейнер)\s*[:=]?\s*([A-Za-z0-9_.-]+)", s, re.IGNORECASE)
  if m_container:
    out["container_name"] = m_container.group(1).strip()

  m_service = re.search(r"(?:service|сервис)\s*[:=]?\s*([A-Za-z0-9_.-]+)", s, re.IGNORECASE)
  if m_service:
    out["service"] = m_service.group(1).strip()

  m_image = re.search(r"(?:image|образ)\s*[:=]?\s*([A-Za-z0-9_./:-]+)", s, re.IGNORECASE)
  if m_image:
    out["image_ref"] = m_image.group(1).strip()

  m_app = re.search(r"(?:app|path|repo|project|путь|репо|проект)\s*[:=]?\s*([A-Za-z]:[\\/][^\s\"']+)", s, re.IGNORECASE)
  if m_app:
    out["app_path"] = m_app.group(1).rstrip(".,;:!?)(").replace("/", "\\")

  m_compose = re.search(
    r"([A-Za-z]:[\\/][^\s\"']*docker-compose[^\s\"']*\.ya?ml|[A-Za-z]:[\\/][^\s\"']*compose[^\s\"']*\.ya?ml)",
    s,
    re.IGNORECASE,
  )
  if m_compose:
    out["compose_file"] = m_compose.group(1).rstrip(".,;:!?)(").replace("/", "\\")

  p_hint = _extract_candidate_path(s)
  if p_hint and not out["app_path"]:
    p_low = p_hint.lower()
    if p_low.endswith((".yml", ".yaml")) and ("compose" in p_low):
      out["compose_file"] = p_hint
    elif (not p_low.endswith((".ps1", ".py", ".md", ".json", ".yaml", ".yml", ".ts", ".js", ".txt"))) and Path(p_hint).exists():
      out["app_path"] = p_hint

  if ("репо" in q or "проект" in q or "repo" in q or "project" in q) and not out["app_path"]:
    out["app_path"] = ""

  return out


def _needs_verification_general(task: str, answer: str) -> bool:
  q = _norm(task)
  a = _norm(answer)
  unstable = bool(
    re.search(
      r"(сейчас|сегодня|завтра|вчера|текущ|версия|в проекте|в репо|установлен|включен|найден|работает|current|today|tomorrow|version|in repo|installed|enabled)",
      q,
    )
  )
  overclaim = bool(
    re.search(
      r"(у вас .* (включено|установлено|настроено)|я проверил|точно|гарантирую|100%)",
      a,
    )
  )
  return unstable or overclaim


def _is_action_request(task: str) -> bool:
  q = _norm(task)
  return bool(re.search(r"\b(сделай|выполни|запусти|проанализируй|собери|определи|identify|analy[sz]e|run|execute)\b", q))


def _is_science_general_question(task: str) -> bool:
  q = _norm(task)
  if (" почему " in f" {q} ") or (" зачем " in f" {q} ") or q.startswith("как устро"):
    return True
  return bool(re.search(r"\b(why|how)\b", q)) and bool(
    re.search(r"(sky|rain|water|sun|earth|plant|дерев|неб|дожд|солнц|фотосинт|гравитац)", q)
  )


def _general_next_best_action(task: str) -> str:
  q = _norm(task)
  if re.search(r"(файл|папк|конфиг|repo|project|path|директори)", q):
    return "Выполнить tool-first проверку через fs(op=list/read_content) для нужного пути."
  if re.search(r"(версия|installed|установлен|pip|package)", q):
    return "Проверить версию через exec (например `pip show ...`) или lock/config файлы."
  if re.search(r"(сегодня|завтра|дата|время|погода|курс|news|weather|rate)", q):
    return "Проверить живые данные через tool-route (exec/web/weather)."
  return "Уточнить цель проверки и запустить соответствующий MCP tool."


def _build_operational_analysis_answer(
  call_tool_once: Callable[[str, Dict[str, Any]], Tuple[bool, str]],
  allowed: set[str],
) -> str:
  verified: List[str] = []
  details: List[str] = []
  actions: List[str] = []
  problems: List[str] = []
  reasons: List[str] = []
  priorities: List[str] = []
  native_details: List[str] = []

  workers_obj: Dict[str, Any] = {}
  meta_obj: Dict[str, Any] = {}
  jobs_obj: Dict[str, Any] = {}

  if "worker_metrics_snapshot" in allowed:
    ok_w, msg_w = call_tool_once("worker_metrics_snapshot", {})
    if ok_w:
      verified.append("MCP tool: worker_metrics_snapshot")
      w = _extract_tool_object(msg_w)
      if isinstance(w, dict):
        workers_obj = w
    else:
      details.append(f"worker_metrics_error={msg_w}")
  if "intelligence_meta_snapshot" in allowed:
    ok_m, msg_m = call_tool_once("intelligence_meta_snapshot", {})
    if ok_m:
      verified.append("MCP tool: intelligence_meta_snapshot")
      m = _extract_tool_object(msg_m)
      if isinstance(m, dict):
        meta_obj = m.get("snapshot", {}) if isinstance(m.get("snapshot"), dict) else {}
    else:
      details.append(f"meta_snapshot_error={msg_m}")
  if "job_history_list" in allowed:
    ok_j, msg_j = call_tool_once("job_history_list", {"limit": 30})
    if ok_j:
      verified.append("MCP tool: job_history_list")
      j = _extract_tool_object(msg_j)
      if isinstance(j, dict):
        jobs_obj = j
    else:
      details.append(f"job_history_error={msg_j}")

  workers = workers_obj.get("workers", []) if isinstance(workers_obj.get("workers"), list) else []
  jobs_items = jobs_obj.get("items", []) if isinstance(jobs_obj.get("items"), list) else []
  err_jobs = [x for x in jobs_items if isinstance(x, dict) and str(x.get("status")) == "error"]
  done_custom_jobs = [
    x for x in jobs_items
    if isinstance(x, dict)
    and str(x.get("status")) == "done"
    and str(x.get("type")) == "custom"
  ]
  stuck = [
    w for w in workers
    if isinstance(w, dict)
    and isinstance(w.get("stuck_job_detection"), dict)
    and bool(w.get("stuck_job_detection", {}).get("is_stuck"))
  ]

  entropy = meta_obj.get("arena_entropy")
  variance_trend = meta_obj.get("transfer_variance_trend")
  gihi_delta_ultra = meta_obj.get("gihi_delta_ultra")
  meta_state = str(meta_obj.get("meta_state", "unknown"))
  controller_meta_effective = ""
  controller_mode = ""
  try:
    ctrl_path = Path(__file__).resolve().parents[2] / "_sync" / "autogen_learning" / "controller_tick_latest.json"
    if ctrl_path.exists():
      ctrl_obj = json.loads(ctrl_path.read_text(encoding="utf-8", errors="replace"))
      if isinstance(ctrl_obj, dict):
        sig = ctrl_obj.get("signals", {})
        if isinstance(sig, dict):
          controller_meta_effective = str(sig.get("meta_state_effective", "") or "")
          controller_mode = str(sig.get("controller_mode", "") or "")
  except Exception:
    pass

  entropy_high = isinstance(entropy, (int, float)) and entropy > 0.90
  variance_bad = isinstance(variance_trend, (int, float)) and variance_trend > 0.0
  gihi_bad = isinstance(gihi_delta_ultra, (int, float)) and gihi_delta_ultra < 0.0

  if meta_state == "stressed":
    problems.append("Meta-state в stressed.")
    reasons.append("Meta snapshot сигнализирует нестабильный режим.")
    priorities.append("MEDIUM: meta-state=stressed")
  if entropy_high:
    reasons.append(f"Энтропия выше порога: {entropy} > 0.90.")
  if variance_bad:
    reasons.append(f"Transfer variance trend положительный: {variance_trend} > 0.")
  if gihi_bad:
    reasons.append(f"GIHI delta ultra отрицательный: {gihi_delta_ultra} < 0.")

  def _parse_iso_dt(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
      return None
    s = value.strip()
    if s.endswith("Z"):
      s = s[:-1] + "+00:00"
    try:
      return datetime.fromisoformat(s)
    except Exception:
      return None

  latest_custom_done_ts: Optional[datetime] = None
  for j in done_custom_jobs:
    ts = _parse_iso_dt(j.get("created_at"))
    if ts is None:
      continue
    if latest_custom_done_ts is None or ts > latest_custom_done_ts:
      latest_custom_done_ts = ts

  legacy_custom_errors: List[Dict[str, Any]] = []
  err_jobs_effective: List[Dict[str, Any]] = []
  err_causes_by_id: Dict[str, str] = {}

  for x in err_jobs:
    jid = str(x.get("job_id", "") or "")
    ref = str(x.get("result_ref", "") or "")
    cause = ""
    try:
      rel = ref.replace("/", "\\").strip().lstrip("\\")
      sync_root = Path(__file__).resolve().parents[2] / "_sync"
      if rel.lower().startswith("_sync\\"):
        rel = rel[6:]
      if rel.lower().startswith("queue\\"):
        p = sync_root / rel
        if p.exists():
          raw = p.read_text(encoding="utf-8", errors="replace")
          obj = json.loads(raw)
          if isinstance(obj, dict):
            cause = str(obj.get("error") or obj.get("message") or obj.get("stderr") or "").strip()
    except Exception:
      cause = ""
    if not cause:
      cause = "cause_not_resolved"
    if jid:
      err_causes_by_id[jid] = cause

    is_legacy_custom = False
    if (
      str(x.get("type")) == "custom"
      and "unknown job.type: custom" in cause.lower()
      and latest_custom_done_ts is not None
    ):
      err_ts = _parse_iso_dt(x.get("created_at"))
      if err_ts is not None and err_ts <= latest_custom_done_ts:
        is_legacy_custom = True

    if is_legacy_custom:
      legacy_custom_errors.append(x)
    else:
      err_jobs_effective.append(x)

  if err_jobs_effective:
    problems.append(f"Есть job-ошибки: {len(err_jobs_effective)} в последних записях.")
    reasons.append("Ошибки исполнения очереди/воркера.")
    priorities.append(f"HIGH: error_jobs={len(err_jobs_effective)}")
  elif legacy_custom_errors:
    reasons.append("Обнаружены только исторические custom-ошибки (legacy), новые custom job уже выполняются.")
  if stuck:
    problems.append(f"Обнаружены stuck workers: {len(stuck)}.")
    reasons.append("Нет прогресса по stuck_job_detection.")
    priorities.append(f"HIGH: stuck_workers={len(stuck)}")

  effective_stressed = (not controller_meta_effective) or (controller_meta_effective == "stressed")
  if err_jobs_effective or stuck:
    system_health = "degraded"
  elif meta_state == "stressed" and effective_stressed:
    system_health = "degraded"
  elif meta_state == "stressed" and controller_meta_effective == "ok_operational":
    system_health = "ok_operational"
  else:
    system_health = "ok"
  details.append(f"system_health={system_health}")
  details.append(f"jobs_seen={len(jobs_items)}; error_jobs={len(err_jobs)}; error_jobs_effective={len(err_jobs_effective)}")
  if legacy_custom_errors:
    details.append(f"legacy_custom_errors_ignored={len(legacy_custom_errors)}")
  details.append(
    f"meta_state={meta_state}; entropy={entropy}; variance_trend={variance_trend}; gihi_delta_ultra={gihi_delta_ultra}"
  )
  if controller_meta_effective:
    details.append(f"controller_meta_state_effective={controller_meta_effective}; controller_mode={controller_mode or 'unknown'}")
  if priorities:
    details.append("severity=" + "; ".join(priorities))

  if err_jobs_effective:
    top = err_jobs_effective[:3]
    compact_top = [
      {
        "job_id": x.get("job_id"),
        "type": x.get("type"),
        "status": x.get("status"),
        "result_ref": x.get("result_ref"),
      }
      for x in top
    ]
    details.append("top_error_jobs=" + _json_dumps(compact_top, 380))
    cause_lines: List[str] = []
    for x in top:
      jid = str(x.get("job_id", "")) or "unknown_job"
      cause = err_causes_by_id.get(jid, "cause_not_resolved")
      cause_lines.append(f"{jid}: {cause}")
    details.append("error_causes=" + "; ".join(cause_lines))

  if system_health == "degraded":
    if err_jobs_effective:
      actions.append("Приоритет 1: разобрать top_error_jobs и исправить корневые ошибки маршрута очереди.")
      actions.append("Приоритет 2: включить recovery playbook (meta throttle + governance_tuner_tick).")
      actions.append("Приоритет 3: после фикса ошибок повторить analysis и подтвердить system_health=ok.")
    elif meta_state == "stressed" and effective_stressed:
      actions.append("Приоритет 1: выполнить system_recovery (controller + analyzer + meta_stability) и сравнить тренд.")
      actions.append("Приоритет 2: снизить частоту тяжелых meta snapshot и оставить async-only для долгих задач.")
      actions.append("Приоритет 3: повторить analysis после 20-30 тиков и проверить снижение entropy/GIHI-негатива.")
    elif meta_state == "stressed" and controller_meta_effective == "ok_operational":
      actions.append("Режим ok_operational активен: держите контроллер в operational-профиле и мониторьте raw meta-сигналы.")
      actions.append("Следующий шаг: снизить transfer_variance_trend и вывести raw meta_state из stressed без потери качества.")
    else:
      actions.append("Приоритет 1: перепроверить degraded-сигнал и выполнить точечный health-check по worker/job route.")
  else:
    actions.append("Система в стабильном состоянии: поддерживать weekly KPI-мониторинг.")

  if not problems:
    problems.append("Критичных проблем по текущему snapshot не выявлено.")
  if not reasons:
    reasons.append("Явных деградационных сигналов не обнаружено.")

  native_checks_failed = 0
  external_checks_failed = 0

  # Native gate checks: MCP preflight + native prompt eval + native secret scan.
  if "exec" in allowed:
    def _extract_status_and_checks(raw_text: str) -> Tuple[str, Dict[str, Any]]:
      txt = str(raw_text or "").strip()
      status = "unknown"
      checks: Dict[str, Any] = {}
      if not txt:
        return status, checks
      try:
        obj = json.loads(txt)
      except Exception:
        start = txt.find("{")
        end = txt.rfind("}")
        if start >= 0 and end > start:
          try:
            obj = json.loads(txt[start:end + 1])
          except Exception:
            obj = {}
        else:
          obj = {}
      if isinstance(obj, dict):
        status = str(obj.get("status", "unknown"))
        c = obj.get("checks", {})
        if isinstance(c, dict):
          checks = c
      return status, checks

    ok_ins, out_ins = _run_exec_ps_script(
      call_tool_once,
      "ops/autogen_engine/autogen_mcp_inspector_preflight.ps1",
      timeout_ms=90000,
      extra_args=["-JsonOnly"],
    )
    if ok_ins:
      st, chk = _extract_status_and_checks(out_ins)
      verified.append("Native check: autogen_mcp_inspector_preflight.ps1")
      native_details.append("native_mcp_preflight_status=" + st)
      if chk:
        native_details.append("native_mcp_preflight_checks=" + _json_dumps(chk, 280))
      if st != "pass":
        native_checks_failed += 1
        problems.append("Native MCP preflight не прошёл.")
        reasons.append("initialize/whoami/sync preflight вернул не-pass.")
    else:
      native_checks_failed += 1
      native_details.append(f"native_mcp_preflight_error={out_ins}")
      problems.append("Не удалось выполнить native MCP preflight.")
      reasons.append("exec route для preflight завершился ошибкой.")

    ok_eval, out_eval = _run_exec_ps_script(
      call_tool_once,
      "ops/autogen_engine/autogen_promptfoo_eval.ps1",
      timeout_ms=180000,
      extra_args=["-JsonOnly"],
    )
    if ok_eval:
      st, chk = _extract_status_and_checks(out_eval)
      verified.append("Native check: autogen_promptfoo_eval.ps1")
      native_details.append("native_prompt_eval_status=" + st)
      if chk:
        native_details.append("native_prompt_eval_checks=" + _json_dumps(chk, 280))
      if st != "pass":
        native_checks_failed += 1
        problems.append("Native prompt eval не прошёл.")
        reasons.append("Проверочные сценарии поведения/контракта вернули не-pass.")
    else:
      native_checks_failed += 1
      native_details.append(f"native_prompt_eval_error={out_eval}")
      problems.append("Не удалось выполнить native prompt eval.")
      reasons.append("exec route для prompt eval завершился ошибкой.")

    secret_scan_timeout_ms = _env_int("LAB_NATIVE_SECRET_SCAN_TIMEOUT_MS", 300000)
    if secret_scan_timeout_ms < 60000:
      secret_scan_timeout_ms = 60000
    ok_sec, out_sec = _run_exec_ps_script(
      call_tool_once,
      "ops/autogen_engine/autogen_trufflehog_scan.ps1",
      timeout_ms=secret_scan_timeout_ms,
      extra_args=["-JsonOnly"],
    )
    if ok_sec:
      st, chk = _extract_status_and_checks(out_sec)
      verified.append("Native check: autogen_trufflehog_scan.ps1")
      native_details.append("native_secret_scan_status=" + st)
      if chk:
        native_details.append("native_secret_scan_checks=" + _json_dumps(chk, 280))
      if st != "pass":
        native_checks_failed += 1
        problems.append("Native secret scan обнаружил риски.")
        reasons.append("Найдены потенциальные секреты/токены в рабочем контуре.")
    else:
      native_checks_failed += 1
      native_details.append(f"native_secret_scan_error={out_sec}")
      problems.append("Не удалось выполнить native secret scan.")
      reasons.append("exec route для secret scan завершился ошибкой.")

    # Mandatory external checks in system analysis: hook probe + security mode.
    repo_root = str(Path(__file__).resolve().parents[2])
    base_url = str(os.getenv("MCP_BASE_URL", "http://127.0.0.1:3000/mcp") or "").strip()
    if base_url.endswith("/mcp"):
      base_url = base_url[:-4].rstrip("/")
    if not base_url:
      base_url = "http://127.0.0.1:3000"

    ok_hook, out_hook = _run_exec_ps_script(
      call_tool_once,
      "ops/autogen_engine/autogen_external_hook_probe.ps1",
      timeout_ms=120000,
      extra_args=["-BaseUrl", base_url, "-AppPath", repo_root, "-JsonOnly"],
    )
    if ok_hook:
      verified.append("Native check: autogen_external_hook_probe.ps1")
      try:
        hook_obj = json.loads(str(out_hook).strip())
      except Exception:
        hook_obj = {}
      if isinstance(hook_obj, dict):
        st = str(hook_obj.get("status", "unknown"))
        sm = hook_obj.get("summary", {})
        cov = sm.get("hook_coverage_percent") if isinstance(sm, dict) else None
        native_details.append(f"native_hook_probe_status={st}")
        if cov is not None:
          native_details.append(f"native_hook_probe_coverage={cov}")
        if st in {"unknown", "error"}:
          external_checks_failed += 1
          problems.append("Hook detection не дал валидный статус.")
          reasons.append("autogen_external_hook_probe вернул неизвестный статус.")
      else:
        external_checks_failed += 1
        native_details.append("native_hook_probe_status=parse_error")
        problems.append("Hook detection вернул не-JSON результат.")
        reasons.append("autogen_external_hook_probe output parse error.")
    else:
      external_checks_failed += 1
      native_details.append(f"native_hook_probe_error={out_hook}")
      problems.append("Не удалось выполнить mandatory hook detection.")
      reasons.append("exec route для autogen_external_hook_probe завершился ошибкой.")

    ok_es, out_es = _run_exec_ps_script(
      call_tool_once,
      "ops/autogen_engine/autogen_external_security_mode.ps1",
      timeout_ms=240000,
      extra_args=["-BaseUrl", base_url, "-AppPath", repo_root, "-JsonOnly"],
    )
    if ok_es:
      verified.append("Native check: autogen_external_security_mode.ps1")
      try:
        sec_obj = json.loads(str(out_es).strip())
      except Exception:
        sec_obj = {}
      if isinstance(sec_obj, dict):
        sm = sec_obj.get("summary", {})
        st = str(sm.get("status", sec_obj.get("status", "unknown"))) if isinstance(sm, dict) else str(sec_obj.get("status", "unknown"))
        findings = int(sm.get("findings", 0)) if isinstance(sm, dict) and str(sm.get("findings", "")).isdigit() else (sm.get("findings", 0) if isinstance(sm, dict) else 0)
        native_details.append(f"native_external_security_status={st}")
        native_details.append(f"native_external_security_findings={findings}")
        if st == "fail":
          external_checks_failed += 1
          problems.append("Mandatory external security mode завершился fail.")
          reasons.append("autogen_external_security_mode обнаружил критические риски.")
        elif st == "warn":
          reasons.append("External security mode вернул предупреждения; требуется ремедиация findings.")
      else:
        external_checks_failed += 1
        native_details.append("native_external_security_status=parse_error")
        problems.append("External security mode вернул не-JSON результат.")
        reasons.append("autogen_external_security_mode output parse error.")
    else:
      external_checks_failed += 1
      native_details.append(f"native_external_security_error={out_es}")
      problems.append("Не удалось выполнить mandatory external security mode.")
      reasons.append("exec route для autogen_external_security_mode завершился ошибкой.")
  else:
    native_checks_failed += 1
    external_checks_failed += 2
    details.append("native_checks_skipped=exec_not_allowed")
    details.append("external_checks_skipped=exec_not_allowed")
    actions.append("Добавить exec в allowlist для полного native и external анализа (preflight/prompt-eval/secret-scan/hook/security).")

  # Effective health synthesis (final output should follow these values).
  operational_health_effective = "degraded" if (err_jobs_effective or stuck or native_checks_failed > 0 or external_checks_failed > 0) else "ok"
  if meta_state == "stressed" and effective_stressed:
    meta_health_effective = "degraded"
  elif meta_state == "stressed" or entropy_high or variance_bad or gihi_bad:
    meta_health_effective = "watch"
  else:
    meta_health_effective = "ok"

  if operational_health_effective == "degraded":
    system_health_effective = "degraded"
  elif meta_health_effective == "degraded":
    system_health_effective = "degraded"
  elif meta_health_effective == "watch":
    system_health_effective = "ok_operational"
  else:
    system_health_effective = "ok"

  details.append(f"system_health_effective={system_health_effective}")
  details.append(f"operational_health={operational_health_effective}")
  details.append(f"meta_health={meta_health_effective}")
  if native_checks_failed > 0:
    details.append(f"native_checks_failed={native_checks_failed}")
  if external_checks_failed > 0:
    details.append(f"external_checks_failed={external_checks_failed}")

  actions_effective: List[str] = []
  if system_health_effective == "degraded":
    if err_jobs_effective:
      actions_effective.append("Приоритет 1: разобрать top_error_jobs и исправить корневые ошибки маршрута очереди.")
      actions_effective.append("Приоритет 2: включить recovery playbook (meta throttle + governance_tuner_tick).")
      actions_effective.append("Приоритет 3: после фикса ошибок повторить analysis и подтвердить system_health=ok.")
    elif operational_health_effective == "degraded" and (native_checks_failed > 0 or external_checks_failed > 0):
      actions_effective.append("Приоритет 1: восстановить native/external checks (preflight/prompt-eval/secret-scan/hook/security).")
      actions_effective.append("Приоритет 2: проверить exec route/policy и таймауты диагностических скриптов.")
      actions_effective.append("Приоритет 3: после этого повторить analysis и подтвердить operational_health=ok.")
    else:
      actions_effective.append("Приоритет 1: выполнить system_recovery (controller + analyzer + meta_stability) и сравнить тренд.")
      actions_effective.append("Приоритет 2: снизить частоту тяжелых meta snapshot и оставить async-only для долгих задач.")
      actions_effective.append("Приоритет 3: повторить analysis после 20-30 тиков и проверить снижение entropy/GIHI-негатива.")
  elif system_health_effective == "ok_operational":
    actions_effective.append("Операционная часть стабильна, meta-контур под наблюдением (watch).")
    actions_effective.append("Следующий шаг: снизить transfer_variance_trend и вывести raw meta_state из stressed.")
    actions_effective.append("Повторить analysis через 20-30 тиков; weekly KPI оставить как фоновый мониторинг.")
  else:
    actions_effective.append("Система стабильна: поддерживать weekly KPI-мониторинг.")

  return _format_response(
    "operational_analysis",
    "Анализ текущего состояния выполнен инструментально.",
    verified=verified,
    details=(["Проблемы: " + "; ".join(problems), "Причины: " + "; ".join(reasons)] + native_details + details)[:16],
    actions=actions_effective[:5],
  )


def _run_exec_ps_script(
  call_tool_once: Callable[[str, Dict[str, Any]], Tuple[bool, str]],
  script_rel_path: str,
  timeout_ms: int = 120000,
  extra_args: Optional[List[str]] = None,
) -> Tuple[bool, str]:
  args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    str(Path(__file__).resolve().parents[2] / script_rel_path),
  ]
  if extra_args:
    args.extend(extra_args)
  ok, msg = call_tool_once("exec", {
    "cmd": "powershell",
    "args": args,
    "timeout_ms": int(timeout_ms),
  })
  if not ok:
    return False, str(msg)
  obj = _extract_tool_object(msg)
  out = _extract_exec_stdout(obj)
  return True, out


def _commercial_setup_variant1_section() -> str:
  return (
    "## Commercial Setup (Variant 1)\n\n"
    "1. Generate an access token and store it securely.\n"
    "2. Set `AUTH_ENABLED=true` in your environment.\n"
    "3. Set `MCP_ALLOWED_ROOTS` to the client's repository path.\n"
    "4. Set `MCP_ALLOWED_ORIGINS` to the client domain(s) and localhost.\n"
    "5. Run `ops\\autogen_engine\\security_token_hygiene.ps1` before production rollout.\n"
  )


def _mit_license_text() -> str:
  return (
    "MIT License\n\n"
    "Copyright (c) 2026\n\n"
    "Permission is hereby granted, free of charge, to any person obtaining a copy\n"
    "of this software and associated documentation files (the \"Software\"), to deal\n"
    "in the Software without restriction, including without limitation the rights\n"
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n"
    "copies of the Software, and to permit persons to whom the Software is\n"
    "furnished to do so, subject to the following conditions:\n\n"
    "The above copyright notice and this permission notice shall be included in all\n"
    "copies or substantial portions of the Software.\n\n"
    "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n"
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n"
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n"
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n"
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n"
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\n"
    "SOFTWARE.\n"
  )


def _security_md_text() -> str:
  return (
    "# Security Policy\n\n"
    "## Reporting a Vulnerability\n\n"
    "If you discover a security issue, do not disclose it publicly.\n"
    "Create a private report to the repository maintainers with reproduction steps,\n"
    "affected components, and impact estimate.\n\n"
    "## Secrets and Tokens\n\n"
    "- Do not hardcode tokens, API keys, or secrets in source files.\n"
    "- Use environment variables or secret managers.\n"
    "- Revoke leaked tokens immediately.\n\n"
    "## Required Hygiene Check\n\n"
    "Run token hygiene checks before release:\n\n"
    "```powershell\n"
    "powershell -NoProfile -ExecutionPolicy Bypass -File ops\\autogen_engine\\security_token_hygiene.ps1\n"
    "```\n"
  )


def _upsert_readme_section(readme_text: str, heading: str, section_body: str) -> str:
  src = readme_text or ""
  pattern = re.compile(
    rf"(?ms)^##\s+{re.escape(heading)}\s*\n.*?(?=^##\s+|\Z)"
  )
  replacement = section_body.strip() + "\n\n"
  if pattern.search(src):
    return pattern.sub(lambda _m: replacement, src).rstrip() + "\n"
  base = src.rstrip()
  if base:
    return base + "\n\n" + replacement
  return replacement


def _goal_keywords(task: str, limit: int = 8) -> List[str]:
  text = re.sub(r"[^a-zA-Z0-9Ð°-ÑÐ-Ð¯_\\-\\s]", " ", task or "")
  words = [w.lower() for w in text.split() if len(w) >= 4]
  # preserve order, remove duplicates
  seen: set[str] = set()
  out: List[str] = []
  for w in words:
    if w in seen:
      continue
    seen.add(w)
    out.append(w)
    if len(out) >= limit:
      break
  return out


def _build_goal_context_snapshot(call_tool_once, allowed: set[str], task: str) -> Dict[str, Any]:
  snap: Dict[str, Any] = {
    "project_id": _project_id(),
    "keywords": _goal_keywords(task),
    "context_present": False,
    "memory_hits": 0,
    "meta_state": "",
  }
  pid = snap["project_id"]
  if "project_context_get" in allowed:
    ok_ctx, msg_ctx = call_tool_once("project_context_get", {"project_id": pid})
    if ok_ctx:
      obj = _extract_tool_object(msg_ctx)
      if isinstance(obj, dict):
        snap["context_present"] = True
        snap["context"] = obj
  if "memory_query" in allowed:
    ok_mem, msg_mem = call_tool_once("memory_query", {"project_id": pid, "limit": 20})
    if ok_mem:
      obj = _extract_tool_object(msg_mem)
      if isinstance(obj, dict) and isinstance(obj.get("items"), list):
        items = obj.get("items") or []
        keywords = set(str(x).lower() for x in snap["keywords"])
        scored: List[Dict[str, Any]] = []
        for it in items:
          if not isinstance(it, dict):
            continue
          blob = _norm(
            " ".join(
              [
                str(it.get("type", "")),
                str(it.get("content", "")),
                " ".join(str(t) for t in (it.get("tags") or [])),
              ]
            )
          )
          score = sum(1 for k in keywords if k and k in blob)
          if score > 0:
            scored.append({"score": score, "item": it})
        scored.sort(key=lambda x: x.get("score", 0), reverse=True)
        snap["memory_hits"] = len(scored)
        snap["memory_top"] = [x["item"] for x in scored[:5]]
        if not snap.get("memory_top"):
          snap["memory_top"] = items[:3]
  if "intelligence_meta_snapshot" in allowed:
    ok_meta, msg_meta = call_tool_once("intelligence_meta_snapshot", {})
    if ok_meta:
      obj = _extract_tool_object(msg_meta)
      if isinstance(obj, dict) and isinstance(obj.get("snapshot"), dict):
        meta = obj.get("snapshot") or {}
        snap["meta_state"] = str(meta.get("meta_state", ""))
        snap["meta"] = {
          "arena_entropy": meta.get("arena_entropy"),
          "transfer_variance_trend": meta.get("transfer_variance_trend"),
          "gihi_delta_ultra": meta.get("gihi_delta_ultra"),
        }
  return snap


# ---- Session memory (Stage 5) ----

def _memory_path() -> Path:
  root = Path(__file__).resolve().parents[2]
  d = root / "_sync" / "autogen_learning"
  d.mkdir(parents=True, exist_ok=True)
  return d / "session_memory.json"


def _load_memory() -> Dict[str, Any]:
  path = _memory_path()
  if not path.exists():
    return {"sessions": {}}
  try:
    return json.loads(path.read_text(encoding="utf-8"))
  except Exception:
    return {"sessions": {}}


def _save_memory(mem: Dict[str, Any]) -> None:
  _memory_path().write_text(_json_dumps(mem), encoding="utf-8")


def _session_id() -> str:
  return os.getenv("LAB_SESSION_ID", "default")


def _load_session_context(ttl_hours: int = 6) -> Dict[str, Any]:
  mem = _load_memory()
  sid = _session_id()
  sessions = mem.get("sessions") if isinstance(mem, dict) else {}
  rec = sessions.get(sid) if isinstance(sessions, dict) else None
  if not isinstance(rec, dict):
    return {}
  try:
    ts = datetime.fromisoformat(rec.get("updated_at", ""))
    age_h = (datetime.now(timezone.utc) - ts).total_seconds() / 3600.0
    if age_h > ttl_hours:
      return {}
  except Exception:
    return {}
  return rec


def _word_set(text: str) -> set[str]:
  q = _norm(text)
  words = re.findall(r"[a-zA-Zа-яА-Я0-9]{2,}", q)
  return set(words)


def _jaccard_similarity(a: str, b: str) -> float:
  sa = _word_set(a)
  sb = _word_set(b)
  if not sa or not sb:
    return 0.0
  inter = len(sa.intersection(sb))
  union = len(sa.union(sb))
  if union <= 0:
    return 0.0
  return float(inter) / float(union)


def _answer_lines(text: str) -> List[str]:
  return [x.strip() for x in str(text or "").splitlines() if x.strip()]


def _extract_section(answer: str, title: str) -> List[str]:
  lines = _answer_lines(answer)
  out: List[str] = []
  capture = False
  title_l = title.lower()
  stop_prefixes = ("verified:", "details:", "next steps:", "warnings:", "constraints:")
  for ln in lines:
    low = ln.lower()
    if low.startswith(title_l):
      capture = True
      continue
    if capture and any(low.startswith(s) for s in stop_prefixes):
      break
    if capture:
      out.append(ln)
  return out


def _rewrite_answer_variant(answer: str, mode: int) -> str:
  lines = _answer_lines(answer)
  if not lines:
    return answer
  summary = lines[0]
  verified = _extract_section(answer, "Verified:")
  details = _extract_section(answer, "Details:")
  steps = _extract_section(answer, "Next steps:")

  if mode == 0:
    parts: List[str] = [summary]
    if details:
      parts.append(f"Ключевое: {details[0]}")
    elif verified:
      parts.append(f"Проверка: {verified[0]}")
    elif len(lines) > 1:
      parts.append(lines[1])
    return "\n".join(parts)

  if mode == 1:
    checklist: List[str] = [summary, "Чеклист:"]
    if verified:
      checklist += [f"1. {verified[0]}", f"2. {verified[1] if len(verified) > 1 else verified[0]}"]
    elif details:
      checklist += [f"1. {details[0]}", f"2. {details[1] if len(details) > 1 else details[0]}"]
    else:
      checklist += [f"1. {lines[1] if len(lines) > 1 else summary}", "2. Уточните следующий шаг."]
    if steps:
      checklist.append(f"3. {steps[0]}")
    return "\n".join(checklist[:6])

  out: List[str] = [summary]
  if details:
    out.append("Суть:")
    out.extend([f"- {x}" for x in details[:2]])
  if verified:
    out.append("Проверено:")
    out.extend([f"- {x}" for x in verified[:2]])
  if steps:
    out.append("Дальше:")
    out.append(f"- {steps[0]}")
  return "\n".join(out)


def _update_session_context(task: str, intent: str, used_tools: List[str], answer: str) -> None:
  mem = _load_memory()
  if not isinstance(mem, dict):
    mem = {}
  if "sessions" not in mem or not isinstance(mem["sessions"], dict):
    mem["sessions"] = {}
  sid = _session_id()
  prev = mem["sessions"].get(sid, {})
  if not isinstance(prev, dict):
    prev = {}
  prev_task = str(prev.get("last_task", ""))
  prev_intent = str(prev.get("last_intent", ""))
  prev_answer = str(prev.get("last_answer", ""))
  anti_repeat_idx = int(prev.get("anti_repeat_idx", 0) or 0)
  mem["sessions"][sid] = {
    "updated_at": _now_iso(),
    "last_task": task,
    "last_intent": intent,
    "last_used_tools": used_tools[:10],
    "last_answer": answer[:500],
    "prev_task": prev_task[:500],
    "prev_intent": prev_intent,
    "prev_answer": prev_answer[:500],
    "anti_repeat_idx": anti_repeat_idx,
  }
  _save_memory(mem)


def _update_session_fields(fields: Dict[str, Any]) -> None:
  mem = _load_memory()
  if not isinstance(mem, dict):
    mem = {}
  if "sessions" not in mem or not isinstance(mem["sessions"], dict):
    mem["sessions"] = {}
  sid = _session_id()
  existing = mem["sessions"].get(sid, {})
  if not isinstance(existing, dict):
    existing = {}
  existing["updated_at"] = _now_iso()
  for k, v in (fields or {}).items():
    existing[k] = v
  mem["sessions"][sid] = existing
  _save_memory(mem)


# ---- Diagnostics logging ----

def _log_learning_sample(payload: dict) -> None:
  payload = _sanitize_text_encoding(payload)
  root = Path(__file__).resolve().parents[2]
  log_dir = root / "_sync" / "autogen_learning"
  log_dir.mkdir(parents=True, exist_ok=True)
  out = log_dir / "dialog_samples.jsonl"
  events = log_dir / "learning_events.jsonl"

  task = str(payload.get("task", ""))
  answer = str(payload.get("answer", ""))
  evidence = payload.get("evidence", [])
  if not isinstance(evidence, list):
    evidence = []

  def _has_marker(marker: str) -> bool:
    m = marker.lower()
    if m in answer.lower():
      return True
    for e in evidence:
      if m in str(e).lower():
        return True
    return False

  def _extract_latency_ms(tool_name: str) -> Optional[int]:
    pat = re.compile(rf"TOOL_LATENCY\[{re.escape(tool_name)}\]=(\d+)ms", re.IGNORECASE)
    for e in evidence:
      s = str(e)
      m = pat.search(s)
      if m:
        try:
          return int(m.group(1))
        except Exception:
          return None
    return None

  goal_detected = _is_goal_intake(task)
  code_change_goal = _is_code_change_goal(task)
  has_context = _has_marker("MCP tool: project_context_get") or _has_marker("MCP tool: memory_query")
  safe_mode_applied = _has_marker("meta_state=stressed") or _has_marker("meta_state_stressed_policy")
  plan_created = _has_marker("MCP tool: tasks(op=plan_generate)")
  orch_activated = _has_marker("MCP tool: tasks(op=orchestrator_tick)")
  bind_done = _has_marker("MCP tool: tasks(op=execution_bind_tick)")
  dispatch_done = _has_marker("MCP tool: agent_dispatch_tick")
  time_to_plan_ms = _extract_latency_ms("tasks")
  time_to_dispatch_ms = _extract_latency_ms("agent_dispatch_tick")

  quality_score = None
  suite_v2_ok = None
  suite_v3_ok = None
  try:
    quality_path = log_dir / "quality_tick_latest.json"
    if quality_path.exists():
      q = json.loads(quality_path.read_text(encoding="utf-8"))
      if isinstance(q, dict):
        quality_score = q.get("quality_score")
        v2 = q.get("quality_suite_v2")
        v3 = q.get("quality_suite_v3")
        if isinstance(v2, dict):
          suite_v2_ok = (str(v2.get("status", "")).lower() == "pass")
        if isinstance(v3, dict):
          suite_v3_ok = (str(v3.get("status", "")).lower() == "pass")
  except Exception:
    pass

  enriched = dict(payload)
  enriched.update({
    "goal_detected": bool(goal_detected),
    "code_change_goal": bool(code_change_goal),
    "has_context": bool(has_context),
    "safe_mode_applied": bool(safe_mode_applied),
    "plan_created": bool(plan_created),
    "orch_activated": bool(orch_activated),
    "bind_done": bool(bind_done),
    "dispatch_done": bool(dispatch_done),
    "time_to_plan_ms": time_to_plan_ms,
    "time_to_dispatch_ms": time_to_dispatch_ms,
    "result_quality": {
      "quality_score": quality_score,
      "suite_v2_ok": suite_v2_ok,
      "suite_v3_ok": suite_v3_ok,
    },
  })

  redacted = _redact_sensitive(enriched)
  with out.open("a", encoding="utf-8") as f:
    f.write(_json_dumps(redacted) + "\n")
  with events.open("a", encoding="utf-8") as f:
    f.write(_json_dumps({
      "ts_utc": redacted.get("ts_utc", _now_iso()),
      "task": redacted.get("task", ""),
      "intent": redacted.get("intent", ""),
      "goal_detected": redacted.get("goal_detected", False),
      "code_change_goal": redacted.get("code_change_goal", False),
      "has_context": redacted.get("has_context", False),
      "safe_mode_applied": redacted.get("safe_mode_applied", False),
      "plan_created": redacted.get("plan_created", False),
      "orch_activated": redacted.get("orch_activated", False),
      "bind_done": redacted.get("bind_done", False),
      "dispatch_done": redacted.get("dispatch_done", False),
      "time_to_plan_ms": redacted.get("time_to_plan_ms"),
      "time_to_dispatch_ms": redacted.get("time_to_dispatch_ms"),
      "result_quality": redacted.get("result_quality"),
    }) + "\n")


def _write_tool_catalog(discovered_tools: List[str], policy_allowed: set[str], dynamic_allowed: List[str]) -> None:
  root = Path(__file__).resolve().parents[2]
  out_dir = root / "_sync" / "autogen_learning"
  out_dir.mkdir(parents=True, exist_ok=True)
  latest = out_dir / "tool_catalog_latest.json"
  history = out_dir / "tool_catalog_history.jsonl"

  defaults: Dict[str, Dict[str, Any]] = {
    "whoami": {"example_args": {}},
    "sync": {"example_args": {"op": "status"}},
    "exec": {"example_args": {"cmd": "powershell", "args": ["-NoProfile", "-Command", "Get-Date"]}},
    "fs": {"example_args": {"op": "list", "dir": r"C:\Users\anani\Projects", "limit": 50}},
    "tasks": {"example_args": {"op": "list", "limit": 20}},
    "project_create": {"example_args": {"project_id": "ai_lab_core", "description": "AI lab core"}},
    "project_context_get": {"example_args": {"project_id": "ai_lab_core"}},
    "project_context_set": {"example_args": {"project_id": "ai_lab_core", "context": "..." }},
    "memory_query": {"example_args": {"project_id": "ai_lab_core", "limit": 10}},
    "memory_store": {"example_args": {"project_id": "ai_lab_core", "type": "decision", "content": "..."}},
    "web": {"example_args": {"op": "search", "query": "openai api docs", "max_results": 5}},
    "search_web": {"example_args": {"query": "weather odesa", "max_results": 5}},
    "weather": {"example_args": {"location": "Odesa, Ukraine"}},
    "read_url_content": {"example_args": {"url": "https://platform.openai.com/docs", "max_chars": 1500}},
  }

  wildcard_all = ("*" in policy_allowed) or ("all" in {x.lower() for x in policy_allowed})
  tools_block = []
  for t in sorted(discovered_tools):
    tools_block.append({
      "name": t,
      "in_policy_allowlist": wildcard_all or (t in policy_allowed),
      "enabled_dynamic": t in dynamic_allowed,
      "schema": "unknown",
      "safe_default": defaults.get(t, {"example_args": {}}),
    })

  payload = {
    "ts_utc": _now_iso(),
    "policy_allowlist": sorted(list(policy_allowed)),
    "policy_wildcard_all": wildcard_all,
    "discovered_count": len(discovered_tools),
    "dynamic_allowed_count": len(dynamic_allowed),
    "tools": tools_block,
  }
  latest.write_text(_json_dumps(payload), encoding="utf-8")
  with history.open("a", encoding="utf-8") as f:
    f.write(_json_dumps(payload) + "\n")


def _run_boot_sequence(policy_allowed: set[str]) -> Tuple[bool, Dict[str, Any]]:
  cap_path = str((Path(__file__).resolve().parents[2] / "_sync" / "CAPABILITIES.md"))
  boot: Dict[str, Any] = {"ok": False, "errors": [], "boot_evidence": [], "allowed_tools": sorted(list(policy_allowed))}

  # Step 1: read CAPABILITIES.md
  ok_cap, msg_cap = _mcp_call_tool("fs", {"op": "read_content", "path": cap_path})
  if not ok_cap:
    boot["errors"].append(f"boot.fs.read_content failed: {msg_cap}")
    return False, boot
  boot["boot_evidence"].append(f"fs.read_content({cap_path})=ok")

  # Step 2: whoami and roots/tools validation
  ok_who, msg_who = _mcp_call_tool("whoami", {})
  if not ok_who:
    boot["errors"].append(f"boot.whoami failed: {msg_who}")
    return False, boot
  who_obj = _extract_tool_object(msg_who)
  if not isinstance(who_obj, dict):
    boot["errors"].append("boot.whoami invalid payload type")
    return False, boot

  roots = who_obj.get("roots")
  tools = who_obj.get("tools")
  if not isinstance(roots, list):
    boot["errors"].append("boot.whoami roots missing")
    return False, boot
  if not isinstance(tools, list):
    boot["errors"].append("boot.whoami tools missing")
    return False, boot

  normalized_roots = [str(x).lower() for x in roots]
  missing_roots = [r for r in _required_roots() if r not in normalized_roots]
  if missing_roots:
    boot["errors"].append(f"boot.roots_mismatch missing={missing_roots}")
    return False, boot
  boot["boot_evidence"].append("whoami.roots=ok")

  discovered = set(str(t).strip() for t in tools if str(t).strip())
  wildcard_all = ("*" in policy_allowed) or ("all" in {x.lower() for x in policy_allowed})
  dynamic_allowed = sorted(list(discovered)) if wildcard_all else sorted(list(discovered.intersection(policy_allowed)))
  if not dynamic_allowed:
    boot["errors"].append("boot.allowed_tools empty after discovery")
    return False, boot
  boot["allowed_tools"] = dynamic_allowed
  if wildcard_all:
    boot["boot_evidence"].append("policy_wildcard_all=true")
  boot["boot_evidence"].append(f"dynamic_allowed_count={len(dynamic_allowed)}")
  _write_tool_catalog(sorted(list(discovered)), policy_allowed, dynamic_allowed)

  # Step 3: publish handshake (best-effort only if tool exists in discovered list)
  if "event_publish" in discovered:
    hs_payload = {
      "ts_utc": _now_iso(),
      "source": "labbrain.boot",
      "session_id": _session_id(),
      "capabilities_path": cap_path,
      "allowed_tools": dynamic_allowed[:80],
    }
    ok_hs, msg_hs = _mcp_call_tool("event_publish", {
      "type": "client.handshake",
      "source": "labbrain.boot",
      "payload": _json_dumps(hs_payload, 4000),
    })
    if not ok_hs:
      boot["errors"].append(f"boot.event_publish failed: {msg_hs}")
      return False, boot
    boot["boot_evidence"].append("event_publish(client.handshake)=ok")

  boot["ok"] = True
  return True, boot


def _project_id() -> str:
  return os.getenv("LAB_PROJECT_ID", "ai_lab_core").strip() or "ai_lab_core"


def _ensure_project_brain_os(call_tool_once, allowed: set[str], evidence: List[str]) -> Tuple[bool, List[str]]:
  """
  Ensure long-term project memory/context exists using MCP project_* and memory_* tools.
  This runs as best-effort and is skipped if required tools are not available.
  """
  actions: List[str] = []
  project_id = _project_id()
  required = {"project_create", "project_context_set", "project_context_get", "memory_query", "memory_store"}
  if not required.issubset(allowed):
    return False, actions

  ok_pc, msg_pc = call_tool_once("project_create", {
    "project_id": project_id,
    "description": "AI lab core brain project",
    "stack": ["nodejs", "typescript", "powershell", "python", "autogen"],
  })
  if not ok_pc:
    evidence.append(f"ERROR[project_create]: {msg_pc}")
    return False, actions
  actions.append("project_create=ok")

  context_block = (
    "mcp-sync-server AI lab brain: tool-first + evidence-first runtime.\n"
    "Core loops: quality_tick, PEJ loop, controller tick.\n"
    "Execution model: sync answers <=4s; long jobs must use queue."
  )
  roadmap_block = (
    "1) Keep quality_score >= 0.90\n"
    "2) Reduce fallback_rate and intent_miss_rate\n"
    "3) Increase autonomy via tasks/orchestrator/evolution"
  )
  constraints_block = (
    "No secret leakage in logs; no unverifiable claims.\n"
    "Allowed roots and MCP tools discovered at boot sequence."
  )
  ok_ctx_set, msg_ctx_set = call_tool_once("project_context_set", {
    "project_id": project_id,
    "context": context_block,
    "roadmap": roadmap_block,
    "constraints": constraints_block,
  })
  if ok_ctx_set:
    actions.append("project_context_set=ok")
  else:
    evidence.append(f"ERROR[project_context_set]: {msg_ctx_set}")

  ok_q, msg_q = call_tool_once("memory_query", {
    "project_id": project_id,
    "type": "runbook",
    "tags": ["brain_os", "bootstrap"],
    "limit": 5,
  })
  has_bootstrap_mem = False
  if ok_q:
    q_obj = _extract_tool_object(msg_q)
    if isinstance(q_obj, dict):
      items = q_obj.get("items")
      if isinstance(items, list) and len(items) > 0:
        has_bootstrap_mem = True
  if not has_bootstrap_mem:
    ok_store, msg_store = call_tool_once("memory_store", {
      "project_id": project_id,
      "type": "runbook",
      "tags": ["brain_os", "bootstrap"],
      "content": "Brain OS bootstrap initialized from lab_brain runtime.",
    })
    if ok_store:
      actions.append("memory_store(runbook/bootstrap)=ok")
    else:
      evidence.append(f"ERROR[memory_store]: {msg_store}")

  ok_ctx_get, msg_ctx_get = call_tool_once("project_context_get", {"project_id": project_id})
  if ok_ctx_get:
    actions.append("project_context_get=ok")
  else:
    evidence.append(f"ERROR[project_context_get]: {msg_ctx_get}")

  return True, actions


def _project_memory_summary(call_tool_once, allowed: set[str]) -> Dict[str, Any]:
  summary: Dict[str, Any] = {
    "project_id": _project_id(),
    "context_present": False,
    "memory_items": 0,
  }
  if "project_context_get" in allowed:
    ok_ctx, msg_ctx = call_tool_once("project_context_get", {"project_id": _project_id()})
    if ok_ctx:
      obj = _extract_tool_object(msg_ctx)
      if isinstance(obj, dict):
        summary["context_present"] = True
        summary["context"] = obj
  if "memory_query" in allowed:
    ok_mem, msg_mem = call_tool_once("memory_query", {
      "project_id": _project_id(),
      "limit": 10,
    })
    if ok_mem:
      obj = _extract_tool_object(msg_mem)
      if isinstance(obj, dict):
        items = obj.get("items")
        if isinstance(items, list):
          summary["memory_items"] = len(items)
          summary["memory_preview"] = items[:5]
  return summary


# ---- Main brain ----

async def run_brain(task: str) -> dict:
  policy_allowed = set(_mcp_allowed_tools())
  used_tools: List[str] = []
  attempted_tools: List[str] = []
  evidence: List[str] = []
  allowed = set(policy_allowed)
  tool_cache: Dict[str, Tuple[bool, str]] = {}
  ttl_cache = _load_ttl_cache()
  ttl_sec = int(os.getenv("LAB_TOOL_CACHE_TTL_SEC", "30"))
  ttl_tools = set(x.strip() for x in os.getenv(
    "LAB_TOOL_CACHE_TOOLS",
    "whoami,sync,worker_metrics_snapshot,intelligence_meta_snapshot,project_context_get,memory_query,job_history_list",
  ).split(",") if x.strip())

  def call_tool_once(name: str, args: Dict[str, Any]) -> Tuple[bool, str]:
    key = f"{name}:{_json_dumps(args)}"
    if key in tool_cache:
      return tool_cache[key]
    persistent_key = _cache_key(name, args)
    if name in ttl_tools:
      cached = ttl_cache.get(persistent_key)
      if isinstance(cached, dict):
        ts = float(cached.get("ts_unix", 0.0))
        age = time.time() - ts
        if age >= 0 and age <= ttl_sec:
          ok_cached = bool(cached.get("ok", False))
          msg_cached = str(cached.get("msg", ""))
          tool_cache[key] = (ok_cached, msg_cached)
          attempted_tools.append(name)
          if ok_cached:
            used_tools.append(name)
            evidence.append(f"CACHE_HIT[{name}]: age_sec={round(age, 2)}")
          else:
            evidence.append(f"CACHE_HIT_ERROR[{name}]: age_sec={round(age, 2)}")
          return ok_cached, msg_cached
    attempted_tools.append(name)
    t0 = time.perf_counter()
    call_timeout_sec = 15
    if name == "exec":
      try:
        req_ms = int(args.get("timeout_ms", 0))
      except Exception:
        req_ms = 0
      if req_ms > 0:
        # MCP transport timeout must exceed exec timeout to avoid false "tool not used" on long commands.
        call_timeout_sec = max(15, min(600, int(req_ms / 1000) + 30))
      else:
        call_timeout_sec = 120
    ok, msg = _mcp_call_tool(name, args, timeout_sec=call_timeout_sec)
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    tool_cache[key] = (ok, msg)
    if name in ttl_tools and ok:
      ttl_cache[persistent_key] = {
        "ts_unix": time.time(),
        "ok": True,
        "msg": msg,
      }
      _save_ttl_cache(ttl_cache)
    if ok:
      used_tools.append(name)
      evidence.append(msg)
      evidence.append(f"TOOL_LATENCY[{name}]={elapsed_ms}ms")
    else:
      evidence.append(f"ERROR[{name}]: {msg}")
      evidence.append(f"TOOL_LATENCY[{name}]={elapsed_ms}ms")
    return ok, msg

  intent_obj = _detect_intent(task)
  intent = str(intent_obj.get("intent", "general"))
  confidence = float(intent_obj.get("confidence", 0.0))

  # Boot sequence: CAPABILITIES -> whoami roots/tools -> client.handshake
  boot_ok, boot = _run_boot_sequence(policy_allowed)
  if not boot_ok:
    ans = _format_response(
      "error",
      "BOOT_SEQUENCE_FAILED: LabBrain Ð½Ðµ Ð¼Ð¾Ð¶ÐµÑ‚ Ð½Ð°Ñ‡Ð°Ñ‚ÑŒ Ñ€Ð°Ð±Ð¾Ñ‚Ñƒ.",
      details=boot.get("boot_evidence", []),
      warnings=boot.get("errors", []),
      actions=["ÐŸÑ€Ð¾Ð²ÐµÑ€ÑŒÑ‚Ðµ roots/tools Ð² whoami Ð¸ Ð½Ð°Ð»Ð¸Ñ‡Ð¸Ðµ _sync/CAPABILITIES.md."],
    )
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "boot_ok": False,
      "boot": boot,
      "identity_guard_applied": False,
      "quality_gate_applied": True,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  allowed = set(boot.get("allowed_tools", sorted(list(policy_allowed))))
  evidence.extend(boot.get("boot_evidence", []))

  # Project Brain OS bootstrap (best effort, quality-first).
  sess = _load_session_context(ttl_hours=24)
  run_project_bootstrap = True
  if intent in {
    "pure_logic",
    "basic_fact",
    "smalltalk",
    "identity",
    "datetime",
    "capabilities",
    "constraints",
    "operational",
    "operational_analysis",
    "system_recovery",
    "external_hook_probe",
    "external_security_analysis",
    "external_app_analysis",
    "tool_call",
    "web",
    "weather",
    "general",
  }:
    run_project_bootstrap = False
  try:
    prev = sess.get("project_brain_os_bootstrap_at", "")
    if isinstance(prev, str) and prev:
      ts_prev = datetime.fromisoformat(prev)
      age_h = (datetime.now(timezone.utc) - ts_prev).total_seconds() / 3600.0
      if age_h < 12:
        run_project_bootstrap = False
  except Exception:
    run_project_bootstrap = True
  if run_project_bootstrap:
    boot_os_ok, boot_os_actions = _ensure_project_brain_os(call_tool_once, allowed, evidence)
    if boot_os_ok and boot_os_actions:
      evidence.extend([f"project_bootstrap:{x}" for x in boot_os_actions])
      _update_session_fields({"project_brain_os_bootstrap_at": _now_iso()})

  if os.getenv("LAB_INTENT_LAYER2", "0") == "1":
    intent_obj = await _llm_intent_refine(task, {"intent": intent, "confidence": confidence})
    intent = str(intent_obj.get("intent", intent))
    confidence = float(intent_obj.get("confidence", confidence))

  # Explicit tool invocation route: "Ð¸ÑÐ¿Ð¾Ð»ÑŒÐ·ÑƒÐ¹ Ð¸Ð½ÑÑ‚Ñ€ÑƒÐ¼ÐµÐ½Ñ‚ <tool_name>"
  requested_tool, requested_args, requested_args_error = _extract_requested_tool(task, allowed)
  if requested_tool:
    if requested_args_error:
      ans = _format_response(
        "error",
        f"TOOL_RESULT `{requested_tool}`",
        details=["ok=false", f"error={requested_args_error}"],
        actions=["ÐŸÐµÑ€ÐµÐ´Ð°Ð¹Ñ‚Ðµ ÐºÐ¾Ñ€Ñ€ÐµÐºÑ‚Ð½Ñ‹Ð¹ JSON-Ð¾Ð±ÑŠÐµÐºÑ‚ Ð¿Ð¾ÑÐ»Ðµ `args {...}`."],
      )
      _update_session_context(task, "tool_call", used_tools, ans)
      payload = {
        "ts_utc": _now_iso(),
        "policy_version": "labbrain_v2",
        "task": task,
        "intent": "tool_call",
        "intent_confidence": 0.99,
        "answer": ans,
        "identity_guard_applied": False,
        "used_tools": used_tools,
        "attempted_tools": attempted_tools,
        "evidence": evidence,
      }
      _log_learning_sample(payload)
      return _finalize_payload(payload)

    if requested_tool not in allowed:
      ans = _format_response(
        "error",
        f"TOOL_RESULT `{requested_tool}`",
        details=["ok=false", "error=tool_not_allowed", f"allowlist={_json_dumps(sorted(list(allowed)), 400)}"],
      )
      _update_session_context(task, "tool_call", used_tools, ans)
      payload = {
        "ts_utc": _now_iso(),
        "policy_version": "labbrain_v2",
        "task": task,
        "intent": "tool_call",
        "intent_confidence": 0.99,
        "answer": ans,
        "identity_guard_applied": False,
        "used_tools": used_tools,
        "attempted_tools": attempted_tools,
        "evidence": evidence,
      }
      _log_learning_sample(payload)
      return _finalize_payload(payload)

    ok, msg = call_tool_once(requested_tool, requested_args)
    if ok:
      obj = _extract_tool_object(msg)
      ans = _format_response(
        "tool",
        f"TOOL_RESULT `{requested_tool}`",
        verified=[f"MCP tool: {requested_tool}"],
        details=["ok=true", f"result={_json_dumps(obj, 1600)}"],
      )
    else:
      ans = _format_response(
        "error",
        f"TOOL_RESULT `{requested_tool}`",
        details=["ok=false", f"error={msg}"],
        actions=["Ð£Ñ‚Ð¾Ñ‡Ð½Ð¸Ñ‚Ðµ Ð°Ñ€Ð³ÑƒÐ¼ÐµÐ½Ñ‚Ñ‹ Ð¸Ð½ÑÑ‚Ñ€ÑƒÐ¼ÐµÐ½Ñ‚Ð° Ð¸ Ð¿Ð¾Ð²Ñ‚Ð¾Ñ€Ð¸Ñ‚Ðµ Ð·Ð°Ð¿Ñ€Ð¾Ñ."],
      )

    _update_session_context(task, "tool_call", used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": "tool_call",
      "intent_confidence": 0.99,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  # Fast deterministic routes by intent
  if intent == "basic_fact":
    solved = _solve_basic_fact(task)
    if solved is None:
      ans = _format_response(
        "basic_fact",
        "Базовый факт распознан, но формулировка не покрыта детерминированным решателем.",
        actions=["Переформулируйте вопрос короче или в формате простого выражения, например `2+2`."],
      )
    else:
      ans = solved
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "quality_gate_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "pure_logic":
    verified: List[str] = []
    details: List[str] = []
    actions: List[str] = []
    warnings: List[str] = []

    solved = _solve_pure_logic(task)
    if solved:
      ok_logic, reason_logic = _logic_verify(task, solved)
      if not ok_logic:
        warnings.append(reason_logic)
        retry = _solve_pure_logic(task)
        if retry:
          solved = retry
      ans = solved
      details.append("mode=pure_logic_no_tools")
    else:
      ans = _format_response(
        "pure_logic",
        "Ð›Ð¾Ð³Ð¸Ñ‡ÐµÑÐºÐ°Ñ Ð·Ð°Ð´Ð°Ñ‡Ð° Ñ€Ð°ÑÐ¿Ð¾Ð·Ð½Ð°Ð½Ð°, Ð½Ð¾ Ð½ÑƒÐ¶ÐµÐ½ Ð±Ð¾Ð»ÐµÐµ ÑÑ‚Ñ€ÑƒÐºÑ‚ÑƒÑ€Ð¸Ñ€Ð¾Ð²Ð°Ð½Ð½Ñ‹Ð¹ Ð²Ñ…Ð¾Ð´ Ð´Ð»Ñ Ð´ÐµÑ‚ÐµÑ€Ð¼Ð¸Ð½Ð¸Ñ€Ð¾Ð²Ð°Ð½Ð½Ð¾Ð³Ð¾ Ñ€ÐµÑˆÐµÐ½Ð¸Ñ.",
        details=["ÐžÐ¶Ð¸Ð´Ð°ÑŽÑ‚ÑÑ ÑÐ²Ð½Ñ‹Ðµ ÑƒÑÐ»Ð¾Ð²Ð¸Ñ: Ð¾Ð³Ñ€Ð°Ð½Ð¸Ñ‡ÐµÐ½Ð¸Ñ/ÑÐ»Ð¾Ñ‚Ñ‹/Ð¿Ñ€Ð°Ð²Ð¸Ð»Ð°."],
        actions=["Ð”Ð¾Ð±Ð°Ð²ÑŒÑ‚Ðµ ÑƒÑÐ»Ð¾Ð²Ð¸Ñ Ð² Ñ„Ð¾Ñ€Ð¼Ð°Ñ‚Ðµ: Given / Constraints / Goal."],
      )
      warnings.append("pure_logic_solver_no_match")

    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "quality_gate_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence + verified,
      "warnings": warnings,
      "details": details,
      "actions": actions,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "smalltalk":
    ans = (
      "Ð—Ð´Ñ€Ð°Ð²ÑÑ‚Ð²ÑƒÐ¹Ñ‚Ðµ. Ð¯ LabBrain Ð¸ Ñ€Ð°Ð±Ð¾Ñ‚Ð°ÑŽ Ð² Ñ€ÐµÐ¶Ð¸Ð¼Ðµ tool-first.\n"
      "ÐœÐ¾Ð³Ñƒ: Ð¿Ñ€Ð¾Ð²ÐµÑ€Ð¸Ñ‚ÑŒ Ð²Ñ€ÐµÐ¼Ñ/Ð´Ð°Ñ‚Ñƒ, ÑÐ¾ÑÑ‚Ð¾ÑÐ½Ð¸Ðµ Ð»Ð°Ð±Ð¾Ñ€Ð°Ñ‚Ð¾Ñ€Ð¸Ð¸, Ð·Ð°Ð´Ð°Ñ‡Ð¸, Ñ„Ð°Ð¹Ð»Ñ‹ Ð¸ web-Ð¿Ð¾Ð¸ÑÐº Ñ‡ÐµÑ€ÐµÐ· MCP tools.\n"
      "ÐÐ°Ð¿Ð¸ÑˆÐ¸Ñ‚Ðµ ÐºÐ¾Ð½ÐºÑ€ÐµÑ‚Ð½Ð¾Ðµ Ð´ÐµÐ¹ÑÑ‚Ð²Ð¸Ðµ: Ð½Ð°Ð¿Ñ€Ð¸Ð¼ÐµÑ€ `Ð¿Ð¾ÐºÐ°Ð¶Ð¸ Ð¼ÐµÑ‚Ñ€Ð¸ÐºÐ¸ Ð»Ð°Ð±Ð¾Ñ€Ð°Ñ‚Ð¾Ñ€Ð¸Ð¸`."
    )
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "next_steps":
    details: List[str] = []
    verified: List[str] = []
    actions: List[str] = []
    project_id = _project_id()

    mem_summary = _project_memory_summary(call_tool_once, allowed)
    if mem_summary.get("context_present"):
      verified.append("MCP tool: project_context_get")
    if int(mem_summary.get("memory_items", 0)) > 0:
      verified.append("MCP tool: memory_query")
    details.append(f"project_id={project_id}")
    details.append(f"memory_items={mem_summary.get('memory_items', 0)}")

    if "tasks" in allowed:
      ok_plan, msg_plan = call_tool_once("tasks", {
        "op": "plan_generate",
        "goal": task,
        "project_id": project_id,
        "max_tasks": 5,
      })
      if ok_plan:
        plan_obj = _extract_tool_object(msg_plan)
        verified.append("MCP tool: tasks(op=plan_generate)")
        details.append(f"plan={_json_dumps(plan_obj, 900)}")
        actions.append("Ð—Ð°Ð¿ÑƒÑÑ‚Ð¸Ñ‚ÑŒ tasks(op=orchestrator_tick) Ð´Ð»Ñ Ð½Ð°Ð·Ð½Ð°Ñ‡ÐµÐ½Ð¸Ñ ÑÐ¾Ð·Ð´Ð°Ð½Ð½Ð¾Ð³Ð¾ Ð¿Ð»Ð°Ð½Ð°.")
        ok_orch, msg_orch = call_tool_once("tasks", {
          "op": "orchestrator_tick",
          "project_id": project_id,
          "limit": 5,
        })
        if ok_orch:
          verified.append("MCP tool: tasks(op=orchestrator_tick)")
          details.append(f"orchestrator={_json_dumps(_extract_tool_object(msg_orch), 700)}")
      else:
        details.append(f"plan_generate_error={msg_plan}")

    if "queue_push" in allowed:
      actions.append("Ð”Ð»Ñ Ð´Ð»Ð¸Ð½Ð½Ñ‹Ñ… ÑˆÐ°Ð³Ð¾Ð² Ð¸ÑÐ¿Ð¾Ð»ÑŒÐ·ÑƒÐ¹Ñ‚Ðµ async queue (queue_push -> router_execute_exec_queue).")
    ans = _format_response(
      "next_steps",
      "Ð¡Ñ„Ð¾Ñ€Ð¼Ð¸Ñ€Ð¾Ð²Ð°Ð½ ÑÐ»ÐµÐ´ÑƒÑŽÑ‰Ð¸Ð¹ Ð¿Ð»Ð°Ð½ Ð´ÐµÐ¹ÑÑ‚Ð²Ð¸Ð¹ Ð¿Ð¾ Ð¿Ñ€Ð¾ÐµÐºÑ‚Ñƒ.",
      verified=verified,
      details=details,
      actions=actions,
    )
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "constraints":
    ans = _constraints_answer(sorted(list(allowed)))
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "operational_analysis":
    ans = _build_operational_analysis_answer(call_tool_once, allowed)
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent in {"external_hook_probe", "external_security_analysis", "external_app_analysis"}:
    verified: List[str] = []
    details: List[str] = []
    actions: List[str] = []
    warnings: List[str] = []

    if "exec" not in allowed:
      ans = _format_response(
        intent,
        "External analysis route requires `exec` tool.",
        warnings=["exec_not_allowed"],
        actions=["Add `exec` to LAB_MCP_TOOL_ALLOWLIST and restart LabBrain."],
      )
      _update_session_context(task, intent, used_tools, ans)
      payload = {
        "ts_utc": _now_iso(),
        "policy_version": "labbrain_v2",
        "task": task,
        "intent": intent,
        "intent_confidence": confidence,
        "answer": ans,
        "identity_guard_applied": False,
        "used_tools": used_tools,
        "attempted_tools": attempted_tools,
        "evidence": evidence,
      }
      _log_learning_sample(payload)
      return _finalize_payload(payload)

    ext = _extract_external_analysis_params(task)
    script_rel = "ops/autogen_engine/autogen_external_analysis_mode.ps1"
    if intent == "external_hook_probe":
      script_rel = "ops/autogen_engine/autogen_external_hook_probe.ps1"
    elif intent == "external_security_analysis":
      script_rel = "ops/autogen_engine/autogen_external_security_mode.ps1"

    extra_args: List[str] = []
    if ext.get("base_url"):
      extra_args.extend(["-BaseUrl", str(ext["base_url"])])
    if ext.get("container_name"):
      extra_args.extend(["-ContainerName", str(ext["container_name"])])
    if ext.get("app_path"):
      extra_args.extend(["-AppPath", str(ext["app_path"])])
    if ext.get("compose_file") and intent in {"external_hook_probe", "external_app_analysis"}:
      extra_args.extend(["-ComposeFile", str(ext["compose_file"])])
    if ext.get("service") and intent in {"external_hook_probe", "external_app_analysis"}:
      extra_args.extend(["-Service", str(ext["service"])])
    if ext.get("image_ref") and intent in {"external_security_analysis", "external_app_analysis"}:
      extra_args.extend(["-ImageRef", str(ext["image_ref"])])
    extra_args.append("-JsonOnly")

    ok_ext, out_ext = _run_exec_ps_script(
      call_tool_once,
      script_rel,
      timeout_ms=240000,
      extra_args=extra_args,
    )
    if ok_ext:
      verified.append(f"MCP tool: exec({Path(script_rel).name})")
      try:
        obj = json.loads(str(out_ext).strip())
      except Exception:
        obj = {}
      if isinstance(obj, dict):
        status = str(obj.get("status", "")) or str(obj.get("summary", {}).get("status", ""))
        if status:
          details.append(f"status={status}")
        if intent == "external_hook_probe":
          coverage = obj.get("summary", {}).get("hook_coverage_percent")
          if coverage is not None:
            details.append(f"hook_coverage_percent={coverage}")
        elif intent == "external_security_analysis":
          findings = obj.get("summary", {}).get("findings")
          if findings is not None:
            details.append(f"security_findings={findings}")
        else:
          summary = obj.get("summary", {})
          if isinstance(summary, dict):
            details.append(f"analysis_summary={_json_dumps(summary, 400)}")
      else:
        details.append("script_output: non-json")

      actions.append("Read latest report in `_sync/external_analysis` for full evidence and history.")
      ans = _format_response(
        intent,
        "External analysis executed successfully.",
        verified=verified,
        details=details,
        actions=actions,
        warnings=warnings,
      )
    else:
      ans = _format_response(
        intent,
        "External analysis failed.",
        verified=verified,
        details=details,
        actions=["Check script path/params and tool logs, then retry."],
        warnings=[f"exec_failed={out_ext}"],
      )

    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "system_recovery":
    verified: List[str] = []
    details: List[str] = []
    actions: List[str] = []
    warnings: List[str] = []
    steps: List[str] = []

    qn = _norm(task)
    loop_mode = bool(re.search(r"(автопетл|авто\s*цикл|recovery\s*loop|system\s*recovery\s*loop|\bloop\b|цикл\s+восстанов)", qn))
    iter_count = 20
    m_iter = re.search(r"(?:итерац|iterations?|тик(?:ов)?)\D{0,5}(\d{1,3})", qn)
    if m_iter:
      try:
        iter_count = max(1, min(120, int(m_iter.group(1))))
      except Exception:
        iter_count = 20
    else:
      m_any_num = re.search(r"\b(\d{1,3})\b", qn)
      if m_any_num:
        try:
          iter_count = max(1, min(120, int(m_any_num.group(1))))
        except Exception:
          iter_count = 20

    before = _build_operational_analysis_answer(call_tool_once, allowed)
    details.append("before_snapshot: captured")
    if "exec" in allowed:
      if loop_mode:
        run_iter = min(iter_count, 1)
        timeout_loop = max(120000, min(300000, run_iter * 120000))
        ok_loop, out_loop = _run_exec_ps_script(
          call_tool_once,
          "ops/autogen_engine/autogen_system_recovery_loop.ps1",
          timeout_ms=timeout_loop,
          extra_args=["-ProjectId", _project_id(), "-Iterations", str(run_iter), "-SleepSec", "0"],
        )
        if ok_loop:
          verified.append("MCP tool: exec(autogen_system_recovery_loop.ps1)")
          steps.append(f"recovery_loop=ok; iterations={run_iter}")
          if iter_count > run_iter:
            warnings.append("Для предотвращения timeout через chat-exec выполнена 1 итерация. Длинный loop запускайте из терминала.")
        else:
          warnings.append(f"recovery_loop_failed={out_loop}")
      else:
        ok1, out1 = _run_exec_ps_script(
          call_tool_once,
          "ops/autogen_engine/autogen_controller_tick.ps1",
          timeout_ms=180000,
          extra_args=["-ProjectId", _project_id()],
        )
        if ok1:
          verified.append("MCP tool: exec(autogen_controller_tick.ps1)")
          steps.append("controller_tick=ok")
        else:
          warnings.append(f"controller_tick_failed={out1}")

        ok2, out2 = _run_exec_ps_script(
          call_tool_once,
          "ops/autogen_engine/autogen_learning_analyzer_tick.ps1",
          timeout_ms=180000,
          extra_args=["-ProjectId", _project_id()],
        )
        if ok2:
          verified.append("MCP tool: exec(autogen_learning_analyzer_tick.ps1)")
          steps.append("learning_analyzer_tick=ok")
        else:
          warnings.append(f"learning_analyzer_tick_failed={out2}")

        ok3, out3 = _run_exec_ps_script(
          call_tool_once,
          "ops/autogen_engine/autogen_meta_stability_tick.ps1",
          timeout_ms=180000,
        )
        if ok3:
          verified.append("MCP tool: exec(autogen_meta_stability_tick.ps1)")
          steps.append("meta_stability_tick=ok")
        else:
          warnings.append(f"meta_stability_tick_failed={out3}")
    else:
      warnings.append("exec tool unavailable: automatic recovery scripts were not executed.")

    after = _build_operational_analysis_answer(call_tool_once, allowed)
    details.append("after_snapshot: captured")
    if steps:
      details.append("recovery_steps=" + ", ".join(steps))

    actions.append("Повторять system_recovery до исчезновения новых error_jobs и снижения stressed индикаторов.")
    actions.append("После стабилизации запустить quality_tick + replay_qa_full и проверить regression gates.")
    actions.append("Если error_jobs продолжают расти: проверить producers, которые отправляют queue_push(type=custom) без payload shape.")

    ans = _format_response(
      "system_recovery",
      "Recovery playbook выполнен: тики восстановления запущены и сделан post-check.",
      verified=verified,
      details=(details + ["--- BEFORE ---", before, "--- AFTER ---", after])[:8],
      actions=actions[:5],
      warnings=warnings[:5],
    )
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "operational":
    verified: List[str] = []
    details: List[str] = []
    actions: List[str] = []
    qn = _norm(task)

    # README ensure/update flow for operational docs tasks.
    if "fs" in allowed and ("readme" in qn) and re.search(r"(contains line|содержит строку|if missing, add|add it|добавь|ensure)", qn):
      path_hint = _extract_candidate_path(task)
      base_dir = ""
      if path_hint:
        p = Path(path_hint)
        if not p.is_absolute():
          p = (Path(__file__).resolve().parents[2] / path_hint).resolve()
        if p.suffix.lower() == ".md":
          readme_path = str(p)
        else:
          base_dir = str(p)
          readme_path = str((p / "README.md").resolve())
      else:
        readme_path = ""

      line_to_ensure = ""
      m_line = re.search(r"contains line\s+['\"]([^'\"]+)['\"]", task, flags=re.IGNORECASE)
      if m_line:
        line_to_ensure = (m_line.group(1) or "").strip()

      if readme_path:
        ok_r, msg_r = call_tool_once("fs", {"op": "read_content", "path": readme_path})
        if ok_r:
          verified.append(f"MCP tool: fs(op=read_content,path={readme_path})")
          obj_r = _extract_tool_object(msg_r)
          content = str(obj_r.get("content", "")) if isinstance(obj_r, dict) else str(obj_r or "")
          if line_to_ensure:
            has_line = (line_to_ensure in content)
            details.append(f"readme_contains_required={has_line}")
            if (not has_line) and re.search(r"(if missing, add|add it|добавь|ensure)", qn):
              updated = (content.rstrip() + "\n" + line_to_ensure + "\n")
              ok_w, msg_w = call_tool_once("fs", {"op": "write_content", "path": readme_path, "content": updated})
              if ok_w:
                verified.append(f"MCP tool: fs(op=write_content,path={readme_path})")
                details.append("readme_line_added=true")
              else:
                details.append(f"readme_write_error={msg_w}")
        else:
          details.append(f"readme_read_error={msg_r}")
          if base_dir:
            ok_ls, msg_ls = call_tool_once("fs", {"op": "list", "dir": base_dir, "limit": 50})
            if ok_ls:
              verified.append(f"MCP tool: fs(op=list,dir={base_dir})")
              details.append(f"dir_list={_json_dumps(_extract_tool_object(msg_ls), 800)}")

    # Direct command execution path for operational prompts (run script / show stdout).
    if "exec" in allowed:
      path_hint = _extract_candidate_path(task)
      expanded_paths = _expand_candidate_paths(path_hint) if path_hint else []
      exec_done = False
      for p in expanded_paths:
        pp = str(p)
        low = pp.lower()
        if low.endswith(".ps1"):
          ok_exec, msg_exec = call_tool_once(
            "exec",
            {
              "cmd": "powershell",
              "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", pp],
              "timeout_ms": 90000,
            },
          )
          if ok_exec:
            verified.append(f"MCP tool: exec(powershell -File {pp})")
            details.append(f"stdout={_extract_exec_stdout(_extract_tool_object(msg_exec))[:1200]}")
            exec_done = True
            break
          details.append(f"exec_error({pp})={msg_exec}")
        elif low.endswith(".py"):
          ok_exec, msg_exec = call_tool_once(
            "exec",
            {
              "cmd": "python",
              "args": [pp],
              "timeout_ms": 90000,
            },
          )
          if ok_exec:
            verified.append(f"MCP tool: exec(python {pp})")
            details.append(f"stdout={_extract_exec_stdout(_extract_tool_object(msg_exec))[:1200]}")
            exec_done = True
            break
          details.append(f"exec_error({pp})={msg_exec}")

      if (not exec_done) and (("python -m unittest -q" in qn) or ("python -m unittest discover -s tests -q" in qn)):
        cwd = ""
        if expanded_paths:
          first = expanded_paths[0]
          if re.match(r"^[A-Za-z]:\\", first):
            if first.lower().endswith((".ps1", ".py", ".md", ".json", ".txt", ".yaml", ".yml", ".ts", ".js")):
              cwd = str(Path(first).parent)
            else:
              cwd = first
        cmd = "python -m unittest discover -s tests -q" if ("discover -s tests -q" in qn) else "python -m unittest -q"
        if cwd:
          cmd = f"Set-Location '{cwd}'; {cmd}"
        ok_exec, msg_exec = call_tool_once(
          "exec",
          {
            "cmd": "powershell",
            "args": ["-NoProfile", "-Command", cmd],
            "timeout_ms": 120000,
          },
        )
        if ok_exec:
          verified.append(f"MCP tool: exec({cmd})")
          details.append(f"stdout={_extract_exec_stdout(_extract_tool_object(msg_exec))[:1200]}")
          exec_done = True
        else:
          details.append(f"exec_error(unittest)={msg_exec}")

      if (not exec_done) and ("pytest" in qn):
        cwd = ""
        if expanded_paths:
          first = expanded_paths[0]
          if re.match(r"^[A-Za-z]:\\", first):
            cwd = first if (not first.lower().endswith((".ps1", ".py", ".md", ".json", ".txt", ".yaml", ".yml", ".ts", ".js"))) else str(Path(first).parent)
        cmd = "python -m pytest -q"
        if cwd:
          cmd = f"Set-Location '{cwd}'; python -m pytest -q"
        ok_exec, msg_exec = call_tool_once(
          "exec",
          {
            "cmd": "powershell",
            "args": ["-NoProfile", "-Command", cmd],
            "timeout_ms": 180000,
          },
        )
        if ok_exec:
          verified.append("MCP tool: exec(python -m pytest -q)")
          details.append(f"stdout={_extract_exec_stdout(_extract_tool_object(msg_exec))[:1200]}")
          exec_done = True
        else:
          details.append(f"exec_error(pytest)={msg_exec}")

      if (not exec_done) and re.search(r"\bnpm\s+test\b", qn):
        cwd = ""
        if expanded_paths:
          first = expanded_paths[0]
          if re.match(r"^[A-Za-z]:\\", first):
            cwd = first if (not first.lower().endswith((".ps1", ".py", ".md", ".json", ".txt", ".yaml", ".yml", ".ts", ".js"))) else str(Path(first).parent)
        cmd = "npm test --silent"
        if cwd:
          cmd = f"Set-Location '{cwd}'; npm test --silent"
        ok_exec, msg_exec = call_tool_once(
          "exec",
          {
            "cmd": "powershell",
            "args": ["-NoProfile", "-Command", cmd],
            "timeout_ms": 180000,
          },
        )
        if ok_exec:
          verified.append("MCP tool: exec(npm test --silent)")
          details.append(f"stdout={_extract_exec_stdout(_extract_tool_object(msg_exec))[:1200]}")
          exec_done = True
        else:
          details.append(f"exec_error(npm_test)={msg_exec}")

    if re.search(r"(last|recent|последн).*(job|jobs|задач|ошиб)", qn) and "job_history_list" in allowed:
      limit = 10
      m_limit = re.search(r"\b(\d{1,3})\b", qn)
      if m_limit:
        try:
          limit = max(1, min(100, int(m_limit.group(1))))
        except Exception:
          limit = 10
      ok_j, msg_j = call_tool_once("job_history_list", {"limit": limit})
      if ok_j:
        verified.append(f"MCP tool: job_history_list(limit={limit})")
        details.append(f"jobs={_json_dumps(_extract_tool_object(msg_j), 1000)}")
      else:
        details.append(f"job_history_error={msg_j}")

    if "project_context_get" in allowed:
      ok_ctx, msg_ctx = call_tool_once("project_context_get", {"project_id": _project_id()})
      if ok_ctx:
        verified.append("MCP tool: project_context_get")
        details.append(f"context={_json_dumps(_extract_tool_object(msg_ctx), 800)}")
      else:
        details.append(f"context_error={msg_ctx}")

    if "memory_query" in allowed:
      ok_mem, msg_mem = call_tool_once("memory_query", {"project_id": _project_id(), "limit": 5})
      if ok_mem:
        verified.append("MCP tool: memory_query")
        details.append(f"memory={_json_dumps(_extract_tool_object(msg_mem), 700)}")
      else:
        details.append(f"memory_error={msg_mem}")

    candidate_path = _extract_candidate_path(task)
    if candidate_path and "fs" in allowed:
      expanded_paths = _expand_candidate_paths(candidate_path)
      read_ok = False
      for p in expanded_paths:
        ok_read, msg_read = call_tool_once("fs", {"op": "read_content", "path": p})
        if ok_read:
          verified.append(f"MCP tool: fs(op=read_content,path={p})")
          details.append(f"file_preview={_json_dumps(_extract_tool_object(msg_read), 1000)}")
          read_ok = True
          break
        details.append(f"file_read_error({p})={msg_read}")
      if (not read_ok) and expanded_paths:
        first = expanded_paths[0]
        if "\\" in first or "/" in first:
          dir_path = str(Path(first).parent)
          ok_ls, msg_ls = call_tool_once("fs", {"op": "list", "dir": dir_path, "limit": 50})
          if ok_ls:
            verified.append(f"MCP tool: fs(op=list,dir={dir_path})")
            details.append(f"dir_list={_json_dumps(_extract_tool_object(msg_ls), 800)}")

    if not verified:
      actions.append(_general_next_best_action(task))

    ans = _format_response(
      "operational",
      "Запрос отнесён к operational. Выполнена проверка через доступные project/memory/fs tools.",
      verified=verified,
      details=details,
      actions=actions,
    )
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "identity":
    ans = _identity_answer()
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": True,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "capabilities":
    ans = _capabilities_answer(sorted(list(allowed)))
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": True,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "improvement_plan":
    verified: List[str] = []
    details: List[str] = []
    qn = _norm(task)
    if ("преимущ" in qn) or ("сильн" in qn):
      actions = [
        "1) Ускорить planning/execution: сократить latency tasks/orchestrator + контролировать dispatch_success.",
        "2) Повысить масштабируемость: оптимизировать queue depth и worker concurrency профили.",
        "3) Улучшить адаптацию: регулярный evolution(shadow-first) только после full replay pass.",
        "4) Поддерживать качество: regression gate перед каждым promote/activate.",
        "5) KPI-контур: weekly отчёт по cycle time, success rate, regression rate.",
      ]
      summary = "План усиления преимуществ сформирован."
    else:
      actions = [
        "1) Стабилизация конфигурации: единый профиль env + preflight whoami/health.",
        "2) Async-first: длинные операции только через queue, без sync-таймаутов.",
        "3) Точность: запрет утверждений без evidence для project/operational запросов.",
        "4) Качество: обязательный replay_qa_full перед каждым промоутом.",
        "5) Мониторинг: weekly KPI (fallback_rate, intent_miss_rate, unsafe_claim_rate).",
      ]
      summary = "План устранения недостатков сформирован."
    if "worker_metrics_snapshot" in allowed:
      ok_w, msg_w = call_tool_once("worker_metrics_snapshot", {})
      if ok_w:
        w = _extract_tool_object(msg_w)
        compact_w = {
          "started": bool(w.get("started")) if isinstance(w, dict) else None,
          "workers_count": len(w.get("workers", [])) if isinstance(w, dict) and isinstance(w.get("workers"), list) else None,
        }
        verified.append("MCP tool: worker_metrics_snapshot")
        details.append(f"baseline_workers={_json_dumps(compact_w, 180)}")
    if "intelligence_meta_snapshot" in allowed:
      ok_m, msg_m = call_tool_once("intelligence_meta_snapshot", {})
      if ok_m:
        m = _extract_tool_object(msg_m)
        snap = m.get("snapshot", {}) if isinstance(m, dict) and isinstance(m.get("snapshot"), dict) else {}
        compact_meta = {
          "meta_state": snap.get("meta_state"),
          "arena_entropy": snap.get("arena_entropy"),
          "transfer_variance_trend": snap.get("transfer_variance_trend"),
          "gihi_delta_ultra": snap.get("gihi_delta_ultra"),
        }
        verified.append("MCP tool: intelligence_meta_snapshot")
        details.append(f"baseline_meta={_json_dumps(compact_meta, 220)}")

    ans = _format_response(
      "improvement_plan",
      summary,
      verified=verified,
      details=details,
      actions=actions,
    )
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "datetime":
    dt_fact = _solve_datetime_fact(task)
    if dt_fact:
      ans = dt_fact
      _update_session_context(task, intent, used_tools, ans)
      payload = {
        "ts_utc": _now_iso(),
        "policy_version": "labbrain_v2",
        "task": task,
        "intent": intent,
        "intent_confidence": confidence,
        "answer": ans,
        "identity_guard_applied": False,
        "used_tools": used_tools,
        "attempted_tools": attempted_tools,
        "evidence": evidence,
      }
      _log_learning_sample(payload)
      return _finalize_payload(payload)

    if "exec" in allowed:
      ok, msg = call_tool_once("exec", {
        "cmd": "powershell",
        "args": ["-NoProfile", "-Command", "Get-Date -Format 'dddd, yyyy-MM-dd HH:mm:ss'"],
        "timeout_ms": 10000,
      })
      if ok:
        text = _extract_tool_text(msg)
        dt_out = ""
        try:
          exec_payload = json.loads(text)
          dt_out = str(exec_payload.get("stdout", "")).strip()
        except Exception:
          dt_out = text.strip()
        ans = _format_response(
          "fact",
          f"Ð¡ÐµÐ¹Ñ‡Ð°Ñ: {dt_out}" if dt_out else "Ð’Ñ€ÐµÐ¼Ñ Ð¿Ð¾Ð»ÑƒÑ‡ÐµÐ½Ð¾.",
          verified=["MCP tool: exec(Get-Date)"],
        )
      else:
        ans = _format_response("error", "ÐÐµ ÑƒÐ´Ð°Ð»Ð¾ÑÑŒ Ð¿Ð¾Ð»ÑƒÑ‡Ð¸Ñ‚ÑŒ Ð²Ñ€ÐµÐ¼Ñ.", warnings=[msg])
      _update_session_context(task, intent, used_tools, ans)
      payload = {
        "ts_utc": _now_iso(),
        "policy_version": "labbrain_v2",
        "task": task,
        "intent": intent,
        "intent_confidence": confidence,
        "answer": ans,
        "identity_guard_applied": False,
        "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
      }
      _log_learning_sample(payload)
      return _finalize_payload(payload)

  if intent == "sync" and "sync" in allowed:
    ok, msg = call_tool_once("sync", {"op": "status"})
    if ok:
      obj = _extract_tool_object(msg)
      ans = _format_response("sync", "Ð¡Ñ‚Ð°Ñ‚ÑƒÑ ÑÐ¸Ð½Ñ…Ñ€Ð¾Ð½Ð¸Ð·Ð°Ñ†Ð¸Ð¸ Ð¿Ð¾Ð»ÑƒÑ‡ÐµÐ½.", verified=["MCP tool: sync(op=status)"], details=[_json_dumps(obj, 800)])
    else:
      ans = _format_response("error", "ÐÐµ ÑƒÐ´Ð°Ð»Ð¾ÑÑŒ Ð¿Ð¾Ð»ÑƒÑ‡Ð¸Ñ‚ÑŒ ÑÑ‚Ð°Ñ‚ÑƒÑ ÑÐ¸Ð½Ñ…Ñ€Ð¾Ð½Ð¸Ð·Ð°Ñ†Ð¸Ð¸.", warnings=[msg])
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "tasks" and "tasks" in allowed:
    ok, msg = call_tool_once("tasks", {"op": "list", "limit": 20})
    if ok:
      obj = _extract_tool_object(msg)
      ans = _format_response("tasks", "Ð¡Ð¿Ð¸ÑÐ¾Ðº Ð·Ð°Ð´Ð°Ñ‡ Ð¿Ð¾Ð»ÑƒÑ‡ÐµÐ½.", verified=["MCP tool: tasks(op=list)"], details=[_json_dumps(obj, 900)])
    else:
      ans = _format_response("error", "ÐÐµ ÑƒÐ´Ð°Ð»Ð¾ÑÑŒ Ð¿Ð¾Ð»ÑƒÑ‡Ð¸Ñ‚ÑŒ ÑÐ¿Ð¸ÑÐ¾Ðº Ð·Ð°Ð´Ð°Ñ‡.", warnings=[msg])
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "metrics":
    wm = None
    im = None
    if "worker_metrics_snapshot" in allowed:
      ok, msg = call_tool_once("worker_metrics_snapshot", {})
      if ok:
        wm = _extract_tool_object(msg)
    if "intelligence_meta_snapshot" in allowed:
      ok, msg = call_tool_once("intelligence_meta_snapshot", {})
      if ok:
        im = _extract_tool_object(msg)

    if wm is not None or im is not None:
      compact_workers = None
      if isinstance(wm, dict):
        workers = wm.get("workers") if isinstance(wm.get("workers"), list) else []
        compact_workers = [{
          "name": w.get("name"),
          "running": w.get("running"),
          "queue_depth": w.get("queue_depth"),
          "avg_exec_latency_ms": w.get("avg_exec_latency_ms"),
          "error_rate": w.get("worker_error_rate"),
        } for w in workers[:8] if isinstance(w, dict)]

      meta_snapshot = None
      if isinstance(im, dict):
        if isinstance(im.get("snapshot"), dict):
          meta_snapshot = im.get("snapshot")
        elif isinstance(im.get("content"), list) and im.get("content"):
          try:
            txt = str(im["content"][0].get("text", ""))
            parsed = json.loads(txt)
            if isinstance(parsed, dict) and isinstance(parsed.get("snapshot"), dict):
              meta_snapshot = parsed.get("snapshot")
          except Exception:
            pass

      compact_meta = None
      if isinstance(meta_snapshot, dict):
        compact_meta = {
          "arena_entropy": meta_snapshot.get("arena_entropy"),
          "transfer_variance_trend": meta_snapshot.get("transfer_variance_trend"),
          "gihi_delta_short": meta_snapshot.get("gihi_delta_short"),
          "gihi_delta_ultra": meta_snapshot.get("gihi_delta_ultra"),
          "meta_state": meta_snapshot.get("meta_state"),
        }

      ans = _format_response(
        "metrics",
        "Ð¢ÐµÐºÑƒÑ‰Ð¸Ðµ Ð¼ÐµÑ‚Ñ€Ð¸ÐºÐ¸ Ð»Ð°Ð±Ð¾Ñ€Ð°Ñ‚Ð¾Ñ€Ð¸Ð¸:",
        verified=["MCP tool: worker_metrics_snapshot", "MCP tool: intelligence_meta_snapshot"],
        details=[
          f"workers={_json_dumps(compact_workers, 800)}",
          f"meta={_json_dumps(compact_meta if compact_meta else im, 800)}",
        ],
      )
    else:
      ans = _format_response("error", "ÐÐµ ÑƒÐ´Ð°Ð»Ð¾ÑÑŒ ÑÐ½ÑÑ‚ÑŒ Ð¼ÐµÑ‚Ñ€Ð¸ÐºÐ¸.", warnings=["ÐŸÐ¾Ð´Ñ…Ð¾Ð´ÑÑ‰Ð¸Ðµ MCP tools Ð½ÐµÐ´Ð¾ÑÑ‚ÑƒÐ¿Ð½Ñ‹ Ð¸Ð»Ð¸ Ð²ÐµÑ€Ð½ÑƒÐ»Ð¸ Ð¾ÑˆÐ¸Ð±ÐºÑƒ."])

    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "fs" and "fs" in allowed:
    target_dir = r"C:\Users\anani\Projects"
    ok, msg = call_tool_once("fs", {"op": "list", "dir": target_dir, "limit": 100})
    if ok:
      obj = _extract_tool_object(msg)
      entries = []
      if isinstance(obj, dict):
        entries = (obj.get("entries") or [])[:20]
      names = []
      for e in entries:
        if isinstance(e, dict):
          names.append(f"{e.get('name', '')} ({e.get('type', '')})")
      ans = _format_response(
        "fs",
        f"ÐŸÐ°Ð¿ÐºÐ¸/Ñ„Ð°Ð¹Ð»Ñ‹ Ð² {target_dir}:",
        verified=["MCP tool: fs(op=list)"],
        details=names if names else [f"Raw={_json_dumps(obj, 800)}"],
      )
    else:
      ans = _format_response("error", "ÐÐµ ÑƒÐ´Ð°Ð»Ð¾ÑÑŒ Ð¿Ð¾Ð»ÑƒÑ‡Ð¸Ñ‚ÑŒ ÑÐ¿Ð¸ÑÐ¾Ðº Ñ„Ð°Ð¹Ð»Ð¾Ð².", warnings=[msg])

    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "weather":
    city = "Odesa, Ukraine"
    qn = _norm(task)
    if "ÐºÐ¸ÐµÐ²" in qn or "kyiv" in qn:
      city = "Kyiv, Ukraine"
    elif "Ð¾Ð´ÐµÑÑ" in qn or "odesa" in qn:
      city = "Odesa, Ukraine"

    # Route A: dedicated weather tool
    if "weather" in allowed:
      ok, msg = call_tool_once("weather", {"location": city})
      if ok:
        obj = _extract_tool_object(msg)
        if isinstance(obj, str) and ("Tool weather not found" in obj or "MCP error -32602" in obj):
          ok = False
      if ok:
        ans = _format_response("weather", f"ÐŸÐ¾Ð³Ð¾Ð´Ð° Ð´Ð»Ñ {city} Ð¿Ð¾Ð»ÑƒÑ‡ÐµÐ½Ð°.", verified=["MCP tool: weather"], details=[_json_dumps(obj, 1200)])
        _update_session_context(task, intent, used_tools, ans)
        payload = {
          "ts_utc": _now_iso(),
          "policy_version": "labbrain_v2",
          "task": task,
          "intent": intent,
          "intent_confidence": confidence,
          "answer": ans,
          "identity_guard_applied": False,
          "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
        }
        _log_learning_sample(payload)
        return _finalize_payload(payload)

    # Route B: web search fallback (multi-step). Prefer MCP web(op=search/read) when available.
    if "search_web" in allowed or "web" in allowed:
      query = f"weather today {city}"
      if "web" in allowed:
        ok, msg = call_tool_once("web", {"op": "search", "query": query, "max_results": 5})
        web_verified = "MCP tool: web(op=search)"
      else:
        ok, msg = call_tool_once("search_web", {"query": query, "max_results": 5})
        web_verified = "MCP tool: search_web"
      if ok:
        obj = _extract_tool_object(msg)
        lines: List[str] = []
        first_url = ""
        if isinstance(obj, dict):
          results = obj.get("results")
          if isinstance(results, list):
            for r in results[:5]:
              if isinstance(r, dict):
                title = str(r.get("title", "")).strip()
                url = _normalize_result_url(str(r.get("url", "")).strip())
                snippet = str(r.get("snippet", "")).strip()
                if not first_url and url:
                  first_url = url
                if title and url and snippet:
                  lines.append(f"{title} — {url} — {snippet}")
                elif title and url:
                  lines.append(f"{title} — {url}")
                elif url and snippet:
                  lines.append(f"{url} — {snippet}")
                elif url:
                  lines.append(url)
                elif title:
                  lines.append(title)

        extra_details: List[str] = []
        # Step 2: read first URL content when available.
        if first_url and "read_url_content" in allowed:
          ok2, msg2 = call_tool_once("read_url_content", {"url": first_url, "max_chars": 1800})
          if ok2:
            extra_details.append(f"read_url_content({first_url})={_json_dumps(_extract_tool_object(msg2), 700)}")
        elif first_url and "web" in allowed:
          ok2, msg2 = call_tool_once("web", {"op": "read", "url": first_url, "max_chars": 1800})
          if ok2:
            extra_details.append(f"web(op=read,url={first_url})={_json_dumps(_extract_tool_object(msg2), 700)}")

        if lines:
          ans = _format_response(
            "weather",
            f"ÐŸÐ¾Ð³Ð¾Ð´Ð° Ð´Ð»Ñ {city} (Ñ‡ÐµÑ€ÐµÐ· web-Ð¿Ð¾Ð¸ÑÐº):",
            verified=[web_verified],
            details=lines[:5] + extra_details,
          )
        else:
          # Route C: direct weather HTTP via exec (wttr.in JSON) when web results are empty.
          wttr_verified: List[str] = []
          wttr_details: List[str] = []
          if "exec" in allowed:
            wttr_city = city.split(",")[0].strip().replace(" ", "+")
            script = (
              "$ProgressPreference='SilentlyContinue'; "
              f"$u='https://wttr.in/{wttr_city}?format=j1'; "
              "$r=Invoke-RestMethod -Method Get -Uri $u -TimeoutSec 20; "
              "$cc=$r.current_condition[0]; "
              "$out=[ordered]@{"
              "temp_c=$cc.temp_C; feels_like_c=$cc.FeelsLikeC; "
              "humidity=$cc.humidity; wind_kmph=$cc.windspeedKmph; "
              "desc=($cc.weatherDesc[0].value) }; "
              "$out | ConvertTo-Json -Compress"
            )
            ok_w, msg_w = call_tool_once("exec", {
              "cmd": "powershell",
              "args": ["-NoProfile", "-Command", script],
              "timeout_ms": 25000,
            })
            if ok_w:
              wttr_verified.append("MCP tool: exec(wttr.in)")
              wttr_details.append(_extract_exec_stdout(_extract_tool_object(msg_w))[:900])

          if wttr_details:
            ans = _format_response(
              "weather",
              f"ÐŸÐ¾Ð³Ð¾Ð´Ð° Ð´Ð»Ñ {city} (exec fallback):",
              verified=[web_verified] + wttr_verified,
              details=[_json_dumps(obj, 600)] + wttr_details + extra_details,
            )
          else:
            fallback_actions = ["ÐŸÐ¾Ð²Ñ‚Ð¾Ñ€Ð¸Ñ‚Ðµ Ð·Ð°Ð¿Ñ€Ð¾Ñ Ð¿Ð¾Ð·Ð¶Ðµ Ð¸Ð»Ð¸ ÑƒÑ‚Ð¾Ñ‡Ð½Ð¸Ñ‚Ðµ Ð³Ð¾Ñ€Ð¾Ð´/ÑÑ‚Ñ€Ð°Ð½Ñƒ (Ð½Ð°Ð¿Ñ€Ð¸Ð¼ÐµÑ€: `Ð¿Ð¾Ð³Ð¾Ð´Ð° Odesa UA`)."]
            if "weather" in allowed:
              fallback_actions += ["ÐŸÐ¾Ð¿Ñ€Ð¾Ð±ÑƒÑŽ Ð¿Ñ€ÑÐ¼Ð¾Ð¹ `weather(location)` Ð¿Ð¾ ÑƒÑ‚Ð¾Ñ‡Ð½Ñ‘Ð½Ð½Ð¾Ð¼Ñƒ Ñ„Ð¾Ñ€Ð¼Ð°Ñ‚Ñƒ Ð³Ð¾Ñ€Ð¾Ð´Ð°."]
            ans = _format_response(
              "weather",
              f"ÐŸÐ¾Ð³Ð¾Ð´Ð° Ð´Ð»Ñ {city}: web-Ð¿Ð¾Ð¸ÑÐº Ð²Ñ‹Ð¿Ð¾Ð»Ð½ÐµÐ½, Ð½Ð¾ ÑÑ‚Ñ€ÑƒÐºÑ‚ÑƒÑ€Ð¸Ñ€Ð¾Ð²Ð°Ð½Ð½Ñ‹Ðµ Ñ€ÐµÐ·ÑƒÐ»ÑŒÑ‚Ð°Ñ‚Ñ‹ Ð¿ÑƒÑÑ‚Ñ‹Ðµ.",
              verified=[web_verified],
              details=[_json_dumps(obj, 900)] + extra_details,
              warnings=["Ð˜ÑÑ‚Ð¾Ñ‡Ð½Ð¸Ðº Ð¿Ð¾Ð¸ÑÐºÐ° Ð²ÐµÑ€Ð½ÑƒÐ» Ð¿ÑƒÑÑ‚Ð¾Ð¹ results[]"],
              actions=fallback_actions,
            )
      else:
        ans = _format_response("error", "ÐÐµ ÑƒÐ´Ð°Ð»Ð¾ÑÑŒ Ð²Ñ‹Ð¿Ð¾Ð»Ð½Ð¸Ñ‚ÑŒ web-Ð¿Ð¾Ð¸ÑÐº Ð¿Ð¾Ð³Ð¾Ð´Ñ‹.", warnings=[msg])

      _update_session_context(task, intent, used_tools, ans)
      payload = {
        "ts_utc": _now_iso(),
        "policy_version": "labbrain_v2",
        "task": task,
        "intent": intent,
        "intent_confidence": confidence,
        "answer": ans,
        "identity_guard_applied": False,
        "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
      }
      _log_learning_sample(payload)
      return _finalize_payload(payload)

  if intent == "web" and ("search_web" in allowed or "web" in allowed):
    direct_url = _extract_first_url(task)
    if direct_url:
      if "read_url_content" in allowed:
        ok_r, msg_r = call_tool_once("read_url_content", {"url": direct_url, "max_chars": 2200})
        if ok_r:
          ans = _format_response(
            "web",
            f"Открыл ссылку: {direct_url}",
            verified=["MCP tool: read_url_content"],
            details=[_json_dumps(_extract_tool_object(msg_r), 900)],
          )
          _update_session_context(task, intent, used_tools, ans)
          payload = {
            "ts_utc": _now_iso(),
            "policy_version": "labbrain_v2",
            "task": task,
            "intent": intent,
            "intent_confidence": confidence,
            "answer": ans,
            "identity_guard_applied": False,
            "used_tools": used_tools,
            "attempted_tools": attempted_tools,
            "evidence": evidence,
          }
          _log_learning_sample(payload)
          return _finalize_payload(payload)
      if "web" in allowed:
        ok_r, msg_r = call_tool_once("web", {"op": "read", "url": direct_url, "max_chars": 2200})
        if ok_r:
          ans = _format_response(
            "web",
            f"Открыл ссылку: {direct_url}",
            verified=["MCP tool: web(op=read)"],
            details=[_json_dumps(_extract_tool_object(msg_r), 900)],
          )
          _update_session_context(task, intent, used_tools, ans)
          payload = {
            "ts_utc": _now_iso(),
            "policy_version": "labbrain_v2",
            "task": task,
            "intent": intent,
            "intent_confidence": confidence,
            "answer": ans,
            "identity_guard_applied": False,
            "used_tools": used_tools,
            "attempted_tools": attempted_tools,
            "evidence": evidence,
          }
          _log_learning_sample(payload)
          return _finalize_payload(payload)

    if "web" in allowed:
      ok, msg = call_tool_once("web", {"op": "search", "query": task.strip(), "max_results": 5})
      web_verified = "MCP tool: web(op=search)"
    else:
      ok, msg = call_tool_once("search_web", {"query": task.strip(), "max_results": 5})
      web_verified = "MCP tool: search_web"
    if ok:
      obj = _extract_tool_object(msg)
      lines: List[str] = []
      first_url = ""
      if isinstance(obj, dict):
        results = obj.get("results")
        if isinstance(results, list):
          for r in results[:5]:
            if isinstance(r, dict):
              title = str(r.get("title", "")).strip()
              url = _normalize_result_url(str(r.get("url", "")).strip())
              snippet = str(r.get("snippet", "")).strip()
              if not first_url and url:
                first_url = url
              if title and url and snippet:
                lines.append(f"{title} — {url} — {snippet}")
              elif title and url:
                lines.append(f"{title} — {url}")
              elif url and snippet:
                lines.append(f"{url} — {snippet}")
              elif url:
                lines.append(url)
              elif title:
                lines.append(title)
      if lines:
        ans = _format_response("web", "ÐÐ°ÑˆÑ‘Ð» Ð² Ð¸Ð½Ñ‚ÐµÑ€Ð½ÐµÑ‚Ðµ:", verified=[web_verified], details=lines)
      else:
        # targeted read fallback for docs-like queries
        qn = _norm(task)
        if "read_url_content" in allowed:
          fallback_urls: List[Tuple[str, str]] = []
          if ("codex" in qn) or ("коди" in qn):
            fallback_urls.extend([
              ("OpenAI Codex", "https://openai.com/codex/"),
              ("OpenAI Platform Docs", "https://platform.openai.com/docs"),
            ])
          elif ("openai" in qn) or ("docs" in qn):
            fallback_urls.extend([
              ("OpenAI Platform Docs", "https://platform.openai.com/docs"),
              ("OpenAI", "https://openai.com"),
            ])
          if not fallback_urls:
            fallback_urls.append(("Wikipedia", "https://en.wikipedia.org/wiki/Main_Page"))

          read_details: List[str] = []
          read_verified: List[str] = [web_verified]
          for label, u in fallback_urls[:3]:
            ok_r, msg_r = call_tool_once("read_url_content", {"url": u, "max_chars": 2200})
            if ok_r:
              read_verified.append(f"MCP tool: read_url_content({u})")
              read_obj = _extract_tool_object(msg_r)
              snippet = ""
              if isinstance(read_obj, dict):
                snippet = str(read_obj.get("content", "")).replace("\n", " ").strip()[:280]
              read_details.append(f"{label}: {u}")
              if snippet:
                read_details.append(f"Snippet: {snippet}")
              ans = _format_response(
                "web",
                "Поиск вернул пустой results[], но удалось прочитать источник по теме.",
                verified=read_verified,
                details=read_details[:6],
              )
              break
          else:
            ans = _format_response("web", "ÐŸÐ¾Ð¸ÑÐº Ð²Ñ‹Ð¿Ð¾Ð»Ð½ÐµÐ½, Ð½Ð¾ ÑÑ‚Ñ€ÑƒÐºÑ‚ÑƒÑ€Ð¸Ñ€Ð¾Ð²Ð°Ð½Ð½Ñ‹Ðµ Ñ€ÐµÐ·ÑƒÐ»ÑŒÑ‚Ð°Ñ‚Ñ‹ Ð¿ÑƒÑÑ‚Ñ‹Ðµ.", verified=[web_verified], details=[_json_dumps(obj, 900)])
        else:
          ans = _format_response("web", "ÐŸÐ¾Ð¸ÑÐº Ð²Ñ‹Ð¿Ð¾Ð»Ð½ÐµÐ½, Ð½Ð¾ ÑÑ‚Ñ€ÑƒÐºÑ‚ÑƒÑ€Ð¸Ñ€Ð¾Ð²Ð°Ð½Ð½Ñ‹Ðµ Ñ€ÐµÐ·ÑƒÐ»ÑŒÑ‚Ð°Ñ‚Ñ‹ Ð¿ÑƒÑÑ‚Ñ‹Ðµ.", verified=[web_verified], details=[_json_dumps(obj, 900)])
    else:
      ans = _format_response("error", "ÐÐµ ÑƒÐ´Ð°Ð»Ð¾ÑÑŒ Ð²Ñ‹Ð¿Ð¾Ð»Ð½Ð¸Ñ‚ÑŒ web-Ð¿Ð¾Ð¸ÑÐº.", warnings=[msg])

    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "web" and "exec" in allowed:
    query = task.strip().replace("'", "''")
    script = (
      "$ProgressPreference='SilentlyContinue'; "
      f"$q='{query}'; "
      "$u='https://api.duckduckgo.com/?q='+[uri]::EscapeDataString($q)+'&format=json&no_redirect=1&no_html=1'; "
      "$r=Invoke-RestMethod -Method Get -Uri $u; "
      "$out=[ordered]@{ heading=$r.Heading; abstract=$r.AbstractText; answer=$r.Answer; related=($r.RelatedTopics | Select-Object -First 5) }; "
      "$out | ConvertTo-Json -Compress"
    )
    ok, msg = call_tool_once("exec", {
      "cmd": "powershell",
      "args": ["-NoProfile", "-Command", script],
      "timeout_ms": 20000,
    })
    if ok:
      obj = _extract_tool_object(msg)
      raw = _extract_exec_stdout(obj)
      ans = _format_response(
        "web",
        "ÐŸÐ¾Ð¸ÑÐº Ð²Ñ‹Ð¿Ð¾Ð»Ð½ÐµÐ½ Ñ‡ÐµÑ€ÐµÐ· exec fallback.",
        verified=["MCP tool: exec(duckduckgo-api)"],
        details=[raw[:900]],
      )
    else:
      ans = _format_response("error", "ÐÐµ ÑƒÐ´Ð°Ð»Ð¾ÑÑŒ Ð²Ñ‹Ð¿Ð¾Ð»Ð½Ð¸Ñ‚ÑŒ web-Ð¿Ð¾Ð¸ÑÐº Ñ‡ÐµÑ€ÐµÐ· exec fallback.", warnings=[msg])

    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "status":
    ctx = _load_session_context()
    quality_path = Path(__file__).resolve().parents[2] / "_sync" / "autogen_learning" / "quality_tick_latest.json"
    kpi_path = Path(__file__).resolve().parents[2] / "_sync" / "autogen_learning" / "brain_kpi_latest.json"
    quality = {}
    kpi = {}
    if quality_path.exists():
      try:
        quality = json.loads(quality_path.read_text(encoding="utf-8"))
      except Exception:
        quality = {}
    if kpi_path.exists():
      try:
        kpi = json.loads(kpi_path.read_text(encoding="utf-8"))
      except Exception:
        kpi = {}
    pm = _project_memory_summary(call_tool_once, allowed)
    summary = "Ð¡Ð¾ÑÑ‚Ð¾ÑÐ½Ð¸Ðµ ÑÐ¸ÑÑ‚ÐµÐ¼Ñ‹ ÑÐ¾Ð±Ñ€Ð°Ð½Ð¾."
    details = [
      f"session_id={_session_id()}",
      f"last_intent={ctx.get('last_intent', '')}",
      f"last_tools={_json_dumps(ctx.get('last_used_tools', []), 300)}",
      f"quality_score={quality.get('quality_score', 'n/a')}",
      f"kpi_coverage={kpi.get('coverage', 'n/a')}",
      f"kpi_autonomy_ratio={kpi.get('autonomy_ratio', 'n/a')}",
      f"project_id={pm.get('project_id', _project_id())}",
      f"project_memory_items={pm.get('memory_items', 0)}",
    ]
    ans = _format_response("status", summary, details=details)
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  # Direct repo maintenance route (docs-only + QA execution).
  if intent == "repo_maintenance" or (intent in {"general", "next_steps"} and _is_repo_maintenance_request(task)):
    verified: List[str] = []
    details: List[str] = []
    actions: List[str] = []
    warnings: List[str] = []
    repo_root = Path(__file__).resolve().parents[2]
    task_path = _extract_candidate_path(task)
    if task_path:
      p = Path(task_path)
      if not p.is_absolute():
        p = (repo_root / task_path).resolve()
      if p.suffix:
        p = p.parent
      repo_root = p.resolve()
    license_path = str((repo_root / "LICENSE").resolve())
    security_path = str((repo_root / "SECURITY.md").resolve())
    readme_path = str((repo_root / "README.md").resolve())

    if "fs" not in allowed or "exec" not in allowed:
      ans = _format_response(
        "repo_maintenance",
        "Direct apply route is available, but required tools are not allowed.",
        details=[
          f"fs_allowed={'fs' in allowed}",
          f"exec_allowed={'exec' in allowed}",
        ],
        warnings=["direct_apply_requires_fs_and_exec"],
      )
      _update_session_context(task, "repo_maintenance", used_tools, ans)
      payload = {
        "ts_utc": _now_iso(),
        "policy_version": "labbrain_v2",
        "task": task,
        "intent": "repo_maintenance",
        "intent_confidence": max(confidence, 0.9),
        "answer": ans,
        "identity_guard_applied": False,
        "used_tools": used_tools,
        "attempted_tools": attempted_tools,
        "evidence": evidence,
      }
      _log_learning_sample(payload)
      return _finalize_payload(payload)

    # Policy gate: docs-only writes inside repo.
    docs_targets = [license_path, security_path, readme_path]
    if any(not str(Path(p)).lower().startswith(str(repo_root).lower()) for p in docs_targets):
      ans = _format_response(
        "repo_maintenance",
        "Direct apply blocked by safety policy.",
        details=["target_path_outside_repo_root"],
        warnings=["direct_apply_docs_only_policy"],
      )
      _update_session_context(task, "repo_maintenance", used_tools, ans)
      payload = {
        "ts_utc": _now_iso(),
        "policy_version": "labbrain_v2",
        "task": task,
        "intent": "repo_maintenance",
        "intent_confidence": max(confidence, 0.9),
        "answer": ans,
        "identity_guard_applied": False,
        "used_tools": used_tools,
        "attempted_tools": attempted_tools,
        "evidence": evidence,
      }
      _log_learning_sample(payload)
      return _finalize_payload(payload)

    ok_license, msg_license = call_tool_once(
      "fs",
      {"op": "write_content", "path": license_path, "content": _mit_license_text()},
    )
    if ok_license:
      verified.append("MCP tool: fs(op=write_content) -> LICENSE")
    else:
      details.append(f"license_write_error={msg_license}")

    ok_security, msg_security = call_tool_once(
      "fs",
      {"op": "write_content", "path": security_path, "content": _security_md_text()},
    )
    if ok_security:
      verified.append("MCP tool: fs(op=write_content) -> SECURITY.md")
    else:
      details.append(f"security_write_error={msg_security}")

    readme_before = ""
    ok_readme, msg_readme = call_tool_once("fs", {"op": "read_content", "path": readme_path})
    if ok_readme:
      obj_readme = _extract_tool_object(msg_readme)
      if isinstance(obj_readme, dict):
        readme_before = str(obj_readme.get("content", "") or "")
      else:
        readme_before = str(obj_readme or "")
      verified.append("MCP tool: fs(op=read_content) -> README.md")
    else:
      details.append(f"readme_read_error={msg_readme}")

    updated_readme = _upsert_readme_section(
      readme_before,
      "Commercial Setup (Variant 1)",
      _commercial_setup_variant1_section(),
    )
    ok_readme_write, msg_readme_write = call_tool_once(
      "fs",
      {"op": "write_content", "path": readme_path, "content": updated_readme},
    )
    if ok_readme_write:
      verified.append("MCP tool: fs(op=write_content) -> README.md")
    else:
      details.append(f"readme_write_error={msg_readme_write}")

    qa_cmd = str((repo_root / "ops" / "autogen_engine" / "replay_qa_full.ps1").resolve())
    ok_qa, msg_qa = call_tool_once(
      "exec",
      {
        "cmd": "powershell",
        "args": [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          qa_cmd,
          "-JsonOnly",
        ],
        "cwd": str(repo_root),
        "timeout_ms": 240000,
      },
    )
    if ok_qa:
      qa_obj = _extract_tool_object(msg_qa)
      qa_stdout = _extract_exec_stdout(qa_obj)
      verified.append("MCP tool: exec(replay_qa_full.ps1 -JsonOnly)")
      details.append(f"replay_qa_full_stdout={qa_stdout[:1200]}")
    else:
      details.append(f"replay_qa_full_error={msg_qa}")

    success = ok_license and ok_security and ok_readme_write and ok_qa
    actions.append("LICENSE added/updated (MIT).")
    actions.append("SECURITY.md added/updated with reporting + token hygiene guidance.")
    actions.append("README.md updated with Commercial Setup (Variant 1).")
    actions.append("Replay QA executed with -JsonOnly.")

    ans = _format_response(
      "repo_maintenance",
      "Repo maintenance completed." if success else "Repo maintenance completed with errors.",
      verified=verified,
      details=details,
      actions=actions,
      warnings=warnings,
    )
    _update_session_context(task, "repo_maintenance", used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": "repo_maintenance",
      "intent_confidence": max(confidence, 0.9),
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  # Task intake router for ordinary goal-like requests (not only next_steps/controller).
  if intent in {"general", "next_steps"} and confidence >= 0.3 and _is_goal_intake(task) and "tasks" in allowed:
    details: List[str] = []
    verified: List[str] = []
    actions: List[str] = []
    project_id = _project_id()
    context = _build_goal_context_snapshot(call_tool_once, allowed, task)
    details.append(f"context={_json_dumps(context, 1100)}")
    if "project_context_get" in allowed:
      verified.append("MCP tool: project_context_get")
    if "memory_query" in allowed:
      verified.append("MCP tool: memory_query")
    if "intelligence_meta_snapshot" in allowed:
      verified.append("MCP tool: intelligence_meta_snapshot")

    code_goal = _is_code_change_goal(task)
    has_context = bool(context.get("context_present")) or int(context.get("memory_hits", 0)) > 0
    meta_state = str(context.get("meta_state", "")).strip().lower()
    stressed = (meta_state == "stressed")

    if code_goal and not has_context:
      # Policy gate: for code-change goals require project context/memory before dispatch.
      gate_task_id = f"brain:context-bootstrap:{int(time.time())}"
      gate_payload = {
        "op": "upsert",
        "id": gate_task_id,
        "title": "Clarify project context for code-change goal",
        "description": f"Goal requires context before code actions: {task}",
        "status": "todo",
        "labels": ["brain", "context", "gate", "code-change"],
      }
      ok_gate, msg_gate = call_tool_once("tasks", gate_payload)
      if ok_gate:
        verified.append("MCP tool: tasks(op=upsert)")
        details.append(f"context_bootstrap_task={_json_dumps(_extract_tool_object(msg_gate), 700)}")
      ans = _format_response(
        "task_brain",
        "Ð¦ÐµÐ»ÑŒ Ð¿Ñ€Ð¸Ð½ÑÑ‚Ð°, Ð½Ð¾ policy-gate Ð¾ÑÑ‚Ð°Ð½Ð¾Ð²Ð¸Ð» Ð°Ð²Ñ‚Ð¾Ð´Ð¸ÑÐ¿ÐµÑ‚Ñ‡ÐµÑ€Ð¸Ð·Ð°Ñ†Ð¸ÑŽ: Ð½Ðµ Ñ…Ð²Ð°Ñ‚Ð°ÐµÑ‚ ÐºÐ¾Ð½Ñ‚ÐµÐºÑÑ‚Ð° Ð¿Ñ€Ð¾ÐµÐºÑ‚Ð°.",
        verified=verified,
        details=details,
        actions=["Ð£Ñ‚Ð¾Ñ‡Ð½Ð¸Ñ‚Ðµ ÐºÐ¾Ð½Ñ‚ÐµÐºÑÑ‚/Ð¼Ð¾Ð´ÑƒÐ»Ð¸/ÐºÑ€Ð¸Ñ‚ÐµÑ€Ð¸Ð¸ Ð³Ð¾Ñ‚Ð¾Ð²Ð½Ð¾ÑÑ‚Ð¸. Ð—Ð°Ñ‚ÐµÐ¼ Ð¿Ð¾Ð²Ñ‚Ð¾Ñ€Ð¸Ñ‚Ðµ Ñ†ÐµÐ»ÑŒ."],
        warnings=["code_change_goal_requires_context"],
      )
      _update_session_context(task, intent, used_tools, ans)
      payload = {
        "ts_utc": _now_iso(),
        "policy_version": "labbrain_v2",
        "task": task,
        "intent": intent,
        "intent_confidence": confidence,
        "answer": ans,
        "identity_guard_applied": False,
        "used_tools": used_tools,
        "attempted_tools": attempted_tools,
        "evidence": evidence,
      }
      _log_learning_sample(payload)
      return _finalize_payload(payload)

    plan_payload: Dict[str, Any] = {
      "op": "plan_generate",
      "goal": task,
      "project_id": project_id,
      "max_tasks": 8,
    }
    # Feed planner with compact context snippet for less generic plans.
    if context.get("context_present") or context.get("memory_top"):
      plan_payload["description"] = _json_dumps(
        {
          "context": context.get("context", {}),
          "memory_top": context.get("memory_top", []),
          "keywords": context.get("keywords", []),
        },
        1600,
      )

    ok_plan, msg_plan = call_tool_once("tasks", plan_payload)
    if ok_plan:
      verified.append("MCP tool: tasks(op=plan_generate)")
      details.append(f"plan={_json_dumps(_extract_tool_object(msg_plan), 900)}")

      if stressed:
        actions.append("meta_state=stressed: Ð¿Ñ€Ð¸Ð¼ÐµÐ½ÐµÐ½ safe mode (Ð±ÐµÐ· dispatch), Ñ‚Ð¾Ð»ÑŒÐºÐ¾ Ð¿Ð»Ð°Ð½ + Ð¾Ñ€ÐºÐµÑÑ‚Ñ€Ð°Ñ‚Ð¾Ñ€.")
        warnings = ["meta_state_stressed_policy"]
      else:
        warnings = []

      ok_orch, msg_orch = call_tool_once("tasks", {
        "op": "orchestrator_tick",
        "project_id": project_id,
        "limit": 8,
      })
      if ok_orch:
        verified.append("MCP tool: tasks(op=orchestrator_tick)")
        details.append(f"orchestrator={_json_dumps(_extract_tool_object(msg_orch), 700)}")

      if not stressed:
        ok_bind, msg_bind = call_tool_once("tasks", {
          "op": "execution_bind_tick",
          "project_id": project_id,
          "limit": 8,
        })
        if ok_bind:
          verified.append("MCP tool: tasks(op=execution_bind_tick)")
          details.append(f"execution_bind={_json_dumps(_extract_tool_object(msg_bind), 700)}")
        if "agent_dispatch_tick" in allowed:
          ok_dispatch, msg_dispatch = call_tool_once("agent_dispatch_tick", {"limit": 8, "project_id": project_id})
          if ok_dispatch:
            verified.append("MCP tool: agent_dispatch_tick")
            details.append(f"dispatch={_json_dumps(_extract_tool_object(msg_dispatch), 700)}")
        actions.append("ÐŸÐ»Ð°Ð½ ÑÐ¾Ð·Ð´Ð°Ð½ Ð¸ Ð¾Ñ‚Ð¿Ñ€Ð°Ð²Ð»ÐµÐ½ Ð² Ð¾Ñ€ÐºÐµÑÑ‚Ñ€Ð°Ñ†Ð¸ÑŽ/Ð´Ð¸ÑÐ¿ÐµÑ‚Ñ‡ÐµÑ€Ð¸Ð·Ð°Ñ†Ð¸ÑŽ.")
      else:
        actions.append("Ð”Ð»Ñ stressed Ñ€ÐµÐ¶Ð¸Ð¼Ð°: Ð²Ñ‹Ð¿Ð¾Ð»Ð½Ð¸Ñ‚Ðµ ÐºÐ¾Ð½Ñ‚Ñ€Ð¾Ð»Ð»ÐµÑ€ Ð¸ Ð¼ÐµÑ‚Ð°-Ñ‚ÑŽÐ½ÐµÑ€ Ð¿ÐµÑ€ÐµÐ´ dispatch.")

      ans = _format_response(
        "task_brain",
        "Ð¦ÐµÐ»ÑŒ Ð¿Ñ€Ð¸Ð½ÑÑ‚Ð°: ÑÑ„Ð¾Ñ€Ð¼Ð¸Ñ€Ð¾Ð²Ð°Ð½ task graph.",
        verified=verified,
        details=details,
        actions=actions,
        warnings=warnings,
      )
    else:
      ans = _format_response(
        "task_brain",
        "Ð¦ÐµÐ»ÑŒ Ñ€Ð°ÑÐ¿Ð¾Ð·Ð½Ð°Ð½Ð°, Ð½Ð¾ Ð¿Ð»Ð°Ð½ Ð½Ðµ ÑÐ¾Ð·Ð´Ð°Ð½.",
        details=[f"plan_generate_error={msg_plan}"],
        actions=["ÐŸÑ€Ð¾Ð²ÐµÑ€ÑŒÑ‚Ðµ tasks API Ð¸ Ð¿Ð¾Ð²Ñ‚Ð¾Ñ€Ð¸Ñ‚Ðµ Ð·Ð°Ð¿Ñ€Ð¾Ñ."],
      )

    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  # Rescue route: if detector confidence is low but the prompt clearly asks about tools/model/clarification,
  # force deterministic intents to avoid repeated "need clarification" loops.
  qnorm = _norm(task)
  if intent == "general" and confidence < 0.5:
    if _is_action_request(task) and (("улучш" in qnorm) or ("восстанов" in qnorm) or ("почин" in qnorm) or ("исправ" in qnorm)) and (
      ("system_health" in qnorm) or ("meta_state" in qnorm) or ("stressed" in qnorm) or ("энтроп" in qnorm) or ("gihi" in qnorm) or ("систем" in qnorm)
    ):
      intent, confidence = "system_recovery", 0.93
    elif _is_action_request(task) and (("анализ" in qnorm) or ("идентификац" in qnorm) or ("metrics" in qnorm) or ("состояни" in qnorm)):
      intent, confidence = "operational_analysis", 0.93
    elif (("инструмент" in qnorm) or ("tools" in qnorm) or ("mcp" in qnorm)) and (not _is_action_request(task)):
      intent, confidence = "capabilities", 0.91
    elif ("модел" in qnorm) or ("llm" in qnorm) or ("backend" in qnorm):
      intent, confidence = "identity", 0.91
    elif ("логич" in qnorm) or ("головолом" in qnorm) or ("puzzle" in qnorm) or ("schedule" in qnorm) or ("slots" in qnorm):
      intent, confidence = "pure_logic", 0.91
    elif ("конкретизац" in qnorm) or ("clarification" in qnorm):
      intent, confidence = "constraints", 0.91
    elif any(
      x in qnorm
      for x in [
        "в интернете",
        "найди в интернете",
        "поиск в интернете",
        "в сети",
        "найди сайт",
        "сайт ",
        "github",
        "github.com",
        "search web",
        "find in internet",
        "find in web",
        "find website",
        "find site",
        "lookup",
      ]
    ):
      intent, confidence = "web", 0.92

  # Re-dispatch deterministic routes after rescue-updated intent.
  if intent == "system_recovery":
    verified: List[str] = []
    details: List[str] = []
    actions: List[str] = []
    warnings: List[str] = []
    steps: List[str] = []

    qn = _norm(task)
    loop_mode = bool(re.search(r"(автопетл|авто\s*цикл|recovery\s*loop|system\s*recovery\s*loop|\bloop\b|цикл\s+восстанов)", qn))
    iter_count = 20
    m_iter = re.search(r"(?:итерац|iterations?|тик(?:ов)?)\D{0,5}(\d{1,3})", qn)
    if m_iter:
      try:
        iter_count = max(1, min(120, int(m_iter.group(1))))
      except Exception:
        iter_count = 20
    else:
      m_any_num = re.search(r"\b(\d{1,3})\b", qn)
      if m_any_num:
        try:
          iter_count = max(1, min(120, int(m_any_num.group(1))))
        except Exception:
          iter_count = 20

    before = _build_operational_analysis_answer(call_tool_once, allowed)
    details.append("before_snapshot: captured")
    if "exec" in allowed:
      if loop_mode:
        run_iter = min(iter_count, 1)
        timeout_loop = max(120000, min(300000, run_iter * 120000))
        ok_loop, out_loop = _run_exec_ps_script(
          call_tool_once,
          "ops/autogen_engine/autogen_system_recovery_loop.ps1",
          timeout_ms=timeout_loop,
          extra_args=["-ProjectId", _project_id(), "-Iterations", str(run_iter), "-SleepSec", "0"],
        )
        if ok_loop:
          verified.append("MCP tool: exec(autogen_system_recovery_loop.ps1)")
          steps.append(f"recovery_loop=ok; iterations={run_iter}")
          if iter_count > run_iter:
            warnings.append("Для предотвращения timeout через chat-exec выполнена 1 итерация. Длинный loop запускайте из терминала.")
        else:
          warnings.append(f"recovery_loop_failed={out_loop}")
      else:
        ok1, out1 = _run_exec_ps_script(
          call_tool_once,
          "ops/autogen_engine/autogen_controller_tick.ps1",
          timeout_ms=180000,
          extra_args=["-ProjectId", _project_id()],
        )
        if ok1:
          verified.append("MCP tool: exec(autogen_controller_tick.ps1)")
          steps.append("controller_tick=ok")
        else:
          warnings.append(f"controller_tick_failed={out1}")
        ok2, out2 = _run_exec_ps_script(
          call_tool_once,
          "ops/autogen_engine/autogen_learning_analyzer_tick.ps1",
          timeout_ms=180000,
          extra_args=["-ProjectId", _project_id()],
        )
        if ok2:
          verified.append("MCP tool: exec(autogen_learning_analyzer_tick.ps1)")
          steps.append("learning_analyzer_tick=ok")
        else:
          warnings.append(f"learning_analyzer_tick_failed={out2}")
        ok3, out3 = _run_exec_ps_script(
          call_tool_once,
          "ops/autogen_engine/autogen_meta_stability_tick.ps1",
          timeout_ms=180000,
        )
        if ok3:
          verified.append("MCP tool: exec(autogen_meta_stability_tick.ps1)")
          steps.append("meta_stability_tick=ok")
        else:
          warnings.append(f"meta_stability_tick_failed={out3}")
    else:
      warnings.append("exec tool unavailable: automatic recovery scripts were not executed.")

    after = _build_operational_analysis_answer(call_tool_once, allowed)
    details.append("after_snapshot: captured")
    if steps:
      details.append("recovery_steps=" + ", ".join(steps))

    actions.append("Повторять system_recovery до исчезновения новых error_jobs и снижения stressed индикаторов.")
    actions.append("После стабилизации запустить quality_tick + replay_qa_full и проверить regression gates.")
    actions.append("Если error_jobs продолжают расти: проверить producers, которые отправляют queue_push(type=custom) без payload shape.")

    ans = _format_response(
      "system_recovery",
      "Recovery playbook выполнен: тики восстановления запущены и сделан post-check.",
      verified=verified,
      details=(details + ["--- BEFORE ---", before, "--- AFTER ---", after])[:8],
      actions=actions[:5],
      warnings=warnings[:5],
    )
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "operational_analysis":
    ans = _build_operational_analysis_answer(call_tool_once, allowed)
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "capabilities":
    ans = _capabilities_answer(sorted(list(allowed)))
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": True,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "capability_proof":
    verified: List[str] = []
    details: List[str] = []
    actions: List[str] = []
    warnings: List[str] = []

    # Advantage 1: planning + execution pipeline.
    planning_ok = False
    if "tasks" in allowed:
      ok_plan, msg_plan = call_tool_once("tasks", {
        "op": "plan_generate",
        "goal": "selftest: validate planning and execution pipeline",
        "project_id": _project_id(),
        "max_tasks": 3,
      })
      if ok_plan:
        planning_ok = True
        verified.append("MCP tool: tasks(op=plan_generate)")
        p_obj = _extract_tool_object(msg_plan)
        compact_plan = p_obj
        if isinstance(p_obj, dict):
          compact_plan = {
            "project_id": p_obj.get("project_id"),
            "created_count": len(p_obj.get("created", [])) if isinstance(p_obj.get("created"), list) else None,
          }
        details.append(f"plan_generate={_json_dumps(compact_plan, 220)}")
        ok_orch, msg_orch = call_tool_once("tasks", {
          "op": "orchestrator_tick",
          "project_id": _project_id(),
          "limit": 3,
        })
        if ok_orch:
          verified.append("MCP tool: tasks(op=orchestrator_tick)")
          orch_obj = _extract_tool_object(msg_orch)
          compact_orch = orch_obj
          if isinstance(orch_obj, dict):
            compact_orch = {
              "project_id": orch_obj.get("project_id"),
              "activated_count": len(orch_obj.get("activated", [])) if isinstance(orch_obj.get("activated"), list) else None,
              "remaining_open": orch_obj.get("remaining_open"),
            }
          details.append(f"orchestrator={_json_dumps(compact_orch, 220)}")
        if "agent_dispatch_tick" in allowed:
          ok_dispatch, msg_dispatch = call_tool_once("agent_dispatch_tick", {"limit": 3, "project_id": _project_id()})
        if ok_dispatch:
          verified.append("MCP tool: agent_dispatch_tick")
          dispatch_obj = _extract_tool_object(msg_dispatch)
          compact_dispatch = dispatch_obj if not isinstance(dispatch_obj, dict) else {
            "queued": dispatch_obj.get("queued"),
            "scanned": dispatch_obj.get("scanned"),
            "errors_count": len(dispatch_obj.get("errors", [])) if isinstance(dispatch_obj.get("errors"), list) else None,
          }
          details.append(f"dispatch={_json_dumps(compact_dispatch, 220)}")
      else:
        details.append(f"plan_generate_error={msg_plan}")
    else:
      warnings.append("tasks tool unavailable: cannot prove planning pipeline.")

    # Advantage 2: scalability/adaptation telemetry.
    scalability_ok = False
    if "worker_metrics_snapshot" in allowed:
      ok_w, msg_w = call_tool_once("worker_metrics_snapshot", {})
      if ok_w:
        scalability_ok = True
        verified.append("MCP tool: worker_metrics_snapshot")
        wobj = _extract_tool_object(msg_w)
        compact_workers = {}
        if isinstance(wobj, dict):
          workers = wobj.get("workers", [])
          compact_workers = {
            "started": wobj.get("started"),
            "workers_count": len(workers) if isinstance(workers, list) else None,
          }
        details.append(f"worker_metrics={_json_dumps(compact_workers if compact_workers else wobj, 220)}")
    if "intelligence_meta_snapshot" in allowed:
      ok_m, msg_m = call_tool_once("intelligence_meta_snapshot", {})
      if ok_m:
        scalability_ok = True
        verified.append("MCP tool: intelligence_meta_snapshot")
        mobj = _extract_tool_object(msg_m)
        snap = mobj.get("snapshot", {}) if isinstance(mobj, dict) and isinstance(mobj.get("snapshot"), dict) else {}
        compact_meta = {
          "meta_state": snap.get("meta_state"),
          "arena_entropy": snap.get("arena_entropy"),
          "transfer_variance_trend": snap.get("transfer_variance_trend"),
          "gihi_delta_ultra": snap.get("gihi_delta_ultra"),
        }
        details.append(f"meta_snapshot={_json_dumps(compact_meta if snap else mobj, 240)}")
    if not scalability_ok:
      warnings.append("metrics/meta tools unavailable: limited scalability evidence.")

    # Advantage 3: quick reaction to changes (async telemetry/readiness).
    reaction_ok = False
    if "job_history_list" in allowed:
      ok_j, msg_j = call_tool_once("job_history_list", {"limit": 5})
      if ok_j:
        reaction_ok = True
        verified.append("MCP tool: job_history_list")
        job_obj = _extract_tool_object(msg_j)
        compact_job = job_obj
        if isinstance(job_obj, dict) and isinstance(job_obj.get("items"), list):
          first = job_obj.get("items")[0] if job_obj.get("items") else {}
          compact_job = {
            "items_count": len(job_obj.get("items")),
            "latest_status": first.get("status") if isinstance(first, dict) else None,
            "latest_type": first.get("type") if isinstance(first, dict) else None,
          }
        details.append(f"job_history={_json_dumps(compact_job, 220)}")
    if not reaction_ok:
      warnings.append("queue/job tools unavailable: limited reaction-speed evidence.")

    if planning_ok and scalability_ok and reaction_ok:
      summary = "Преимущества подтверждены инструментально: planning/execution, scalability/adaptation, quick reaction."
    else:
      summary = "Часть преимуществ подтверждена инструментально, часть требует недостающих tools/настроек."
      actions.append("Для полного proof обеспечьте доступ к tools: tasks, agent_dispatch_tick, worker_metrics_snapshot, intelligence_meta_snapshot, queue_push, job_history_list.")

    ans = _format_response(
      "capability_proof",
      summary,
      verified=verified,
      details=details,
      actions=actions,
      warnings=warnings,
    )
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "identity":
    ans = _identity_answer()
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": True,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "constraints":
    ans = _constraints_answer(sorted(list(allowed)))
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  if intent == "operational":
    verified: List[str] = []
    details: List[str] = []
    actions: List[str] = []

    if "project_context_get" in allowed:
      ok_ctx, msg_ctx = call_tool_once("project_context_get", {"project_id": _project_id()})
      if ok_ctx:
        verified.append("MCP tool: project_context_get")
        details.append(f"context={_json_dumps(_extract_tool_object(msg_ctx), 800)}")
      else:
        details.append(f"context_error={msg_ctx}")

    if "memory_query" in allowed:
      ok_mem, msg_mem = call_tool_once("memory_query", {"project_id": _project_id(), "limit": 5})
      if ok_mem:
        verified.append("MCP tool: memory_query")
        details.append(f"memory={_json_dumps(_extract_tool_object(msg_mem), 700)}")
      else:
        details.append(f"memory_error={msg_mem}")

    candidate_path = _extract_candidate_path(task)
    if candidate_path and "fs" in allowed:
      expanded_paths = _expand_candidate_paths(candidate_path)
      read_ok = False
      for p in expanded_paths:
        ok_read, msg_read = call_tool_once("fs", {"op": "read_content", "path": p})
        if ok_read:
          verified.append(f"MCP tool: fs(op=read_content,path={p})")
          details.append(f"file_preview={_json_dumps(_extract_tool_object(msg_read), 1000)}")
          read_ok = True
          break
        details.append(f"file_read_error({p})={msg_read}")
      if (not read_ok) and expanded_paths:
        first = expanded_paths[0]
        if "\\" in first or "/" in first:
          dir_path = str(Path(first).parent)
          ok_ls, msg_ls = call_tool_once("fs", {"op": "list", "dir": dir_path, "limit": 50})
          if ok_ls:
            verified.append(f"MCP tool: fs(op=list,dir={dir_path})")
            details.append(f"dir_list={_json_dumps(_extract_tool_object(msg_ls), 800)}")

    if not verified:
      actions.append(_general_next_best_action(task))

    ans = _format_response(
      "operational",
      "Запрос отнесён к operational. Выполнена проверка через доступные project/memory/fs tools.",
      verified=verified,
      details=details,
      actions=actions,
    )
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  # Low-confidence guard (legacy strict mode). By default we allow general LLM fallback.
  if intent == "general" and confidence < 0.5 and os.getenv("LAB_STRICT_CLARIFY", "0") == "1":
    ans = _format_response(
      "clarify",
      "ÐÑƒÐ¶Ð½Ð° ÐºÐ¾Ð½ÐºÑ€ÐµÑ‚Ð¸Ð·Ð°Ñ†Ð¸Ñ Ð·Ð°Ð¿Ñ€Ð¾ÑÐ°, Ñ‡Ñ‚Ð¾Ð±Ñ‹ Ð´Ð°Ñ‚ÑŒ Ð¿Ñ€Ð¾Ð²ÐµÑ€ÑÐµÐ¼Ñ‹Ð¹ Ð¾Ñ‚Ð²ÐµÑ‚.",
      details=[
        "Ð¯ Ð¼Ð¾Ð³Ñƒ: Ð²Ñ€ÐµÐ¼Ñ/Ð´Ð°Ñ‚Ð°, Ð¼ÐµÑ‚Ñ€Ð¸ÐºÐ¸, Ð·Ð°Ð´Ð°Ñ‡Ð¸, ÑÐ¸Ð½Ñ…Ñ€Ð¾Ð½Ð¸Ð·Ð°Ñ†Ð¸Ñ, ÑÐ¿Ð¸ÑÐ¾Ðº Ñ„Ð°Ð¹Ð»Ð¾Ð², web-Ð¿Ð¾Ð¸ÑÐº, ÑÐ²Ð½Ñ‹Ð¹ Ð²Ñ‹Ð·Ð¾Ð² Ð¸Ð½ÑÑ‚Ñ€ÑƒÐ¼ÐµÐ½Ñ‚Ð°.",
      ],
      actions=[
        "ÐŸÑ€Ð¸Ð¼ÐµÑ€ 1: `ÐºÐ°ÐºÐ¾Ð¹ ÑÐµÐ¹Ñ‡Ð°Ñ Ð´ÐµÐ½ÑŒ Ð½ÐµÐ´ÐµÐ»Ð¸ Ð¸ Ð²Ñ€ÐµÐ¼Ñ`",
        "ÐŸÑ€Ð¸Ð¼ÐµÑ€ 2: `Ð¿Ð¾ÐºÐ°Ð¶Ð¸ Ð¼ÐµÑ‚Ñ€Ð¸ÐºÐ¸ Ð»Ð°Ð±Ð¾Ñ€Ð°Ñ‚Ð¾Ñ€Ð¸Ð¸`",
        "ÐŸÑ€Ð¸Ð¼ÐµÑ€ 3: `Ð¸ÑÐ¿Ð¾Ð»ÑŒÐ·ÑƒÐ¹ Ð¸Ð½ÑÑ‚Ñ€ÑƒÐ¼ÐµÐ½Ñ‚ whoami Ð¸ Ð¿Ð¾ÐºÐ°Ð¶Ð¸ ÐµÐ³Ð¾ Ð²Ñ‹Ð²Ð¾Ð´`",
      ],
    )
    _update_session_context(task, intent, used_tools, ans)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": ans,
      "identity_guard_applied": False,
      "quality_gate_applied": True,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)

  # LLM fallback with context and strict quality gate
  ctx = _load_session_context()
  context_hint = ""
  if ctx and intent != "general":
    context_hint = (
      f"Context: last_intent={ctx.get('last_intent','')}; "
      f"last_used_tools={_json_dumps(ctx.get('last_used_tools', []), 300)}"
    )

  client = build_client()
  agent = AssistantAgent(name="lab_brain", model_client=client, system_message=SYSTEM_PROMPT)
  prompt = task if not context_hint else f"{task}\n\n{context_hint}"
  result = None
  try:
    result = await agent.run(task=prompt)
  except Exception as e:
    await client.close()
    final_text = _format_response(
      "error",
      "LLM backend Ð½ÐµÐ´Ð¾ÑÑ‚ÑƒÐ¿ÐµÐ½, Ð¾Ñ‚Ð²ÐµÑ‚ ÑÐ³ÐµÐ½ÐµÑ€Ð¸Ñ€Ð¾Ð²Ð°Ñ‚ÑŒ Ð½Ðµ ÑƒÐ´Ð°Ð»Ð¾ÑÑŒ.",
      warnings=[str(e)],
      actions=["ÐŸÑ€Ð¾Ð²ÐµÑ€ÑŒÑ‚Ðµ Ð´Ð¾ÑÑ‚ÑƒÐ¿Ð½Ð¾ÑÑ‚ÑŒ OPENAI_BASE_URL Ð¸ Ð·Ð°Ð¿ÑƒÑÑ‚Ð¸Ñ‚Ðµ Ð¼Ð¾Ð´ÐµÐ»ÑŒÐ½Ñ‹Ð¹ ÑÐµÑ€Ð²ÐµÑ€."],
    )
    _update_session_context(task, intent, used_tools, final_text)
    payload = {
      "ts_utc": _now_iso(),
      "policy_version": "labbrain_v2",
      "task": task,
      "intent": intent,
      "intent_confidence": confidence,
      "answer": final_text,
      "identity_guard_applied": False,
      "quality_gate_applied": False,
      "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
      "llm_error": str(e),
    }
    _log_learning_sample(payload)
    return _finalize_payload(payload)
  await client.close()

  final_text = ""
  try:
    msgs = getattr(result, "messages", None) or []
    if msgs:
      final_text = str(getattr(msgs[-1], "content", "") or "")
  except Exception:
    final_text = ""

  guard_applied = False
  quality_gate_applied = False
  if _is_identity_question(task):
    final_text = _identity_answer()
    guard_applied = True
  elif _is_capabilities_question(task):
    final_text = _capabilities_answer(sorted(list(allowed)))
    guard_applied = True
  elif _is_constraints_question(task):
    final_text = _constraints_answer(sorted(list(allowed)))
    guard_applied = True
  elif _contains_identity_hallucination(final_text):
    if intent in {"identity", "capabilities", "constraints"}:
      final_text = _identity_answer()
      guard_applied = True
    else:
      stripped = _strip_identity_preamble(final_text)
      if stripped:
        final_text = stripped
      quality_gate_applied = True
  elif _requires_tool_evidence(task) and len(used_tools) == 0:
    final_text = (
      "Ð”Ð»Ñ ÑÑ‚Ð¾Ð³Ð¾ Ð·Ð°Ð¿Ñ€Ð¾ÑÐ° Ð½ÑƒÐ¶ÐµÐ½ Ð¿Ð¾Ð´Ñ‚Ð²ÐµÑ€Ð¶Ð´Ð°ÑŽÑ‰Ð¸Ð¹ Ð²Ñ‹Ð·Ð¾Ð² Ð¸Ð½ÑÑ‚Ñ€ÑƒÐ¼ÐµÐ½Ñ‚Ð°, "
      "Ð½Ð¾ tool route Ð½Ðµ ÑÑ€Ð°Ð±Ð¾Ñ‚Ð°Ð». Ð£Ñ‚Ð¾Ñ‡Ð½Ð¸Ñ‚Ðµ Ð·Ð°Ð¿Ñ€Ð¾Ñ Ð¸Ð»Ð¸ Ð¿Ñ€Ð¾Ð²ÐµÑ€ÑŒÑ‚Ðµ Ð´Ð¾ÑÑ‚ÑƒÐ¿Ð½Ð¾ÑÑ‚ÑŒ MCP tools."
    )
    quality_gate_applied = True
  elif intent == "general" and len(used_tools) == 0 and _is_science_general_question(task):
    stripped = _strip_identity_preamble(final_text)
    base = stripped if stripped else final_text
    final_text = _format_response(
      "general",
      base if base else "Базовое объяснение по общим знаниям.",
      warnings=["Это базовое объяснение без инструментальной проверки фактов."],
    )
    quality_gate_applied = True
  elif intent == "general" and len(used_tools) == 0 and _needs_verification_general(task, final_text):
    stripped = _strip_identity_preamble(final_text)
    base = stripped if stripped else final_text
    final_text = _format_response(
      "general",
      base if base else "Дан предварительный ответ.",
      actions=[_general_next_best_action(task)],
      warnings=["Это предварительный ответ без tool-evidence. Для точности выполните проверку инструментами."],
    )
    quality_gate_applied = True

  _update_session_context(task, intent, used_tools, final_text)
  domain_signature = _detect_domain_signature(task, intent, used_tools)
  payload = {
    "ts_utc": _now_iso(),
    "policy_version": "labbrain_v2",
    "task": task,
    "intent": intent,
    "domain_signature": domain_signature,
    "intent_confidence": confidence,
    "answer": final_text,
    "identity_guard_applied": guard_applied,
    "quality_gate_applied": quality_gate_applied,
    "used_tools": used_tools,
      "attempted_tools": attempted_tools,
      "evidence": evidence,
    "result": str(result),
  }
  _log_learning_sample(payload)
  return _finalize_payload(payload)


def main() -> None:
  try:
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
  except Exception:
    pass

  parser = argparse.ArgumentParser()
  parser.add_argument("--task", required=False, default="", help="Brain task to execute.")
  parser.add_argument("--task-file", required=False, default="", help="UTF-8 file containing task text.")
  parser.add_argument("--json-out", default="", help="Optional path to write JSON output.")
  parser.add_argument("--plain", action="store_true", help="Print only assistant answer text.")
  args = parser.parse_args()
  task_text = str(args.task or "")
  if args.task_file:
    try:
      task_text = Path(args.task_file).read_text(encoding="utf-8")
    except Exception as e:
      err_obj = {
        "schema_version": "labbrain.contract.v1",
        "ts_utc": _now_iso(),
        "task": "",
        "intent": "error",
        "confidence": 1.0,
        "plan": [],
        "tool_calls": [],
        "evidence": [],
        "warnings": [f"task_file_read_failed: {e}"],
        "answer": "Failed to read task file.",
      }
      print(json.dumps(err_obj, ensure_ascii=False, indent=2))
      return
  if not task_text.strip():
    err_obj = {
      "schema_version": "labbrain.contract.v1",
      "ts_utc": _now_iso(),
      "task": "",
      "intent": "error",
      "confidence": 1.0,
      "plan": [],
      "tool_calls": [],
      "evidence": [],
      "warnings": ["empty_task"],
      "answer": "Empty task.",
    }
    print(json.dumps(err_obj, ensure_ascii=False, indent=2))
    return

  import asyncio

  payload = asyncio.run(run_brain(task_text))
  payload = _sanitize_text_encoding(payload)
  contract = _sanitize_text_encoding(_build_output_contract(payload))
  valid_contract, contract_errors = _validate_output_contract(contract)
  payload["contract_v1"] = contract
  payload["contract_valid"] = valid_contract
  if not valid_contract:
    payload["contract_errors"] = contract_errors
  _log_contract_snapshot(payload, contract, valid_contract)
  _log_decision_trace(payload, contract, valid_contract)

  strict_json_only = os.getenv("LAB_OUTPUT_STRICT_JSON", "0") == "1"
  output_obj: Dict[str, Any] = contract if strict_json_only else payload
  if args.plain:
    print(contract.get("answer", ""))
    text = _json_dumps(output_obj)
  else:
    text = json.dumps(output_obj, ensure_ascii=False, indent=2)
    print(text)

  if args.json_out:
    Path(args.json_out).write_text(text, encoding="utf-8")


if __name__ == "__main__":
  main()


