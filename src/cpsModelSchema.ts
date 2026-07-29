import {
  DEFAULT_EFFORT_LEVEL,
  EFFORT_LEVELS,
  type EffortGroup,
} from "./modelStore";
import type { EffortMode } from "./effort";
import type { ProviderId } from "./providers/types";

export interface CpsModel {
  modelId: string;
  modelName: string;
  description: string;
  promptCaching: {
    maximumCacheCheckpointsPerRequest: number;
    minimumTokensPerCacheCheckpoint: number;
    supportsPromptCaching: boolean;
  };
  rateUnit: string;
  supportedInputTypes: string[];
  tokenLimits: { maxInputTokens: number; maxOutputTokens: number };
  additionalModelRequestFieldsSchema?: unknown;
  defaultEffortLevel?: string;
}

/** Build the Kiro-visible model schemas without depending on the VS Code runtime. */
export function buildCpsModels(
  groups: EffortGroup[],
  relayMode: ProviderId,
  mode: EffortMode,
): CpsModel[] {
  return groups.map((group) => {
    const model: CpsModel = {
      modelId: group.baseId,
      modelName: group.name || group.baseId,
      description: group.description || "",
      promptCaching: {
        maximumCacheCheckpointsPerRequest: 4,
        minimumTokensPerCacheCheckpoint: 1024,
        supportsPromptCaching: true,
      },
      rateUnit: "Credit",
      supportedInputTypes: ["TEXT", "IMAGE"],
      tokenLimits: {
        maxInputTokens: group.maxInputTokens || 200000,
        maxOutputTokens: group.maxOutputTokens || 64000,
      },
    };

    let efforts: string[] = [];
    let schemaPath = "output_config";
    if (relayMode === "anthropic") {
      if (mode === "modelVariant") {
        efforts = EFFORT_LEVELS.filter((effort) => group.efforts.has(effort));
      } else if (mode === "auto" || mode === "thinkingBudget") {
        efforts = [...EFFORT_LEVELS];
      }
    } else if (group.nativeEffortLevels && group.nativeEffortLevels.length > 0) {
      efforts = group.nativeEffortLevels;
      if (group.effortSchemaPath) {
        schemaPath = group.effortSchemaPath;
      }
    } else if (mode === "modelVariant") {
      efforts = EFFORT_LEVELS.filter((effort) => group.efforts.has(effort));
    } else if (mode === "auto" || mode === "thinkingBudget") {
      efforts = [...EFFORT_LEVELS];
    }

    if (efforts.length === 0) {
      return model;
    }

    const defaultEffort =
      group.defaultEffortLevel && efforts.includes(group.defaultEffortLevel)
        ? group.defaultEffortLevel
        : efforts.includes(DEFAULT_EFFORT_LEVEL)
          ? DEFAULT_EFFORT_LEVEL
          : efforts[0];

    if (schemaPath === "reasoning") {
      const reasoningProps: Record<string, unknown> = {};
      if (group.reasoningModes && group.reasoningModes.length > 0) {
        const defaultMode =
          group.defaultReasoningMode && group.reasoningModes.includes(group.defaultReasoningMode)
            ? group.defaultReasoningMode
            : group.reasoningModes[0];
        reasoningProps.mode = {
          type: "string",
          enum: group.reasoningModes,
          default: defaultMode,
        };
      }
      reasoningProps.effort = { type: "string", enum: efforts, default: defaultEffort };
      model.additionalModelRequestFieldsSchema = {
        type: "object",
        properties: { reasoning: { type: "object", properties: reasoningProps } },
        additionalProperties: false,
      };
    } else {
      model.additionalModelRequestFieldsSchema = {
        type: "object",
        properties: {
          [schemaPath]: {
            type: "object",
            properties: { effort: { type: "string", enum: efforts } },
          },
        },
      };
    }
    model.defaultEffortLevel = defaultEffort;
    return model;
  });
}
