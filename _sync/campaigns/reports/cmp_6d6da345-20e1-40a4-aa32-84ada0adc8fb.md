# Campaign Report: cmp_6d6da345-20e1-40a4-aa32-84ada0adc8fb

## Goal
stabilize medium|high|low|p5 variance and reduce entropy

## Objective
```json
"maximize score"
```

## Summary
- Status: running
- Experiments planned max: 36
- Experiments run: 16
- Ticks: 4
- Stop reason: n/a

## Best Strategy Per Domain
```json
[
  {
    "domain_signature": "small|high|low|p2",
    "best_strategy": {
      "strategy_id": "stg_seed_1771253469491_4783f8_2",
      "version_id": "v_seed_1771253469491_2",
      "fitness": 0.141832,
      "status": "active",
      "win_rate": 0.015267,
      "convergence_speed": 0.071146,
      "variance_stability": 0.999829,
      "transfer_usage": 0.415606,
      "allocation_weight": 0.247895,
      "selection_count_window": 0
    }
  },
  {
    "domain_signature": "small|low|low|p2",
    "best_strategy": {
      "strategy_id": "stg_seed_1771253469491_fbd431_2",
      "version_id": "v_seed_1771253469491_2",
      "fitness": 0.137481,
      "status": "shadow",
      "win_rate": 0.048338,
      "convergence_speed": 0.224044,
      "variance_stability": 0.998544,
      "transfer_usage": 0.351795,
      "allocation_weight": 0.188077,
      "selection_count_window": 0
    }
  },
  {
    "domain_signature": "small|high|low|p5",
    "best_strategy": {
      "strategy_id": "stg_seed_1771253469491_968a46_2",
      "version_id": "v_seed_1771253469491_2",
      "fitness": 0.124264,
      "status": "active",
      "win_rate": 0.142857,
      "convergence_speed": 1,
      "variance_stability": 1,
      "transfer_usage": 0.5,
      "allocation_weight": 0.45,
      "selection_count_window": 0
    }
  },
  {
    "domain_signature": "small|low|low|p5",
    "best_strategy": {
      "strategy_id": "stg_bd63d4f3-f87a-4262-b9eb-844987f210f9",
      "version_id": "v_1771254248323",
      "fitness": 0.181265,
      "status": "shadow",
      "win_rate": 0.388889,
      "convergence_speed": 0.204545,
      "variance_stability": 0.999671,
      "transfer_usage": 0.14821,
      "allocation_weight": 0.1,
      "selection_count_window": 0
    }
  },
  {
    "domain_signature": "medium|high|low|p5",
    "best_strategy": {
      "strategy_id": "stg_8d55394f-75bd-460d-8e63-dfc7b6aed17b",
      "version_id": "v_1771256710428",
      "fitness": 0.316753,
      "status": "shadow",
      "win_rate": 0,
      "convergence_speed": 0.085714,
      "variance_stability": 0.999957,
      "transfer_usage": 0.248193,
      "allocation_weight": 0.1,
      "selection_count_window": 0
    }
  },
  {
    "domain_signature": "medium|low|low|p5",
    "best_strategy": {
      "strategy_id": "stg_2e816fa2-b922-4fef-a55c-82f31b9b4ec7",
      "version_id": "v_1771399263330",
      "fitness": 0.124344,
      "status": "inactive",
      "win_rate": 0,
      "convergence_speed": 0.257143,
      "variance_stability": 1,
      "transfer_usage": 0.711546,
      "allocation_weight": 0.124344,
      "selection_count_window": 0
    }
  }
]
```

## Best Parameters
```json
[
  {
    "experiment_id": "exp_e3886581-0475-4d7a-b5cb-939b9b5f5205",
    "run_id": "run_2713fdcb-deef-4338-9874-82cbf49404c6",
    "params": {
      "exploration_bias": 0.6,
      "narrowing_factor": 1
    },
    "score": 0.9754
  }
]
```

## Convergence Summary
```json
{
  "experiments_total": 2,
  "converged_count": 0,
  "details": [
    {
      "experiment_id": "exp_e3886581-0475-4d7a-b5cb-939b9b5f5205",
      "converged": false,
      "completed_runs": 17,
      "stagnation_rate": 0.75
    },
    {
      "experiment_id": "exp_b348f2bd-77a0-4233-8fd4-59be5dd5532e",
      "converged": false,
      "completed_runs": 0,
      "stagnation_rate": 1
    }
  ]
}
```

## Evolution Summary
```json
{
  "mutation_effectiveness": {
    "generated_at": "2026-02-20T09:03:00.424Z",
    "adaptive_mutation": {
      "total_mutations": 5,
      "improved_after_mutation": 3,
      "mutation_effectiveness_ratio": 0.6
    },
    "meta_mutation": {
      "total_mutations": 1,
      "improved_after_mutation": 1,
      "mutation_effectiveness_ratio": 1
    },
    "overall": {
      "total_mutations": 6,
      "improved_after_mutation": 4,
      "mutation_effectiveness_ratio": 0.666667
    }
  },
  "lineage_nodes": 5
}
```

