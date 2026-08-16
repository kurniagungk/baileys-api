import { Router } from "express";
import { body, param } from "express-validator";
import { label } from "@/controllers";
import requestValidator from "@/middlewares/request-validator";
import sessionValidator from "@/middlewares/session-validator";

const router: Router = Router({ mergeParams: true });
router.get("/", sessionValidator, label.list);
router.post(
	"/",
	body("name").isString().notEmpty().isLength({ max: 100 }),
	body("color").isInt({ min: 0, max: 19 }),
	body("predefinedId").isNumeric().optional(),
	requestValidator,
	sessionValidator,
	label.add,
);
router.put(
	"/:labelId",
	param("labelId").isString().notEmpty(),
	body("name").isString().notEmpty().isLength({ max: 100 }).optional(),
	body("color").isInt({ min: 0, max: 19 }).optional(),
	requestValidator,
	sessionValidator,
	label.update,
);
router.delete("/:labelId", sessionValidator, label.remove);
router.post(
	"/chats/:jid/:labelId",
	param("jid").isString().notEmpty(),
	param("labelId").isString().notEmpty(),
	requestValidator,
	sessionValidator,
	label.addChatLabel,
);
router.delete(
	"/chats/:jid/:labelId",
	param("jid").isString().notEmpty(),
	param("labelId").isString().notEmpty(),
	requestValidator,
	sessionValidator,
	label.removeChatLabel,
);
router.post(
	"/messages/:jid/:messageId/:labelId",
	param("jid").isString().notEmpty(),
	param("messageId").isString().notEmpty(),
	param("labelId").isString().notEmpty(),
	requestValidator,
	sessionValidator,
	label.addMessageLabel,
);
router.delete(
	"/messages/:jid/:messageId/:labelId",
	param("jid").isString().notEmpty(),
	param("messageId").isString().notEmpty(),
	param("labelId").isString().notEmpty(),
	requestValidator,
	sessionValidator,
	label.removeMessageLabel,
);

export default router;
