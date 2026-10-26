import { z } from 'zod';

/** One component in `third-party.json` (written by `scripts/third-party-notices.ts`). */
export const ThirdPartyPackageSchema = z.object({
  name: z.string(),
  version: z.string(),
  /** SPDX expression for npm packages; free text for image and vendored entries. */
  licence: z.string(),
  homepage: z.string().nullable(),
  origin: z.enum(['npm', 'image', 'vendored']),
  usedBy: z.array(z.enum(['web', 'server', 'image'])),
  /** Key into `texts` (texts are deduplicated). */
  textKey: z.string(),
});
export type ThirdPartyPackage = z.infer<typeof ThirdPartyPackageSchema>;

export const ThirdPartyFileSchema = z.object({
  format: z.literal(1),
  packages: z.array(ThirdPartyPackageSchema),
  texts: z.record(z.string(), z.string()),
});
export type ThirdPartyFile = z.infer<typeof ThirdPartyFileSchema>;

/** `available: false` when the build has no generated list (a dev server before `pnpm licences`). */
export const LicencesOutputSchema = z.discriminatedUnion('available', [
  ThirdPartyFileSchema.extend({ available: z.literal(true) }),
  z.object({ available: z.literal(false) }),
]);
export type LicencesOutput = z.infer<typeof LicencesOutputSchema>;
