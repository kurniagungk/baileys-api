"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = messageHandler;
const baileys_1 = require("baileys");
const utils_1 = require("../../../utils");
const database_1 = require("../../../config/database");
const getKeyAuthor = (key) => (key?.fromMe ? "me" : key?.participant || key?.remoteJid) || "";
function messageHandler(sessionId, event) {
    const model = database_1.prisma.message;
    let listening = false;
    const set = async ({ messages, isLatest }) => {
        try {
            await database_1.prisma.$transaction(async (tx) => {
                if (isLatest)
                    await tx.message.deleteMany({ where: { sessionId } });
                const processedMessages = messages.map((message) => ({
                    ...(0, utils_1.transformPrisma)(message),
                    remoteJid: message.key.remoteJid,
                    id: message.key.id,
                    sessionId,
                }));
                await tx.message.createMany({
                    data: processedMessages,
                });
                (0, utils_1.emitEvent)("messages.upsert", sessionId, { messages: processedMessages });
            });
            utils_1.logger.info({ messages: messages.length }, "Synced messages");
        }
        catch (e) {
            utils_1.logger.error(e, "An error occured during messages set");
            (0, utils_1.emitEvent)("messages.upsert", sessionId, undefined, "error", `An error occured during messages set: ${e.message}`);
        }
    };
    const upsert = async ({ messages, type }) => {
        switch (type) {
            case "append":
            case "notify":
                for (const message of messages) {
                    try {
                        const jid = (0, baileys_1.jidNormalizedUser)(message.key.remoteJid);
                        const data = (0, utils_1.transformPrisma)(message);
                        await model.upsert({
                            select: { pkId: true },
                            create: {
                                ...data,
                                remoteJid: jid,
                                id: message.key.id,
                                sessionId,
                            },
                            update: { ...data },
                            where: {
                                sessionId_remoteJid_id: {
                                    remoteJid: jid,
                                    id: message.key.id,
                                    sessionId,
                                },
                            },
                        });
                        (0, utils_1.emitEvent)("messages.upsert", sessionId, { messages: data });
                        const chatExists = (await database_1.prisma.chat.count({ where: { id: jid, sessionId } })) > 0;
                        if (type === "notify" && !chatExists) {
                            event.emit("chats.upsert", [
                                {
                                    id: jid,
                                    conversationTimestamp: (0, baileys_1.toNumber)(message.messageTimestamp),
                                    unreadCount: 1,
                                },
                            ]);
                        }
                    }
                    catch (e) {
                        utils_1.logger.error(e, "An error occured during message upsert");
                        (0, utils_1.emitEvent)("messages.upsert", sessionId, undefined, "error", `An error occured during message upsert: ${e.message}`);
                    }
                }
                break;
        }
    };
    const update = async (updates) => {
        for (const { update, key } of updates) {
            try {
                await database_1.prisma.$transaction(async (tx) => {
                    const prevData = await tx.message.findFirst({
                        where: { id: key.id, remoteJid: key.remoteJid, sessionId },
                    });
                    if (!prevData) {
                        return utils_1.logger.info({ update }, "Got update for non existent message");
                    }
                    const data = { ...prevData, ...update };
                    if (!data.key || !data.key.id || !data.key.remoteJid) {
                        return utils_1.logger.info({ update, key }, "Message key is incomplete");
                    }
                    await tx.message.delete({
                        select: { pkId: true },
                        where: {
                            sessionId_remoteJid_id: {
                                id: data.key.id,
                                remoteJid: data.key.remoteJid,
                                sessionId,
                            },
                        },
                    });
                    const processedMessage = {
                        ...(0, utils_1.transformPrisma)(data),
                        id: data.key.id,
                        remoteJid: data.key.remoteJid,
                        sessionId,
                    };
                    await tx.message.create({
                        select: { pkId: true },
                        data: processedMessage,
                    });
                    await (0, utils_1.resetUnreadCount)(sessionId, data.key.remoteJid);
                    (0, utils_1.emitEvent)("messages.update", sessionId, { messages: processedMessage });
                });
            }
            catch (e) {
                utils_1.logger.error(e, "An error occured during message update");
                (0, utils_1.emitEvent)("messages.update", sessionId, undefined, "error", `An error occured during message update: ${e.message}`);
            }
        }
    };
    const del = async (item) => {
        try {
            if ("all" in item) {
                await database_1.prisma.message.deleteMany({ where: { remoteJid: item.jid, sessionId } });
                (0, utils_1.emitEvent)("messages.delete", sessionId, { message: item });
                return;
            }
            const jid = item.keys[0].remoteJid;
            await database_1.prisma.message.deleteMany({
                where: { id: { in: item.keys.map((k) => k.id) }, remoteJid: jid, sessionId },
            });
            (0, utils_1.emitEvent)("messages.delete", sessionId, { message: item });
        }
        catch (e) {
            utils_1.logger.error(e, "An error occured during message delete");
            (0, utils_1.emitEvent)("messages.delete", sessionId, undefined, "error", `An error occured during message delete: ${e.message}`);
        }
    };
    const updateReceipt = async (updates) => {
        for (const { key, receipt } of updates) {
            try {
                await database_1.prisma.$transaction(async (tx) => {
                    const message = await tx.message.findFirst({
                        select: { userReceipt: true },
                        where: { id: key.id, remoteJid: key.remoteJid, sessionId },
                    });
                    if (!message) {
                        return utils_1.logger.debug({ key, receipt }, "Got receipt update for non existent message");
                    }
                    let userReceipt = (message.userReceipt ||
                        []);
                    const recepient = userReceipt.find((m) => m.userJid === receipt.userJid);
                    if (recepient) {
                        userReceipt = [
                            ...userReceipt.filter((m) => m.userJid !== receipt.userJid),
                            receipt,
                        ];
                    }
                    else {
                        userReceipt.push(receipt);
                    }
                    await tx.message.update({
                        select: { pkId: true },
                        data: (0, utils_1.transformPrisma)({ userReceipt: userReceipt }),
                        where: {
                            sessionId_remoteJid_id: {
                                id: key.id,
                                remoteJid: key.remoteJid,
                                sessionId,
                            },
                        },
                    });
                    (0, utils_1.emitEvent)("message-receipt.update", sessionId, { message: { key, receipt } });
                });
            }
            catch (e) {
                utils_1.logger.error(e, "An error occured during message receipt update");
                (0, utils_1.emitEvent)("message-receipt.update", sessionId, undefined, "error", `An error occured during message receipt update: ${e.message}`);
            }
        }
    };
    const updateReaction = async (reactions) => {
        for (const { key, reaction } of reactions) {
            try {
                await database_1.prisma.$transaction(async (tx) => {
                    const message = await tx.message.findFirst({
                        select: { reactions: true },
                        where: { id: key.id, remoteJid: key.remoteJid, sessionId },
                    });
                    if (!message) {
                        return utils_1.logger.debug({ update }, "Got reaction update for non existent message");
                    }
                    const authorID = getKeyAuthor(reaction.key);
                    const reactions = (message.reactions || []).filter((r) => getKeyAuthor(r.key) !== authorID);
                    if (reaction.text)
                        reactions.push(reaction);
                    await tx.message.update({
                        select: { pkId: true },
                        data: (0, utils_1.transformPrisma)({ reactions: reactions }),
                        where: {
                            sessionId_remoteJid_id: {
                                id: key.id,
                                remoteJid: key.remoteJid,
                                sessionId,
                            },
                        },
                    });
                    (0, utils_1.emitEvent)("messages.reaction", sessionId, { message: { key, reaction } });
                });
            }
            catch (e) {
                utils_1.logger.error(e, "An error occured during message reaction update");
                (0, utils_1.emitEvent)("messages.reaction", sessionId, undefined, "error", `An error occured during message reaction update: ${e.message}`);
            }
        }
    };
    const listen = () => {
        if (listening)
            return;
        event.on("messaging-history.set", set);
        event.on("messages.upsert", upsert);
        event.on("messages.update", update);
        event.on("messages.delete", del);
        event.on("message-receipt.update", updateReceipt);
        event.on("messages.reaction", updateReaction);
        listening = true;
    };
    const unlisten = () => {
        if (!listening)
            return;
        event.off("messaging-history.set", set);
        event.off("messages.upsert", upsert);
        event.off("messages.update", update);
        event.off("messages.delete", del);
        event.off("message-receipt.update", updateReceipt);
        event.off("messages.reaction", updateReaction);
        listening = false;
    };
    return { listen, unlisten };
}
