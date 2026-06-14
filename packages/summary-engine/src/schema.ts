import { z } from "zod";

export const recapDocumentSchema = z.object({
  overview: z.string().min(1),
  decisions: z.array(z.string()),
  actionItems: z.array(
    z.object({
      task: z.string().min(1),
      owner: z.string().optional(),
      dueDate: z.string().optional(),
      timestampSeconds: z.number().nonnegative().optional()
    })
  ),
  risks: z.array(z.string()),
  openQuestions: z.array(z.string()),
  importantDates: z.array(z.object({ date: z.string().min(1), description: z.string().min(1) })),
  followUps: z.array(z.string())
});

export type RecapDocument = z.infer<typeof recapDocumentSchema>;
