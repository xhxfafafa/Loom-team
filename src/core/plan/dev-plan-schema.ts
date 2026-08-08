/**
 * DevPlan validation schemas.
 *
 * Used to validate both LLM-generated and template-generated plans so the
 * resulting structure is guaranteed well-formed before persisting. Also used
 * to validate incoming API payloads.
 */

import { z } from "zod";

export const devPlanRiskSchema = z.object({
  risk: z.string().min(1),
  mitigation: z.string().optional(),
});

export const devPlanUserStorySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  story: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).min(0),
});

export const devPlanTeamAllocationSchema = z.object({
  role: z.string().min(1),
  responsibility: z.string().min(1),
});

export const devPlanFeedbackEntrySchema = z.object({
  at: z.string().min(1),
  note: z.string().min(1),
});

export const devPlanStatusSchema = z.enum(["draft", "confirmed", "rejected"]);

export const devPlanSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  goalId: z.string().min(1),
  status: devPlanStatusSchema,
  scope: z.array(z.string()),
  nonGoals: z.array(z.string()),
  risks: z.array(devPlanRiskSchema),
  userStories: z.array(devPlanUserStorySchema),
  technicalApproach: z.string(),
  teamAllocation: z.array(devPlanTeamAllocationSchema),
  feedbackLog: z.array(devPlanFeedbackEntrySchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  confirmedAt: z.string().optional(),
});

/**
 * Shape produced by the generator (no id / timestamps yet).
 * The API layer assigns id + createdAt/updatedAt before persistence.
 */
export const devPlanContentSchema = z.object({
  scope: z.array(z.string()),
  nonGoals: z.array(z.string()),
  risks: z.array(devPlanRiskSchema),
  userStories: z.array(devPlanUserStorySchema),
  technicalApproach: z.string(),
  teamAllocation: z.array(devPlanTeamAllocationSchema),
});

export type DevPlanContent = z.infer<typeof devPlanContentSchema>;

/**
 * Validate a raw object against the content schema. Returns the parsed
 * content on success or throws ZodError on failure.
 */
export function parseDevPlanContent(input: unknown): DevPlanContent {
  return devPlanContentSchema.parse(input);
}

/**
 * Non-throwing variant — returns { success, data, error }.
 */
export function safeParseDevPlanContent(input: unknown): {
  success: boolean;
  data?: DevPlanContent;
  error?: string;
} {
  const result = devPlanContentSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const issues = (result.error as z.ZodError).issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  return { success: false, error: issues };
}
