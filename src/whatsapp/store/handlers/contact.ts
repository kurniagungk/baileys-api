import type { BaileysEventEmitter } from "baileys";
import type { BaileysEventHandler } from "@/types";
import { transformPrisma, logger, emitEvent } from "@/utils";
import { prisma } from "@/config/database";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import WhatsappService from "@/whatsapp/service";

export default function contactHandler(sessionId: string, event: BaileysEventEmitter) {
	const model = prisma.contact;
	let listening = false;

	// helper: ubah nomor mentah -> JID WhatsApp user
	function toUserJidFromNumber(num?: string | null): string | null {
		if (!num) return null;
		const digits = String(num).replace(/\D/g, "");
		if (!digits) return null;
		const normalized = digits.startsWith("0") ? `62${digits.slice(1)}` : digits;
		return `${normalized}@s.whatsapp.net`;
	}

	type RawContact = any;
	type ContactCreateInput = {
		id: string;
		sessionId: string;
		name?: string | null;
		notify?: string | null;
		verifiedName?: string | null;
		imgUrl?: string | null;
		status?: string | null;
	};

	function normalizeContact(raw: RawContact, sessionId: string): ContactCreateInput | null {
		// ambil id dari id -> jid -> fallback nomor (opsional)
		let id: string | null = raw?.id ?? raw?.jid ?? null;
		if (!id) id = toUserJidFromNumber(raw?.number ?? raw?.phone ?? null);
		if (!id) return null; // drop jika tetap tidak ada

		return {
			id,
			sessionId,
			name: raw?.name ?? null,
			notify: raw?.notify ?? null,
			verifiedName: raw?.verifiedName ?? null,
			imgUrl: typeof raw?.imgUrl === "string" ? raw.imgUrl : null,
			status: raw?.status ?? null,
		};
	}

	const set: BaileysEventHandler<"messaging-history.set"> = async ({ contacts }) => {
		try {
			const session = WhatsappService.getSession(sessionId)!;

			const dropped: RawContact[] = [];

			const processedContacts = await Promise.all(
				contacts.map(async (contact) => {
					const transformed = transformPrisma(contact, false);

					// pastikan imgUrl property ada (nullable)
					if (!("imgUrl" in transformed)) transformed.imgUrl = null;

					// hanya cek PP kalau kita punya id/jid untuk dicek
					const jidForCheck: string | undefined = transformed?.id ?? transformed?.jid;
					if (jidForCheck) {
						const exists = await WhatsappService.jidExists(
							session,
							jidForCheck,
							"number",
						).catch(() => false);
						transformed.imgUrl = exists
							? await session.profilePictureUrl(jidForCheck).catch(() => null)
							: null;
					} else {
						// tidak ada id/jid -> nanti akan di-drop saat normalisasi
						transformed.imgUrl = null;
					}

					const sanitized = normalizeContact(transformed, sessionId);
					if (!sanitized) dropped.push(contact);
					return sanitized;
				}),
			);

			// buang yang null (tanpa id/jid)
			const validContacts: ContactCreateInput[] = processedContacts.filter(Boolean) as any[];

			logger.info(
				{ received: contacts.length, saved: validContacts.length, dropped: dropped.length },
				"Contacts prepared",
			);
			if (dropped.length) {
				logger.warn({ samples: dropped.slice(0, 3) }, "Dropped contacts: missing id/jid");
			}

			// upsert hanya field yang ada di schema Contact
			const upsertPromises = validContacts.map((data) =>
				model.upsert({
					select: { pkId: true },
					create: data,
					update: {
						name: data.name ?? null,
						notify: data.notify ?? null,
						verifiedName: data.verifiedName ?? null,
						imgUrl: data.imgUrl ?? null,
						status: data.status ?? null,
						// id & sessionId tidak diubah pada update
					},
					where: { sessionId_id: { id: data.id, sessionId: data.sessionId } },
				}),
			);

			const results = await Promise.allSettled(upsertPromises);
			const failed = results.filter(
				(r) => r.status === "rejected",
			) as PromiseRejectedResult[];
			if (failed.length) {
				logger.error(
					{
						failed: failed.length,
						reasons: failed.slice(0, 3).map((f) => String(f.reason)),
					},
					"Some upserts failed",
				);
			}

			logger.info({ newContacts: validContacts.length }, "Synced contacts");
			emitEvent("contacts.set", sessionId, { contacts: validContacts });
		} catch (e: unknown) {
			logger.error(e, "An error occured during contacts set");
			emitEvent(
				"contacts.set",
				sessionId,
				undefined,
				"error",
				`An error occured during contacts set: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	};

	const upsert: BaileysEventHandler<"contacts.upsert"> = async (contacts) => {
		try {
			console.info(`Received ${contacts.length} contacts for upsert.`); // Informative message
			console.info(contacts[0]); // Informative message

			if (contacts.length === 0) {
				return;
			}

			const processedContacts = contacts
				.map((contact) => transformPrisma(contact))
				.map((contact) => ({
					...contact,
					sessionId,
				}));
			await model.createMany({
				data: processedContacts,
				skipDuplicates: true, // Prevent duplicate inserts
			});
			emitEvent("contacts.upsert", sessionId, { contacts: processedContacts });
		} catch (error: any) {
			logger.error("An unexpected error occurred during contacts upsert", error);
			emitEvent(
				"contacts.upsert",
				sessionId,
				undefined,
				"error",
				`An unexpected error occurred during contacts upsert: ${error.message}`,
			);
		}
	};

	const update: BaileysEventHandler<"contacts.update"> = async (updates) => {
		for (const update of updates) {
			try {
				const data = transformPrisma(update);
				await model.update({
					select: { pkId: true },
					data,
					where: {
						sessionId_id: { id: update.id!, sessionId },
					},
				});
				emitEvent("contacts.update", sessionId, { contacts: data });
			} catch (e: any) {
				if (e instanceof PrismaClientKnownRequestError && e.code === "P2025") {
					return logger.info({ update }, "Got update for non existent contact");
				}
				logger.error(e, "An error occured during contact update");
				emitEvent(
					"contacts.update",
					sessionId,
					undefined,
					"error",
					`An error occured during contact update: ${e.message}`,
				);
			}
		}
	};

	const listen = () => {
		if (listening) return;

		event.on("messaging-history.set", set);
		event.on("contacts.upsert", upsert);
		event.on("contacts.update", update);
		listening = true;
	};

	const unlisten = () => {
		if (!listening) return;

		event.off("messaging-history.set", set);
		event.off("contacts.upsert", upsert);
		event.off("contacts.update", update);
		listening = false;
	};

	return { listen, unlisten };
}
