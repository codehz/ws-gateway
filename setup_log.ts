import { log, fmt, logger } from "./deps.ts";

await log.setup({
  handlers: {
    console: new log.handlers.ConsoleHandler("DEBUG", {
      formatter: (record: logger.LogRecord) =>
        fmt.sprintf(`${record.levelName} ${record.msg}`, ...record.args)
    })
  },
  loggers: {
    default: {
      level: "DEBUG",
      handlers: ["console"]
    }
  }
});