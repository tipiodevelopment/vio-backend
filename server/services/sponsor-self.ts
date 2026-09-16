import { z } from "zod";

/**
 * What a brand (role `sponsor`) may edit about itself via PATCH
 * /api/sponsor/me: its identity only. Commerce keys, payment methods and
 * the Commerce link are not the brand's to type — `.strict()` rejects them.
 */
export const sponsorSelfUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    logoUrl: z.string().trim().max(2048).nullable(),
    avatarUrl: z.string().trim().max(2048).nullable(),
    primaryColor: z.string().trim().max(20).nullable(),
    secondaryColor: z.string().trim().max(20).nullable(),
  })
  .partial()
  .strict();
