import type { EventsType } from "@/types/websocket";
import type { SocketServer } from "../server/websocket-server";
import env from "@/config/env";
import axios from "axios";
import { Prisma } from "@prisma/client"; // Import Prisma namespace jika belum
import { prisma } from "@/config/database";
import { logger } from "@/utils";
import crypto from "crypto";

let socketServer: SocketServer | null = null;
export function initializeSocketEmitter(server: SocketServer) {
	socketServer = server;
}

export function emitEvent(
	event: EventsType,
	sessionId: string,
	data?: unknown,
	status: "success" | "error" = "success",
	message?: string,
) {
	if (env.ENABLE_WEBHOOK) {
		sendWebhook(event, sessionId, data, status, message);
	}

	if (!socketServer) {
		console.error("Socket server not initialized. Call initializeSocketEmitter first.");
		return;
	}
	socketServer.emitEvent(event, sessionId, { status, message, data });
}

export async function getSessionWebhookUrl(sessionId: string): Promise<string | null> {
	try {
		// Hapus tanda kutip ganda pada nama tabel dan kolom
		const result = await prisma.$queryRaw<Array<{ webhookUrl: string | null }>>(
			// Ganti `"Session"` menjadi `Session` dan `"sessionId"` menjadi `sessionId`
			// Jika nama kolom Anda di database *benar-benar* case-sensitive dan memerlukan kutipan,
			// maka Anda perlu memeriksa kembali konfigurasi database atau menggunakan `backticks` (`)
			// yang merupakan kutipan identifier standar MySQL/MariaDB. Tapi coba tanpa kutipan dulu.
			Prisma.sql`SELECT webhookUrl FROM Session WHERE sessionId = ${sessionId} AND id = 'session-config-${sessionId}' LIMIT 1`,
		);
		return result.length > 0 ? result[0].webhookUrl : null;
	} catch (error) {
		console.error("Error fetching webhookUrl:", error);
		return null;
	}
}

export function encryptData(text: string, secretKey: string): string | null {
	try {
		const iv = crypto.randomBytes(16);
		const key = crypto.createHash("sha256").update(secretKey, "utf8").digest(); // 32-byte Buffer

		const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
		const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);

		return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
	} catch (e) {
		console.error("Encryption failed:", e);
		return null;
	}
}

export async function sendWebhook(
	event: EventsType, // Asumsi EventsType sudah didefinisikan
	sessionId: string,
	data?: unknown,
	status: "success" | "error" = "success",
	message?: string,
) {
	const webhookUrl = await getSessionWebhookUrl(sessionId);

	if (!webhookUrl) {
		logger.warn(`No webhook URL found for session: ${sessionId}`);
		return;
	}

	// Siapkan payload yang akan dikirim
	const payload = {
		sessionId,
		event,
		data,
		status,
		message,
	};

	// Enkripsi payload jika env.API_KEY tersedia
	let encryptedPayload: string | null = null;
	let encryptedDataPayload: unknown = payload; // Default: kirim payload asli jika tidak ada API_KEY atau enkripsi gagal

	if (env.API_KEY) {
		try {
			// Ubah payload menjadi string JSON sebelum dienkripsi
			const payloadString = JSON.stringify(payload);
			encryptedPayload = encryptData(payloadString, env.API_KEY);

			if (encryptedPayload) {
				// Jika enkripsi berhasil, kirimkan payload yang terenkripsi
				// Anda mungkin perlu menandai bahwa data ini terenkripsi, misal dengan field tambahan
				// atau dengan header kustom. Di sini kita kirim sebagai string terenkripsi.
				encryptedDataPayload = { encryptedData: encryptedPayload };
				// Opsional: Tambahkan header untuk menandakan data terenkripsi
				// (Perlu disesuaikan dengan server penerima)
				// await axios.post(webhookUrl, encryptedDataPayload, {
				//     headers: { 'Content-Type': 'application/json', 'X-Encrypted': 'true' }
				// });
			} else {
				// Jika enkripsi gagal, log error dan kirim payload asli atau batalkan pengiriman
				logger.error(
					`Failed to encrypt webhook data for session ${sessionId}. Sending original payload.`,
				);
				// Jika Anda ingin membatalkan: return;
			}
		} catch (e) {
			logger.error(e, `Error during webhook encryption for session ${sessionId}`);
			// Jika Anda ingin membatalkan: return;
		}
	} else {
		logger.warn(
			`API_KEY not found. Sending webhook data unencrypted for session ${sessionId}.`,
		);
	}

	// Kirim request POST menggunakan axios
	try {
		await axios.post(webhookUrl, encryptedDataPayload, {
			// Anda bisa menambahkan header di sini jika diperlukan, misal untuk menandakan enkripsi
			// headers: { 'Content-Type': 'application/json', ...(encryptedPayload ? { 'X-Encrypted': 'true' } : {}) }
		});
		logger.info(`Webhook sent successfully for session ${sessionId}, event ${event}`);
	} catch (e: any) {
		logger.error(e, `Error sending webhook to ${webhookUrl} for session ${sessionId}`);
	}
}
