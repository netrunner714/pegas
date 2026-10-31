/**
 * Тихий режим для тестов: глушит console.warn/error/log по умолчанию,
 * но любой тест может явно попросить «громкий» прогон (PEGAS_LOUD_TESTS=1).
 *
 * Зачем: CLI-команды печатают диагностику в stderr/stdout. В тестах этот
 * вывод не проверяется (кроме случаев, где тест сам перехватывает console),
 * и без глушения лог прогона превращается в простыню предупреждений —
 * при том, что итог бинарный: pass/fail.
 */
const loud = process.env.PEGAS_LOUD_TESTS === "1";

if (!loud) {
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    const original = console[method].bind(console);
    // Тесты, которым нужен вывод, подменяют console[method] сами;
    // подмена после этого модуля работает как обычно.
    (console as any)[method] = (...args: any[]) => {
      // Ошибки с фатальным смыслом всё же показываем, чтобы не прятать
      // настоящие проблемы за «тихим» прогоном.
      if (method === "error") {
        const text = args.map(String).join(" ");
        if (/unhandled|deprecat/i.test(text)) original(...args);
      }
    };
  }
}

export const isLoud = loud;
