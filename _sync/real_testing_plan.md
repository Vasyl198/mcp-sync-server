# 🎯 ПЛАН РЕАЛЬНОГО ТЕСТИРОВАНИЯ

## ✅ **ЧТО ИСПРАВЛЕНО (ваши правки):**

### 1. 🛑 Остановка лавины shadow-eval:retry
- **Проблема:** Множественные pending/running retry
- **Решение:** Проверка live-очереди перед новым retry
- **Файлы:** index.ts (line 3476), queue.ts (line 582)

### 2. 📁 Снижение риска длинных путей в Windows
- **Проблема:** Длинные job_id в именах папок
- **Решение:** Короткий hash-id (j_<sha1>)
- **Файлы:** queue.ts (line 47, 290, 412), index.ts (line 7420)

### 3. 🔍 Честная проверка SWE
- **Проблема:** "Самоотчёты без измерений"
- **Решение:** `swe_truth_check` с реальными метриками
- **Файл:** index.ts (line 6353)

## 🧪 **ПЛАН A/B/C ТЕСТИРОВАНИЯ:**

### **Шаг 1: Создать benchmark задачи**
- ✅ Task A (FAST): Fix comment in README.md
- ✅ Task B (FAST+): Fix import in src/config.ts  
- ✅ Task C (DEEP): Fix failing test in tests/mcp.test.js

### **Шаг 2: Прогнать задачи через DevAgent v5**
- 🔄 Task A (FAST) → ожидает выполнения
- 🔄 Task B (FAST+) → готова к запуску
- 🔄 Task C (DEEP) → готова к запуску

### **Шаг 3: После каждой задачи - swe_truth_check**
```
Проверить:
- agentMetricsSnapshot (реальные метрики)
- tasksList(query="benchmark") (статус задач)
- meta-очередь + retry-хвост
- verdict: validated|insufficient_evidence
```

### **Шаг 4: Сравнить с baseline (когда runs_count >= 5)**
- **Baseline:** DevAgent v1 (4 runs, 100% failure)
- **Target:** DevAgent v5 (цель: >50% success, быстрее avg_time)

## 📊 **ТРЕБУЕМЫЕ МЕТРИКИ:**

### **Для каждой задачи:**
- ✅ completion_time_ms
- ✅ success/failure status
- ✅ reasoning_depth (FAST/DEEP/ULTRA)
- ✅ verification_quality
- ✅ iterations_per_task

### **Для сравнения:**
- ✅ success_rate (v5 vs v1)
- ✅ avg_completion_time (v5 vs v1)
- ✅ reasoning_appropriateness
- ✅ quality_vs_speed_tradeoff

## 🎯 **КРИТЕРИИ УСПЕХА:**

### **Минимальный успех:**
- runs_count >= 5
- success_rate > 0% (лучше чем v1)
- avg_completion_time < 4500ms (быстрее чем v1)

### **Хороший успех:**
- success_rate >= 50%
- avg_completion_time <= 3000ms
- reasoning_appropriateness >= 0.8

### **Отличный успех:**
- success_rate >= 80%
- avg_completion_time <= 2000ms
- FAST/DEEP режимы используются адекватно

## 🚀 **СЛЕДУЮЩИЕ ШАГИ:**

1. **Исправить ошибку** в swe_truth_check (file argument undefined)
2. **Выполнить Task A (FAST)** через DevAgent v5
3. **Запустить swe_truth_check** для сбора метрик
4. **Повторить для Tasks B и C**
5. **Сравнить результаты** с baseline
6. **Сделать вывод** о реальном impact адаптивной логики

## 📈 **ОЖИДАЕМЫЕ РЕЗУЛЬТАТЫ:**

Если адаптивная логика работает:
- FAST задачи: быстрые, минимальный reasoning
- DEEP задачи: качественные, структурированный анализ
- Общий success_rate: значительно выше чем у v1
- avg_completion_time: значительно ниже чем у v1

Если нет разницы:
- Нужно пересмотреть подход к адаптивной логике
- Возможно, проблема в реализации, не концепции
