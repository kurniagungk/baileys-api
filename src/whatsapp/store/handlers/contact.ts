import type { BaileysEventEmitter } from "baileys";
import type { BaileysEventHandler } from "@/types";
import { transformPrisma, logger, emitEvent } from "@/utils";
import { prisma } from "@/config/database";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import WhatsappService from "@/whatsapp/service";

export default function contactHandler(sessionId: string, event: BaileysEventEmitter) {
	const model = prisma.contact;
	let listening = false;

	const set: BaileysEventHandler<"messaging-history.set"> = async ({ contacts }) => {
		try {
			// const contactIds = contacts.map((c) => c.id);
			// const deletedOldContactIds = (
			// 	await prisma.contact.findMany({
			// 		select: { id: true },
			// 		where: { id: { notIn: contactIds }, sessionId },
			// 	})
			// ).map((c) => c.id);
			const session = WhatsappService.getSession(sessionId)!;

			const processedContacts = await Promise.all(
				contacts.map(async (contact) => {
					const transformed = transformPrisma(contact, false);

					// Pastikan properti imgUrl ada, kalau belum ada buat default null
					if (!("imgUrl" in transformed)) {
						transformed.imgUrl = null;
					}

					if (typeof transformed.imgUrl !== "undefined") {
						// cek dulu apakah JID ada
						const exists = await WhatsappService.jidExists(
							session,
							transformed.id!,
							"number",
						); // "user" atau tipe yang sesuai

						if (!exists) {
							transformed.imgUrl = null;
						} else {
							// kalau ada, ambil URL foto profil
							const url = await session
								.profilePictureUrl(transformed.id!)
								.catch(() => null);
							transformed.imgUrl = url;
	
						}
					}


					return transformed;
				}),
			);

			logger.info(processedContacts[0], "Upsert promises");

			const upsertPromises = processedContacts.map((data) =>
				model.upsert({
					select: { pkId: true },
					create: { ...data, sessionId },
					update: data,
					where: { sessionId_id: { id: data.id, sessionId } },
				}),
			);

			logger.info(upsertPromises[0], "Upsert promises");

			await Promise.any([
				...upsertPromises,
				//danger: contacts come with several patches of N contacts, deleting those that are not in this patch ends up deleting those received in the previous patch
				//prisma.contact.deleteMany({ where: { id: { in: deletedOldContactIds }, sessionId } }),
			]);
			logger.info({ newContacts: contacts.length }, "Synced contacts");
			emitEvent("contacts.set", sessionId, { contacts: processedContacts });
		} catch (e: unknown) {
			logger.error(e, "An error occured during contacts set");
			emitEvent(
				"contacts.set",
				sessionId,
				undefined,
				"error",
				`An error occured during contacts set: ${
					e instanceof Error ? e.message : String(e)
				}`,
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
