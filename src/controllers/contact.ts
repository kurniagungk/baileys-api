import type { RequestHandler } from "express";
import { logger } from "@/utils";
import { makePhotoURLHandler } from "./misc";
import { prisma } from "@/config/database";
import WhatsappService from "@/whatsapp/service";

interface ContactRaw {
	pkId: number;
	sessionId: string;
	id: string;
	name?: string | null;
	notify?: string | null;
	verifiedName?: string | null;
	imgUrl?: string | null;
	status?: string | null;
	unreadCount?: number | null;
}

export const list: RequestHandler = async (req, res) => {
	try {
		const { sessionId } = req.params;
		const { cursor = undefined, limit = 25, search } = req.query;

		const limitNumber = Number(limit);
		const cursorNumber = cursor ? Number(cursor) : null;

		const conditions = ["c.sessionId = ?", "c.id LIKE '%@s.whatsapp.net'"];
		const params: (string | number)[] = [sessionId];

		if (search) {
			// Kalau ada search, tambahkan kondisi search, tapi *jangan* tambahkan lidJid IS NOT NULL
			conditions.push("(c.name LIKE ? OR c.verifiedName LIKE ? OR c.notify LIKE ?)");
			const searchTerm = `%${search}%`;
			params.push(searchTerm, searchTerm, searchTerm);
		} else {
			// Kalau tidak ada search, tambahkan kondisi lidJid IS NOT NULL
			conditions.push("lidJid IS NOT NULL");
		}

		if (cursorNumber) {
			conditions.push("c.pkId > ?");
			params.push(cursorNumber);
		}

		params.push(limitNumber);

		const whereClause = `WHERE ${conditions.join(" AND ")}`;

		const rawQuery = `
			SELECT 
				c.pkId, 
				c.sessionId, 
				c.id, 
				c.name, 
				c.notify, 
				c.verifiedName, 
				c.imgUrl, 
				c.status,
				m.unreadCount
			FROM Contact c
			LEFT JOIN Chat m ON c.id = m.id AND c.sessionId = m.sessionId
			${whereClause}
			GROUP BY c.pkId, c.sessionId, c.id, c.name, c.notify, c.verifiedName, c.imgUrl, c.status, m.unreadCount
			ORDER BY m.conversationTimestamp DESC
			LIMIT ?
			`;

		const contacts = await prisma.$queryRawUnsafe<ContactRaw[]>(rawQuery, ...params);

		const contactsSafe = contacts.map((c) => ({
			...c,
			pkId: c.pkId.toString(),
			unreadCount: c.unreadCount ?? 0,
		}));

		const lastCursor =
			contacts.length === limitNumber ? contacts[contacts.length - 1].pkId.toString() : null;

		res.status(200).json({
			data: contactsSafe,
			cursor: lastCursor,
		});
	} catch (e) {
		const message = "An error occurred during contact list";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};

export const listBlocked: RequestHandler = async (req, res) => {
	try {
		const session = WhatsappService.getSession(req.params.sessionId)!;
		const data = await session.fetchBlocklist();
		res.status(200).json(data);
	} catch (e) {
		const message = "An error occured during blocklist fetch";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};

export const updateBlock: RequestHandler = async (req, res) => {
	try {
		const session = WhatsappService.getSession(req.params.sessionId)!;
		const { jid, action = "block" } = req.body;

		const exists = await WhatsappService.jidExists(session, jid);
		if (!exists) return res.status(400).json({ error: "Jid does not exists" });

		await session.updateBlockStatus(jid, action);
		res.status(200).json({ message: `Contact ${action}ed` });
	} catch (e) {
		const message = "An error occured during blocklist update";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};

export const check: RequestHandler = async (req, res) => {
	try {
		const { sessionId, jid } = req.params;
		const session = WhatsappService.getSession(sessionId)!;

		const exists = await WhatsappService.jidExists(session, jid);
		res.status(200).json({ exists });
	} catch (e) {
		const message = "An error occured during jid check";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};

export const photo: RequestHandler = makePhotoURLHandler();
