import env from "@/config/env";
import pino, { type Logger } from "pino";
import path from "path";

const logsDir = path.resolve(process.cwd(), "logs");

export const logger: Logger = pino({
	timestamp: () => `,"time":"${new Date().toJSON()}"`,
	transport: {
		targets: [
			{
				level: env.LOG_LEVEL || "debug",
				target: "pino-pretty",
				options: {
					colorize: true,
				},
			},
			{
				level: env.LOG_LEVEL || "debug",
				target: "pino-roll",
				options: {
					file: path.join(logsDir, "app"),
					frequency: "daily",
					dateFormat: "yyyy-MM-dd",
					extension: ".log",
					mkdir: true,
				},
			},
		],
	},
	mixin(mergeObject, level) {
		return {
			...mergeObject,
			level: level,
		};
	},
});
