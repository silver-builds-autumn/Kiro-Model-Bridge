import assert from "node:assert/strict";
import test from "node:test";
import type { CwRequest } from "../src/cwTypes";
import {
  buildOpenAIResponsesRequest,
  normalizeOpenAIEffort,
} from "../src/providers/openaiResponsesRequest";

test("完整 Responses 请求保留历史、工具调用结果、图片和当前消息", () => {
  const request: CwRequest = {
    conversationState: {
      history: [
        {
          userInputMessage: {
            content: "inspect this image",
            images: [{ format: "png", source: { bytes: "aGVsbG8=" } }],
          },
        },
        {
          assistantResponseMessage: {
            content: "I will inspect it.",
            toolUses: [{
              toolUseId: "call-1",
              name: "inspect_image",
              input: { imageId: "image-1" },
            }],
          },
        },
        {
          userInputMessage: {
            userInputMessageContext: {
              toolResults: [{
                toolUseId: "call-1",
                content: [
                  { text: "image decoded" },
                  { json: { width: 1, height: 1 } },
                ],
                status: "success",
              }],
            },
          },
        },
      ],
      currentMessage: {
        userInputMessage: {
          content: "Summarize the result.",
          modelId: "KIRO_MODEL",
          userInputMessageContext: {
            tools: [{
              toolSpecification: {
                name: "inspect_image",
                description: "Inspect an image",
                inputSchema: {
                  json: {
                    type: "object",
                    properties: { imageId: { type: "string" } },
                    required: ["imageId"],
                  },
                },
              },
            }],
          },
        },
      },
    },
  };

  const body = buildOpenAIResponsesRequest(request, {
    model: "gpt-test",
    maxOutputTokens: 32000,
    effort: "high",
  });

  assert.equal(body.model, "gpt-test");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 32000);
  assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(body.tools, [{
    type: "function",
    name: "inspect_image",
    description: "Inspect an image",
    parameters: {
      type: "object",
      properties: { imageId: { type: "string" } },
      required: ["imageId"],
    },
    strict: false,
  }]);
  assert.equal("function" in (body.tools?.[0] ?? {}), false);

  assert.deepEqual(body.input, [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "inspect this image" },
        {
          type: "input_image",
          image_url: "data:image/png;base64,aGVsbG8=",
          detail: "auto",
        },
      ],
    },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{
        type: "output_text",
        text: "I will inspect it.",
        annotations: [],
      }],
    },
    {
      type: "function_call",
      call_id: "call-1",
      name: "inspect_image",
      arguments: JSON.stringify({ imageId: "image-1" }),
    },
    {
      type: "function_call_output",
      call_id: "call-1",
      output: "image decoded\n{\"width\":1,\"height\":1}",
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Summarize the result." }],
    },
  ]);
});

test("Responses effort 将 max 归一化为 xhigh", () => {
  assert.equal(normalizeOpenAIEffort("max"), "xhigh");
  for (const effort of ["low", "medium", "high", "xhigh"] as const) {
    assert.equal(normalizeOpenAIEffort(effort), effort);
  }
  assert.equal(normalizeOpenAIEffort(undefined), undefined);
});

test("Responses 请求兼容顶层工具定义和字符串工具参数", () => {
  const body = buildOpenAIResponsesRequest({
    conversationState: {
      history: [{
        assistantResponseMessage: {
          toolUses: [{
            toolUseId: "call-string",
            name: "read_file",
            input: '{"path":"a.ts"}',
          }],
        },
      }],
      currentMessage: {
        userInputMessage: {
          content: "continue",
          userInputMessageContext: {
            tools: [{
              name: "read_file",
              description: "Read one file",
              inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            }],
          },
        },
      },
    },
  }, {
    model: "gpt-test",
    maxOutputTokens: 1024,
  });

  assert.deepEqual(body.tools, [{
    type: "function",
    name: "read_file",
    description: "Read one file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    strict: false,
  }]);
  assert.equal(
    body.input.find((item) => item.type === "function_call")?.arguments,
    '{"path":"a.ts"}',
  );
});
