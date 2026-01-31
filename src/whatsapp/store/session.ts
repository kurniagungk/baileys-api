/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from "baileys";
import { proto } from "baileys";
import { BufferJSON, initAuthCreds } from "baileys";
import { prisma } from "@/config/database";
import { logger } from "@/utils";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";

const fixId = (id: string) => id.replace(/\//g, "__").replace(/:/g, "-");

export async function useSession(sessionId: string): Promise<{
	state: AuthenticationState;
	saveCreds: () => Promise<void>;
	deleteAllSessionData: () => Promise<void>;
}> {
	const model = prisma.session;

	const write = async (data: any, id: string, retry = 0): Promise<void> => {
		const MAX_RETRIES = 3;
		const fixedId = fixId(id);
		const stringified = JSON.stringify(data, BufferJSON.replacer);

		try {
			logger.debug({ sessionId, id: fixedId }, "Try upsert session");

			await model.upsert({
				where: { sessionId_id: { id: fixedId, sessionId } },
				update: { data: stringified },
				create: { id: fixedId, sessionId, data: stringified },
			});
		} catch (e: any) {
			const isConflict = e.message?.includes("Record has changed");

			if (isConflict && retry < MAX_RETRIES) {
				logger.warn(`Retry write upsert() ${id}, attempt ${retry + 1}`);
				await new Promise((res) => setTimeout(res, 100 * (retry + 1)));
				return write(data, id, retry + 1);
			} else {
				logger.error(e, "An error occurred during session upsert");
			}
		}
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
		try {
			await model.delete({
				select: { pkId: true },
				where: { sessionId_id: { id: fixId(id), sessionId } },
			});
		} catch (e) {
			logger.error(e, "An error occured during session delete");
		}
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
		saveCreds: () => write(creds, "creds"),
		deleteAllSessionData,
	};
}
