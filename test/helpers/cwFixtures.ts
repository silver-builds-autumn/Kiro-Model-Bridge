import type { CwRequest } from "../../src/cwTypes";

export function initialCwRequest(): CwRequest {
  return {
    conversationState: {
      conversationId: "conversation-1",
      currentMessage: {
        userInputMessage: {
          content: "Read a.ts",
          modelId: "MODEL",
          userInputMessageContext: {
            tools: [{
              toolSpecification: {
                name: "read_file",
                description: "Read one file",
                inputSchema: {
                  json: {
                    type: "object",
                    properties: { path: { type: "string" } },
                    required: ["path"],
                  },
                },
              },
            }],
          },
        },
      },
    },
  };
}

export function cwToolResultRequest(
  toolUseId: string,
  result: string,
  reasoningSignature: string,
): CwRequest {
  return {
    conversationState: {
      conversationId: "conversation-1",
      history: [
        {
          assistantResponseMessage: {
            reasoningContent: {
              reasoningText: { text: "读取文件", signature: reasoningSignature },
            },
            toolUses: [{
              toolUseId,
              name: "read_file",
              input: { path: "a.ts" },
            }],
          },
        },
        {
          userInputMessage: {
            userInputMessageContext: {
              toolResults: [{
                toolUseId,
                content: [{ text: result }],
                status: "success",
              }],
            },
          },
        },
      ],
      currentMessage: {
        userInputMessage: { content: "continue", modelId: "MODEL" },
      },
    },
  };
}
