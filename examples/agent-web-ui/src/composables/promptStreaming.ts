import {
  appendMessage,
  findMessage,
  findMessageByToolId,
  getSession,
} from "../stores/chat.ts";
import { useBridge } from "./useBridge.ts";
import { randomUUID } from "../uuid.ts";
import type { DiscoveredAgentDTO, WireAttachment } from "../wire.ts";

/**
 * Start one prompt stream against one discovered agent and mirror every
 * incoming event into the per-agent chat store.
 */
export function startPromptStream(
  agent: DiscoveredAgentDTO,
  text: string,
  attachments: WireAttachment[] | undefined,
): string {
  const bridge = useBridge();
  const instanceId = agent.instanceId;
  const session = getSession(instanceId);

  const userMsg = appendMessage(instanceId, {
    id: randomUUID(),
    role: "user",
    content: text,
    streaming: false,
    timestamp: Date.now(),
  });
  if (attachments && attachments.length > 0) {
    userMsg.attachments = attachments.map((a) => ({ filename: a.filename, base64: a.base64 }));
  }

  let currentAgentMsgId = randomUUID();
  appendMessage(instanceId, {
    id: currentAgentMsgId,
    role: "agent",
    content: "",
    streaming: true,
    timestamp: Date.now(),
  });

  function newAgentBubble(): void {
    currentAgentMsgId = randomUUID();
    appendMessage(instanceId, {
      id: currentAgentMsgId,
      role: "agent",
      content: "",
      streaming: true,
      timestamp: Date.now(),
    });
  }

  let syncErrored = false;
  let promptId = "";
  promptId = bridge.prompt(instanceId, text, attachments, {
    onResponse(chunk, responseAttachments) {
      const m = findMessage(instanceId, currentAgentMsgId);
      if (!m) return;
      m.content += chunk;
      if (responseAttachments && responseAttachments.length > 0) {
        m.attachments = [...(m.attachments ?? []), ...responseAttachments];
      }
    },
    onStatus(status) {
      const m = findMessage(instanceId, currentAgentMsgId);
      if (m && status === "stopped") m.statusNote = "(stopped)";
    },
    onQuery(queryId, queryPrompt, queryAttachments) {
      const prev = findMessage(instanceId, currentAgentMsgId);
      if (prev) prev.streaming = false;
      appendMessage(instanceId, {
        id: randomUUID(),
        role: "query",
        content: queryPrompt,
        streaming: false,
        timestamp: Date.now(),
        queryId,
        promptId,
        replied: false,
        attachments: queryAttachments,
      });
      newAgentBubble();
    },
    onToolUse(toolUseId, toolName, input) {
      const prev = findMessage(instanceId, currentAgentMsgId);
      if (prev) prev.streaming = false;
      appendMessage(instanceId, {
        id: randomUUID(),
        role: "tool",
        content: "",
        streaming: false,
        timestamp: Date.now(),
        tool: { id: toolUseId, name: toolName, input },
      });
      newAgentBubble();
    },
    onToolResult(toolUseId, output, isError) {
      const m = findMessageByToolId(instanceId, toolUseId);
      if (m && m.tool) {
        m.tool.result = output;
        m.tool.isError = isError;
      }
    },
    onCost(turnCostUsd) {
      const m = findMessage(instanceId, currentAgentMsgId);
      if (m) m.costUsd = turnCostUsd;
    },
    onDone() {
      const m = findMessage(instanceId, currentAgentMsgId);
      if (m) m.streaming = false;
      session.activePromptId = null;
    },
    onError(message, code, details) {
      syncErrored = true;
      const m = findMessage(instanceId, currentAgentMsgId);
      if (m) {
        const detail = code ? ` [${code}]` : "";
        const extra = details ? ` ${JSON.stringify(details)}` : "";
        m.error = `${message}${detail}${extra}`;
        m.streaming = false;
      }
      session.activePromptId = null;
    },
  });

  if (!syncErrored) session.activePromptId = promptId;
  return promptId;
}
