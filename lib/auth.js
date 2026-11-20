import { auth as getSession } from "@/auth";

export async function auth() {
  const session = await getSession();

  return {
    userId: session?.user?.id ?? null,
  };
}
