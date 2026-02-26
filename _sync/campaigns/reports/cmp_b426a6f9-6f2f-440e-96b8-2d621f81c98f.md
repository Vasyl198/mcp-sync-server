# Campaign Report: cmp_b426a6f9-6f2f-440e-96b8-2d621f81c98f

## Goal
Optimize model accuracy for medium search space

## Objective
```json
{
  "metric": "accuracy",
  "mode": "maximize"
}
```

## Summary
- Status: completed
- Experiments planned max: 10
- Experiments run: 12
- Ticks: 1
- Stop reason: max_experiments_reached

## Best Strategy Per Domain
```json
[]
```

## Best Parameters
```json
[]
```

## Convergence Summary
```json
{
  "experiments_total": 2,
  "converged_count": 0,
  "details": [
    {
      "experiment_id": "exp_06339f45-dc3c-454b-85ee-f3a7a02c3939",
      "converged": false,
      "completed_runs": 0,
      "stagnation_rate": 1
    },
    {
      "experiment_id": "exp_d6f34b77-a2ee-479c-af32-6ed9a1c98a66",
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
    "generated_at": "2026-02-16T12:03:33.831Z",
    "adaptive_mutation": {
      "total_mutations": 0,
      "improved_after_mutation": 0,
      "mutation_effectiveness_ratio": 0
    },
    "meta_mutation": {
      "total_mutations": 0,
      "improved_after_mutation": 0,
      "mutation_effectiveness_ratio": 0
    },
    "overall": {
      "total_mutations": 0,
      "improved_after_mutation": 0,
      "mutation_effectiveness_ratio": 0
    }
  },
  "lineage_nodes": 0
}
```

## Transfer Summary
```json
{
  "generated_at": "2026-02-16T12:03:33.831Z",
  "transfer_success_rate": 0,
  "average_similarity": 0,
  "average_transfer_confidence": 0,
  "reuse_block_rate": 0,
  "anomaly_rate": 0,
  "counts": {
    "experiments_completed": 0,
    "transfer_initialized": 0,
    "transfer_successful": 0
  }
}
```

## Intelligence Health Trajectory
```json
{
  "global": [],
  "research_impact": []
}
```

## Recommendations
```json
[
  "Reduce mutation aggressiveness and increase arena cooldown.",
  "Collect more domain evidence before enabling transfer for new domains."
]
```

Generated at: 2026-02-16T12:03:33.837Z