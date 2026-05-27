/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from "baileys";
import { proto } from "baileys";
import { BufferJSON, initAuthCreds } from "baileys";
import { prisma } from "@/config/database";
import { logger } from "@/utils";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";

const fixId = (id: string) => id.replace(/\//g, "__").replace(/:/g, "-");

const rowLocks = new Map<string, Promise<unknown>>();

const withRowLock = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
	const prev = rowLocks.get(key) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	let tail: Promise<unknown>;
	tail = next.finally(() => {
		if (rowLocks.get(key) === tail) rowLocks.delete(key);
	});
	rowLocks.set(key, tail);
	return next;
};

export async function useSession(sessionId: string): Promise<{
	state: AuthenticationState;
	saveCreds: () => Promise<void>;
	deleteAllSessionData: () => Promise<void>;
}> {
	const model = prisma.session;

	const write = async (data: any, id: string): Promise<void> => {
		const fixedId = fixId(id);
		const stringified = JSON.stringify(data, BufferJSON.replacer);
		const maxRetries = 3;
		const lockKey = `${sessionId}:${fixedId}`;

		await withRowLock(lockKey, async () => {
			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				try {
					logger.debug({ sessionId, id: fixedId, attempt }, "Try upsert session");

					await model.upsert({
						select: { pkId: true },
						create: { sessionId, id: fixedId, data: stringified },
						update: { data: stringified },
						where: { sessionId_id: { id: fixedId, sessionId } },
					});
					return;
				} catch (e: any) {
					if (attempt < maxRetries) {
						logger.warn(
							{ sessionId, id: fixedId, attempt: attempt + 1 },
							"Retry session upsert",
						);
						await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
						continue;
					}
					logger.error(e, "Session upsert failed after retries");
					throw e;
				}
			}
		});
	};

	const read = async (id: string) => {
		try {
			const result = await model.findUnique({
				select: { data: true },
				where: { sessionId_id: { id: fixId(id), sessionId } },
			});

			if (!result) {
				logger.info({ id }, "Trying to read non existent session data");
				return null;
			}

			return JSON.parse(result.data, BufferJSON.reviver);
		} catch (e) {
			if (e instanceof PrismaClientKnownRequestError && e.code === "P2025") {
				logger.info({ id }, "Trying to read non existent session data");
			} else {
				logger.error(e, "An error occured during session read");
			}
			return null;
		}
	};

	const del = async (id: string) => {
		const fixedId = fixId(id);
		const lockKey = `${sessionId}:${fixedId}`;

		await withRowLock(lockKey, async () => {
			try {
				await model.delete({
					select: { pkId: true },
					where: { sessionId_id: { id: fixedId, sessionId } },
				});
			} catch (e) {
				logger.error(e, "An error occured during session delete");
			}
		});
	};

	// Fungsi khusus untuk menghapus semua data session terkait saat terjadi Bad MAC error
	const deleteAllSessionData = async (): Promise<void> => {
		try {
			logger.warn({ sessionId }, "Deleting all session data due to Bad MAC error");

			// Hapus semua data session terkait dari berbagai tabel
			await Promise.all([
				prisma.chat.deleteMany({ where: { sessionId } }),
				prisma.contact.deleteMany({ where: { sessionId } }),
				prisma.message.deleteMany({ where: { sessionId } }),
				prisma.groupMetadata.deleteMany({ where: { sessionId } }),
				prisma.session.deleteMany({ where: { sessionId } }),
			]);

			logger.info(
				{ sessionId },
				"All session data successfully deleted due to Bad MAC error",
			);
		} catch (error: Error | unknown) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			logger.error({ sessionId, error: errorMessage }, "Failed to delete all session data");
			throw error;
		}
	};

	const creds: AuthenticationCreds = (await read("creds")) || initAuthCreds();

	return {
		state: {
			creds,
			keys: {
				get: async <T extends keyof SignalDataTypeMap>(
					type: T,
					ids: string[],
				): Promise<{
					[id: string]: SignalDataTypeMap[T];
				}> => {
					const data: { [key: string]: SignalDataTypeMap[typeof type] } = {};
					await Promise.all(
						ids.map(async (id) => {
							try {
								let value = await read(`${type}-${id}`);
								if (type === "app-state-sync-key" && value) {
									value = proto.Message.AppStateSyncKeyData.create(value);
								}
								data[id] = value;
							} catch (error: Error | unknown) {
								const errorMessage =
									error instanceof Error ? error.message : String(error);
								// Jika terjadi Bad MAC error saat membaca data, hapus semua session
								if (errorMessage.includes("Bad MAC")) {
									logger.error(
										{ sessionId, id, error: errorMessage },
										"Bad MAC error detected during key read - deleting all session data",
									);
									await deleteAllSessionData();
									throw new Error(`Bad MAC error detected: ${errorMessage}`);
								}
								logger.warn(
									{ sessionId, id, error: errorMessage },
									"Error reading session key",
								);
							}
						}),
					);
					return data;
				},
				set: async (data: any): Promise<void> => {
					for (const category in data) {
						for (const id in data[category]) {
							try {
								const value = data[category][id];
								const sId = `${category}-${id}`;
								if (value) {
									await write(value, sId);
								} else {
									await del(sId);
								}
							} catch (error: Error | unknown) {
								const errorMessage =
									error instanceof Error ? error.message : String(error);
								// Jika terjadi Bad MAC error saat menulis data, hapus semua session
								if (errorMessage.includes("Bad MAC")) {
									logger.error(
										{ sessionId, id, error: errorMessage },
										"Bad MAC error detected during key write - deleting all session data",
									);
									await deleteAllSessionData();
									throw new Error(`Bad MAC error detected: ${errorMessage}`);
								}
								logger.warn(
									{ sessionId, id, error: errorMessage },
									"Error writing session key",
								);
							}
						}
					}
				},
			},
		},
		saveCreds: async () => {
			try {
				await write(creds, "creds");
			} catch (e) {
				logger.error({ sessionId, err: e }, "saveCreds failed");
			}
		},
		deleteAllSessionData,
	};
}
