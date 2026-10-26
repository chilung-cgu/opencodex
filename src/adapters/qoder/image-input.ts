import type { OcxParsedRequest } from "../../types";
import { buildConversationInput } from "../coding-agent/protocol";

/** #7516 live evidence: qoderclicn 1.1.70, one user PNG on stream-json stdin. */
export function qoderCnImageInputSupported(parsed: OcxParsedRequest): boolean {
  const messages = parsed.context.messages;
  const imageMessages = messages.filter(message => Array.isArray(message.content)
    && message.content.some(part => part.type === "image"));
  if (imageMessages.length === 0) return true;
  const nonDev = messages.filter(message => message.role !== "developer");
  if (imageMessages.length !== 1 || nonDev.length !== 1 || imageMessages[0] !== nonDev[0]
    || nonDev[0]!.role !== "user"
    || !["DeepSeek-Flash", "Qwen3.8-Flash"].includes(parsed.modelId)) return false;
  const content = nonDev[0]!.content;
  if (!Array.isArray(content)) return false;
  const images = content.filter(part => part.type === "image");
  return images.length === 1 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(images[0]!.imageUrl);
}

/** Keep Qoder omission markers out of CodeBuddy's and Claude's replay formats. */
export const buildQoderConversationInput: typeof buildConversationInput = (parsed, options = {}) =>
  buildConversationInput(parsed, { ...options, markUnsupportedImages: true });
