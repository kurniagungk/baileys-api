import type { RequestHandler } from "express";
import { logger, serializePrisma, resetUnreadCount } from "@/utils";
import type { Chat, Message } from "@prisma/client";
import { prisma } from "@/config/database";
import { presenceHandler } from "./misc";
import WhatsappService from "@/whatsapp/service";

export const list: RequestHandler = async (req, res) => {
	try {
		const { sessionId } = req.params;
		const { cursor = undefined, limit = 25 } = req.query;
		const chats = (
			await prisma.chat.findMany({
				cursor: cursor ? { pkId: Number(cursor) } : undefined,
				take: Number(limit),
				skip: cursor ? 1 : 0,
				where: { sessionId },
			})
		).map((c: Chat) => serializePrisma(c));

		res.status(200).json({
			data: chats,
			cursor:
				chats.length !== 0 && chats.length === Number(limit)
					? chats[chats.length - 1].pkId
					: null,
		});
	} catch (e) {
		const message = "An error occured during chat list";
		logger.error(e, message);
		res.status(500).json({ error: message });
		
	}
};

export const find: RequestHandler = async (req, res) => {
	try {
		const { sessionId, jid } = req.params;
		const { cursor = undefined, limit = 25 } = req.query;
		const session = WhatsappService.getSession(sessionId)!;
		// ambil unreadCount
		const chat = await prisma.chat.findUnique({
			where: {
				sessionId_id: {
					sessionId,
					id: jid,
				},
			},
			select: { unreadCount: true },
		});

		const messages = (
			await prisma.message.findMany({
				cursor: cursor ? { pkId: Number(cursor) } : undefined,
				take: Number(limit),
				skip: cursor ? 1 : 0,
				where: { sessionId, remoteJid: jid },
				orderBy: { messageTimestamp: "desc" },
			})
		).map((m: Message) => serializePrisma(m));

		if ((chat?.unreadCount ?? 0) > 0) {
			type MessageKey = {
				remoteJid: string;
				fromMe: boolean;
				id: string;
			};

			// saat akses, cast key ke tipe MessageKey
			const unreadMessages = messages
				.filter((m) => {
					const key = m.key as MessageKey | undefined;
					return key && !key.fromMe;
				})
				.slice(0, chat!.unreadCount ?? 0);

			const keys = unreadMessages.map((m) => {
				const key = m.key as MessageKey;
				return {
					remoteJid: key.remoteJid,
					id: key.id,
					fromMe: key.fromMe,
					participant: m.participant ?? undefined,
				};
			});

			await resetUnreadCount(sessionId, jid);

			await session.sendReceipts(keys, "read");
		}

		res.status(200).json({
			data: messages,
			cursor:
				messages.length !== 0 && messages.length === Number(limit)
					? messages[messages.length - 1].pkId
					: null,
		});
	} catch (e) {
		const message = "An error occured during chat find";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};

export const presence: RequestHandler = presenceHandler();

const READ_LIMIT = 500;

export const read: RequestHandler = async (req, res) => {
	try {
		const { sessionId, jid } = req.params;
		const session = WhatsappService.getSession(sessionId)!;
		const { messageIds } = req.body as { messageIds?: string[] };

		// jika messageIds diberikan, tandai pesan tersebut; jika tidak,
		// tandai semua pesan masuk yang belum dibaca di chat ini
		const where = Array.isArray(messageIds) && messageIds.length > 0
			? { sessionId, remoteJid: jid, id: { in: messageIds } }
			: {
					sessionId,
					remoteJid: jid,
					key: { path: ["fromMe"], equals: false },
				};

		const messages = await prisma.message.findMany({
			where,
			select: { key: true, participant: true },
			orderBy: { pkId: "desc" },
			take: READ_LIMIT,
		});

		if (messages.length === 0) {
			return res.status(200).json({ message: "No unread messages", count: 0 });
		}

		const keys = messages
			.map((m) => {
				const key = m.key as
					| { remoteJid: string; id: string; fromMe: boolean }
					| undefined;
				if (!key?.id) return null;
				return {
					remoteJid: key.remoteJid,
					id: key.id,
					fromMe: key.fromMe,
					participant: m.participant ?? undefined,
				};
			})
			.filter((k): k is NonNullable<typeof k> => k !== null);

		await session.readMessages(keys);
		// reset counter hanya jika semua pesan masuk tertangani;
		// jika terpotong limit, biarkan unreadCount mencerminkan sisa pesan
		if (messages.length < READ_LIMIT) {
			await resetUnreadCount(sessionId, jid);
		}

		res.status(200).json({ message: "Messages marked as read", count: keys.length });
	} catch (e) {
		const message = "An error occured during marking messages as read";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};