## Transfer Summary
```json
{
  "generated_at": "2026-02-20T09:03:00.952Z",
  "transfer_success_rate": 0.204124,
  "average_similarity": 0.116701,
  "average_transfer_confidence": 0.115132,
  "average_transfer_match_confidence": 0.115132,
  "average_transfer_evidence_confidence": 0.484058,
  "average_transfer_confidence_applied": 0.912,
  "average_transfer_match_confidence_applied": 0.098077,
  "transfer_variance_applied_micro": 0.000006,
  "transfer_variance_applied_micro_raw": 0.000005826677907225068,
  "transfer_variance_applied_micro_display": "0.000006",
  "transfer_variance_applied_micro_n": 380,
  "transfer_variance_applied_micro_applied": 380,
  "transfer_variance_applied_micro_signal": "transfer_confidence",
  "transfer_variance_applied_micro_min": 0.092729,
  "transfer_variance_applied_micro_max": 0.105519,
  "applied_micro_signals_sample": [
    0.097341,
    0.097341,
    0.097341,
    0.097341,
    0.097569,
    0.097569,
    0.097394,
    0.097394,
    0.097394,
    0.097394,
    0.097394,
    0.097394
  ],
  "share_conf_below_confmin_among_applied": 0,
  "reuse_block_rate": 0,
  "anomaly_rate": 0.021026,
  "impact_applied_share": 0.204124,
  "micro_gate_block_share": 0,
  "obs_gate_block_share": 0,
  "micro_gate_pass_share": 1,
  "micro_gate_pass_share_strict": 1,
  "micro_success_block_share": 0.030369,
  "micro_impact_throttled_share": 0.093275,
  "micro_impact_throttled_by_budget_share": 0.093275,
  "micro_cooldown_active_share": 0,
  "micro_domain_tick_cooldown_share": 0,
  "micro_attempted_share": 0.91757,
  "micro_blocked_by_domain_tick_cooldown_count": 0,
  "micro_blocked_by_domain_tick_cooldown_share": 0,
  "micro_blocked_by_budget_count": 43,
  "micro_blocked_by_budget_share": 0.101655,
  "micro_not_considered_due_to_budget_count": 0,
  "micro_not_considered_due_to_budget_share": 0,
  "micro_blocked_by_other_gates_count": 0,
  "micro_blocked_by_other_gates_share": 0,
  "micro_applied_share": 0.824295,
  "evidence_gate_flag_invalid_count": 0,
  "impact_attempted_count": 404,
  "impact_skip_reason_breakdown": {
    "impact_level_none": 43,
    "impact_allowed_micro_false": 14
  },
  "missing_evidence_gate_count": 1308,
  "transfer_success_signal_full_share": 0,
  "transfer_success_signal_micro_share": 0,
  "impact_level_share": {
    "none": 0.123644,
    "micro": 0.824295,
    "full": 0.052061
  },
  "avg_impact_scale_micro": 0.043026,
  "cap_micro_used_avg": 0.043026,
  "cap_micro_used_p95": 0.05,
  "low_confidence_domain_share": 0,
  "counts": {
    "experiments_completed": 4661,
    "experiment_complete_with_evidence_gate": 2730,
    "experiment_complete_with_evidence_gate_schema_v2": 1632,
    "experiment_complete_with_evidence_gate_legacy": 1098,
    "transfer_initialized": 2861,
    "transfer_successful": 584,
    "transfer_with_evidence_gate": 1553,
    "transfer_with_evidence_gate_schema_v2": 461,
    "transfer_with_evidence_gate_legacy": 1092
  },
  "recent_window": {
    "events_considered": 2000,
    "experiment_complete_with_evidence_gate": 1786,
    "experiment_complete_with_evidence_gate_schema_v2": 1632,
    "experiment_complete_with_evidence_gate_legacy": 154,
    "transfer_initialized": 611,
    "transfer_with_evidence_gate": 609,
    "transfer_with_evidence_gate_schema_v2": 461,
    "transfer_with_evidence_gate_legacy": 148,
    "missing_evidence_gate_count": 2,
    "missing_evidence_gate_share": 0.003273,
    "micro_applied_share": 0.824295,
    "micro_blocked_by_budget_share": 0.093275,
    "micro_not_considered_due_to_budget_share": 0
  },
  "per_domain_transfer": [
    {
      "domain_signature": "small|low|low|p2",
      "experiments_total": 131,
      "transfer_initialized": 131,
      "confidence_observations": 131,
      "evidence_observations": 0,
      "transfer_success_rate": 0.40458,
      "transfer_variance": 0.240895,
      "transfer_variance_applied_micro": 0.000022751299701836837,
      "transfer_variance_applied_micro_n": 29,
      "transfer_variance_applied_micro_applied": 29,
      "transfer_variance_applied_micro_signal": "transfer_confidence",
      "transfer_variance_applied_micro_min": 0.09609502890487501,
      "transfer_variance_applied_micro_max": 0.10551933651,
      "average_transfer_confidence": 0.109186,
      "average_transfer_evidence_confidence": 0,
      "average_impact_scale_micro": 0.038793,
      "impact_applied_share": 0.40458,
      "impact_applied_share_micro": 0.221374,
      "memory_updated_share": 0.969466
    },
    {
      "domain_signature": "medium|high|low|p5",
      "experiments_total": 1678,
      "transfer_initialized": 1678,
      "confidence_observations": 1678,
      "evidence_observations": 541,
      "transfer_success_rate": 0.307509,
      "transfer_variance": 0.212947,
      "transfer_variance_applied_micro": 0.0000030473482914436555,
      "transfer_variance_applied_micro_n": 511,
      "transfer_variance_applied_micro_applied": 511,
      "transfer_variance_applied_micro_signal": "transfer_confidence",
      "transfer_variance_applied_micro_min": 0.09272888058887097,
      "transfer_variance_applied_micro_max": 0.099748,
      "average_transfer_confidence": 0.110736,
      "average_transfer_evidence_confidence": 0.531553,
      "average_impact_scale_micro": 0.045205,
      "impact_applied_share": 0.307509,
      "impact_applied_share_micro": 0.304529,
      "memory_updated_share": 0.905244
    },
    {
      "domain_signature": "small|low|low|p5",
      "experiments_total": 1052,
      "transfer_initialized": 1052,
      "confidence_observations": 1052,
      "evidence_observations": 561,
      "transfer_success_rate": 0.014259,
      "transfer_variance": 0.014055,
      "transfer_variance_applied_micro": 1.7066666666641587e-11,
      "transfer_variance_applied_micro_n": 15,
      "transfer_variance_applied_micro_applied": 15,
      "transfer_variance_applied_micro_signal": "transfer_confidence",
      "transfer_variance_applied_micro_min": 0.096435,
      "transfer_variance_applied_micro_max": 0.096443,
      "average_transfer_confidence": 0.122884,
      "average_transfer_evidence_confidence": 0.352282,
      "average_impact_scale_micro": 0.05,
      "impact_applied_share": 0.014259,
      "impact_applied_share_micro": 0.014259,
      "memory_updated_share": 0.84981
    },
    {
      "domain_signature": "unknown",
      "experiments_total": 1800,
      "transfer_initialized": 0,
      "confidence_observations": 0,
      "evidence_observations": 0,
      "transfer_success_rate": 0,
      "transfer_variance": 0,
      "transfer_variance_applied_micro": null,
      "transfer_variance_applied_micro_n": 0,
      "transfer_variance_applied_micro_applied": 0,
      "transfer_variance_applied_micro_signal": null,
      "transfer_variance_applied_micro_min": null,
      "transfer_variance_applied_micro_max": null,
      "average_transfer_confidence": 0,
      "average_transfer_evidence_confidence": 0,
      "average_impact_scale_micro": 0,
      "impact_applied_share": 0,
      "impact_applied_share_micro": 0,
      "memory_updated_share": 0
    }
  ],
  "stressed_driver_breakdown": {
    "high_variance_domains": [
      {
        "domain_signature": "small|low|low|p2",
        "experiments_total": 131,
        "transfer_initialized": 131,
        "confidence_observations": 131,
        "evidence_observations": 0,
        "transfer_success_rate": 0.40458,
        "transfer_variance": 0.240895,
        "transfer_variance_applied_micro": 0.000022751299701836837,
        "transfer_variance_applied_micro_n": 29,
        "transfer_variance_applied_micro_applied": 29,
        "transfer_variance_applied_micro_signal": "transfer_confidence",
        "transfer_variance_applied_micro_min": 0.09609502890487501,
        "transfer_variance_applied_micro_max": 0.10551933651,
        "average_transfer_confidence": 0.109186,
        "average_transfer_evidence_confidence": 0,
        "average_impact_scale_micro": 0.038793,
        "impact_applied_share": 0.40458,
        "impact_applied_share_micro": 0.221374,
        "memory_updated_share": 0.969466
      },
      {
        "domain_signature": "medium|high|low|p5",
        "experiments_total": 1678,
        "transfer_initialized": 1678,
        "confidence_observations": 1678,
        "evidence_observations": 541,
        "transfer_success_rate": 0.307509,
        "transfer_variance": 0.212947,
        "transfer_variance_applied_micro": 0.0000030473482914436555,
        "transfer_variance_applied_micro_n": 511,
        "transfer_variance_applied_micro_applied": 511,
        "transfer_variance_applied_micro_signal": "transfer_confidence",
        "transfer_variance_applied_micro_min": 0.09272888058887097,
        "transfer_variance_applied_micro_max": 0.099748,
        "average_transfer_confidence": 0.110736,
        "average_transfer_evidence_confidence": 0.531553,
        "average_impact_scale_micro": 0.045205,
        "impact_applied_share": 0.307509,
        "impact_applied_share_micro": 0.304529,
        "memory_updated_share": 0.905244
      }
    ],
    "high_variance_domains_top2": [
      {
        "domain_signature": "small|low|low|p2",
        "experiments_total": 131,
        "transfer_initialized": 131,
        "confidence_observations": 131,
        "evidence_observations": 0,
        "transfer_success_rate": 0.40458,
        "transfer_variance": 0.240895,
        "transfer_variance_applied_micro": 0.000022751299701836837,
        "transfer_variance_applied_micro_n": 29,
        "transfer_variance_applied_micro_applied": 29,
        "transfer_variance_applied_micro_signal": "transfer_confidence",
        "transfer_variance_applied_micro_min": 0.09609502890487501,
        "transfer_variance_applied_micro_max": 0.10551933651,
        "average_transfer_confidence": 0.109186,
        "average_transfer_evidence_confidence": 0,
        "average_impact_scale_micro": 0.038793,
        "impact_applied_share": 0.40458,
        "impact_applied_share_micro": 0.221374,
        "memory_updated_share": 0.969466
      },
      {
        "domain_signature": "medium|high|low|p5",
        "experiments_total": 1678,
        "transfer_initialized": 1678,
        "confidence_observations": 1678,
        "evidence_observations": 541,
        "transfer_success_rate": 0.307509,
        "transfer_variance": 0.212947,
        "transfer_variance_applied_micro": 0.0000030473482914436555,
        "transfer_variance_applied_micro_n": 511,
        "transfer_variance_applied_micro_applied": 511,
        "transfer_variance_applied_micro_signal": "transfer_confidence",
        "transfer_variance_applied_micro_min": 0.09272888058887097,
        "transfer_variance_applied_micro_max": 0.099748,
        "average_transfer_confidence": 0.110736,
        "average_transfer_evidence_confidence": 0.531553,
        "average_impact_scale_micro": 0.045205,
        "impact_applied_share": 0.307509,
        "impact_applied_share_micro": 0.304529,
        "memory_updated_share": 0.905244
      }
    ],
    "low_confidence_domains": []
  }
}
```

