import type { RequestHandler } from "express";
import { logger } from "@/utils";
import { prisma } from "@/config/database";
import WhatsappService from "@/whatsapp/service";

// addLabel di Baileys menandai label_edit oleh label id, jid hanya syarat
// signature — gunakan JID akun sendiri sebagai default.
// Null berarti session belum terhubung (creds.me belum terisi).
function getOwnJid(sessionId: string): string | null {
	const session = WhatsappService.getSession(sessionId)!;
	return session.authState.creds.me?.id ?? null;
}

export const list: RequestHandler = async (req, res) => {
	try {
		const { sessionId } = req.params;
		const labels = await prisma.label.findMany({
			where: { sessionId, deleted: false },
			orderBy: { pkId: "asc" },
		});
		res.status(200).json({ data: labels });
	} catch (e) {
		const message = "An error occured during label list";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};

export const add: RequestHandler = async (req, res) => {
	try {
		const { sessionId } = req.params;
		const session = WhatsappService.getSession(sessionId)!;
		const { name, color, predefinedId } = req.body;

		// id label custom digenerate client-side; label predefined pakai predefinedId
		const ownJid = getOwnJid(sessionId);
		if (!ownJid) {
			return res.status(400).json({ error: "Session is not connected" });
		}

		await session.addLabel(ownJid, {
			id: predefinedId ?? Date.now().toString(),
			name,
			color,
			predefinedId: predefinedId !== undefined ? Number(predefinedId) : undefined,
		});
		res.status(200).json({ message: "Label added" });
	} catch (e) {
		const message = "An error occured during label creation";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};

export const update: RequestHandler = async (req, res) => {
	try {
		const { sessionId, labelId } = req.params;
		const session = WhatsappService.getSession(sessionId)!;
		const { name, color } = req.body;

		const ownJid = getOwnJid(sessionId);
		if (!ownJid) {
			return res.status(400).json({ error: "Session is not connected" });
		}

		await session.addLabel(ownJid, { id: labelId, name, color });
		res.status(200).json({ message: "Label updated" });
	} catch (e) {
		const message = "An error occured during label update";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};

export const remove: RequestHandler = async (req, res) => {
	try {
		const { sessionId, labelId } = req.params;
		const session = WhatsappService.getSession(sessionId)!;

		const ownJid = getOwnJid(sessionId);
		if (!ownJid) {
			return res.status(400).json({ error: "Session is not connected" });
		}

		await session.addLabel(ownJid, { id: labelId, deleted: true });
		await prisma.label.updateMany({
			data: { deleted: true },
			where: { sessionId, labelId },
		});
		res.status(200).json({ message: "Label deleted" });
	} catch (e) {
		const message = "An error occured during label deletion";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};

export const addChatLabel: RequestHandler = async (req, res) => {
	try {
		const { sessionId, jid, labelId } = req.params;
		const session = WhatsappService.getSession(sessionId)!;

		const isGroup = jid.endsWith("@g.us");
		const validJid = await WhatsappService.validJid(session, jid, isGroup ? "group" : "number");
		if (!validJid) {
			return res.status(422).json({ error: "The jid does not exist" });
		}

		await session.addChatLabel(validJid, labelId);
		res.status(200).json({ message: "Chat label added" });
	} catch (e) {
		const message = "An error occured during adding chat label";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};

export const removeChatLabel: RequestHandler = async (req, res) => {
	try {
		const { sessionId, jid, labelId } = req.params;
		const session = WhatsappService.getSession(sessionId)!;

		const isGroup = jid.endsWith("@g.us");
		const validJid = await WhatsappService.validJid(session, jid, isGroup ? "group" : "number");
		if (!validJid) {
			return res.status(422).json({ error: "The jid does not exist" });
		}

		await session.removeChatLabel(validJid, labelId);
		res.status(200).json({ message: "Chat label removed" });
	} catch (e) {
		const message = "An error occured during removing chat label";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};

export const addMessageLabel: RequestHandler = async (req, res) => {
	try {
		const { sessionId, jid, messageId, labelId } = req.params;
		const session = WhatsappService.getSession(sessionId)!;

		const isGroup = jid.endsWith("@g.us");
		const validJid = await WhatsappService.validJid(session, jid, isGroup ? "group" : "number");
		if (!validJid) {
			return res.status(422).json({ error: "The jid does not exist" });
		}

		await session.addMessageLabel(validJid, messageId, labelId);
		res.status(200).json({ message: "Message label added" });
	} catch (e) {
		const message = "An error occured during adding message label";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};

export const removeMessageLabel: RequestHandler = async (req, res) => {
	try {
		const { sessionId, jid, messageId, labelId } = req.params;
		const session = WhatsappService.getSession(sessionId)!;

		const isGroup = jid.endsWith("@g.us");
		const validJid = await WhatsappService.validJid(session, jid, isGroup ? "group" : "number");
		if (!validJid) {
			return res.status(422).json({ error: "The jid does not exist" });
		}

		await session.removeMessageLabel(validJid, messageId, labelId);
		res.status(200).json({ message: "Message label removed" });
	} catch (e) {
		const message = "An error occured during removing message label";
		logger.error(e, message);
		res.status(500).json({ error: message });
	}
};
