# 🚀 Патч для исправления файловой системы MCP сервера

## 📋 **ПРОБЛЕМА:**
Символ `|` в доменных сигнатурах несовместим с Windows файловой системой

## 🔧 **РЕШЕНИЕ:**
Кодирование доменных сигнатур в безопасные имена файлов

## 📝 **ИЗМЕНЕНИЯ:**

### **1. Добавить функции кодирования:**
```javascript
// В начало MCP сервера
function encodeDomainSignature(domainSignature) {
    return domainSignature.replace(/\|/g, '_');
}

function generateSafeFilename(operation, domainSignature, timestamp) {
    const safeDomain = encodeDomainSignature(domainSignature);
    return `${operation}-${safeDomain}-${timestamp}`;
}
```

### **2. Изменить создание папок:**
```javascript
// Было:
const dirName = `campaign-tick-${domainSignature}-${timestamp}`;

// Стало:
const dirName = generateSafeFilename('campaign-tick', domainSignature, timestamp);
```

### **3. Обновить все места использования доменных сигнатур:**
- Campaign ticks
- Arena evaluations  
- Strategy storage
- Transfer operations

## 📊 **РЕЗУЛЬТАТЫ ТЕСТИРОВАНИЯ:**
```
Original: small|high|low|p2
Encoded:  small_high_low_p2
Filename:  campaign-tick-small_high_low_p2-1771842012496

Original: medium|low|low|p5  
Encoded:  medium_low_low_p5
Filename:  arena-eval-medium_low_low_p5-1771842138574
```

## ✅ **ПРЕИМУЩЕСТВА:**
1. **Windows совместимость** - больше нет ошибок ENOENT
2. **Обратная совместимость** - можно декодировать обратно
3. **Простота** - минимальные изменения
4. **Надежность** - все символы безопасны

## 🚀 **СТАТУС:**
- ✅ Решение разработано
- ✅ Тестирование пройдено  
- ⏳ Ожидает интеграции в MCP сервер
