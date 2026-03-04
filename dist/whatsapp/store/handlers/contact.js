"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = contactHandler;
const utils_1 = require("../../../utils");
const database_1 = require("../../../config/database");
const library_1 = require("@prisma/client/runtime/library");
const service_1 = __importDefault(require("../../service"));
function contactHandler(sessionId, event) {
    const model = database_1.prisma.contact;
    let listening = false;
    function toUserJidFromNumber(num) {
        if (!num)
            return null;
        const digits = String(num).replace(/\D/g, "");
        if (!digits)
            return null;
        const normalized = digits.startsWith("0") ? `62${digits.slice(1)}` : digits;
        return `${normalized}@s.whatsapp.net`;
    }
    function normalizeContact(raw, sessionId) {
        let id = raw?.id ?? raw?.jid ?? null;
        if (!id)
            id = toUserJidFromNumber(raw?.number ?? raw?.phone ?? null);
        if (!id)
            return null;
        return {
            id,
            sessionId,
            name: raw?.name ?? undefined,
            notify: raw?.notify ?? undefined,
            verifiedName: raw?.verifiedName ?? undefined,
            imgUrl: typeof raw?.imgUrl === "string" ? raw.imgUrl : undefined,
            status: raw?.status ?? undefined,
        };
    }
    const set = async ({ contacts }) => {
        try {
            const session = service_1.default.getSession(sessionId);
            const dropped = [];
            const processedContacts = await Promise.all(contacts.map(async (contact) => {
                const transformed = (0, utils_1.transformPrisma)(contact, false);
                if (!("imgUrl" in transformed))
                    transformed.imgUrl = undefined;
                const jidForCheck = transformed?.id;
                if (jidForCheck) {
                    const exists = await service_1.default.jidExists(session, jidForCheck, "number").catch(() => false);
                    transformed.imgUrl = exists
                        ? await session.profilePictureUrl(jidForCheck).catch(() => undefined)
                        : undefined;
                }
                else {
                    transformed.imgUrl = undefined;
                }
                const sanitized = normalizeContact(transformed, sessionId);
                if (!sanitized)
                    dropped.push(contact);
                return sanitized;
            }));
            const validContacts = processedContacts.filter(Boolean);
            utils_1.logger.info({ received: contacts.length, saved: validContacts.length, dropped: dropped.length }, "Contacts prepared");
            if (dropped.length) {
                utils_1.logger.warn({ samples: dropped.slice(0, 3) }, "Dropped contacts: missing id/jid");
            }
            const upsertPromises = validContacts.map((data) => model.upsert({
                select: { pkId: true },
                create: data,
                update: {
                    name: data.name ?? undefined,
                    notify: data.notify ?? undefined,
                    verifiedName: data.verifiedName ?? undefined,
                    imgUrl: data.imgUrl ?? undefined,
                    status: data.status ?? undefined,
                },
                where: { sessionId_id: { id: data.id, sessionId: data.sessionId } },
            }));
            const results = await Promise.allSettled(upsertPromises);
            const failed = results.filter((r) => r.status === "rejected");
            if (failed.length) {
                utils_1.logger.error({
                    failed: failed.length,
                    reasons: failed.slice(0, 3).map((f) => String(f.reason)),
                }, "Some upserts failed");
            }
            utils_1.logger.info({ newContacts: validContacts.length }, "Synced contacts");
            (0, utils_1.emitEvent)("contacts.set", sessionId, { contacts: validContacts });
        }
        catch (e) {
            utils_1.logger.error(e, "An error occured during contacts set");
            (0, utils_1.emitEvent)("contacts.set", sessionId, undefined, "error", `An error occured during contacts set: ${e instanceof Error ? e.message : String(e)}`);
        }
    };
    const upsert = async (contacts) => {
        try {
            console.info(`Received ${contacts.length} contacts for upsert.`);
            console.info(contacts[0]);
            if (contacts.length === 0) {
                return;
            }
            const processedContacts = contacts
                .map((contact) => (0, utils_1.transformPrisma)(contact))
                .map((contact) => ({
                ...contact,
                sessionId,
            }));
            await model.createMany({
                data: processedContacts,
                skipDuplicates: true,
            });
            (0, utils_1.emitEvent)("contacts.upsert", sessionId, { contacts: processedContacts });
        }
        catch (error) {
            utils_1.logger.error("An unexpected error occurred during contacts upsert", error);
            (0, utils_1.emitEvent)("contacts.upsert", sessionId, undefined, "error", `An unexpected error occurred during contacts upsert: ${error.message}`);
        }
    };
    const update = async (updates) => {
        for (const update of updates) {
            try {
                if (!update?.id) {
                    const data = (0, utils_1.transformPrisma)(update);
                    utils_1.logger.info({ update }, "Got update without contact id");
                    (0, utils_1.emitEvent)("contacts.update", sessionId, { contacts: data }, "success", "Skipped update: missing contact id");
                    continue;
                }
                const data = (0, utils_1.transformPrisma)(update);
                delete data.id;
                delete data.sessionId;
                const result = await model.updateMany({
                    data,
                    where: { id: update.id, sessionId },
                });
                if (result.count === 0) {
                    utils_1.logger.info({ update }, "Got update for non existent contact");
                    continue;
                }
                (0, utils_1.emitEvent)("contacts.update", sessionId, { contacts: data });
            }
            catch (e) {
                if (e instanceof library_1.PrismaClientKnownRequestError && e.code === "P2025") {
                    utils_1.logger.info({ update }, "Got update for non existent contact");
                    continue;
                }
                utils_1.logger.error(e, "An error occured during contact update");
                (0, utils_1.emitEvent)("contacts.update", sessionId, undefined, "error", `An error occured during contact update: ${e.message}`);
            }
        }
    };
    const listen = () => {
        if (listening)
            return;
        event.on("messaging-history.set", set);
        event.on("contacts.upsert", upsert);
        event.on("contacts.update", update);
        listening = true;
    };
    const unlisten = () => {
        if (!listening)
            return;
        event.off("messaging-history.set", set);
        event.off("contacts.upsert", upsert);
        event.off("contacts.update", update);
        listening = false;
    };
    return { listen, unlisten };
}
