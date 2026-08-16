import type { BaileysEventEmitter } from "baileys";
import type { BaileysEventHandler } from "@/types";
import { logger, emitEvent } from "@/utils";
import { prisma } from "@/config/database";

export default function labelHandler(sessionId: string, event: BaileysEventEmitter) {
	let listening = false;

	const labelEdited: BaileysEventHandler<"labels.edit"> = async (label) => {
		try {
			if (!label?.id) {
				logger.info({ label }, "Got label edit without label id");
				return;
			}

			const data = {
				sessionId,
				labelId: label.id,
				name: label.name ?? "",
				color: label.color ?? 0,
				predefinedId: label.predefinedId,
				deleted: label.deleted ?? false,
			};

			await prisma.label.upsert({
				select: { pkId: true },
				create: data,
				update: {
					name: data.name,
					color: data.color,
					predefinedId: data.predefinedId,
					deleted: data.deleted,
				},
				where: { sessionId_labelId: { sessionId, labelId: label.id } },
			});
			emitEvent("labels.edit", sessionId, { label: data });
		} catch (e) {
			logger.error(e, "An error occured during label edit");
			emitEvent(
				"labels.edit",
				sessionId,
				undefined,
				"error",
				`An error occured during label edit: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	};

	const labelAssociation: BaileysEventHandler<"labels.association"> = async (update) => {
		emitEvent("labels.association", sessionId, update);
	};

	const listen = () => {
		if (listening) return;

		logger.info("Label handler listening");
		event.on("labels.edit", labelEdited);
		event.on("labels.association", labelAssociation);
		listening = true;
	};

	const unlisten = () => {
		if (!listening) return;

		event.off("labels.edit", labelEdited);
		event.off("labels.association", labelAssociation);
		listening = false;
	};

	return { listen, unlisten };
}
