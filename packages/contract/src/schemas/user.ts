import { z } from 'zod';

export const UserSchema = z.object({
  id: z.string(),
  username: z.string(),
  createdAt: z.iso.datetime(),
});
export type User = z.infer<typeof UserSchema>;