## Intelligence Health Trajectory
```json
{
  "global": [
    {
      "ts": "2026-02-19T14:29:41.518Z",
      "global_research_fitness": 0.144505,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:29:45.041Z",
      "global_research_fitness": 0.144515,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:29:46.402Z",
      "global_research_fitness": 0.144522,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:29:47.414Z",
      "global_research_fitness": 0.144519,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:29:49.476Z",
      "global_research_fitness": 0.144524,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:29:50.927Z",
      "global_research_fitness": 0.14454,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:29:53.213Z",
      "global_research_fitness": 0.144559,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:29:54.981Z",
      "global_research_fitness": 0.144585,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:29:55.950Z",
      "global_research_fitness": 0.144611,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:29:57.177Z",
      "global_research_fitness": 0.144634,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:29:58.240Z",
      "global_research_fitness": 0.144657,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:29:59.659Z",
      "global_research_fitness": 0.144678,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:00.894Z",
      "global_research_fitness": 0.144698,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:01.838Z",
      "global_research_fitness": 0.144717,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:02.804Z",
      "global_research_fitness": 0.144735,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:04.420Z",
      "global_research_fitness": 0.144758,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:05.511Z",
      "global_research_fitness": 0.144779,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:06.769Z",
      "global_research_fitness": 0.1448,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:08.021Z",
      "global_research_fitness": 0.144807,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:09.587Z",
      "global_research_fitness": 0.144791,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:10.753Z",
      "global_research_fitness": 0.144775,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:11.700Z",
      "global_research_fitness": 0.144758,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:12.666Z",
      "global_research_fitness": 0.144741,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:14.452Z",
      "global_research_fitness": 0.144724,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:15.423Z",
      "global_research_fitness": 0.144705,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:16.498Z",
      "global_research_fitness": 0.144687,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:17.675Z",
      "global_research_fitness": 0.144673,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:18.635Z",
      "global_research_fitness": 0.144659,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:20.165Z",
      "global_research_fitness": 0.144644,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:21.124Z",
      "global_research_fitness": 0.144628,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:22.217Z",
      "global_research_fitness": 0.144612,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:23.401Z",
      "global_research_fitness": 0.144596,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:24.798Z",
      "global_research_fitness": 0.144579,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:26.007Z",
      "global_research_fitness": 0.144562,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:27.094Z",
      "global_research_fitness": 0.144544,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:28.063Z",
      "global_research_fitness": 0.144528,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:29.838Z",
      "global_research_fitness": 0.144511,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:31.464Z",
      "global_research_fitness": 0.144494,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:32.549Z",
      "global_research_fitness": 0.144477,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:34.772Z",
      "global_research_fitness": 0.144463,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:35.863Z",
      "global_research_fitness": 0.144448,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:36.861Z",
      "global_research_fitness": 0.144433,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:37.821Z",
      "global_research_fitness": 0.144417,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:39.668Z",
      "global_research_fitness": 0.144401,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:40.627Z",
      "global_research_fitness": 0.144408,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:41.576Z",
      "global_research_fitness": 0.144393,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:42.945Z",
      "global_research_fitness": 0.144396,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:44.368Z",
      "global_research_fitness": 0.144394,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:45.502Z",
      "global_research_fitness": 0.14439,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:46.617Z",
      "global_research_fitness": 0.14441,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:47.748Z",
      "global_research_fitness": 0.144414,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:48.986Z",
      "global_research_fitness": 0.144415,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:50.850Z",
      "global_research_fitness": 0.144414,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:51.873Z",
      "global_research_fitness": 0.144417,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:53.275Z",
      "global_research_fitness": 0.14442,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:54.825Z",
      "global_research_fitness": 0.144421,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:55.980Z",
      "global_research_fitness": 0.144421,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:57.088Z",
      "global_research_fitness": 0.14442,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:58.039Z",
      "global_research_fitness": 0.144426,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:30:59.870Z",
      "global_research_fitness": 0.144446,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:00.838Z",
      "global_research_fitness": 0.144451,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:01.915Z",
      "global_research_fitness": 0.144454,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:03.006Z",
      "global_research_fitness": 0.144457,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:04.545Z",
      "global_research_fitness": 0.144459,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:05.671Z",
      "global_research_fitness": 0.14446,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:06.699Z",
      "global_research_fitness": 0.14446,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:07.806Z",
      "global_research_fitness": 0.14446,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:09.411Z",
      "global_research_fitness": 0.144459,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:10.371Z",
      "global_research_fitness": 0.144457,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:11.465Z",
      "global_research_fitness": 0.144441,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:12.649Z",
      "global_research_fitness": 0.144442,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:13.604Z",
      "global_research_fitness": 0.144442,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:15.089Z",
      "global_research_fitness": 0.144442,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:16.330Z",
      "global_research_fitness": 0.144449,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:17.283Z",
      "global_research_fitness": 0.144458,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:18.275Z",
      "global_research_fitness": 0.144442,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:19.849Z",
      "global_research_fitness": 0.144457,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:21.029Z",
      "global_research_fitness": 0.144477,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:22.149Z",
      "global_research_fitness": 0.144492,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:23.139Z",
      "global_research_fitness": 0.144502,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:24.957Z",
      "global_research_fitness": 0.14451,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:25.997Z",
      "global_research_fitness": 0.144516,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:26.961Z",
      "global_research_fitness": 0.144525,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:29.243Z",
      "global_research_fitness": 0.144532,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:30.200Z",
      "global_research_fitness": 0.144538,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:31.225Z",
      "global_research_fitness": 0.144543,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:32.414Z",
      "global_research_fitness": 0.144547,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:31:33.859Z",
      "global_research_fitness": 0.14455,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:32:15.596Z",
      "global_research_fitness": 0.144553,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T14:32:27.562Z",
      "global_research_fitness": 0.144556,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T15:16:09.105Z",
      "global_research_fitness": 0.144563,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T15:16:13.467Z",
      "global_research_fitness": 0.144587,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T15:16:15.183Z",
      "global_research_fitness": 0.144614,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T15:16:17.147Z",
      "global_research_fitness": 0.144633,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T15:16:18.488Z",
      "global_research_fitness": 0.144647,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T15:16:18.577Z",
      "global_research_fitness": 0.144659,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T15:16:19.852Z",
      "global_research_fitness": 0.144668,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T15:16:22.572Z",
      "global_research_fitness": 0.144687,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T15:17:18.546Z",
      "global_research_fitness": 0.144706,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-19T15:17:27.650Z",
      "global_research_fitness": 0.144713,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:17:31.375Z",
      "global_research_fitness": 0.144698,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:17:32.523Z",
      "global_research_fitness": 0.144682,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:17:33.652Z",
      "global_research_fitness": 0.144674,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:17:34.859Z",
      "global_research_fitness": 0.14467,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:17:36.428Z",
      "global_research_fitness": 0.144663,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:17:37.406Z",
      "global_research_fitness": 0.144655,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:17:38.584Z",
      "global_research_fitness": 0.144647,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:17:39.717Z",
      "global_research_fitness": 0.144644,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:17:41.354Z",
      "global_research_fitness": 0.144638,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:18:27.184Z",
      "global_research_fitness": 0.14463,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:18:37.195Z",
      "global_research_fitness": 0.144622,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:18:39.129Z",
      "global_research_fitness": 0.144614,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:18:49.419Z",
      "global_research_fitness": 0.144621,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:18:50.579Z",
      "global_research_fitness": 0.144629,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:18:52.343Z",
      "global_research_fitness": 0.144626,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:18:53.472Z",
      "global_research_fitness": 0.144626,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:18:54.598Z",
      "global_research_fitness": 0.144622,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:18:55.748Z",
      "global_research_fitness": 0.144615,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:18:57.211Z",
      "global_research_fitness": 0.144606,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:18:58.723Z",
      "global_research_fitness": 0.144596,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:18:59.989Z",
      "global_research_fitness": 0.144589,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:19:01.751Z",
      "global_research_fitness": 0.144581,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:19:07.729Z",
      "global_research_fitness": 0.144573,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:19:12.458Z",
      "global_research_fitness": 0.144563,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:19:12.732Z",
      "global_research_fitness": 0.144552,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:19:14.054Z",
      "global_research_fitness": 0.144541,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:19:39.287Z",
      "global_research_fitness": 0.144531,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-19T15:19:53.939Z",
      "global_research_fitness": 0.144519,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-20T08:16:01.285Z",
      "global_research_fitness": 0.144527,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-20T08:16:01.801Z",
      "global_research_fitness": 0.144512,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-20T08:16:04.572Z",
      "global_research_fitness": 0.144496,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-20T08:16:05.674Z",
      "global_research_fitness": 0.14448,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-20T08:16:07.934Z",
      "global_research_fitness": 0.144464,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-20T08:16:09.805Z",
      "global_research_fitness": 0.144447,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-20T08:16:10.958Z",
      "global_research_fitness": 0.144429,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-20T08:16:11.947Z",
      "global_research_fitness": 0.144411,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-20T08:16:13.461Z",
      "global_research_fitness": 0.144398,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-20T08:16:14.756Z",
      "global_research_fitness": 0.144384,
      "domain_signature": "medium|high|low|p5"
    },
    {
      "ts": "2026-02-20T08:44:56.244Z",
      "global_research_fitness": 0.144391,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:01.812Z",
      "global_research_fitness": 0.144376,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:03.504Z",
      "global_research_fitness": 0.144361,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:07.664Z",
      "global_research_fitness": 0.144371,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:08.509Z",
      "global_research_fitness": 0.14438,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:09.334Z",
      "global_research_fitness": 0.144386,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:10.107Z",
      "global_research_fitness": 0.144391,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:10.803Z",
      "global_research_fitness": 0.144395,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:11.487Z",
      "global_research_fitness": 0.144403,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:12.847Z",
      "global_research_fitness": 0.14441,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:13.444Z",
      "global_research_fitness": 0.144417,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:14.229Z",
      "global_research_fitness": 0.144449,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:14.735Z",
      "global_research_fitness": 0.144468,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:15.541Z",
      "global_research_fitness": 0.144482,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:17.226Z",
      "global_research_fitness": 0.144494,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:18.374Z",
      "global_research_fitness": 0.144504,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:19.694Z",
      "global_research_fitness": 0.144512,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:22.347Z",
      "global_research_fitness": 0.144529,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:23.540Z",
      "global_research_fitness": 0.14455,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:45:24.582Z",
      "global_research_fitness": 0.144569,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:03.433Z",
      "global_research_fitness": 0.144587,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:09.404Z",
      "global_research_fitness": 0.144604,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:09.505Z",
      "global_research_fitness": 0.14462,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:10.554Z",
      "global_research_fitness": 0.144636,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:15.456Z",
      "global_research_fitness": 0.144643,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:15.560Z",
      "global_research_fitness": 0.144675,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:20.430Z",
      "global_research_fitness": 0.144695,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:20.534Z",
      "global_research_fitness": 0.14471,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:21.650Z",
      "global_research_fitness": 0.144735,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:25.655Z",
      "global_research_fitness": 0.144758,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:27.926Z",
      "global_research_fitness": 0.144779,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:29.684Z",
      "global_research_fitness": 0.144798,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:31.384Z",
      "global_research_fitness": 0.14482,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:33.310Z",
      "global_research_fitness": 0.144841,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:34.342Z",
      "global_research_fitness": 0.144861,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:35.477Z",
      "global_research_fitness": 0.14488,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:36.553Z",
      "global_research_fitness": 0.144898,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:38.469Z",
      "global_research_fitness": 0.144916,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:47:39.601Z",
      "global_research_fitness": 0.144932,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:48:38.149Z",
      "global_research_fitness": 0.144949,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:49:38.625Z",
      "global_research_fitness": 0.144966,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:52:53.968Z",
      "global_research_fitness": 0.144981,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:52:59.807Z",
      "global_research_fitness": 0.144989,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:53:04.493Z",
      "global_research_fitness": 0.144974,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:53:05.624Z",
      "global_research_fitness": 0.144958,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:53:10.659Z",
      "global_research_fitness": 0.14495,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:53:11.241Z",
      "global_research_fitness": 0.144952,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:53:12.019Z",
      "global_research_fitness": 0.144951,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:53:15.429Z",
      "global_research_fitness": 0.144954,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:53:16.138Z",
      "global_research_fitness": 0.144954,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:53:16.852Z",
      "global_research_fitness": 0.144957,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:53:17.692Z",
      "global_research_fitness": 0.14496,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:53:18.867Z",
      "global_research_fitness": 0.144965,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:53:19.808Z",
      "global_research_fitness": 0.144977,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:53:20.145Z",
      "global_research_fitness": 0.144988,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:53:21.202Z",
      "global_research_fitness": 0.144997,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:53:21.304Z",
      "global_research_fitness": 0.145005,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T08:54:15.494Z",
      "global_research_fitness": 0.145014,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T09:02:11.203Z",
      "global_research_fitness": 0.145021,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T09:02:16.912Z",
      "global_research_fitness": 0.145028,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T09:02:21.687Z",
      "global_research_fitness": 0.145013,
      "domain_signature": ""
    },
    {
      "ts": "2026-02-20T09:02:24.734Z",
      "global_research_fitness": 0.145014,
      "domain_signature": ""
    }
  ],
  "research_impact": [
    {
      "ts": "2026-02-19T14:29:41.480Z",
      "research_fitness": 0.144505,
      "meta_stability_index": 0.276144,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:29:45.008Z",
      "research_fitness": 0.144515,
      "meta_stability_index": 0.276196,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:29:46.268Z",
      "research_fitness": 0.144522,
      "meta_stability_index": 0.276225,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:29:47.380Z",
      "research_fitness": 0.144519,
      "meta_stability_index": 0.276176,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:29:49.443Z",
      "research_fitness": 0.144524,
      "meta_stability_index": 0.276189,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:29:50.894Z",
      "research_fitness": 0.14454,
      "meta_stability_index": 0.276225,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:29:53.180Z",
      "research_fitness": 0.144559,
      "meta_stability_index": 0.276248,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:29:54.948Z",
      "research_fitness": 0.144585,
      "meta_stability_index": 0.276288,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:29:55.917Z",
      "research_fitness": 0.144611,
      "meta_stability_index": 0.276317,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:29:57.144Z",
      "research_fitness": 0.144634,
      "meta_stability_index": 0.276338,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:29:58.206Z",
      "research_fitness": 0.144657,
      "meta_stability_index": 0.276351,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:29:59.626Z",
      "research_fitness": 0.144678,
      "meta_stability_index": 0.276358,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:00.862Z",
      "research_fitness": 0.144698,
      "meta_stability_index": 0.27636,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:01.805Z",
      "research_fitness": 0.144717,
      "meta_stability_index": 0.276358,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:02.770Z",
      "research_fitness": 0.144735,
      "meta_stability_index": 0.276352,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:04.387Z",
      "research_fitness": 0.144758,
      "meta_stability_index": 0.276356,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:05.477Z",
      "research_fitness": 0.144779,
      "meta_stability_index": 0.276356,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:06.738Z",
      "research_fitness": 0.1448,
      "meta_stability_index": 0.276353,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:07.988Z",
      "research_fitness": 0.144807,
      "meta_stability_index": 0.276524,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:09.555Z",
      "research_fitness": 0.144791,
      "meta_stability_index": 0.276458,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:10.721Z",
      "research_fitness": 0.144775,
      "meta_stability_index": 0.276392,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:11.667Z",
      "research_fitness": 0.144758,
      "meta_stability_index": 0.276326,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:12.634Z",
      "research_fitness": 0.144741,
      "meta_stability_index": 0.27626,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:14.420Z",
      "research_fitness": 0.144724,
      "meta_stability_index": 0.276195,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:15.390Z",
      "research_fitness": 0.144705,
      "meta_stability_index": 0.276131,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:16.463Z",
      "research_fitness": 0.144687,
      "meta_stability_index": 0.276066,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:17.643Z",
      "research_fitness": 0.144673,
      "meta_stability_index": 0.276001,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:18.600Z",
      "research_fitness": 0.144659,
      "meta_stability_index": 0.275936,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:20.133Z",
      "research_fitness": 0.144644,
      "meta_stability_index": 0.275871,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:21.092Z",
      "research_fitness": 0.144628,
      "meta_stability_index": 0.275806,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:22.184Z",
      "research_fitness": 0.144612,
      "meta_stability_index": 0.275741,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:23.368Z",
      "research_fitness": 0.144596,
      "meta_stability_index": 0.275676,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:24.766Z",
      "research_fitness": 0.144579,
      "meta_stability_index": 0.275612,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:25.974Z",
      "research_fitness": 0.144562,
      "meta_stability_index": 0.275547,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:27.061Z",
      "research_fitness": 0.144544,
      "meta_stability_index": 0.275482,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:28.031Z",
      "research_fitness": 0.144528,
      "meta_stability_index": 0.275431,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:29.800Z",
      "research_fitness": 0.144511,
      "meta_stability_index": 0.275379,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:31.431Z",
      "research_fitness": 0.144494,
      "meta_stability_index": 0.275326,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:32.516Z",
      "research_fitness": 0.144477,
      "meta_stability_index": 0.275273,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:34.739Z",
      "research_fitness": 0.144463,
      "meta_stability_index": 0.27523,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:35.830Z",
      "research_fitness": 0.144448,
      "meta_stability_index": 0.275186,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:36.830Z",
      "research_fitness": 0.144433,
      "meta_stability_index": 0.275142,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:37.786Z",
      "research_fitness": 0.144417,
      "meta_stability_index": 0.275097,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:39.636Z",
      "research_fitness": 0.144401,
      "meta_stability_index": 0.275052,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:40.593Z",
      "research_fitness": 0.144408,
      "meta_stability_index": 0.275222,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:41.542Z",
      "research_fitness": 0.144393,
      "meta_stability_index": 0.275157,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:42.895Z",
      "research_fitness": 0.144396,
      "meta_stability_index": 0.27521,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:44.336Z",
      "research_fitness": 0.144394,
      "meta_stability_index": 0.275224,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:45.469Z",
      "research_fitness": 0.14439,
      "meta_stability_index": 0.275218,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:46.584Z",
      "research_fitness": 0.14441,
      "meta_stability_index": 0.275215,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:47.715Z",
      "research_fitness": 0.144414,
      "meta_stability_index": 0.275244,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:48.668Z",
      "research_fitness": 0.144415,
      "meta_stability_index": 0.275258,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:50.817Z",
      "research_fitness": 0.144414,
      "meta_stability_index": 0.27526,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:51.841Z",
      "research_fitness": 0.144417,
      "meta_stability_index": 0.275254,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:53.242Z",
      "research_fitness": 0.14442,
      "meta_stability_index": 0.275241,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:54.792Z",
      "research_fitness": 0.144421,
      "meta_stability_index": 0.275223,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:55.948Z",
      "research_fitness": 0.144421,
      "meta_stability_index": 0.275201,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:57.054Z",
      "research_fitness": 0.14442,
      "meta_stability_index": 0.275175,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:58.006Z",
      "research_fitness": 0.144426,
      "meta_stability_index": 0.275164,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:30:59.837Z",
      "research_fitness": 0.144446,
      "meta_stability_index": 0.275161,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:00.806Z",
      "research_fitness": 0.144451,
      "meta_stability_index": 0.275147,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:01.818Z",
      "research_fitness": 0.144454,
      "meta_stability_index": 0.275129,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:02.972Z",
      "research_fitness": 0.144457,
      "meta_stability_index": 0.275108,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:04.513Z",
      "research_fitness": 0.144459,
      "meta_stability_index": 0.275085,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:05.634Z",
      "research_fitness": 0.14446,
      "meta_stability_index": 0.27506,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:06.668Z",
      "research_fitness": 0.14446,
      "meta_stability_index": 0.275032,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:07.771Z",
      "research_fitness": 0.14446,
      "meta_stability_index": 0.275003,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:09.373Z",
      "research_fitness": 0.144459,
      "meta_stability_index": 0.274972,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:10.338Z",
      "research_fitness": 0.144457,
      "meta_stability_index": 0.274939,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:11.433Z",
      "research_fitness": 0.144441,
      "meta_stability_index": 0.274893,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:12.616Z",
      "research_fitness": 0.144442,
      "meta_stability_index": 0.274869,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:13.569Z",
      "research_fitness": 0.144442,
      "meta_stability_index": 0.274844,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:15.057Z",
      "research_fitness": 0.144442,
      "meta_stability_index": 0.274817,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:16.298Z",
      "research_fitness": 0.144449,
      "meta_stability_index": 0.274986,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:17.251Z",
      "research_fitness": 0.144458,
      "meta_stability_index": 0.275154,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:18.238Z",
      "research_fitness": 0.144442,
      "meta_stability_index": 0.275108,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:19.816Z",
      "research_fitness": 0.144457,
      "meta_stability_index": 0.275277,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:20.995Z",
      "research_fitness": 0.144477,
      "meta_stability_index": 0.275446,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:22.009Z",
      "research_fitness": 0.144492,
      "meta_stability_index": 0.275557,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:23.106Z",
      "research_fitness": 0.144502,
      "meta_stability_index": 0.275632,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:24.923Z",
      "research_fitness": 0.14451,
      "meta_stability_index": 0.275684,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:25.963Z",
      "research_fitness": 0.144516,
      "meta_stability_index": 0.27572,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:26.928Z",
      "research_fitness": 0.144525,
      "meta_stability_index": 0.275743,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:29.203Z",
      "research_fitness": 0.144532,
      "meta_stability_index": 0.275756,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:30.166Z",
      "research_fitness": 0.144538,
      "meta_stability_index": 0.275762,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:31.193Z",
      "research_fitness": 0.144543,
      "meta_stability_index": 0.275761,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:32.379Z",
      "research_fitness": 0.144547,
      "meta_stability_index": 0.275755,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:31:33.687Z",
      "research_fitness": 0.14455,
      "meta_stability_index": 0.275744,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:32:15.561Z",
      "research_fitness": 0.144553,
      "meta_stability_index": 0.275717,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T14:32:27.451Z",
      "research_fitness": 0.144556,
      "meta_stability_index": 0.275706,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:16:09.060Z",
      "research_fitness": 0.144563,
      "meta_stability_index": 0.275875,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:16:13.434Z",
      "research_fitness": 0.144587,
      "meta_stability_index": 0.276043,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:16:15.150Z",
      "research_fitness": 0.144614,
      "meta_stability_index": 0.276211,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:16:17.110Z",
      "research_fitness": 0.144633,
      "meta_stability_index": 0.276301,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:16:18.452Z",
      "research_fitness": 0.144647,
      "meta_stability_index": 0.276353,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:16:18.538Z",
      "research_fitness": 0.144659,
      "meta_stability_index": 0.276382,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:16:19.816Z",
      "research_fitness": 0.144668,
      "meta_stability_index": 0.276395,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:16:22.539Z",
      "research_fitness": 0.144687,
      "meta_stability_index": 0.27643,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:17:18.510Z",
      "research_fitness": 0.144706,
      "meta_stability_index": 0.276465,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:17:27.608Z",
      "research_fitness": 0.144713,
      "meta_stability_index": 0.276633,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:17:31.336Z",
      "research_fitness": 0.144698,
      "meta_stability_index": 0.276569,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:17:32.489Z",
      "research_fitness": 0.144682,
      "meta_stability_index": 0.276505,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:17:33.618Z",
      "research_fitness": 0.144674,
      "meta_stability_index": 0.276518,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:17:34.826Z",
      "research_fitness": 0.14467,
      "meta_stability_index": 0.27657,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:17:36.247Z",
      "research_fitness": 0.144663,
      "meta_stability_index": 0.276599,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:17:37.373Z",
      "research_fitness": 0.144655,
      "meta_stability_index": 0.276612,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:17:38.548Z",
      "research_fitness": 0.144647,
      "meta_stability_index": 0.276647,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:17:39.684Z",
      "research_fitness": 0.144644,
      "meta_stability_index": 0.276669,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:17:41.313Z",
      "research_fitness": 0.144638,
      "meta_stability_index": 0.276682,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:18:27.151Z",
      "research_fitness": 0.14463,
      "meta_stability_index": 0.276669,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:18:37.162Z",
      "research_fitness": 0.144622,
      "meta_stability_index": 0.276657,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:18:39.094Z",
      "research_fitness": 0.144614,
      "meta_stability_index": 0.276644,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:18:49.386Z",
      "research_fitness": 0.144621,
      "meta_stability_index": 0.276811,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:18:50.545Z",
      "research_fitness": 0.144629,
      "meta_stability_index": 0.276978,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:18:52.307Z",
      "research_fitness": 0.144626,
      "meta_stability_index": 0.27703,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:18:53.439Z",
      "research_fitness": 0.144626,
      "meta_stability_index": 0.27712,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:18:54.562Z",
      "research_fitness": 0.144622,
      "meta_stability_index": 0.277171,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:18:55.714Z",
      "research_fitness": 0.144615,
      "meta_stability_index": 0.277199,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:18:57.178Z",
      "research_fitness": 0.144606,
      "meta_stability_index": 0.277212,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:18:58.687Z",
      "research_fitness": 0.144596,
      "meta_stability_index": 0.277213,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:18:59.953Z",
      "research_fitness": 0.144589,
      "meta_stability_index": 0.277208,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:19:01.715Z",
      "research_fitness": 0.144581,
      "meta_stability_index": 0.277195,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:19:07.593Z",
      "research_fitness": 0.144573,
      "meta_stability_index": 0.277177,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:19:12.418Z",
      "research_fitness": 0.144563,
      "meta_stability_index": 0.277155,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:19:12.551Z",
      "research_fitness": 0.144552,
      "meta_stability_index": 0.277129,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:19:14.015Z",
      "research_fitness": 0.144541,
      "meta_stability_index": 0.2771,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:19:39.245Z",
      "research_fitness": 0.144531,
      "meta_stability_index": 0.277062,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-19T15:19:53.907Z",
      "research_fitness": 0.144519,
      "meta_stability_index": 0.277033,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:16:01.243Z",
      "research_fitness": 0.144527,
      "meta_stability_index": 0.2772,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:16:01.767Z",
      "research_fitness": 0.144512,
      "meta_stability_index": 0.277136,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:16:04.534Z",
      "research_fitness": 0.144496,
      "meta_stability_index": 0.277072,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:16:05.639Z",
      "research_fitness": 0.14448,
      "meta_stability_index": 0.277008,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:16:07.899Z",
      "research_fitness": 0.144464,
      "meta_stability_index": 0.276944,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:16:09.651Z",
      "research_fitness": 0.144447,
      "meta_stability_index": 0.27688,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:16:10.921Z",
      "research_fitness": 0.144429,
      "meta_stability_index": 0.276816,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:16:11.913Z",
      "research_fitness": 0.144411,
      "meta_stability_index": 0.276752,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:16:13.055Z",
      "research_fitness": 0.144398,
      "meta_stability_index": 0.276688,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:16:14.720Z",
      "research_fitness": 0.144384,
      "meta_stability_index": 0.276625,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:44:56.147Z",
      "research_fitness": 0.144391,
      "meta_stability_index": 0.276791,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:01.377Z",
      "research_fitness": 0.144376,
      "meta_stability_index": 0.276727,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:03.465Z",
      "research_fitness": 0.144361,
      "meta_stability_index": 0.276663,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:07.625Z",
      "research_fitness": 0.144371,
      "meta_stability_index": 0.276676,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:08.471Z",
      "research_fitness": 0.14438,
      "meta_stability_index": 0.27667,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:09.294Z",
      "research_fitness": 0.144386,
      "meta_stability_index": 0.276652,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:10.069Z",
      "research_fitness": 0.144391,
      "meta_stability_index": 0.276626,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:10.766Z",
      "research_fitness": 0.144395,
      "meta_stability_index": 0.276596,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:11.449Z",
      "research_fitness": 0.144403,
      "meta_stability_index": 0.276561,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:12.810Z",
      "research_fitness": 0.14441,
      "meta_stability_index": 0.276523,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:13.406Z",
      "research_fitness": 0.144417,
      "meta_stability_index": 0.276688,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:14.194Z",
      "research_fitness": 0.144449,
      "meta_stability_index": 0.276853,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:14.699Z",
      "research_fitness": 0.144468,
      "meta_stability_index": 0.276904,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:15.402Z",
      "research_fitness": 0.144482,
      "meta_stability_index": 0.276917,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:17.190Z",
      "research_fitness": 0.144494,
      "meta_stability_index": 0.27691,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:18.338Z",
      "research_fitness": 0.144504,
      "meta_stability_index": 0.276892,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:19.586Z",
      "research_fitness": 0.144512,
      "meta_stability_index": 0.276867,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:22.309Z",
      "research_fitness": 0.144529,
      "meta_stability_index": 0.276869,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:23.500Z",
      "research_fitness": 0.14455,
      "meta_stability_index": 0.276863,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:45:24.547Z",
      "research_fitness": 0.144569,
      "meta_stability_index": 0.27685,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:03.396Z",
      "research_fitness": 0.144587,
      "meta_stability_index": 0.276832,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:09.363Z",
      "research_fitness": 0.144604,
      "meta_stability_index": 0.27681,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:09.462Z",
      "research_fitness": 0.14462,
      "meta_stability_index": 0.276785,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:10.514Z",
      "research_fitness": 0.144636,
      "meta_stability_index": 0.276758,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:15.414Z",
      "research_fitness": 0.144643,
      "meta_stability_index": 0.276923,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:15.526Z",
      "research_fitness": 0.144675,
      "meta_stability_index": 0.277087,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:20.360Z",
      "research_fitness": 0.144695,
      "meta_stability_index": 0.277138,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:20.497Z",
      "research_fitness": 0.14471,
      "meta_stability_index": 0.27715,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:21.609Z",
      "research_fitness": 0.144735,
      "meta_stability_index": 0.277201,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:25.620Z",
      "research_fitness": 0.144758,
      "meta_stability_index": 0.277229,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:27.893Z",
      "research_fitness": 0.144779,
      "meta_stability_index": 0.277242,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:29.289Z",
      "research_fitness": 0.144798,
      "meta_stability_index": 0.277244,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:31.348Z",
      "research_fitness": 0.14482,
      "meta_stability_index": 0.277238,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:33.205Z",
      "research_fitness": 0.144841,
      "meta_stability_index": 0.277225,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:34.309Z",
      "research_fitness": 0.144861,
      "meta_stability_index": 0.277207,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:35.444Z",
      "research_fitness": 0.14488,
      "meta_stability_index": 0.277185,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:36.520Z",
      "research_fitness": 0.144898,
      "meta_stability_index": 0.27716,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:38.433Z",
      "research_fitness": 0.144916,
      "meta_stability_index": 0.277132,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:47:39.567Z",
      "research_fitness": 0.144932,
      "meta_stability_index": 0.277101,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:48:38.114Z",
      "research_fitness": 0.144949,
      "meta_stability_index": 0.27707,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:49:38.589Z",
      "research_fitness": 0.144966,
      "meta_stability_index": 0.277039,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:52:53.926Z",
      "research_fitness": 0.144981,
      "meta_stability_index": 0.277006,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:52:59.770Z",
      "research_fitness": 0.144989,
      "meta_stability_index": 0.277171,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:53:04.343Z",
      "research_fitness": 0.144974,
      "meta_stability_index": 0.277108,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:53:05.585Z",
      "research_fitness": 0.144958,
      "meta_stability_index": 0.277045,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:53:10.619Z",
      "research_fitness": 0.14495,
      "meta_stability_index": 0.277058,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:53:11.203Z",
      "research_fitness": 0.144952,
      "meta_stability_index": 0.277109,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:53:11.983Z",
      "research_fitness": 0.144951,
      "meta_stability_index": 0.277137,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:53:15.393Z",
      "research_fitness": 0.144954,
      "meta_stability_index": 0.277188,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:53:16.102Z",
      "research_fitness": 0.144954,
      "meta_stability_index": 0.277222,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:53:16.813Z",
      "research_fitness": 0.144957,
      "meta_stability_index": 0.277244,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:53:17.519Z",
      "research_fitness": 0.14496,
      "meta_stability_index": 0.277257,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:53:18.271Z",
      "research_fitness": 0.144965,
      "meta_stability_index": 0.277285,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:53:19.772Z",
      "research_fitness": 0.144977,
      "meta_stability_index": 0.277325,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:53:20.092Z",
      "research_fitness": 0.144988,
      "meta_stability_index": 0.277357,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:53:21.167Z",
      "research_fitness": 0.144997,
      "meta_stability_index": 0.27738,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:53:21.271Z",
      "research_fitness": 0.145005,
      "meta_stability_index": 0.277398,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T08:54:15.456Z",
      "research_fitness": 0.145014,
      "meta_stability_index": 0.277416,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T09:02:11.024Z",
      "research_fitness": 0.145021,
      "meta_stability_index": 0.277429,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T09:02:16.874Z",
      "research_fitness": 0.145028,
      "meta_stability_index": 0.277593,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T09:02:21.614Z",
      "research_fitness": 0.145013,
      "meta_stability_index": 0.27753,
      "domain_size": "small"
    },
    {
      "ts": "2026-02-20T09:02:22.813Z",
      "research_fitness": 0.145014,
      "meta_stability_index": 0.27758,
      "domain_size": "small"
    }
  ]
}
```

## Recommendations
```json
[
  "Reduce mutation aggressiveness and increase arena cooldown.",
  "Collect more domain evidence before enabling transfer for new domains."
]
```

Generated at: 2026-02-20T09:03:02.901Z