import env from "@/config/env";
import pino, { type Logger } from "pino";
import path from "path";
import fs from "fs";

const logsDir = path.resolve(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const logFile = path.join(logsDir, `app-${new Date().toISOString().slice(0, 10)}.log`);

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
				target: "pino/file",
				options: {
					destination: logFile,
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
