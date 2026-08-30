import { z } from "zod";

/** Where a refinement puts a complaint: the path of the field, and the text. */
export type IssueSink = (path: string, message: string) => void;

/** The one call a refinement makes, over the context zod hands it. */
export function issueSink(ctx: z.RefinementCtx): IssueSink {
  return (path, message) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
}
