import { auth } from "@/auth";
import { db } from "./prisma";

export const checkUser = async () => {
  const session = await auth();
  const user = session?.user;

  if (!user?.id || !user.email) {
    return null;
  }

  let loggedInUser = await db.user.findUnique({
    where: { authProviderId: user.id },
  });

  if (loggedInUser) {
    return loggedInUser;
  }

  if (user.emailVerified) {
    loggedInUser = await db.user.findFirst({
      where: {
        email: { equals: user.email, mode: "insensitive" },
      },
    });

    if (loggedInUser) {
      return db.user.update({
        where: { id: loggedInUser.id },
        data: { authProviderId: user.id },
      });
    }
  }

  return db.user.create({
    data: {
      authProviderId: user.id,
      email: user.email,
      name: user.name,
      imageUrl: user.image,
    },
  });
};
