import pino from "pino";
import { config } from "./config";

export const log = pino({
  level: config.logLevel,
  transport: config.dev ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" } } : undefined,
});

export function childLog(name: string) {
  return log.child({ name });
}
